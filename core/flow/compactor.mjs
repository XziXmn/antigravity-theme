/**
 * core/flow/compactor.mjs — Codex CLI-Style Virtual Sliding Context Compactor
 *
 * Implements openai/codex-style handoff compaction inside the local Flow Proxy:
 *   1. Keeps the most recent <= keepTailTokens (default 20k) verbatim, always snapping the
 *      cut point to a pure user message (never splitting functionCall/functionResponse pairs).
 *   2. Summarizes older history with tools stripped (preventing tool-call errors during compaction)
 *      and injects a first-person continuation anchor (avoiding the "Another language model" paradox).
 *   3. Persists per-conversation snapshots atomically to user/flow-compactions/<cid>.json and
 *      rolls back atomically on non-200 / empty / truncated / refused summary responses.
 *   4. Hijacks and slims down Antigravity's native Checkpoint compaction requests when enabled.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractSseText } from './purify.mjs';
import { analyzeRefusal, isPolicyBlockText } from './detect.mjs';

export const CODEX_COMPACTION_MARKER = '[CODEX_VIRTUAL_COMPACTION_V1]';

const HANDOFF_PREFIX =
  '以下是我自己早先在本会话中已完成工作的结构化交接摘要（作为连续上下文起点；若后续原文尾部仍有最新细节，以最新消息与实际文件为准）：\n\n';

const COMPACT_INSTRUCTION = [
  '请将上述较早的对话历史压缩为一份高密度、第一人称视角的工程交接摘要（Handoff Summary），以便后续无缝接力继续执行。',
  '要求：',
  '1. 严格使用以下结构输出（无需寒暄或免责声明）：',
  '   - **当前目标与用户约束**：用户最终要求、硬性限制与偏好。',
  '   - **已验证事实与完成进度**：已修改/创建的文件精确路径、关键符号名、已验证通过或失败的测试与命令输出。',
  '   - **关键技术决策与避坑**：已定位的根因、放弃的方案及原因。',
  '   - **待完成下一步**：尚未完成的具体步骤与当前阻塞点。',
  '2. 保留所有精确文件路径、命令、报错原文、数字和代码标识符，不要笼统概括。',
  '3. 只陈述对话中实际出现过的内容，绝不编造未验证的结果。'
].join('\n');

const NATIVE_COMPACT_RE =
  /\b(?:conversation checkpoint|compact the conversation|create a checkpoint|context summary|summarize the conversation|previous session summary|conversation summary|handoff summary)\b|<CONTEXT_SUMMARY>/i;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

export function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjkMatches = s.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const asciiCount = Math.max(0, s.length - cjkCount);
  return Math.ceil(cjkCount / 1.5 + asciiCount / 4);
}

export function estimateContentTokens(content) {
  if (!content || !Array.isArray(content.parts)) return 4;
  let total = 4;
  for (const p of content.parts) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') total += estimateTextTokens(p.text);
    if (typeof p.thought === 'string') total += estimateTextTokens(p.thought);
    const fc = p.functionCall || p.function_call;
    if (fc) {
      try {
        total += Math.ceil(JSON.stringify(fc).length / 3.5);
      } catch {
        total += 64;
      }
    }
    const fr = p.functionResponse || p.function_response;
    if (fr) {
      try {
        total += Math.ceil(JSON.stringify(fr).length / 3.5);
      } catch {
        total += 128;
      }
    }
    if (p.inlineData || p.inline_data || p.fileData || p.file_data) {
      total += 1200;
    }
  }
  return total;
}

export function estimateModelContextWindow(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (!m) return 256000;
  if (/claude/.test(m)) return 200000;
  if (/gpt-oss|gpt-4o|o1|o3|o4/.test(m)) return 128000;
  if (/gemini-4|neon|hydrogen|carbon|argon/.test(m)) return 512000;
  if (/gemini-3|gemini-2\.5|flash|pro/.test(m)) {
    return 1000000;
  }
  return 256000;
}

export function estimatePayloadTokens(payload) {
  const reqObj = payload?.request || payload || {};
  let total = 0;
  const sys = reqObj.systemInstruction || reqObj.system_instruction;
  if (sys && Array.isArray(sys.parts)) {
    total += estimateContentTokens({ role: 'user', parts: sys.parts });
  }
  const contents = Array.isArray(reqObj.contents) ? reqObj.contents : [];
  for (const c of contents) {
    total += estimateContentTokens(c);
  }
  return total;
}

export function isToolResponseTurn(content) {
  if (!content || content.role !== 'user' || !Array.isArray(content.parts)) return false;
  return content.parts.some((p) => Boolean(p && (p.functionResponse || p.function_response)));
}

export function isToolCallTurn(content) {
  if (!content || content.role !== 'model' || !Array.isArray(content.parts)) return false;
  return content.parts.some((p) => Boolean(p && (p.functionCall || p.function_call)));
}

export function contentFingerprint(content) {
  if (!content || typeof content !== 'object') return '';
  const role = String(content.role || '');
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const snippet = parts
    .map((p) => {
      if (!p || typeof p !== 'object') return '';
      if (typeof p.text === 'string') return p.text.slice(0, 512);
      const fc = p.functionCall || p.function_call;
      if (fc?.name) return `fc:${fc.name}`;
      const fr = p.functionResponse || p.function_response;
      if (fr?.name) return `fr:${fr.name}`;
      return '';
    })
    .filter(Boolean)
    .join('|')
    .slice(0, 512);
  return crypto.createHash('sha256').update(`${role}:${snippet}`).digest('hex').slice(0, 16);
}

export function splitHistoryForCodexCompact(contents, { keepTailTokens = 20000, allowAdaptive = false } = {}) {
  const list = Array.isArray(contents) ? contents : [];
  if (list.length < (allowAdaptive ? 4 : 6)) {
    return { canCompact: false, reason: 'too_few_turns' };
  }

  const tokenList = list.map((c) => estimateContentTokens(c));
  const totalTokens = tokenList.reduce((a, b) => a + b, 0);

  const trySplit = (targetKeepTail, minSplitIdx, minHeadTokens) => {
    let tailTokens = 0;
    let rawStart = list.length - 1;

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const t = tokenList[i];
      if (i < list.length - 1 && tailTokens + t > targetKeepTail) {
        rawStart = i + 1;
        break;
      }
      tailTokens += t;
      rawStart = i;
    }

    // Snap forward/backward to a pure user turn (not a functionResponse, and not right after an unclosed functionCall)
    const isSafeUserAnchor = (idx) => {
      if (idx < minSplitIdx || idx >= list.length) return false;
      const cur = list[idx];
      if (!cur || cur.role !== 'user' || isToolResponseTurn(cur)) return false;
      if (idx > 0 && isToolCallTurn(list[idx - 1])) return false;
      return true;
    };

    // Fallback anchor for long agentic tool-call chains: model turn right after a user turn, keeping every functionCall/functionResponse pair intact
    const isSafeModelAnchor = (idx) => {
      if (idx < minSplitIdx || idx >= list.length) return false;
      const cur = list[idx];
      const prev = list[idx - 1];
      if (!cur || cur.role !== 'model') return false;
      if (!prev || prev.role !== 'user') return false;
      return true;
    };

    const findAnchor = (predicate) => {
      for (let idx = rawStart; idx < list.length; idx += 1) {
        if (predicate(idx)) return idx;
      }
      for (let idx = rawStart - 1; idx >= minSplitIdx; idx -= 1) {
        if (predicate(idx)) return idx;
      }
      return -1;
    };

    let splitIdx = findAnchor(isSafeUserAnchor);
    let anchorMode = 'user';

    const userTailTokens = splitIdx >= minSplitIdx ? tokenList.slice(splitIdx).reduce((a, b) => a + b, 0) : Infinity;
    const excessiveTailLimit = Math.max(targetKeepTail * 2.5, 48000);
    if (splitIdx < minSplitIdx || userTailTokens > excessiveTailLimit) {
      const modelIdx = findAnchor(isSafeModelAnchor);
      if (modelIdx >= minSplitIdx) {
        const modelHeadTokens = tokenList.slice(0, modelIdx).reduce((a, b) => a + b, 0);
        const modelTailTokens = tokenList.slice(modelIdx).reduce((a, b) => a + b, 0);
        if (modelHeadTokens >= minHeadTokens && (splitIdx < minSplitIdx || modelTailTokens <= userTailTokens * 0.8)) {
          splitIdx = modelIdx;
          anchorMode = 'model';
        }
      }
    }

    if (splitIdx < minSplitIdx) {
      return { canCompact: false, reason: 'no_safe_split_point' };
    }

    const head = list.slice(0, splitIdx);
    const tail = list.slice(splitIdx);
    const headTokens = tokenList.slice(0, splitIdx).reduce((a, b) => a + b, 0);
    const finalTailTokens = tokenList.slice(splitIdx).reduce((a, b) => a + b, 0);

    if (headTokens < minHeadTokens) {
      return { canCompact: false, reason: 'head_too_small' };
    }

    return {
      canCompact: true,
      splitIdx,
      anchorMode,
      head,
      tail,
      headTokens,
      tailTokens: finalTailTokens,
      anchorFingerprint: contentFingerprint(list[splitIdx])
    };
  };

  let res = list.length >= 6 ? trySplit(keepTailTokens, 4, 800) : { canCompact: false, reason: 'too_few_turns' };
  if (!res.canCompact && allowAdaptive && list.length >= 4 && totalTokens >= 1200) {
    const adaptiveTail = Math.min(keepTailTokens, Math.max(1200, Math.floor(totalTokens * 0.35)));
    res = trySplit(adaptiveTail, 2, 400);
  }
  return res;
}

export function isNativeCompactionRequest(payload) {
  const reqObj = payload?.request || payload || {};
  const contents = Array.isArray(reqObj.contents) ? reqObj.contents : [];
  if (contents.length === 0) return false;
  const hasTools = Array.isArray(reqObj.tools) && reqObj.tools.length > 0;
  if (hasTools) return false;

  const sysParts = Array.isArray((reqObj.systemInstruction || reqObj.system_instruction)?.parts)
    ? (reqObj.systemInstruction || reqObj.system_instruction).parts
    : [];
  const sysText = sysParts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n').slice(0, 4000);
  const tail = contents[contents.length - 1];
  const fullTailText = Array.isArray(tail?.parts)
    ? tail.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
    : '';
  const tailText =
    fullTailText.length > 6000
      ? `${fullTailText.slice(0, 4000)}\n${fullTailText.slice(-2000)}`
      : fullTailText;
  const combined = `${sysText}\n${tailText}`;

  // Exclude safety monitors & short conversation title generators
  if (
    /\b(?:severe_internal_risks|sir_flash_lite|safety monitor|evaluate whether the trajectory)\b/i.test(combined) ||
    /\b(?:generate (?:a )?(?:short |concise |brief )?title|conversation title|title for this (?:conversation|chat|thread)|name this (?:conversation|chat))\b/i.test(
      combined
    )
  ) {
    return false;
  }

  if (!NATIVE_COMPACT_RE.test(sysText) && !NATIVE_COMPACT_RE.test(tailText)) {
    return false;
  }
  return contents.length >= 2 || /<CONTEXT_SUMMARY>/i.test(combined) || fullTailText.length >= 4000;
}

function slimPartsForSummary(parts) {
  if (!Array.isArray(parts)) return [];
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.inlineData || p.inline_data || p.fileData || p.file_data) {
      out.push({ text: '[媒体附件已省略]' });
      continue;
    }
    const fr = p.functionResponse || p.function_response;
    if (fr) {
      let serialized = '';
      try {
        serialized = JSON.stringify(fr.response ?? fr);
      } catch {
        serialized = String(fr.name || 'tool');
      }
      if (serialized.length > 2400) {
        out.push({ text: `[工具 ${fr.name || 'tool'} 返回 ${serialized.length} 字符，节选]: ${serialized.slice(0, 1200)} ... ${serialized.slice(-400)}` });
      } else {
        out.push({ text: `[工具 ${fr.name || 'tool'} 返回]: ${serialized}` });
      }
      continue;
    }
    const fc = p.functionCall || p.function_call;
    if (fc) {
      let argsStr = '';
      try {
        argsStr = JSON.stringify(fc.args || {});
      } catch {}
      out.push({ text: `[调用工具 ${fc.name || 'tool'}(${argsStr.slice(0, 600)})]` });
      continue;
    }
    if (typeof p.text === 'string' && p.text.trim()) {
      out.push({ text: p.text.length > 12000 ? `${p.text.slice(0, 9000)}\n...[已省略 ${p.text.length - 10500} 字符]...\n${p.text.slice(-1500)}` : p.text });
    }
  }
  return out.length > 0 ? out : [{ text: '[空轮次]' }];
}

export function rewriteNativeCompactionRequest(payload) {
  const next = structuredClone(payload);
  const reqObj = next.request || next;
  delete reqObj.tools;
  delete reqObj.toolConfig;
  delete reqObj.tool_config;

  if (Array.isArray(reqObj.contents)) {
    reqObj.contents = reqObj.contents.map((c, idx) => {
      if (idx === reqObj.contents.length - 1) return c;
      return {
        role: c?.role === 'model' ? 'model' : 'user',
        parts: slimPartsForSummary(c?.parts)
      };
    });
    const last = reqObj.contents[reqObj.contents.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.parts)) {
      last.parts.push({ text: `\n\n[Codex 精简压缩规范]\n${COMPACT_INSTRUCTION}` });
    }
  }
  return next;
}

function mergeConsecutiveRoles(turns) {
  const out = [];
  for (const c of Array.isArray(turns) ? turns : []) {
    const role = c?.role === 'model' ? 'model' : 'user';
    const parts = Array.isArray(c?.parts) && c.parts.length > 0 ? c.parts : [{ text: '[空轮次]' }];
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      out.push({ role, parts: [...parts] });
    }
  }
  return out;
}

export function buildCompactionSummaryPayload(basePayload, headContents, { compactModel = '' } = {}) {
  const srcReq = basePayload?.request || basePayload || {};
  const model = compactModel || String(basePayload?.model || srcReq.model || 'gemini-3.8-flash-low');
  const slimmedHistory = (Array.isArray(headContents) ? headContents : []).map((c) => ({
    role: c?.role === 'model' ? 'model' : 'user',
    parts: slimPartsForSummary(c?.parts)
  }));
  slimmedHistory.push({
    role: 'user',
    parts: [{ text: COMPACT_INSTRUCTION }]
  });

  return {
    project: basePayload?.project || 'aicode-consumers',
    requestId: `ag-codex-compact-${Date.now()}`,
    model,
    request: {
      systemInstruction: {
        role: 'user',
        parts: [
          {
            text: '你是一个高密度工程上下文交接摘要生成器。请严格依据给定历史对话整理结构化交接摘要，不要调用任何工具，也不要输出多余寒暄。'
          }
        ]
      },
      contents: mergeConsecutiveRoles(slimmedHistory),
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192
      }
    }
  };
}

export function buildCompactedContents(origContents, state) {
  const list = Array.isArray(origContents) ? origContents : [];
  if (!state || !state.summaryText || !Number.isInteger(state.splitIdx) || state.splitIdx <= 0) {
    return { applied: false, contents: list, savedTokensEst: 0 };
  }

  let matchIdx = -1;
  if (state.anchorFingerprint) {
    if (state.splitIdx < list.length && contentFingerprint(list[state.splitIdx]) === state.anchorFingerprint) {
      matchIdx = state.splitIdx;
    } else {
      const start = Math.max(2, state.splitIdx - 4);
      const end = Math.min(list.length - 1, state.splitIdx + 6);
      for (let i = start; i <= end; i += 1) {
        if (contentFingerprint(list[i]) === state.anchorFingerprint) {
          matchIdx = i;
          break;
        }
      }
      // Full-array fallback heals index drift from earlier incremental compactions
      if (matchIdx < 2) {
        for (let i = list.length - 1; i >= 2; i -= 1) {
          if (contentFingerprint(list[i]) === state.anchorFingerprint) {
            matchIdx = i;
            break;
          }
        }
      }
    }
  } else if (state.splitIdx < list.length) {
    matchIdx = state.splitIdx;
  }

  if (matchIdx < 2 || matchIdx >= list.length) {
    return { applied: false, contents: list, savedTokensEst: 0 };
  }
  const anchorTurn = list[matchIdx];
  const isPureUserAnchor = Boolean(anchorTurn && anchorTurn.role === 'user' && !isToolResponseTurn(anchorTurn));
  const isModelAnchor = Boolean(state.anchorMode === 'model' && anchorTurn && anchorTurn.role === 'model');
  if (!isPureUserAnchor && !isModelAnchor) {
    return { applied: false, contents: list, savedTokensEst: 0 };
  }

  const droppedTokens = list.slice(0, matchIdx).reduce((acc, c) => acc + estimateContentTokens(c), 0);
  const summaryBody = `${HANDOFF_PREFIX}${CODEX_COMPACTION_MARKER}\n${state.summaryText}`;
  const bridge = isModelAnchor
    ? [{ role: 'user', parts: [{ text: summaryBody }] }]
    : [
        { role: 'user', parts: [{ text: summaryBody }] },
        { role: 'model', parts: [{ text: '已接续上述工作上下文与当前进度，下面基于最新对话记录继续执行。' }] }
      ];
  const bridgeTokens = bridge.reduce((acc, c) => acc + estimateContentTokens(c), 0);
  const savedTokensEst = Math.max(0, droppedTokens - bridgeTokens);

  return {
    applied: true,
    contents: [...bridge, ...list.slice(matchIdx)],
    savedTokensEst
  };
}

function sanitizeCid(cid) {
  return String(cid || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function createFlowCompactor({ compactionDir = '', log = () => {} } = {}) {
  const latestTurnByCid = new Map();
  const compactionsByCid = new Map();
  const lastCheckByCid = new Map();
  const lastErrorByCid = new Map();
  const inFlightByCid = new Set();

  function getSnapshotPath(cid) {
    const safe = sanitizeCid(cid);
    if (!compactionDir || !safe) return '';
    return path.join(compactionDir, `${safe}.json`);
  }

  function loadState(cid) {
    const safe = sanitizeCid(cid);
    if (!safe) return null;
    if (compactionsByCid.has(safe)) return compactionsByCid.get(safe);
    const filePath = getSnapshotPath(safe);
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object' && typeof raw.summaryText === 'string' && raw.summaryText.trim()) {
        compactionsByCid.set(safe, raw);
        return raw;
      }
    } catch {}
    return null;
  }

  function persistState(cid, state) {
    const safe = sanitizeCid(cid);
    if (!safe) return;
    compactionsByCid.set(safe, state);
    const filePath = getSnapshotPath(safe);
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, filePath);
      } catch {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch (err) {
      log(`[FlowCompactor] persist failed for ${safe}: ${err.message}`);
    }
  }

  function captureTurnPayload(cid, payload, { model = '', reqPath = '' } = {}) {
    const safe = sanitizeCid(cid);
    if (!safe || !payload) return;
    const reqObj = payload?.request || payload;
    if (!Array.isArray(reqObj?.contents) || reqObj.contents.length === 0) return;
    latestTurnByCid.set(safe, {
      payload: structuredClone(payload),
      model: String(model || payload.model || reqObj.model || ''),
      reqPath: String(reqPath || '/v1internal:streamGenerateContent?alt=sse'),
      capturedAt: Date.now(),
      turnsCount: reqObj.contents.length
    });
    if (latestTurnByCid.size > 12) {
      const oldest = latestTurnByCid.keys().next().value;
      if (oldest) latestTurnByCid.delete(oldest);
    }
  }

  function applyToPayload(cid, payload) {
    const safe = sanitizeCid(cid);
    if (!safe || !payload) return { applied: false, savedTokensEst: 0, count: 0 };
    const state = loadState(safe);
    if (!state || !state.summaryText || !state.anchorFingerprint) {
      return { applied: false, savedTokensEst: 0, count: (state?.count || 0) + (state?.hijackCount || 0) };
    }
    const reqObj = payload?.request || payload;
    if (!Array.isArray(reqObj?.contents)) {
      return { applied: false, savedTokensEst: 0, count: (state.count || 0) + (state.hijackCount || 0) };
    }
    const res = buildCompactedContents(reqObj.contents, state);
    if (!res.applied) {
      return { applied: false, savedTokensEst: 0, count: (state.count || 0) + (state.hijackCount || 0) };
    }
    reqObj.contents = res.contents;
    return { applied: true, savedTokensEst: res.savedTokensEst, count: (state.count || 0) + (state.hijackCount || 0) };
  }

  function recordNativeHijack(cid) {
    const safe = sanitizeCid(cid);
    if (!safe) return { ok: false, count: 0 };
    const prev = loadState(safe);
    const nextState = prev
      ? {
          ...prev,
          hijackCount: Number(prev.hijackCount || 0) + 1,
          lastHijackAt: Date.now()
        }
      : {
          version: 1,
          cascadeId: safe,
          count: 0,
          hijackCount: 1,
          compactedAt: Date.now(),
          reason: 'native-hijack'
        };
    persistState(safe, nextState);
    return { ok: true, count: Number(nextState.count || 0) + Number(nextState.hijackCount || 0) };
  }

  function recordCheck(safe, info) {
    if (!safe) return;
    lastCheckByCid.set(safe, { at: Date.now(), ...info });
    if (lastCheckByCid.size > 24) {
      const oldest = lastCheckByCid.keys().next().value;
      if (oldest) lastCheckByCid.delete(oldest);
    }
  }

  function shouldAutoCompact(
    cid,
    { promptTokenCount = 0, model = '', contextWindow = 0, thresholdPct = 70, keepTailTokens = 20000 } = {}
  ) {
    const safe = sanitizeCid(cid);
    if (!safe) return false;
    const windowSize = Number(contextWindow) > 0 ? Number(contextWindow) : estimateModelContextWindow(model);
    const pct = windowSize > 0 && Number.isFinite(promptTokenCount) ? (promptTokenCount / windowSize) * 100 : 0;
    const pctRounded = Number(pct.toFixed(1));
    if (inFlightByCid.has(safe)) {
      recordCheck(safe, { promptTokenCount, windowSize, pct: pctRounded, thresholdPct, decision: false, reason: 'in_flight' });
      return false;
    }
    if (!Number.isFinite(promptTokenCount) || promptTokenCount <= 0) {
      recordCheck(safe, { promptTokenCount, windowSize, pct: 0, thresholdPct, decision: false, reason: 'no_tokens' });
      return false;
    }
    if (pct < thresholdPct) {
      recordCheck(safe, { promptTokenCount, windowSize, pct: pctRounded, thresholdPct, decision: false, reason: 'below_threshold' });
      return false;
    }
    const snap = latestTurnByCid.get(safe);
    if (!snap) {
      recordCheck(safe, { promptTokenCount, windowSize, pct: pctRounded, thresholdPct, decision: false, reason: 'no_snapshot' });
      return false;
    }
    const existing = loadState(safe);
    if (existing) {
      const sinceMs = Date.now() - Number(existing.compactedAt || 0);
      const addedTurns = Number(snap.turnsCount || 0) - Number(existing.totalTurnsAtCompact || 0);
      if (sinceMs < 90_000 && addedTurns < 6) {
        recordCheck(safe, { promptTokenCount, windowSize, pct: pctRounded, thresholdPct, decision: false, reason: 'cooldown' });
        return false;
      }
    }
    const split = splitHistoryForCodexCompact(snap.payload?.request?.contents || snap.payload?.contents || [], {
      keepTailTokens
    });
    recordCheck(safe, {
      promptTokenCount,
      windowSize,
      pct: pctRounded,
      thresholdPct,
      decision: Boolean(split.canCompact),
      reason: split.canCompact ? `trigger_${split.anchorMode || 'user'}` : split.reason || 'cannot_compact'
    });
    return Boolean(split.canCompact);
  }

  async function runCompaction(
    cid,
    { sendUpstream, upstream, authHeaders, compactModel = '', keepTailTokens = 20000, reason = 'manual' } = {}
  ) {
    const safe = sanitizeCid(cid);
    if (!safe) return { ok: false, error: 'missing_cascade_id' };
    const recordFailure = (errorCode) => {
      lastErrorByCid.set(safe, { error: String(errorCode || 'compaction_failed'), at: Date.now(), reason });
      if (lastErrorByCid.size > 24) {
        const oldest = lastErrorByCid.keys().next().value;
        if (oldest) lastErrorByCid.delete(oldest);
      }
    };
    if (inFlightByCid.has(safe)) return { ok: false, error: 'compaction_in_flight' };
    const snap = latestTurnByCid.get(safe);
    if (!snap) {
      recordFailure('no_session_snapshot');
      return { ok: false, error: 'no_session_snapshot', status: getStatus(safe) };
    }
    if (!authHeaders || typeof sendUpstream !== 'function') {
      recordFailure('missing_auth_or_transport');
      return { ok: false, error: 'missing_auth_or_transport', status: getStatus(safe) };
    }

    const reqObj = snap.payload?.request || snap.payload || {};
    const origContents = Array.isArray(reqObj.contents) ? reqObj.contents : [];
    const prevState = loadState(safe);
    // Incremental multi-round compaction: compact the already-compacted effective history when prevState exists
    const effectiveInput =
      prevState?.summaryText && prevState?.anchorFingerprint
        ? buildCompactedContents(origContents, prevState).contents || origContents
        : origContents;
    const split = splitHistoryForCodexCompact(effectiveInput, {
      keepTailTokens,
      allowAdaptive: reason === 'manual'
    });
    if (!split.canCompact) {
      const errCode = split.reason || 'cannot_compact';
      recordFailure(errCode);
      return { ok: false, error: errCode, status: getStatus(safe) };
    }

    const requestSummary = async (targetModel) => {
      const summaryPayload = buildCompactionSummaryPayload(snap.payload, split.head, {
        compactModel: targetModel
      });
      const r = await sendUpstream({
        upstream,
        reqPath: snap.reqPath,
        headers: authHeaders,
        payloadObj: summaryPayload,
        useHttp2: false,
        timeoutMs: 60000
      });
      if (!r || r.status !== 200) {
        throw new Error(`COMPACT_HTTP_${r?.status || 0}`);
      }
      const sse = extractSseText(r.body);
      const summaryText = String(sse.text || '').trim();
      if (sse.toolCalls > 0) {
        throw new Error('COMPACT_UNEXPECTED_TOOL_CALL');
      }
      if (
        summaryText.length < 60 ||
        isPolicyBlockText(summaryText) ||
        analyzeRefusal(summaryText, { scene: 'engineering' }).isRefusal
      ) {
        throw new Error('COMPACT_INVALID_SUMMARY');
      }
      return summaryText;
    };

    inFlightByCid.add(safe);
    try {
      const primaryModel = compactModel || snap.model || 'gemini-3.8-flash-low';
      let summaryText = '';
      try {
        summaryText = await requestSummary(primaryModel);
      } catch (primaryErr) {
        if (!compactModel && !/gemini-3\.8-flash-low/i.test(primaryModel)) {
          log(`[FlowCompactor] Primary summary failed (${primaryErr.message}), falling back to gemini-3.8-flash-low`);
          summaryText = await requestSummary('gemini-3.8-flash-low');
        } else {
          throw primaryErr;
        }
      }

      const summaryTokens = estimateTextTokens(summaryText) + 40;
      const beforeTokensEst = split.headTokens + split.tailTokens;
      const afterTokensEst = summaryTokens + split.tailTokens;
      const savedTokensEst = Math.max(0, beforeTokensEst - afterTokensEst);

      let realSplitIdx = split.splitIdx;
      if (split.anchorFingerprint) {
        for (let i = origContents.length - 1; i >= 2; i -= 1) {
          if (contentFingerprint(origContents[i]) === split.anchorFingerprint) {
            realSplitIdx = i;
            break;
          }
        }
      }

      const nextState = {
        version: 1,
        cascadeId: safe,
        count: (prevState?.count || 0) + 1,
        hijackCount: Number(prevState?.hijackCount || 0),
        compactedAt: Date.now(),
        reason,
        splitIdx: realSplitIdx,
        anchorMode: split.anchorMode || 'user',
        anchorFingerprint: split.anchorFingerprint,
        totalTurnsAtCompact: origContents.length,
        beforeTokensEst,
        afterTokensEst,
        savedTokensEst,
        summaryText
      };
      persistState(safe, nextState);
      lastErrorByCid.delete(safe);
      log(
        `[FlowCompactor] Compacted ${safe.slice(0, 8)} (${reason}): ${beforeTokensEst} -> ${afterTokensEst} est tokens (saved ${savedTokensEst})`
      );
      return { ok: true, status: getStatus(safe) };
    } catch (err) {
      // Atomic rollback: keep prevState intact
      if (prevState) compactionsByCid.set(safe, prevState);
      const msg = err?.message || String(err || 'compaction_failed');
      recordFailure(msg);
      log(`[FlowCompactor] Rollback for ${safe.slice(0, 8)}: ${msg}`);
      return { ok: false, error: msg, status: getStatus(safe) };
    } finally {
      inFlightByCid.delete(safe);
    }
  }

  function clearCompaction(cid) {
    const safe = sanitizeCid(cid);
    if (!safe) return { ok: false, error: 'missing_cascade_id' };
    compactionsByCid.delete(safe);
    lastErrorByCid.delete(safe);
    const filePath = getSnapshotPath(safe);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    return { ok: true, status: getStatus(safe) };
  }

  function getStatus(cid) {
    const safe = sanitizeCid(cid);
    if (!safe) {
      return { active: false, count: 0, inFlight: false, hasSnapshot: false };
    }
    const st = loadState(safe);
    const totalCount = Number(st?.count || 0) + Number(st?.hijackCount || 0);
    const errInfo = lastErrorByCid.get(safe) || null;
    const snap = latestTurnByCid.get(safe) || null;
    return {
      active: Boolean((st?.summaryText && st?.anchorFingerprint) || Number(st?.hijackCount || 0) > 0),
      count: totalCount,
      hijackCount: Number(st?.hijackCount || 0),
      compactedAt: st?.compactedAt || 0,
      savedTokensEst: st?.savedTokensEst || 0,
      beforeTokensEst: st?.beforeTokensEst || 0,
      afterTokensEst: st?.afterTokensEst || 0,
      reason: st?.reason || '',
      inFlight: inFlightByCid.has(safe),
      hasSnapshot: Boolean(snap),
      turnsCount: snap?.turnsCount || 0,
      lastError: errInfo?.error || '',
      lastErrorAt: errInfo?.at || 0,
      lastCheck: lastCheckByCid.get(safe) || null
    };
  }

  function listTrackedCids() {
    return Array.from(
      new Set([...latestTurnByCid.keys(), ...compactionsByCid.keys(), ...lastErrorByCid.keys(), ...inFlightByCid])
    );
  }

  return {
    captureTurnPayload,
    applyToPayload,
    recordNativeHijack,
    shouldAutoCompact,
    runCompaction,
    clearCompaction,
    getStatus,
    listTrackedCids
  };
}
