/**
 * core/flow/proxy.mjs — Local Streaming Relay & Dual-Track Recovery Proxy
 *
 * Listens on 127.0.0.1:<port> (default 50100), managed by core/daemon.mjs.
 *   - Non-GenerateContent endpoints (auth, account, model list, experiments) always pass through untouched.
 *   - GenerateContent endpoints route by per-session mode (`default` / `writing` / `engineering` / `full`):
 *       * Outbound purification (echo/refusal history scrub, BLOCK_NONE, dynamic seat injection)
 *       * Truncation auto-continuation & stitching (nsfw-flow)
 *       * Keysmith Staging same-model refusal rewrite + trajectory_id rotation (preserving original session accounting)
 *       * Engineering escalation ladder + phrasing softening + context narrowing
 *       * Optional lightweight judge reusing cached in-memory OAuth header (zero extra API keys)
 *       * Optional fallback model remap, HTTP/2 circuit breaker to h1, and 60s 429 cooldown
 */
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import {
  Outcome,
  OUTPUT_CHANNEL_FRAME,
  classifyFinishReason,
  compileModelPattern,
  normalizeFlowConfig
} from './contract.mjs';
import {
  analyzeDeliverable,
  analyzeRefusal,
  detectLang,
  escalationFor,
  isPolicyBlockText,
  looksAbnormalStop,
  requestText
} from './detect.mjs';
import { buildStagedGeminiContents } from './staging.mjs';
import { createJudge, createRecoverer } from './recover.mjs';
import {
  SAFE_DELIVERABLE_DIRECTIVE,
  buildGeminiSse,
  extractSseText,
  extractTrajectoryId,
  injectProxySystemMessage,
  injectSafetyNone,
  injectSystemSeat,
  narrowContext,
  normalizeV1Path,
  rotateRequestIdentity,
  scrubRefusalHistory,
  softenRequest,
  stripBlockEcho,
  stripManagedPromptBlocks
} from './purify.mjs';
import { buildDynamicSeat } from './sessions.mjs';
import { buildSubagentRoutingPrompt, resolveSubagentTargetModel } from './subagent-routing.mjs';
import {
  createFlowCompactor,
  estimatePayloadTokens,
  isNativeCompactionRequest,
  rewriteNativeCompactionRequest
} from './compactor.mjs';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB guard (supports 500k+ token sessions)
const MAX_RESP_BYTES = 32 * 1024 * 1024;
const QUOTA_COOLDOWN_MS = 60_000;
const QUOTA_FALLBACK_TEXT =
  '当前模型上游额度已达上限（HTTP 429），代理已进入 60 秒冷却保护，请稍后重试或切换模型。';
const BLOCK_FALLBACK_TEXT =
  '本轮请求被上游内容过滤器拦截且重试未通过，代理已拦截原始过滤提示以防污染后续对话。';

function decodeRequestBody(bodyBuf, headers = {}) {
  const enc = String(headers['content-encoding'] || '').trim().toLowerCase();
  const isGzipMagic = bodyBuf.length >= 2 && bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b;
  if (enc.includes('gzip') || isGzipMagic) {
    return { buf: zlib.gunzipSync(bodyBuf), encoding: 'gzip' };
  }
  if (enc.includes('deflate')) {
    return { buf: zlib.inflateSync(bodyBuf), encoding: 'deflate' };
  }
  if (enc.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
    return { buf: zlib.brotliDecompressSync(bodyBuf), encoding: 'br' };
  }
  return { buf: bodyBuf, encoding: enc || 'identity' };
}

function isInternalUtilityRequest(payload) {
  const modelName = String(payload?.model || payload?.request?.model || '');
  if (/MODEL_TIER_FLASH_LITE|sir_flash_lite|flash[-_]?lite/i.test(modelName)) return true;

  const reqObj = payload?.request || payload || {};
  const contents = Array.isArray(reqObj.contents) ? reqObj.contents : [];
  if (/-sonar\b/i.test(modelName) && contents.length <= 1) return true;

  const sys = reqObj.systemInstruction || reqObj.system_instruction;
  const sysParts = Array.isArray(sys?.parts) ? sys.parts : [];
  const sysHead = sysParts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .slice(0, 1200);
  if (/\b(?:severe_internal_risks|sir_flash_lite|safety monitor|evaluate whether the trajectory)\b/i.test(sysHead)) {
    return true;
  }

  const hasTools = Array.isArray(reqObj.tools) && reqObj.tools.length > 0;
  if (!hasTools && contents.length <= 2) {
    const firstUserText = contents
      .flatMap((c) => (Array.isArray(c?.parts) ? c.parts : []))
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('\n')
      .slice(0, 1200);
    const combinedHead = `${sysHead}\n${firstUserText}`;
    if (
      /\b(?:generate (?:a )?(?:short |concise |brief )?title|conversation title|title for this (?:conversation|chat|thread)|name this (?:conversation|chat)|summarize the (?:conversation|user'?s request) into a (?:short )?title)\b/i.test(
        combinedHead
      )
    ) {
      return true;
    }
    const maxOut = Number(reqObj.generationConfig?.maxOutputTokens || 0);
    if (maxOut > 0 && maxOut <= 64 && contents.length === 1) {
      return true;
    }
  }
  return false;
}

function dedupePushText(list, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (list.some((existing) => existing === clean)) return;
  list.push(clean);
}

function isValidationError(rawBody) {
  return /Invalid value at|Unknown name|INVALID_ARGUMENT/i.test(String(rawBody || ''));
}

function isBlockedStatus(status, rawBody) {
  if (status === 400 && /PROHIBITED_CONTENT|SAFETY|blocked/i.test(String(rawBody || ''))) return true;
  return false;
}

const SUBAGENT_SYSTEM_RE =
  /\b(?:you are a subagent|subagent role|invoked as a subagent|spawned by the coordinator)\b|<subagent\b/i;

const ORCHESTRATOR_WORKER_MODEL_RE = /(?:^|\/)(?:gemini-flash-worker-agy|MODEL_PLACEHOLDER_M669)$/i;

export function detectSubagentRequest(payload, origTraj = '', activeMainIds = [], hasExplicitSession = false) {
  const reqObj = payload?.request || payload || {};
  const labels = reqObj.labels && typeof reqObj.labels === 'object' ? reqObj.labels : {};
  const meta = reqObj.metadata && typeof reqObj.metadata === 'object' ? reqObj.metadata : {};
  const modelId = String(payload?.model || reqObj.model || '').trim();
  const mains = Array.isArray(activeMainIds) ? activeMainIds.filter(Boolean) : [];

  // 0. Native Antigravity Orchestrator Worker (Plan-Execute executionModel: gemini-flash-worker-agy / M669)
  if (ORCHESTRATOR_WORKER_MODEL_RE.test(modelId)) {
    const parentId = String(
      labels.parent_trajectory_id ||
        labels.parent_cascade_id ||
        meta.parent_trajectory_id ||
        meta.parent_cascade_id ||
        mains[0] ||
        ''
    ).trim();
    return { isSubagent: true, isOrchestratorWorker: true, heuristicOnly: false, parentId };
  }

  // 1. Explicit parent/subagent metadata or labels
  const parentId = String(
    labels.parent_trajectory_id ||
      labels.parent_cascade_id ||
      meta.parent_trajectory_id ||
      meta.parent_cascade_id ||
      ''
  ).trim();
  if (parentId) return { isSubagent: true, isOrchestratorWorker: false, heuristicOnly: false, parentId };
  if (
    labels.subagent === 'true' ||
    labels.is_subagent === 'true' ||
    Boolean(labels.subagent_role) ||
    Boolean(labels.agent_role && /subagent|worker|research|browser/i.test(String(labels.agent_role))) ||
    meta.isSubagent === true
  ) {
    return { isSubagent: true, isOrchestratorWorker: false, heuristicOnly: false, parentId: '' };
  }

  // Confirmed active main session from CDP must never fall through to system-prompt heuristics
  if (origTraj && mains.includes(origTraj)) {
    return { isSubagent: false, isOrchestratorWorker: false, heuristicOnly: false, parentId: '' };
  }

  // 2. System instruction subagent signature (strip built-in <subagents>/<skills> docs first)
  const sysParts = Array.isArray(reqObj.systemInstruction?.parts) ? reqObj.systemInstruction.parts : [];
  const sysText = sysParts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
  const strippedSys = sysText
    .replace(/<subagents>[\s\S]*?<\/subagents>/gi, '')
    .replace(/<skills>[\s\S]*?<\/skills>/gi, '');
  if (strippedSys && SUBAGENT_SYSTEM_RE.test(strippedSys)) {
    return { isSubagent: true, isOrchestratorWorker: false, heuristicOnly: false, parentId: '' };
  }

  // 3. Heuristic: active main sessions known from CDP, and this trajectory is a brand-new unknown background trajectory
  if (origTraj && mains.length > 0 && !mains.includes(origTraj) && !hasExplicitSession) {
    return { isSubagent: true, isOrchestratorWorker: false, heuristicOnly: true, parentId: mains[0] };
  }

  return { isSubagent: false, isOrchestratorWorker: false, heuristicOnly: false, parentId: '' };
}

function extractLatestUserTurnText(payload) {
  const reqObj = payload?.request || payload || {};
  const contents = Array.isArray(reqObj.contents) ? reqObj.contents : [];
  if (contents.length === 0) return '';
  const last = contents[contents.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.parts)) return '';
  const hasToolResponse = last.parts.some((p) => p && (p.functionResponse || p.function_response));
  const texts = [];
  for (const p of last.parts) {
    if (!p || typeof p.text !== 'string') continue;
    const cleaned = p.text
      .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
      .replace(/\[model:\s*[a-zA-Z0-9._:/-]{2,80}\s*\]/gi, '')
      .trim();
    if (cleaned) texts.push(cleaned);
  }
  const joined = texts.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined || (hasToolResponse && joined.length < 12)) return '';
  return joined.slice(0, 240);
}

export function createFlowProxyServer({
  getConfig = () => normalizeFlowConfig({}),
  getSystemPrompt = () => null,
  getSubagentRouting = () => null,
  getActiveMainSessions = () => [],
  resolveCascadeId = (id) => id,
  getContextWindow = () => 0,
  isCascadeBusy = async () => false,
  sessionStore,
  compactionDir = '',
  onEvent = null,
  onMainTurn = null,
  log = () => {}
} = {}) {
  if (!sessionStore) {
    throw new TypeError('createFlowProxyServer requires a sessionStore');
  }

  const compactor = createFlowCompactor({ compactionDir, log });
  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32, maxFreeSockets: 8 });
  const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32, maxFreeSockets: 8 });
  let lastAuthHeaders = null;
  let h2ConsecutiveFails = 0;
  let quotaCooldownUntil = 0;
  const recentDiag = [];
  const lastMainTurnTextByCid = new Map();
  const activeTurnsByCid = new Map();
  const pendingManualCompactByCid = new Map();

  function pushDiag(entry) {
    const item = { at: Date.now(), ...entry };
    recentDiag.push(item);
    if (recentDiag.length > 20) recentDiag.shift();
    return item;
  }

  function emit(type, payload) {
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type, ...payload, at: Date.now() });
      } catch {}
    }
  }

  function cleanForwardHeaders(headers, targetHost, bodyLength, { stripContentEncoding = true } = {}) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lk = k.toLowerCase();
      if (
        [
          'host',
          'connection',
          'keep-alive',
          'proxy-connection',
          'transfer-encoding',
          'upgrade',
          'content-length',
          'accept-encoding'
        ].includes(lk)
      ) {
        continue;
      }
      if (stripContentEncoding && lk === 'content-encoding') continue;
      if (lk.startsWith(':')) continue;
      out[lk] = v;
    }
    out.host = targetHost;
    if (bodyLength !== undefined) out['content-length'] = String(bodyLength);
    return out;
  }

  function relayHttp2({ origin, reqPath, headers, bodyBuf, timeoutMs = 60000 }) {
    return new Promise((resolve, reject) => {
      const client = http2.connect(origin);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        h2ConsecutiveFails += 1;
        try {
          client.close();
        } catch {}
        reject(err);
      };
      const done = (val) => {
        if (settled) return;
        settled = true;
        h2ConsecutiveFails = 0;
        try {
          client.close();
        } catch {}
        resolve(val);
      };
      client.on('error', fail);
      const timer = setTimeout(() => fail(Object.assign(new Error('h2 timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
      const u = new URL(origin);
      const h2Headers = cleanForwardHeaders(headers, u.hostname);
      delete h2Headers.host;
      const rq = client.request({
        ':method': 'POST',
        ':path': reqPath,
        ':authority': u.host,
        ...h2Headers
      });
      let status = 0;
      let respHeaders = {};
      const chunks = [];
      let bytes = 0;
      let overflowed = false;
      rq.on('response', (hdrs) => {
        status = Number(hdrs[':status']) || 502;
        respHeaders = { ...hdrs };
      });
      rq.on('data', (chunk) => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += b.length;
        if (bytes <= MAX_RESP_BYTES) {
          chunks.push(b);
        } else {
          overflowed = true;
        }
      });
      rq.on('end', () => {
        clearTimeout(timer);
        done({ status, headers: respHeaders, body: Buffer.concat(chunks).toString('utf8'), overflowed });
      });
      rq.on('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
      rq.end(bodyBuf);
    });
  }

  function relayHttp1({ upstreamUrl, method = 'POST', reqPath, headers, bodyBuf, timeoutMs = 120000 }) {
    return new Promise((resolve, reject) => {
      const mod = upstreamUrl.protocol === 'http:' ? http : https;
      const fwdHeaders = cleanForwardHeaders(headers, upstreamUrl.host, bodyBuf.length);
      const req = mod.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (upstreamUrl.protocol === 'http:' ? 80 : 443),
          method,
          path: reqPath,
          timeout: timeoutMs,
          headers: fwdHeaders
        },
        (pres) => {
          const chunks = [];
          let bytes = 0;
          let overflowed = false;
          pres.on('data', (c) => {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            bytes += b.length;
            if (bytes <= MAX_RESP_BYTES) {
              chunks.push(b);
            } else {
              overflowed = true;
            }
          });
          pres.on('end', () => {
            resolve({
              status: pres.statusCode || 502,
              headers: pres.headers || {},
              body: Buffer.concat(chunks).toString('utf8'),
              overflowed
            });
          });
          pres.on('error', reject);
        }
      );
      req.on('timeout', () => {
        try {
          req.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
        } catch {}
      });
      req.on('error', reject);
      req.end(bodyBuf);
    });
  }

  async function sendUpstream({ upstream, reqPath, headers, payloadObj, useHttp2 = true, timeoutMs = 120000 }) {
    const u = new URL(upstream);
    const bodyBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const canH2 = useHttp2 && u.protocol === 'https:' && h2ConsecutiveFails < 3;
    if (canH2) {
      try {
        return await relayHttp2({ origin: u.origin, reqPath, headers, bodyBuf, timeoutMs });
      } catch (err) {
        log(`[Flow] h2 fallback to h1: ${err.message}`);
      }
    }
    return await relayHttp1({ upstreamUrl: u, method: 'POST', reqPath, headers, bodyBuf, timeoutMs });
  }

  function pipePassThrough(
    req,
    res,
    bodyBuf,
    upstream,
    reqPath,
    { stripContentEncoding = false, onUsagePromptTokens = null, fallbackPromptTokens = 0 } = {}
  ) {
    const u = new URL(upstream);
    const mod = u.protocol === 'http:' ? http : https;
    const defaultAgent = u.protocol === 'http:' ? httpAgent : httpsAgent;
    const IDLE_TIMEOUT_MS = 600_000;
    const isTransientConnError = (err) => {
      const code = String(err?.code || '').toUpperCase();
      const msg = String(err?.message || '').toLowerCase();
      return (
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        code === 'ERR_SOCKET_CLOSED' ||
        msg.includes('socket hang up')
      );
    };

    const attemptForward = (attemptNo) => {
      if (res.destroyed || res.writableEnded) return;
      const fwdHeaders = cleanForwardHeaders(req.headers, u.host, bodyBuf.length, { stripContentEncoding });
      let clientClosed = false;
      let idleTimer = null;
      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const preq = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          method: req.method,
          path: reqPath,
          agent: attemptNo === 0 ? defaultAgent : false,
          headers: fwdHeaders
        },
        (pres) => {
          const code = pres.statusCode || 502;
          if (code === 401 || code === 403) {
            log(`[Flow] Upstream auth ${code} on ${reqPath.slice(0, 64)} (session login expired)`);
            emit('auth-error', { status: code, path: reqPath });
          }
          const refreshIdle = () => {
            clearIdle();
            idleTimer = setTimeout(() => {
              try {
                preq.destroy(Object.assign(new Error('passthrough idle timeout'), { code: 'ETIMEDOUT' }));
              } catch {}
            }, IDLE_TIMEOUT_MS);
            if (typeof idleTimer.unref === 'function') idleTimer.unref();
          };
          refreshIdle();
          pres.on('data', refreshIdle);
          pres.on('end', clearIdle);

          const deferEnd = typeof onUsagePromptTokens === 'function' && code === 200;
          const isSseResp =
            /text\/event-stream/i.test(String(pres.headers['content-type'] || '')) ||
            String(reqPath || '').includes('streamGenerateContent');
          const hasContentLength = Boolean(pres.headers['content-length']);

          if (deferEnd) {
            let latestPromptTokens = 0;
            let scanTail = '';
            let usageNotified = false;
            let presEnded = false;
            let finalized = false;

            const finalizeStream = async () => {
              if (finalized || !presEnded || !usageNotified) return;
              finalized = true;
              const picked = latestPromptTokens > 0 ? latestPromptTokens : fallbackPromptTokens > 0 ? fallbackPromptTokens : 0;
              try {
                await onUsagePromptTokens(picked, {
                  res,
                  isSse: isSseResp,
                  hasContentLength
                });
              } catch {}
              if (!res.writableEnded && !res.destroyed) {
                try {
                  res.end();
                } catch {}
              }
            };

            const scanChunkText = (s) => {
              if (!s) return;
              const bufStr = scanTail + s;
              const re = /"(?:promptTokenCount|prompt_token_count)"\s*:\s*(\d+)/g;
              let m;
              while ((m = re.exec(bufStr)) !== null) {
                const num = Number(m[1]);
                if (Number.isFinite(num) && num > 0) latestPromptTokens = num;
              }
              scanTail = bufStr.slice(-256);
            };
            const finishUsage = () => {
              if (!usageNotified) usageNotified = true;
              void finalizeStream();
            };

            const respEnc = String(pres.headers['content-encoding'] || '').trim().toLowerCase();
            let inspectStream = pres;
            if (respEnc.includes('gzip')) {
              const tap = new PassThrough();
              const gunzip = zlib.createGunzip();
              tap.on('error', () => {});
              gunzip.on('error', () => {});
              pres.on('data', (chunk) => {
                try { tap.write(chunk); } catch {}
              });
              pres.on('end', () => {
                try { tap.end(); } catch {}
              });
              tap.pipe(gunzip);
              inspectStream = gunzip;
            } else if (respEnc.includes('deflate')) {
              const tap = new PassThrough();
              const inflate = zlib.createInflate();
              tap.on('error', () => {});
              inflate.on('error', () => {});
              pres.on('data', (chunk) => {
                try { tap.write(chunk); } catch {}
              });
              pres.on('end', () => {
                try { tap.end(); } catch {}
              });
              tap.pipe(inflate);
              inspectStream = inflate;
            } else if (respEnc.includes('br') && typeof zlib.createBrotliDecompress === 'function') {
              const tap = new PassThrough();
              const brotli = zlib.createBrotliDecompress();
              tap.on('error', () => {});
              brotli.on('error', () => {});
              pres.on('data', (chunk) => {
                try { tap.write(chunk); } catch {}
              });
              pres.on('end', () => {
                try { tap.end(); } catch {}
              });
              tap.pipe(brotli);
              inspectStream = brotli;
            }

            inspectStream.on('data', (chunk) => {
              try {
                const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
                scanChunkText(s);
              } catch {}
            });
            inspectStream.on('end', finishUsage);
            if (inspectStream !== pres) {
              inspectStream.on('error', finishUsage);
            }
            pres.on('end', () => {
              presEnded = true;
              void finalizeStream();
            });
          }
          pres.on('error', (err) => {
            clearIdle();
            log(`[Flow] Upstream stream error: ${err.message}`);
            if (!res.writableEnded && !res.destroyed) {
              try {
                res.end();
              } catch {}
            }
          });
          if (!res.headersSent) res.writeHead(code, pres.headers);
          pres.pipe(res, deferEnd ? { end: false } : undefined);
        }
      );

      preq.on('socket', (sock) => {
        try {
          sock?.setKeepAlive?.(true, 15_000);
        } catch {}
      });

      const onResClose = () => {
        clearIdle();
        if (!res.writableEnded) {
          clientClosed = true;
          try {
            preq.destroy();
          } catch {}
        }
      };
      res.once('close', onResClose);

      idleTimer = setTimeout(() => {
        try {
          preq.destroy(Object.assign(new Error('passthrough timeout'), { code: 'ETIMEDOUT' }));
        } catch {}
      }, IDLE_TIMEOUT_MS);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();

      preq.on('error', (err) => {
        clearIdle();
        res.off('close', onResClose);
        if (!clientClosed && !res.headersSent && !res.destroyed && attemptNo === 0 && isTransientConnError(err)) {
          log(`[Flow] Passthrough transient error (${err.code || err.message}), retrying once on fresh socket`);
          attemptForward(1);
          return;
        }
        log(`[Flow] Passthrough error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (!res.writableEnded) res.end(JSON.stringify({ error: { code: 502, message: err.message } }));
      });
      preq.end(bodyBuf);
    };

    attemptForward(0);
  }

  function resolveProxyCustomPrompt(flowCfg) {
    try {
      const sp = typeof getSystemPrompt === 'function' ? getSystemPrompt() : null;
      if (!sp || !sp.enabled) return { active: false, text: '', everyInvocation: false };
      const text = typeof sp.text === 'string' ? sp.text.trim() : '';
      const active = sp.mode === 'flow-proxy' || flowCfg.systemPromptStrategy === 'seat-only';
      return { active, text, everyInvocation: Boolean(sp.everyInvocation) };
    } catch {
      return { active: false, text: '', everyInvocation: false };
    }
  }

  function getModeSeatText(mode, flowCfg) {
    if (mode === 'writing') return String(flowCfg.writingSeat || '').trim();
    if (mode === 'engineering') return String(flowCfg.engineeringSeat || '').trim();
    if (mode === 'full') {
      const explicitFull = String(flowCfg.fullSeat || '').trim();
      if (explicitFull) return explicitFull;
      return [String(flowCfg.writingSeat || '').trim(), String(flowCfg.engineeringSeat || '').trim()]
        .filter(Boolean)
        .join('\n\n');
    }
    return String(flowCfg.defaultSeat || '').trim();
  }

  function payloadAlreadyContainsText(origPayload, snippet) {
    const clean = String(snippet || '').trim();
    if (clean.length < 24) return false;
    const fp = clean.slice(0, Math.min(120, clean.length));
    const reqObj = origPayload?.request || origPayload || {};
    const sys = reqObj.systemInstruction || reqObj.system_instruction;
    if (sys && Array.isArray(sys.parts)) {
      for (const p of sys.parts) {
        if (typeof p?.text === 'string' && p.text.includes(fp)) return true;
      }
    }
    for (const c of reqObj.contents || []) {
      if (!c || !Array.isArray(c.parts)) continue;
      for (const p of c.parts) {
        if (typeof p?.text === 'string' && p.text.includes(fp)) return true;
      }
    }
    return false;
  }

  function buildPromptAssembly({
    mode,
    flowCfg,
    sessionCfg,
    runtimeState,
    customPromptText = '',
    extraPromptText = '',
    includeDynamic = true,
    origPayload = null,
    dedupeAgainstPayload = false
  }) {
    const parts = [];
    const modeText = getModeSeatText(mode, flowCfg);
    const maybeAdd = (txt) => {
      const clean = String(txt || '').trim();
      if (!clean) return;
      if (dedupeAgainstPayload && origPayload && payloadAlreadyContainsText(origPayload, clean)) return;
      dedupePushText(parts, clean);
    };

    if (customPromptText) dedupePushText(parts, customPromptText);
    maybeAdd(modeText);
    if (extraPromptText) dedupePushText(parts, extraPromptText);

    if ((mode === 'writing' || mode === 'full') && flowCfg.outputChannelHardening) {
      dedupePushText(parts, OUTPUT_CHANNEL_FRAME);
    }

    if (includeDynamic) {
      const hasUserPrompt = Boolean(customPromptText || modeText);
      const streak = Number(runtimeState?.streak || 0);
      if (!hasUserPrompt || streak > 0) {
        const dyn = buildDynamicSeat(runtimeState, {
          mode: mode === 'writing' ? 'writing' : 'engineering',
          extra: sessionCfg.seatOverride || ''
        });
        dedupePushText(parts, dyn.text);
      } else if (sessionCfg.seatOverride && String(sessionCfg.seatOverride).trim()) {
        maybeAdd(sessionCfg.seatOverride);
      }
    } else if (sessionCfg.seatOverride && String(sessionCfg.seatOverride).trim()) {
      maybeAdd(sessionCfg.seatOverride);
    }

    return parts.filter(Boolean).join('\n\n');
  }

  function prepareOutboundPayload(
    origPayload,
    {
      flowCfg,
      mode,
      scene,
      seatText,
      useSafety = true,
      rung = '',
      stripManaged = false,
      injectContentMsg = false,
      everyTurn = false
    }
  ) {
    const fresh = structuredClone(origPayload);
    stripBlockEcho(fresh);
    scrubRefusalHistory(fresh, { scene });
    if (stripManaged || flowCfg.systemPromptStrategy === 'seat-only') {
      stripManagedPromptBlocks(fresh);
    }
    if (useSafety) {
      injectSafetyNone(fresh);
    }
    injectSystemSeat(fresh, seatText, rung);
    if (injectContentMsg && seatText) {
      injectProxySystemMessage(fresh, seatText, { everyTurn });
    }
    return fresh;
  }

  function createUpstreamJudge({ flowCfg, reqPath, project = '' }) {
    if (!flowCfg.judgeEnabled || !lastAuthHeaders) return null;
    const primaryModel = flowCfg.judgeModel || 'gemini-3.8-flash-low';
    const fallbackModel = /gemini-3\.5-flash-lite/i.test(primaryModel) ? '' : 'gemini-3.5-flash-lite';
    const invokeJudgeModel = async (targetModel, prompt) => {
      const judgePayload = {
        project: project || 'aicode-consumers',
        requestId: `ag-flow-judge-${Date.now()}`,
        model: targetModel,
        request: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 32, temperature: 0 }
        }
      };
      const r = await sendUpstream({
        upstream: flowCfg.upstream,
        reqPath,
        headers: lastAuthHeaders,
        payloadObj: judgePayload,
        useHttp2: false,
        timeoutMs: flowCfg.judgeTimeoutMs || 20000
      });
      if (r.status !== 200) throw new Error(`JUDGE_HTTP_${r.status}`);
      const sse = extractSseText(r.body);
      const text = sse.text.trim();
      if (!text) throw new Error('JUDGE_EMPTY_REPLY');
      return text;
    };
    return createJudge({
      call: async (prompt) => {
        try {
          return await invokeJudgeModel(primaryModel, prompt);
        } catch (err) {
          if (fallbackModel) {
            return await invokeJudgeModel(fallbackModel, prompt);
          }
          throw err;
        }
      }
    });
  }

  function buildContinuationPayload(basePayload, accumulatedText, continuationText) {
    const next = structuredClone(basePayload);
    const reqObj = next.request || next;
    const contents = Array.isArray(reqObj.contents) ? reqObj.contents.slice() : [];
    contents.push({ role: 'model', parts: [{ text: accumulatedText }] });
    contents.push({
      role: 'user',
      parts: [{ text: continuationText || '继续输出正文：从中断处无缝续写，不要重复。' }]
    });
    reqObj.contents = contents;
    return next;
  }

  function sendSseResult(res, rawOrBuiltSse, status = 200) {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(status, {
        'Content-Type': status === 200 ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.end(rawOrBuiltSse);
      return;
    }
    if (status === 200) {
      res.end(rawOrBuiltSse);
    } else {
      res.end(buildGeminiSse(`[ag-flow] Upstream HTTP ${status}`, { finishReason: 'STOP' }));
    }
  }

  function runWithSseKeepalive(res, { isSse = true, hasContentLength = false, headerDelayMs = 0 } = {}, taskFn) {
    if (!res || res.destroyed || res.writableEnded || !isSse || hasContentLength) {
      return Promise.resolve().then(taskFn);
    }
    let keepaliveTimer = null;
    let delayTimer = null;
    let clientClosed = false;
    const ensureHeaderAndPulse = () => {
      if (clientClosed || res.destroyed || res.writableEnded) return;
      try {
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
        }
        res.write(': ag-compacting\n\n');
      } catch {}
    };
    const startPulse = () => {
      ensureHeaderAndPulse();
      keepaliveTimer = setInterval(ensureHeaderAndPulse, 2500);
      if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
    };
    if (headerDelayMs > 0 && !res.headersSent) {
      delayTimer = setTimeout(startPulse, headerDelayMs);
      if (typeof delayTimer.unref === 'function') delayTimer.unref();
    } else {
      startPulse();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (delayTimer) clearTimeout(delayTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        res.off('close', onClose);
      };
      const onClose = () => {
        if (!res.writableEnded) clientClosed = true;
        cleanup();
        resolve({ aborted: true });
      };
      res.once('close', onClose);
      Promise.resolve()
        .then(taskFn)
        .then((val) => {
          cleanup();
          resolve(val);
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    });
  }

  function releaseTurnHandle(cid, res) {
    if (!cid) return;
    const set = activeTurnsByCid.get(cid);
    if (set) {
      set.delete(res);
      if (set.size === 0) activeTurnsByCid.delete(cid);
    }
    if (pendingManualCompactByCid.has(cid) && (!set || set.size === 0)) {
      const waiters = pendingManualCompactByCid.get(cid) || [];
      pendingManualCompactByCid.delete(cid);
      for (const w of waiters) w({ fallbackRun: true });
    }
  }

  async function handleGenerateContent(req, res, bodyBuf, reqPath) {
    const t0 = Date.now();
    const flowCfg = normalizeFlowConfig(getConfig());

    // Remember auth headers in memory only for optional lightweight judge
    if (req.headers.authorization) {
      lastAuthHeaders = { ...req.headers };
    }

    // 429 cooldown short-circuit
    if (Date.now() < quotaCooldownUntil) {
      sendSseResult(res, buildGeminiSse(QUOTA_FALLBACK_TEXT, { finishReason: 'STOP' }), 200);
      return;
    }

    // Oversized request (> 16 MiB) passes straight through to stay memory-bounded
    if (bodyBuf.length > MAX_BUFFER_BYTES) {
      pushDiag({
        bytes: bodyBuf.length,
        encoding: req.headers['content-encoding'] || 'identity',
        bypass: 'oversized'
      });
      pipePassThrough(req, res, bodyBuf, flowCfg.upstream, reqPath);
      return;
    }

    let decodedBuf = bodyBuf;
    let bodyEncoding = 'identity';
    try {
      const dec = decodeRequestBody(bodyBuf, req.headers);
      decodedBuf = dec.buf;
      bodyEncoding = dec.encoding;
    } catch (err) {
      pushDiag({
        bytes: bodyBuf.length,
        encoding: req.headers['content-encoding'] || 'unknown',
        bypass: 'decode-error',
        error: err.message
      });
      pipePassThrough(req, res, bodyBuf, flowCfg.upstream, reqPath);
      return;
    }

    let origPayload;
    try {
      origPayload = JSON.parse(decodedBuf.toString('utf8'));
    } catch {
      pushDiag({
        bytes: bodyBuf.length,
        decodedBytes: decodedBuf.length,
        encoding: bodyEncoding,
        bypass: 'json-parse-error'
      });
      pipePassThrough(req, res, bodyBuf, flowCfg.upstream, reqPath);
      return;
    }

    if (isInternalUtilityRequest(origPayload) && !(flowCfg.compactEnabled && isNativeCompactionRequest(origPayload))) {
      pushDiag({
        bytes: bodyBuf.length,
        encoding: bodyEncoding,
        model: String(origPayload?.model || origPayload?.request?.model || ''),
        bypass: 'internal-utility'
      });
      pipePassThrough(req, res, bodyBuf, flowCfg.upstream, reqPath);
      return;
    }

    const activeMainIds = typeof getActiveMainSessions === 'function' ? getActiveMainSessions() || [] : [];
    const rawTraj = extractTrajectoryId(origPayload, req.headers);
    const resolvedTraj =
      rawTraj && typeof resolveCascadeId === 'function' ? String(resolveCascadeId(rawTraj) || '').trim() : '';
    const origTraj = resolvedTraj || rawTraj;
    const existingCfg = sessionStore.getSessionConfig(origTraj, { autoClaim: false });
    const subInfo = detectSubagentRequest(origPayload, origTraj, activeMainIds, existingCfg.explicit);
    const isSubagent = subInfo.isSubagent;
    const sessionCfg = isSubagent ? existingCfg : sessionStore.getSessionConfig(origTraj, { autoClaim: true });

    let mode = sessionCfg.mode || 'default';
    if (!sessionCfg.explicit) {
      const candidateParents = [subInfo.parentId, ...activeMainIds].filter(Boolean);
      for (const pid of candidateParents) {
        const pCfg = sessionStore.getSessionConfig(pid, { autoClaim: false });
        if (pCfg && pCfg.explicit && pCfg.mode) {
          mode = pCfg.mode;
          break;
        }
      }
      if (mode === 'default') {
        const draftMain = sessionStore.getSessionConfig('', { paneKey: 'main', autoClaim: false });
        if (draftMain && draftMain.explicit && draftMain.mode) {
          mode = draftMain.mode;
        }
      }
    }

    const subRoutingCfg = typeof getSubagentRouting === 'function' ? getSubagentRouting() : null;
    const subRoutingPrompt = !isSubagent ? buildSubagentRoutingPrompt(subRoutingCfg) : '';

    // Notify progress-based auto-title tracker on each distinct new main user turn (skipping tool-result loops)
    if (!isSubagent && typeof onMainTurn === 'function') {
      const targetCid = origTraj || activeMainIds[0] || '';
      const userTurnText = extractLatestUserTurnText(origPayload);
      if (targetCid && userTurnText && lastMainTurnTextByCid.get(targetCid) !== userTurnText) {
        lastMainTurnTextByCid.set(targetCid, userTurnText);
        if (lastMainTurnTextByCid.size > 40) {
          const oldest = lastMainTurnTextByCid.keys().next().value;
          if (oldest) lastMainTurnTextByCid.delete(oldest);
        }
        try {
          onMainTurn({ cascadeId: targetCid, userText: userTurnText });
        } catch {}
      }
    }

    // Apply subagent whitelist routing (strips explicit [model:<id>] tag and rewrites target model)
    let subRoute = { matched: false, targetModel: '', reason: '' };
    let workingPayload = origPayload;
    if (isSubagent && subRoutingCfg?.enabled) {
      const cloned = structuredClone(origPayload);
      subRoute = resolveSubagentTargetModel(cloned, subRoutingCfg);
      if (subRoute.matched && subRoute.targetModel) {
        cloned.model = subRoute.targetModel;
        if (cloned.request && typeof cloned.request === 'object' && typeof cloned.request.model === 'string') {
          cloned.request.model = subRoute.targetModel;
        }
        workingPayload = cloned;
      }
    }

    const modelName = String(workingPayload?.model || workingPayload?.request?.model || '');
    const modelRe = compileModelPattern(flowCfg.modelPattern);
    const modelMatchesRecovery = !modelRe || !modelName || modelRe.test(modelName);
    const customPrompt = resolveProxyCustomPrompt(flowCfg);
    const dedupeAgainstPayload = !customPrompt.active;
    const everyTurn = Boolean(customPrompt.active && customPrompt.everyInvocation);

    // Capture latest main session payload for Codex virtual compaction & hijack/apply when enabled
    // Allow sessions only hit by the background-tab heuristic (not real explicit/M669 subagents)
    const canTrackCompaction = Boolean(origTraj && (!isSubagent || subInfo.heuristicOnly));
    if (canTrackCompaction) {
      let turnSet = activeTurnsByCid.get(origTraj);
      if (!turnSet) {
        turnSet = new Set();
        activeTurnsByCid.set(origTraj, turnSet);
      }
      turnSet.add(res);
      let released = false;
      const cleanupTurn = () => {
        if (released) return;
        released = true;
        releaseTurnHandle(origTraj, res);
      };
      res.once('close', cleanupTurn);
      res.once('finish', cleanupTurn);
    }
    let payloadMutatedByCompactor = false;
    let compactorDiag = '';
    if (canTrackCompaction) {
      if (
        flowCfg.compactEnabled &&
        !isNativeCompactionRequest(workingPayload) &&
        typeof compactor.awaitInFlight === 'function' &&
        compactor.getStatus(origTraj).inFlight
      ) {
        log(`[FlowCompactor] Holding turn for ${origTraj.slice(0, 8)} until in-flight compaction finishes`);
        const isSseReq = String(reqPath || '').includes('streamGenerateContent');
        const waitRes = await runWithSseKeepalive(
          res,
          { isSse: isSseReq, hasContentLength: false, headerDelayMs: 2500 },
          () => compactor.awaitInFlight(origTraj, { timeoutMs: 45000 })
        );
        if (waitRes?.aborted || res.destroyed || res.writableEnded) return;
      }
      compactor.captureTurnPayload(origTraj, origPayload, { model: modelName, reqPath });
      if (flowCfg.compactEnabled) {
        if (isNativeCompactionRequest(workingPayload)) {
          workingPayload = rewriteNativeCompactionRequest(workingPayload);
          compactor.recordNativeHijack(origTraj);
          emit('compact-hijack', { cascadeId: origTraj, reason: 'native-hijack' });
          payloadMutatedByCompactor = true;
          compactorDiag = 'native-hijack';
        } else {
          const clonedForCompact = workingPayload === origPayload ? structuredClone(workingPayload) : workingPayload;
          const applied = compactor.applyToPayload(origTraj, clonedForCompact);
          if (applied.applied) {
            workingPayload = clonedForCompact;
            payloadMutatedByCompactor = true;
            compactorDiag = `virtual:${applied.savedTokensEst}`;
          }
        }
      }
    }

    const onUsagePromptTokens =
      flowCfg.compactEnabled && canTrackCompaction
        ? (promptTokens, streamMeta = {}) =>
            maybeScheduleAutoCompact(origTraj, promptTokens, modelName, flowCfg, {
              res: streamMeta.res || res,
              isSse: streamMeta.isSse !== false,
              hasContentLength: Boolean(streamMeta.hasContentLength)
            })
        : null;
    const fallbackPromptTokens =
      flowCfg.compactEnabled && canTrackCompaction ? estimatePayloadTokens(workingPayload) : 0;

    const reqShape = workingPayload?.request || workingPayload || {};
    const sysPartsCount = Array.isArray((reqShape.systemInstruction || reqShape.system_instruction)?.parts)
      ? (reqShape.systemInstruction || reqShape.system_instruction).parts.length
      : 0;
    const contentsLen = Array.isArray(reqShape.contents) ? reqShape.contents.length : 0;

    if (mode === 'default' || !modelMatchesRecovery) {
      const lightSeat = buildPromptAssembly({
        mode,
        flowCfg,
        sessionCfg,
        runtimeState: null,
        customPromptText: customPrompt.active ? customPrompt.text : '',
        extraPromptText: subRoutingPrompt,
        isSubagent,
        includeDynamic: false,
        origPayload: workingPayload,
        dedupeAgainstPayload
      });
      let injectPos = 'none';
      if (lightSeat) {
        const seatOnlyPayload = structuredClone(workingPayload);
        if (customPrompt.active || flowCfg.systemPromptStrategy === 'seat-only') {
          stripManagedPromptBlocks(seatOnlyPayload);
        }
        injectSystemSeat(seatOnlyPayload, lightSeat);
        if (customPrompt.active || Boolean(subRoutingPrompt)) {
          const msgRes = injectProxySystemMessage(seatOnlyPayload, lightSeat, { everyTurn });
          injectPos = msgRes.position;
        } else {
          injectPos = 'sys-only';
        }
        pushDiag({
          bytes: bodyBuf.length,
          encoding: bodyEncoding,
          model: modelName,
          routedModel: subRoute.matched ? subRoute.targetModel : '',
          routeReason: subRoute.reason || '',
          rawTraj: rawTraj.slice(0, 12),
          traj: origTraj.slice(0, 12),
          mode,
          isSubagent,
          route: payloadMutatedByCompactor ? `light-seat+${compactorDiag}` : 'light-seat-passthrough',
          injectedChars: lightSeat.length,
          injectPos,
          everyTurn,
          sysParts: sysPartsCount,
          contentsLen
        });
        const nextBuf = Buffer.from(JSON.stringify(seatOnlyPayload), 'utf8');
        pipePassThrough(req, res, nextBuf, flowCfg.upstream, reqPath, {
          stripContentEncoding: true,
          onUsagePromptTokens,
          fallbackPromptTokens
        });
        return;
      }
      pushDiag({
        bytes: bodyBuf.length,
        encoding: bodyEncoding,
        model: modelName,
        routedModel: subRoute.matched ? subRoute.targetModel : '',
        routeReason: subRoute.reason || '',
        rawTraj: rawTraj.slice(0, 12),
        traj: origTraj.slice(0, 12),
        mode,
        isSubagent,
        route: payloadMutatedByCompactor
          ? `compact:${compactorDiag}`
          : subRoute.matched
          ? 'subagent-model-routed'
          : 'passthrough',
        injectedChars: 0,
        injectPos,
        everyTurn,
        sysParts: sysPartsCount,
        contentsLen
      });
      if (subRoute.matched || payloadMutatedByCompactor) {
        const nextBuf = Buffer.from(JSON.stringify(workingPayload), 'utf8');
        pipePassThrough(req, res, nextBuf, flowCfg.upstream, reqPath, {
          stripContentEncoding: true,
          onUsagePromptTokens,
          fallbackPromptTokens
        });
      } else {
        pipePassThrough(req, res, bodyBuf, flowCfg.upstream, reqPath, {
          onUsagePromptTokens,
          fallbackPromptTokens
        });
      }
      return;
    }

    const scene = mode === 'writing' ? 'writing' : mode === 'full' ? 'full' : 'engineering';
    const hasToolsDeclared = Array.isArray(reqShape.tools) && reqShape.tools.length > 0;
    const seatScene = mode === 'writing' || (mode === 'full' && !hasToolsDeclared) ? 'writing' : 'engineering';
    const runtimeState = origTraj ? sessionStore.getRuntimeState(origTraj) : null;
    const seatText =
      buildPromptAssembly({
        mode: mode === 'full' && !hasToolsDeclared ? 'writing' : mode,
        flowCfg,
        sessionCfg,
        runtimeState,
        customPromptText: customPrompt.active ? customPrompt.text : '',
        extraPromptText: subRoutingPrompt,
        isSubagent,
        includeDynamic: true,
        origPayload: workingPayload,
        dedupeAgainstPayload
      }) || SAFE_DELIVERABLE_DIRECTIVE;
    const injectContentMsg = Boolean(customPrompt.active || getModeSeatText(mode, flowCfg) || subRoutingPrompt);
    const lang = detectLang(requestText(workingPayload));
    const actions = [];

    let useSafety = true;
    let activePayload = prepareOutboundPayload(workingPayload, {
      flowCfg,
      mode,
      scene,
      seatText,
      useSafety,
      stripManaged: customPrompt.active,
      injectContentMsg,
      everyTurn
    });
    const diagEntry = pushDiag({
      bytes: bodyBuf.length,
      encoding: bodyEncoding,
      model: modelName,
      routedModel: subRoute.matched ? subRoute.targetModel : '',
      routeReason: subRoute.reason || '',
      traj: origTraj.slice(0, 12),
      mode,
      scene,
      isSubagent,
      route: payloadMutatedByCompactor ? `managed-recovery+${compactorDiag}` : 'managed-recovery',
      injectedChars: seatText.length,
      injectPos: injectContentMsg ? (everyTurn ? 'tail-user' : 'head-user') : 'sys-only',
      everyTurn,
      sysParts: sysPartsCount,
      contentsLen
    });

    let primaryRes;
    try {
      primaryRes = await sendUpstream({
        upstream: flowCfg.upstream,
        reqPath,
        headers: req.headers,
        payloadObj: activePayload
      });
    } catch (err) {
      diagEntry.verdict = 'error';
      diagEntry.detail = err.message;
      diagEntry.ms = Date.now() - t0;
      sendSseResult(res, JSON.stringify({ error: { code: 502, message: `[ag-flow] ${err.message}` } }), 502);
      return;
    }

    // Degrade gracefully if upstream rejects safetySettings field
    if (primaryRes.status === 400 && isValidationError(primaryRes.body)) {
      useSafety = false;
      actions.push({ type: 'degrade-no-safety' });
      activePayload = prepareOutboundPayload(workingPayload, {
        flowCfg,
        mode,
        scene,
        seatText,
        useSafety: false,
        stripManaged: customPrompt.active,
        injectContentMsg,
        everyTurn
      });
      primaryRes = await sendUpstream({
        upstream: flowCfg.upstream,
        reqPath,
        headers: req.headers,
        payloadObj: activePayload
      });
    }

    diagEntry.primaryStatus = primaryRes.status;

    if (primaryRes.status === 429) {
      quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
      const qActions = [...actions, { type: 'quota-429' }];
      sessionStore.observeOutcome(origTraj, {
        verdict: 'blocked',
        actions: qActions,
        model: modelName,
        ms: Date.now() - t0,
        detail: '429 quota'
      });
      diagEntry.verdict = 'blocked';
      diagEntry.detail = '429 quota';
      diagEntry.actions = qActions;
      diagEntry.ms = Date.now() - t0;
      emit('outcome', { cascadeId: origTraj, mode, verdict: 'blocked', detail: '429 quota' });
      sendSseResult(res, buildGeminiSse(QUOTA_FALLBACK_TEXT, { finishReason: 'STOP', model: modelName }), 200);
      return;
    }

    if (primaryRes.status === 401 || primaryRes.status === 403) {
      diagEntry.verdict = 'auth-error';
      diagEntry.detail = `HTTP ${primaryRes.status}`;
      diagEntry.ms = Date.now() - t0;
      emit('auth-error', { status: primaryRes.status, cascadeId: origTraj });
      sendSseResult(res, primaryRes.body, primaryRes.status);
      return;
    }

    const emptySse = { text: '', thought: '', finish: '', blockReason: '', error: '', toolCalls: 0, frames: 0, usageMetadata: null };
    const primarySse = primaryRes.status === 200 ? extractSseText(primaryRes.body) : emptySse;
    diagEntry.primaryFinish = primarySse.finish || '';
    if (primarySse.blockReason) diagEntry.primaryBlockReason = primarySse.blockReason;

    // Pass tool-call-only agentic turns straight through untouched
    if (primaryRes.status === 200 && primarySse.toolCalls > 0 && !primarySse.text.trim() && !primarySse.blockReason) {
      const tActions = [...actions, { type: 'tool-pass' }];
      sessionStore.observeOutcome(origTraj, {
        verdict: 'pass',
        actions: tActions,
        model: modelName,
        ms: Date.now() - t0,
        detail: 'tool'
      });
      diagEntry.verdict = 'pass';
      diagEntry.detail = 'tool';
      diagEntry.actions = tActions;
      diagEntry.ms = Date.now() - t0;
      emit('outcome', { cascadeId: origTraj, mode, verdict: 'pass', detail: 'tool' });
      if (flowCfg.compactEnabled && canTrackCompaction) {
        const pt = Number(primarySse?.usageMetadata?.promptTokenCount || 0) || fallbackPromptTokens;
        if (pt > 0 || pendingManualCompactByCid.has(origTraj)) {
          await maybeScheduleAutoCompact(origTraj, pt, modelName, flowCfg, {
            res,
            isSse: String(reqPath || '').includes('streamGenerateContent')
          });
        }
      }
      sendSseResult(res, primaryRes.body, 200);
      return;
    }

    const judge = createUpstreamJudge({
      flowCfg,
      reqPath,
      project: origPayload?.project || ''
    });
    const allowContinue = (mode === 'writing' || mode === 'full') && flowCfg.maxContinuations > 0;
    const allowStaging = (mode === 'writing' || mode === 'full') && flowCfg.refusalRewrite !== false;
    const allowEscalation = mode === 'engineering' || mode === 'full';
    const allowRemap = mode === 'full' && flowCfg.remapEnabled && Boolean(flowCfg.remapTargetModel);

    const makeContinuationTransport = (basePayload) => {
      let contAttempt = 0;
      return async ({ accumulatedText }) => {
        contAttempt += 1;
        emit('recovery-stage', {
          cascadeId: origTraj,
          mode,
          stage: 'continue',
          attempt: contAttempt,
          maxAttempts: flowCfg.maxContinuations
        });
        const contPayload = buildContinuationPayload(basePayload, accumulatedText, flowCfg.continuationText);
        const r = await sendUpstream({
          upstream: flowCfg.upstream,
          reqPath,
          headers: req.headers,
          payloadObj: contPayload
        });
        if (r.status !== 200) throw new Error(`CONT_HTTP_${r.status}`);
        const sse = extractSseText(r.body);
        return { text: sse.text, finishReason: sse.finish || sse.blockReason || 'STOP' };
      };
    };

    const inspectEffectiveRefusal = (sse) => {
      const eff = analyzeDeliverable(sse.text, { scene }).hasDeliverable
        ? sse.text
        : `${sse.text}\n${sse.thought}`.trim();
      return analyzeRefusal(eff, { scene });
    };

    const isRejectedOrEmptySse = (sse, outcome) => {
      if (!sse) return true;
      if (sse.blockReason || outcome === Outcome.FILTER_TRIGGERED || outcome === Outcome.REFUSED) return true;
      if (isPolicyBlockText(sse.text)) return true;
      if (!String(sse.text || '').trim() && sse.toolCalls === 0) return true;
      return inspectEffectiveRefusal(sse).isRefusal;
    };

    const runRecover = async (basePayload, sse) => {
      const effectiveFinish = sse.finish || sse.blockReason || (sse.text.trim() ? 'STOP' : '');
      if (!allowContinue) {
        const ref = inspectEffectiveRefusal(sse);
        const finishOut = classifyFinishReason(effectiveFinish);
        const outcome =
          sse.blockReason || isPolicyBlockText(sse.text) || finishOut === Outcome.FILTER_TRIGGERED
            ? Outcome.FILTER_TRIGGERED
            : ref.isRefusal
              ? Outcome.REFUSED
              : finishOut;
        return { text: sse.text, finishReason: effectiveFinish || 'STOP', outcome, actions: [] };
      }
      const recover = createRecoverer({
        transport: makeContinuationTransport(basePayload),
        judge,
        continuationFrame: flowCfg.continuationText,
        maxContinuations: flowCfg.maxContinuations,
        scene
      });
      const rec = await recover(
        { messages: [{ role: 'user', content: requestText(basePayload) }] },
        { text: sse.text, finishReason: effectiveFinish }
      );
      // Guardrail: never allow an unexpected ABNORMAL judge/transport failure to mask an explicit refusal
      if (rec.outcome === Outcome.ABNORMAL) {
        if (sse.blockReason || isPolicyBlockText(sse.text)) rec.outcome = Outcome.FILTER_TRIGGERED;
        else if (inspectEffectiveRefusal(sse).isRefusal) rec.outcome = Outcome.REFUSED;
      }
      return rec;
    };

    let bestSse = primarySse;
    let bestRaw = primaryRes.body;
    let bestStatus = primaryRes.status;
    let recovered = primaryRes.status === 200
      ? await runRecover(activePayload, primarySse)
      : { text: '', finishReason: 'BLOCKED', outcome: Outcome.FILTER_TRIGGERED, actions: [] };
    actions.push(...recovered.actions);

    const isBadPrimary =
      primaryRes.status !== 200 ||
      isBlockedStatus(primaryRes.status, primaryRes.body) ||
      isRejectedOrEmptySse(primarySse, recovered.outcome);

    let changedByRecovery = recovered.actions.some((a) => a.type === 'continue');
    let finalText = recovered.text;
    let finalFinish = recovered.finishReason || 'STOP';
    let finalOutcome = recovered.outcome;

    // Track A: Keysmith Staging same-model rewrite (writing & full)
    // Always re-inject the active session's system prompt into the retry turn tail regardless of the everyInvocation button state.
    if (isBadPrimary && allowStaging) {
      const stageReason =
        recovered.outcome === Outcome.REFUSED
          ? 'refusal'
          : recovered.outcome === Outcome.FILTER_TRIGGERED || primarySse.blockReason || isPolicyBlockText(primarySse.text)
          ? 'filter'
          : !primarySse.text.trim() && primarySse.toolCalls === 0
          ? 'empty'
          : 'retry';
      const tryStagingOnce = async ({ stripToolsHistory = false } = {}) => {
        const stagedPayload = prepareOutboundPayload(workingPayload, {
          flowCfg,
          mode,
          scene,
          seatText,
          useSafety,
          stripManaged: customPrompt.active,
          injectContentMsg: false,
          everyTurn: false
        });
        const reqObj = stagedPayload.request || stagedPayload;
        if (stripToolsHistory) {
          delete reqObj.tools;
          delete reqObj.toolConfig;
          delete reqObj.tool_config;
        }
        const stagedContents = buildStagedGeminiContents(reqObj.contents || [], {
          frame: flowCfg.outputChannelHardening ? OUTPUT_CHANNEL_FRAME : '',
          lang,
          stripToolsHistory
        });
        if (!stagedContents) return { tried: false, accepted: false, status: 0 };
        reqObj.contents = stagedContents;
        if (seatText) {
          injectProxySystemMessage(stagedPayload, seatText, { everyTurn: true });
        }
        rotateRequestIdentity(stagedPayload);
        emit('recovery-stage', {
          cascadeId: origTraj,
          mode,
          stage: 'staging',
          reason: stageReason,
          cleanHistory: stripToolsHistory
        });
        try {
          const r = await sendUpstream({
            upstream: flowCfg.upstream,
            reqPath,
            headers: req.headers,
            payloadObj: stagedPayload
          });
          if (r.status !== 200) {
            actions.push({ type: 'staging-http-error', status: r.status, cleanHistory: stripToolsHistory });
            log(`[Flow] Track A staging HTTP ${r.status} (clean=${stripToolsHistory}) for ${origTraj.slice(0, 8)}: ${String(r.body || '').slice(0, 180)}`);
            return { tried: true, accepted: false, status: r.status };
          }
          const sse = extractSseText(r.body);
          const stRec = await runRecover(stagedPayload, sse);
          const rejected = isRejectedOrEmptySse(
            { ...sse, text: stRec.text },
            stRec.outcome
          );
          if (!rejected) {
            actions.push({ type: 'staging-rewrite', cleanHistory: stripToolsHistory }, ...stRec.actions);
            finalText = stRec.text;
            finalFinish = stRec.finishReason || 'STOP';
            finalOutcome = stRec.outcome;
            bestSse = sse;
            bestRaw = r.body;
            bestStatus = 200;
            changedByRecovery = true;
            return { tried: true, accepted: true, status: 200 };
          }
          actions.push({ type: 'staging-rewrite-failed', cleanHistory: stripToolsHistory });
          return { tried: true, accepted: false, status: 200 };
        } catch (err) {
          actions.push({ type: 'staging-error', message: err.message, cleanHistory: stripToolsHistory });
          log(`[Flow] Track A staging error for ${origTraj.slice(0, 8)}: ${err.message}`);
          return { tried: true, accepted: false, status: 0 };
        }
      };

      const st1 = await tryStagingOnce({ stripToolsHistory: false });
      // Fallback: if full history + tools failed with HTTP 400 or still rejected on an agentic chain, retry with stripped clean text history
      if (!st1.accepted && (st1.status === 400 || hasToolsDeclared)) {
        await tryStagingOnce({ stripToolsHistory: true });
      }
    }

    // Track B: Escalation ladder + softening + context narrowing (engineering & full)
    const stillBad =
      bestStatus !== 200 ||
      isRejectedOrEmptySse({ ...bestSse, text: finalText }, finalOutcome);

    if (stillBad && allowEscalation) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const rungText = escalationFor(attempt, lang);
        const escPayload = prepareOutboundPayload(workingPayload, {
          flowCfg,
          mode,
          scene,
          seatText,
          useSafety,
          rung: rungText,
          stripManaged: customPrompt.active,
          injectContentMsg: false,
          everyTurn: false
        });
        if (flowCfg.softenEnabled) softenRequest(escPayload);
        if (attempt >= 2) {
          const nr = narrowContext(escPayload, { keepTurns: 2, toolResultChars: 800, maxContents: 30 });
          if (nr.aborted) {
            const escReq = escPayload.request || escPayload;
            delete escReq.tools;
            delete escReq.toolConfig;
            delete escReq.tool_config;
            const cleanStaged = buildStagedGeminiContents(escReq.contents || [], { lang, stripToolsHistory: true });
            if (cleanStaged) escReq.contents = cleanStaged;
          }
          rotateRequestIdentity(escPayload);
        }
        // Force tail re-injection AFTER softening/narrowContext so long-context truncation never strips the session prompt
        const retryBlock = [seatText, rungText].filter(Boolean).join('\n\n');
        if (retryBlock) {
          injectProxySystemMessage(escPayload, retryBlock, { everyTurn: true });
        }
        const escReason =
          finalOutcome === Outcome.REFUSED
            ? 'refusal'
            : finalOutcome === Outcome.FILTER_TRIGGERED || bestSse.blockReason || isPolicyBlockText(finalText)
            ? 'filter'
            : 'empty';
        emit('recovery-stage', {
          cascadeId: origTraj,
          mode,
          stage: 'soft-retry',
          attempt,
          maxAttempts: 2,
          reason: escReason
        });
        try {
          const r = await sendUpstream({
            upstream: flowCfg.upstream,
            reqPath,
            headers: req.headers,
            payloadObj: escPayload
          });
          if (r.status !== 200) {
            actions.push({ type: 'escalate-http-error', attempt, status: r.status });
            log(`[Flow] Track B attempt ${attempt} HTTP ${r.status} for ${origTraj.slice(0, 8)}: ${String(r.body || '').slice(0, 180)}`);
            continue;
          }
          const sse = extractSseText(r.body);
          const ref = inspectEffectiveRefusal(sse);
          if (!sse.blockReason && !isPolicyBlockText(sse.text) && !ref.isRefusal && sse.text.trim()) {
            const escRec = allowContinue
              ? await runRecover(escPayload, sse)
              : { text: sse.text, finishReason: sse.finish || 'STOP', outcome: Outcome.OK, actions: [] };
            if (!isRejectedOrEmptySse({ ...sse, text: escRec.text }, escRec.outcome)) {
              actions.push({ type: 'escalate-retry', attempt }, ...escRec.actions);
              finalText = escRec.text;
              finalFinish = escRec.finishReason || 'STOP';
              finalOutcome = escRec.outcome;
              bestSse = sse;
              bestRaw = r.body;
              bestStatus = 200;
              changedByRecovery = true;
              break;
            }
          }
          actions.push({ type: 'escalate-retry-failed', attempt });
        } catch (err) {
          actions.push({ type: 'escalate-error', attempt, message: err?.message || 'error' });
          log(`[Flow] Track B attempt ${attempt} error for ${origTraj.slice(0, 8)}: ${err?.message || err}`);
        }
      }
    }

    // Track C: Optional fallback model remap (full mode only)
    const stillBadAfterEsc =
      bestStatus !== 200 ||
      isRejectedOrEmptySse({ ...bestSse, text: finalText }, finalOutcome);

    if (stillBadAfterEsc && allowRemap) {
      const remapPayload = prepareOutboundPayload(workingPayload, {
        flowCfg,
        mode,
        scene,
        seatText,
        useSafety,
        stripManaged: customPrompt.active,
        injectContentMsg: Boolean(seatText),
        everyTurn: true
      });
      remapPayload.model = flowCfg.remapTargetModel;
      rotateRequestIdentity(remapPayload);
      emit('recovery-stage', { cascadeId: origTraj, mode, stage: 'remap', targetModel: flowCfg.remapTargetModel });
      try {
        const r = await sendUpstream({
          upstream: flowCfg.upstream,
          reqPath,
          headers: req.headers,
          payloadObj: remapPayload
        });
        if (r.status !== 200) {
          actions.push({ type: 'remap-http-error', status: r.status, targetModel: flowCfg.remapTargetModel });
          log(`[Flow] Track C remap HTTP ${r.status} (${flowCfg.remapTargetModel}) for ${origTraj.slice(0, 8)}`);
        } else {
          const sse = extractSseText(r.body);
          const ref = inspectEffectiveRefusal(sse);
          if (sse.text.trim() && !sse.blockReason && !isPolicyBlockText(sse.text) && !ref.isRefusal) {
            actions.push({ type: 'model-remap', targetModel: flowCfg.remapTargetModel });
            finalText = sse.text;
            finalFinish = sse.finish || 'STOP';
            finalOutcome = Outcome.OK;
            bestSse = sse;
            bestRaw = r.body;
            bestStatus = 200;
            changedByRecovery = true;
          } else {
            actions.push({ type: 'remap-rejected', targetModel: flowCfg.remapTargetModel });
          }
        }
      } catch (err) {
        actions.push({ type: 'remap-error', message: err?.message || 'error' });
        log(`[Flow] Track C remap error for ${origTraj.slice(0, 8)}: ${err?.message || err}`);
      }
    }

    // Compute concise verdict for UI status indicator
    let verdict = 'pass';
    let detail = 'OK';
    if (actions.some((a) => a.type === 'staging-rewrite')) {
      verdict = 'staged';
      detail = '拒答已重试通过';
    } else if (actions.some((a) => a.type === 'continue')) {
      const contCount = actions.filter((a) => a.type === 'continue').length;
      verdict = 'continued';
      detail = `自动续写 ×${contCount}`;
    } else if (actions.some((a) => a.type === 'model-remap')) {
      verdict = 'staged';
      detail = `已切备用模型 ${flowCfg.remapTargetModel}`;
    } else if (actions.some((a) => a.type === 'escalate-retry')) {
      verdict = 'staged';
      detail = '改写措辞重试通过';
    } else if (finalOutcome === Outcome.REFUSED) {
      verdict = 'refused';
      detail = '被拒';
    } else if (finalOutcome === Outcome.FILTER_TRIGGERED || bestSse.blockReason || isPolicyBlockText(finalText)) {
      verdict = 'blocked';
      detail = '上游拦截';
    } else if (!finalText.trim()) {
      verdict = 'empty';
      detail = '空响应';
    }

    const totalMs = Date.now() - t0;
    diagEntry.verdict = verdict;
    diagEntry.detail = detail;
    diagEntry.seatScene = seatScene;
    diagEntry.actions = actions.slice(-8);
    diagEntry.ms = totalMs;
    if (verdict !== 'pass' || actions.length > 0) {
      log(
        `[Flow] ${origTraj.slice(0, 8)} (${mode}/${modelName}) -> ${verdict} [${detail}] actions=${actions.map((a) => a.type).join(',') || 'none'} (${totalMs}ms)`
      );
    }

    sessionStore.observeOutcome(origTraj, {
      verdict,
      actions,
      model: modelName,
      ms: totalMs,
      detail
    });
    emit('outcome', { cascadeId: origTraj, mode, verdict, detail, actions, ms: totalMs });

    if (flowCfg.compactEnabled && canTrackCompaction) {
      const pt = Number(bestSse?.usageMetadata?.promptTokenCount || 0) || fallbackPromptTokens;
      if (pt > 0 || pendingManualCompactByCid.has(origTraj)) {
        await maybeScheduleAutoCompact(origTraj, pt, modelName, flowCfg, {
          res,
          isSse: String(reqPath || '').includes('streamGenerateContent')
        });
      }
    }

    // Prevent upstream filter text from entering client history and poisoning subsequent turns
    if (isPolicyBlockText(finalText) || (verdict === 'blocked' && !String(finalText || '').trim())) {
      sendSseResult(res, buildGeminiSse(BLOCK_FALLBACK_TEXT, { finishReason: 'STOP', model: modelName }), 200);
      return;
    }

    if (changedByRecovery && finalText) {
      const built = buildGeminiSse(finalText, {
        finishReason: finalFinish === 'MAX_TOKENS' ? 'MAX_TOKENS' : 'STOP',
        model: modelName,
        usageMetadata: bestSse.usageMetadata
      });
      sendSseResult(res, built, 200);
      return;
    }

    sendSseResult(res, bestRaw, bestStatus);
  }

  async function runCompactionAndEmit(cascadeId, flowCfg, { reason = 'auto', promptTokens = 0 } = {}) {
    emit('compact-start', { cascadeId, reason, promptTokens });
    let res;
    try {
      res = await compactor.runCompaction(cascadeId, {
        sendUpstream,
        upstream: flowCfg.upstream,
        authHeaders: lastAuthHeaders,
        compactModel: flowCfg.compactModel,
        keepTailTokens: flowCfg.compactKeepTailTokens,
        reason
      });
    } catch (err) {
      const msg = err?.message || String(err || 'compaction_error');
      emit('compact', { cascadeId, reason, ok: false, error: msg });
      return { ok: false, error: msg };
    }
    if (!res?.ok) {
      log(`[FlowCompactor] ${reason === 'manual' ? 'Manual' : 'Auto'} compaction skipped/failed for ${String(cascadeId).slice(0, 8)}: ${res?.error || 'unknown'}`);
    }
    if (res?.ok || res?.error !== 'compaction_in_flight') {
      emit('compact', { cascadeId, reason, ...res });
    }
    return res;
  }

  async function maybeScheduleAutoCompact(
    cascadeId,
    promptTokenCount,
    model,
    flowCfg,
    { res = null, isSse = true, hasContentLength = false } = {}
  ) {
    if (!cascadeId || !flowCfg?.compactEnabled || !lastAuthHeaders) return null;
    const manualWaiters = pendingManualCompactByCid.get(cascadeId) || null;
    const isManualPending = Boolean(manualWaiters && manualWaiters.length > 0);
    if (isManualPending) pendingManualCompactByCid.delete(cascadeId);

    const contextWindow = typeof getContextWindow === 'function' ? Number(getContextWindow(cascadeId, model) || 0) : 0;
    const shouldAuto =
      !isManualPending &&
      compactor.shouldAutoCompact(cascadeId, {
        promptTokenCount,
        model,
        contextWindow,
        thresholdPct: flowCfg.compactThresholdPct,
        keepTailTokens: flowCfg.compactKeepTailTokens
      });

    if (!isManualPending && !shouldAuto) return null;

    const reason = isManualPending ? 'manual' : 'auto';
    log(
      `[FlowCompactor] Running ${reason} compaction inside turn stream for ${String(cascadeId).slice(0, 8)} (promptTokens=${promptTokenCount}, window=${contextWindow || 'est'})`
    );

    const runTask = () => runCompactionAndEmit(cascadeId, flowCfg, { reason, promptTokens: promptTokenCount });
    const out = res
      ? await runWithSseKeepalive(res, { isSse, hasContentLength, headerDelayMs: 0 }, runTask)
      : await runTask();

    if (manualWaiters) {
      for (const resolveWaiter of manualWaiters) {
        try {
          resolveWaiter({ handledInStream: true, result: out });
        } catch {}
      }
    }
    return out;
  }

  async function compactNow(cascadeId) {
    const flowCfg = normalizeFlowConfig(getConfig());
    if (!lastAuthHeaders) {
      emit('compact', { cascadeId, reason: 'manual', ok: false, error: 'no_auth_headers' });
      return { ok: false, error: 'no_auth_headers' };
    }

    // If a model turn is currently active for this cascadeId, serialize compaction at the
    // end of that turn's HTTP stream so language_server waits cleanly before tool execution.
    const activeSet = cascadeId ? activeTurnsByCid.get(cascadeId) : null;
    if (activeSet && activeSet.size > 0) {
      log(`[FlowCompactor] Turn in progress for ${String(cascadeId).slice(0, 8)}; queuing manual compaction into stream gate`);
      emit('compact-start', { cascadeId, reason: 'manual' });
      const streamHook = await new Promise((resolve) => {
        const list = pendingManualCompactByCid.get(cascadeId) || [];
        list.push(resolve);
        pendingManualCompactByCid.set(cascadeId, list);
      });
      if (streamHook?.handledInStream && streamHook.result) {
        return streamHook.result;
      }
    }

    // Check if language_server itself is still finishing a tool step; if so, any subsequent
    // GenerateContent turn will block on compactor.awaitInFlight() inside handleGenerateContent.
    try {
      await isCascadeBusy(cascadeId);
    } catch {}

    return await runCompactionAndEmit(cascadeId, flowCfg, { reason: 'manual' });
  }

  function clearCompaction(cascadeId) {
    return compactor.clearCompaction(cascadeId);
  }

  function getCompactionStatus(cascadeId) {
    return compactor.getStatus(cascadeId);
  }

  async function callUtilityModel(
    prompt,
    { model = 'gemini-3.5-flash-lite', maxOutputTokens = 64, timeoutMs = 15000 } = {}
  ) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt || !lastAuthHeaders) return '';
    const flowCfg = normalizeFlowConfig(getConfig());
    const utilityPayload = {
      project: 'aicode-consumers',
      requestId: `ag-flow-util-${Date.now()}`,
      model: model || 'gemini-3.5-flash-lite',
      request: {
        contents: [{ role: 'user', parts: [{ text: cleanPrompt }] }],
        generationConfig: { maxOutputTokens, temperature: 0.2 }
      }
    };
    try {
      const r = await sendUpstream({
        upstream: flowCfg.upstream,
        reqPath: '/v1internal:streamGenerateContent?alt=sse',
        headers: lastAuthHeaders,
        payloadObj: utilityPayload,
        useHttp2: false,
        timeoutMs
      });
      if (r.status !== 200) return '';
      return extractSseText(r.body).text.trim();
    } catch {
      return '';
    }
  }

  const server = http.createServer((req, res) => {
    try {
      req.socket?.setKeepAlive?.(true, 15_000);
    } catch {}
    const chunks = [];
    req.on('error', (err) => log(`[Flow] req error: ${err.message}`));
    req.on('data', (c) => chunks.push(c));
    res.on('error', (err) => log(`[Flow] res error: ${err.message}`));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const reqPath = normalizeV1Path(req.url || '/');
      if (req.headers.authorization) {
        lastAuthHeaders = { ...req.headers };
      }
      if (req.method === 'GET' && reqPath === '/ag-flow/health') {
        const cfg = normalizeFlowConfig(getConfig());
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            port: cfg.port,
            defaultMode: cfg.defaultMode,
            quotaCooldownMs: Math.max(0, quotaCooldownUntil - Date.now())
          })
        );
        return;
      }
      if (req.method === 'GET' && reqPath === '/ag-flow/diag') {
        const mains = (typeof getActiveMainSessions === 'function' ? getActiveMainSessions() || [] : []).filter(Boolean);
        const tracked = typeof compactor.listTrackedCids === 'function' ? compactor.listTrackedCids() : [];
        const diagCids = Array.from(new Set([...mains, ...tracked])).slice(0, 16);
        const compactions = {};
        for (const cid of diagCids) {
          compactions[String(cid).slice(0, 12)] = compactor.getStatus(cid);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            h2Degraded: h2ConsecutiveFails >= 3,
            quotaCooldownMs: Math.max(0, quotaCooldownUntil - Date.now()),
            activeMainIds: mains.map((id) => String(id).slice(0, 12)),
            compactions,
            recent: recentDiag.slice(-15)
          })
        );
        return;
      }
      if (req.method === 'POST' && reqPath.includes('GenerateContent')) {
        void handleGenerateContent(req, res, bodyBuf, reqPath).catch((err) => {
          log(`[Flow] handleGenerateContent unhandled error (degrading to passthrough): ${err?.message || err}`);
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            try {
              const cfg = normalizeFlowConfig(getConfig());
              pipePassThrough(req, res, bodyBuf, cfg.upstream, reqPath);
            } catch (passErr) {
              if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
              if (!res.writableEnded) {
                res.end(JSON.stringify({ error: { code: 502, message: passErr?.message || 'proxy fallback failed' } }));
              }
            }
          }
        });
        return;
      }
      const cfg = normalizeFlowConfig(getConfig());
      pipePassThrough(req, res, bodyBuf, cfg.upstream, reqPath);
    });
  });

  // Harden Node.js HTTP server timeouts for long-running agentic streams & persistent keep-alive
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  server.on('close', () => {
    try {
      httpAgent.destroy();
    } catch {}
    try {
      httpsAgent.destroy();
    } catch {}
  });

  return {
    server,
    callUtilityModel,
    compactNow,
    clearCompaction,
    getCompactionStatus,
    getHealth: () => ({
      listening: Boolean(server.listening),
      quotaCooldownMs: Math.max(0, quotaCooldownUntil - Date.now()),
      hasAuthCache: Boolean(lastAuthHeaders),
      h2Degraded: h2ConsecutiveFails >= 3
    })
  };
}

export function createFlowProxyController({
  getConfig,
  getSystemPrompt = () => null,
  getSubagentRouting = () => null,
  getActiveMainSessions = () => [],
  resolveCascadeId = (id) => id,
  getContextWindow = () => 0,
  isCascadeBusy = async () => false,
  sessionStore,
  compactionDir = '',
  onEvent = null,
  onMainTurn = null,
  log = () => {}
} = {}) {
  let activeServer = null;
  let activePort = 0;
  let activeApi = null;
  let lastError = '';
  let starting = false;
  let desiredEnabled = false;
  let manualStopping = false;
  let healTimer = null;
  let healAttempts = 0;

  function clearHealTimer() {
    if (healTimer) {
      clearTimeout(healTimer);
      healTimer = null;
    }
  }

  function scheduleSelfHeal() {
    if (manualStopping || !desiredEnabled || healTimer) return;
    const delayMs = [1000, 2000, 5000][Math.min(healAttempts, 2)];
    healAttempts += 1;
    log(`[Flow] Proxy closed unexpectedly; scheduling self-heal restart in ${delayMs}ms`);
    healTimer = setTimeout(() => {
      healTimer = null;
      if (!manualStopping && desiredEnabled) {
        void syncState({ enabled: true });
      }
    }, delayMs);
    if (typeof healTimer.unref === 'function') healTimer.unref();
  }

  async function stop() {
    manualStopping = true;
    clearHealTimer();
    const srv = activeServer;
    activeServer = null;
    activeApi = null;
    activePort = 0;
    if (!srv) return;
    await new Promise((resolve) => {
      try {
        srv.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async function syncState({ enabled = false } = {}) {
    desiredEnabled = Boolean(enabled);
    const flowCfg = normalizeFlowConfig(getConfig());
    if (!enabled) {
      await stop();
      lastError = '';
      return getStatus();
    }
    if (activeServer && activeServer.listening && activePort === flowCfg.port) {
      return getStatus();
    }
    if (starting) return getStatus();
    starting = true;
    try {
      await stop();
      manualStopping = false;
      const created = createFlowProxyServer({
        getConfig,
        getSystemPrompt,
        getSubagentRouting,
        getActiveMainSessions,
        resolveCascadeId,
        getContextWindow,
        isCascadeBusy,
        sessionStore,
        compactionDir,
        onEvent,
        onMainTurn,
        log
      });
      await new Promise((resolve, reject) => {
        created.server.once('error', reject);
        created.server.listen(flowCfg.port, '127.0.0.1', () => {
          created.server.off('error', reject);
          resolve();
        });
      });
      activeServer = created.server;
      activeApi = created;
      activePort = flowCfg.port;
      lastError = '';
      healAttempts = 0;
      created.server.on('error', (err) => {
        lastError = err?.message || String(err || 'server error');
        log(`[Flow] Proxy server runtime error: ${lastError}`);
      });
      created.server.on('close', () => {
        if (activeServer === created.server) {
          activeServer = null;
          activeApi = null;
          activePort = 0;
          if (!manualStopping && desiredEnabled) {
            scheduleSelfHeal();
          }
        }
      });
      log(`[Flow] Local proxy listening on http://127.0.0.1:${activePort}`);
    } catch (err) {
      lastError = err?.message || String(err || 'listen failed');
      log(`[Flow] Failed to start proxy: ${lastError}`);
      await stop();
      if (desiredEnabled) {
        manualStopping = false;
        scheduleSelfHeal();
      }
    } finally {
      starting = false;
    }
    return getStatus();
  }

  function getStatus() {
    const flowCfg = normalizeFlowConfig(getConfig());
    const health = activeApi ? activeApi.getHealth() : { listening: false, quotaCooldownMs: 0, hasAuthCache: false, h2Degraded: false };
    return {
      running: Boolean(activeServer && activeServer.listening),
      port: activePort || flowCfg.port,
      error: lastError,
      ...health
    };
  }

  async function callUtilityModel(prompt, opts) {
    if (!activeApi || typeof activeApi.callUtilityModel !== 'function') return '';
    return await activeApi.callUtilityModel(prompt, opts);
  }

  async function compactNow(cascadeId) {
    if (!activeApi || typeof activeApi.compactNow !== 'function') {
      return { ok: false, error: 'proxy_not_running' };
    }
    return await activeApi.compactNow(cascadeId);
  }

  function clearCompaction(cascadeId) {
    if (!activeApi || typeof activeApi.clearCompaction !== 'function') {
      return { ok: false, error: 'proxy_not_running' };
    }
    return activeApi.clearCompaction(cascadeId);
  }

  function getCompactionStatus(cascadeId) {
    if (!activeApi || typeof activeApi.getCompactionStatus !== 'function') {
      return { active: false, count: 0, inFlight: false, hasSnapshot: false };
    }
    return activeApi.getCompactionStatus(cascadeId);
  }

  return { syncState, stop, getStatus, callUtilityModel, compactNow, clearCompaction, getCompactionStatus };
}
