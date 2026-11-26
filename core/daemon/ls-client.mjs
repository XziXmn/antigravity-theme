/**
 * core/daemon/ls-client.mjs — Local Antigravity Language Server Discovery, Quota Aggregator & Conversation RPC
 *
 * Discovers the live language_server hub via ~/.gemini/antigravity/daemon/hub_*.json (verified by PID liveness),
 * fetches sanitized model quota buckets via GetUserStatus (zero PII retained), and invokes
 * product.v1.ConversationService (GetConversation / UpdateConversation) for progress-based title updates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive, stripUtf8Bom } from '../shared.mjs';

const QUOTA_CACHE_TTL_MS = 15_000;

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(stripUtf8Bom(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Scan ~/.gemini/antigravity/daemon/hub_*.json (and insiders) to find the active language_server port + CSRF token.
 */
export function discoverLiveHub({ customHome = '', isAliveFn = isPidAlive, channel = 'auto' } = {}) {
  const home = customHome || os.homedir();
  const dirs = [];
  if (channel === 'insiders') {
    dirs.push(path.join(home, '.gemini', 'antigravity-insiders', 'daemon'));
  } else if (channel === 'stable') {
    dirs.push(path.join(home, '.gemini', 'antigravity', 'daemon'));
  } else {
    dirs.push(
      path.join(home, '.gemini', 'antigravity', 'daemon'),
      path.join(home, '.gemini', 'antigravity-insiders', 'daemon')
    );
  }

  const candidates = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^hub_\d+\.json$/i.test(name)) continue;
      const fullPath = path.join(dir, name);
      const data = readJsonSafe(fullPath);
      if (!data || typeof data !== 'object') continue;
      const port = Number(data.httpPort || data.port || 0);
      const csrfToken = typeof data.csrfToken === 'string' ? data.csrfToken.trim() : '';
      const pid = Number(data.pid || 0);
      if (!Number.isInteger(port) || port <= 0 || !csrfToken) continue;
      if (pid > 0 && typeof isAliveFn === 'function' && !isAliveFn(pid)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs || 0;
      } catch {}
      candidates.push({
        host: '127.0.0.1',
        port,
        address: `127.0.0.1:${port}`,
        csrfToken,
        pid,
        lsVersion: String(data.lsVersion || ''),
        mtimeMs
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

function classifyBucketName(labels = []) {
  const joined = labels.join(' | ').toLowerCase();
  const hasGemini = /\bgemini\b/.test(joined);
  const hasClaude = /\bclaude\b/.test(joined);
  const hasGpt = /\bgpt\b/.test(joined);
  const hasDeepSeek = /\bdeepseek\b/.test(joined);
  if (hasGemini && !hasClaude && !hasGpt) return { key: 'gemini', label: 'Gemini' };
  if (hasClaude && hasGpt) return { key: 'claude-gpt', label: 'Claude / GPT' };
  if (hasClaude) return { key: 'claude', label: 'Claude' };
  if (hasGpt) return { key: 'gpt', label: 'GPT' };
  if (hasDeepSeek) return { key: 'deepseek', label: 'DeepSeek' };
  const first = String(labels[0] || 'Other').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { key: first.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'other', label: first || 'Other' };
}

/**
 * Normalize raw GetUserStatus response into a compact, PII-free quota summary suitable for UI display.
 */
export function parseUserStatusQuota(rawJson, nowMs = Date.now()) {
  const us = rawJson?.userStatus && typeof rawJson.userStatus === 'object' ? rawJson.userStatus : {};
  const planStatus = us.planStatus && typeof us.planStatus === 'object' ? us.planStatus : {};
  const planInfo = planStatus.planInfo && typeof planStatus.planInfo === 'object' ? planStatus.planInfo : {};
  const configs = Array.isArray(us.cascadeModelConfigData?.clientModelConfigs)
    ? us.cascadeModelConfigData.clientModelConfigs
    : [];

  const grouped = new Map();
  for (const item of configs) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label || item.modelOrAlias?.model || '').trim();
    if (!label) continue;
    const qi = item.quotaInfo && typeof item.quotaInfo === 'object' ? item.quotaInfo : null;
    if (!qi) continue;
    const hasFraction = typeof qi.remainingFraction === 'number' && Number.isFinite(qi.remainingFraction);
    const resetTime = typeof qi.resetTime === 'string' ? qi.resetTime.trim() : '';
    if (!hasFraction && !resetTime) continue;
    const frac = hasFraction ? Math.max(0, Math.min(1, qi.remainingFraction)) : null;
    const groupKey = `${frac === null ? 'na' : frac.toFixed(4)}|${resetTime}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { remainingFraction: frac, resetTime, labels: [] });
    }
    grouped.get(groupKey).labels.push(label);
  }

  const buckets = [];
  const seenKeys = new Set();
  for (const g of grouped.values()) {
    const meta = classifyBucketName(g.labels);
    let key = meta.key;
    if (seenKeys.has(key)) key = `${key}-${buckets.length + 1}`;
    seenKeys.add(key);
    const resetMs = g.resetTime ? Date.parse(g.resetTime) : NaN;
    const resetInSec = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null;
    buckets.push({
      key,
      label: meta.label,
      remainingFraction: g.remainingFraction,
      remainingPct: g.remainingFraction === null ? null : Math.round(g.remainingFraction * 100),
      resetTime: g.resetTime,
      resetInSec,
      modelCount: g.labels.length
    });
  }

  // Stable order: Gemini first, then Claude/GPT, then others
  const rank = (k) => (k === 'gemini' ? 0 : k.startsWith('claude') ? 1 : k.startsWith('gpt') ? 2 : 3);
  buckets.sort((a, b) => rank(a.key) - rank(b.key) || b.modelCount - a.modelCount);

  return {
    ok: true,
    fetchedAt: nowMs,
    planName: String(planInfo.planName || us.userTier?.name || '').trim(),
    availablePromptCredits:
      typeof planStatus.availablePromptCredits === 'number' ? planStatus.availablePromptCredits : null,
    availableFlowCredits:
      typeof planStatus.availableFlowCredits === 'number' ? planStatus.availableFlowCredits : null,
    groups: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      fiveHour: {
        remainingFraction: b.remainingFraction,
        remainingPct: b.remainingPct,
        resetTime: b.resetTime,
        resetInSec: b.resetInSec
      },
      weekly: null
    })),
    buckets
  };
}

function normalizeQuotaWindow(bucket, nowMs) {
  if (!bucket || typeof bucket !== 'object') return null;
  const hasFrac = typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction);
  const frac = hasFrac ? Math.max(0, Math.min(1, bucket.remainingFraction)) : null;
  const resetTime = typeof bucket.resetTime === 'string' ? bucket.resetTime.trim() : '';
  const resetMs = resetTime ? Date.parse(resetTime) : NaN;
  const resetInSec = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null;
  if (frac === null && !resetTime) return null;
  return {
    remainingFraction: frac,
    remainingPct: frac === null ? null : Math.round(frac * 100),
    resetTime,
    resetInSec
  };
}

/**
 * Parse RetrieveUserQuotaSummary response (contains both 5-hour and weekly quota windows per model group).
 */
export function parseQuotaSummary(rawJson, nowMs = Date.now(), { planName = '' } = {}) {
  const resp = rawJson?.response && typeof rawJson.response === 'object' ? rawJson.response : rawJson || {};
  const rawGroups = Array.isArray(resp.groups) ? resp.groups : [];
  if (rawGroups.length === 0) return null;

  const groups = [];
  const buckets = [];
  const seenKeys = new Set();

  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const displayName = String(g.displayName || '').trim();
    const meta = classifyBucketName([displayName, String(g.description || '')]);
    let key = meta.key;
    if (seenKeys.has(key)) key = `${key}-${groups.length + 1}`;
    seenKeys.add(key);

    const gBuckets = Array.isArray(g.buckets) ? g.buckets : [];
    let fiveHour = null;
    let weekly = null;
    for (const b of gBuckets) {
      const win = String(b?.window || b?.bucketId || '').toLowerCase();
      if (win.includes('week')) {
        weekly = normalizeQuotaWindow(b, nowMs);
      } else if (win.includes('5h') || win.includes('hour')) {
        fiveHour = normalizeQuotaWindow(b, nowMs);
      } else if (!fiveHour) {
        fiveHour = normalizeQuotaWindow(b, nowMs);
      }
    }
    if (!fiveHour && !weekly) continue;
    groups.push({ key, label: meta.label, fiveHour, weekly });
    const primary = fiveHour || weekly;
    buckets.push({
      key,
      label: meta.label,
      remainingFraction: primary.remainingFraction,
      remainingPct: primary.remainingPct,
      resetTime: primary.resetTime,
      resetInSec: primary.resetInSec,
      modelCount: 0
    });
  }

  if (groups.length === 0) return null;
  const rank = (k) => (k === 'gemini' ? 0 : k.startsWith('claude') ? 1 : k.startsWith('gpt') ? 2 : 3);
  groups.sort((a, b) => rank(a.key) - rank(b.key));
  buckets.sort((a, b) => rank(a.key) - rank(b.key));

  return {
    ok: true,
    fetchedAt: nowMs,
    planName: String(planName || '').trim(),
    availablePromptCredits: null,
    availableFlowCredits: null,
    groups,
    buckets
  };
}

export function createLanguageServerClient({
  customHome = '',
  fetchImpl = globalThis.fetch,
  discoverFn = discoverLiveHub,
  nowFn = () => Date.now(),
  cacheTtlMs = QUOTA_CACHE_TTL_MS
} = {}) {
  let cachedQuota = null;
  let inFlightQuota = null;

  function resolveHub() {
    return discoverFn({ customHome });
  }

  async function postLs(hub, endpointPath, bodyObj, { connectProtocol = false, timeoutMs = 6000 } = {}) {
    if (!hub || typeof fetchImpl !== 'function') {
      return { ok: false, status: 0, data: null, error: 'language_server unavailable' };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (connectProtocol) {
      headers['Connect-Protocol-Version'] = '1';
      headers['x-antigravity-csrf-token'] = hub.csrfToken;
    } else {
      headers['x-codeium-csrf-token'] = hub.csrfToken;
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`http://${hub.address}${endpointPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj || {}),
        signal: ctrl ? ctrl.signal : undefined
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      return { ok: res.ok, status: res.status, data, error: res.ok ? '' : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: err?.message || String(err || 'request failed') };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getQuotaStatus({ force = false } = {}) {
    const now = nowFn();
    if (!force && cachedQuota && now - cachedQuota.fetchedAt < cacheTtlMs) {
      return cachedQuota;
    }
    if (inFlightQuota) return await inFlightQuota;
    inFlightQuota = (async () => {
      try {
        const hub = resolveHub();
        if (!hub) {
          return cachedQuota || { ok: false, error: 'hub not found', buckets: [], fetchedAt: now };
        }
        const [summaryRes, statusRes] = await Promise.all([
          postLs(hub, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {}),
          postLs(hub, '/exa.language_server_pb.LanguageServerService/GetUserStatus', {})
        ]);
        const nowDone = nowFn();
        const statusParsed = statusRes.ok && statusRes.data ? parseUserStatusQuota(statusRes.data, nowDone) : null;
        const summaryParsed =
          summaryRes.ok && summaryRes.data
            ? parseQuotaSummary(summaryRes.data, nowDone, { planName: statusParsed?.planName || '' })
            : null;
        const parsed = summaryParsed
          ? {
              ...summaryParsed,
              availablePromptCredits: statusParsed?.availablePromptCredits ?? null,
              availableFlowCredits: statusParsed?.availableFlowCredits ?? null
            }
          : statusParsed;
        if (!parsed) {
          return (
            cachedQuota || {
              ok: false,
              error: summaryRes.error || statusRes.error || 'Quota RPC failed',
              groups: [],
              buckets: [],
              fetchedAt: now
            }
          );
        }
        cachedQuota = parsed;
        return parsed;
      } finally {
        inFlightQuota = null;
      }
    })();
    return await inFlightQuota;
  }

  async function getConversation(conversationId) {
    const cid = String(conversationId || '').trim();
    if (!cid) return { ok: false, error: 'missing conversationId' };
    const hub = resolveHub();
    if (!hub) return { ok: false, error: 'hub not found' };
    return await postLs(
      hub,
      '/product.v1.ConversationService/GetConversation',
      { conversationId: cid },
      { connectProtocol: true }
    );
  }

  async function updateConversationTitle(conversationId, title) {
    const cid = String(conversationId || '').trim();
    const cleanTitle = String(title || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'“”「」『』《》【】\[\]]+|["'“”「」『』《》【】\[\]]+$/g, '')
      .trim()
      .slice(0, 48);
    if (!cid || !cleanTitle) return { ok: false, error: 'invalid arguments' };
    const hub = resolveHub();
    if (!hub) return { ok: false, error: 'hub not found' };
    return await postLs(
      hub,
      '/product.v1.ConversationService/UpdateConversation',
      { conversationId: cid, annotations: { title: cleanTitle } },
      { connectProtocol: true }
    );
  }

  return {
    resolveHub,
    getQuotaStatus,
    getCachedQuota: () => cachedQuota,
    getConversation,
    updateConversationTitle
  };
}
