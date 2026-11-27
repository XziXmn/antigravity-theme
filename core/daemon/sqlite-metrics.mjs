/**
 * core/daemon/sqlite-metrics.mjs — Incremental Conversation DB Reader (node:sqlite)
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseGenMetadataRow,
  parseCheckpointStepInfo,
  extractStepStartMs,
  extractUserStepSig,
  extractStep17Message,
  extractProtoLeafStrings,
  extractStepTimingMs,
  parseStepToolSummary,
  isCancelText
} from './protobuf.mjs';
import { readRecentLsRetryInfo } from './ls-log.mjs';
import {
  fmtTok,
  formatContextLimitLabel,
  buildInlineTelemetryHtml,
  buildMetricsTooltipHtml,
  buildTurnSummaries
} from './telemetry-renderer.mjs';
import { estimateRequestCostUsd } from './usage-analytics.mjs';

function shortModelDisplay(name) {
  const clean = String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (!clean) return 'Unknown';
  const g4 = clean.match(/^gemini[\s-]+4[\s-]+([a-z0-9]+)/i);
  if (g4) return g4[1].charAt(0).toUpperCase() + g4[1].slice(1).toLowerCase();
  const gVer = clean.match(/^gemini[\s-]+(\d+(?:\.\d+)?)[\s-]+(pro|flash)/i);
  if (gVer) return `${gVer[1]} ${gVer[2].charAt(0).toUpperCase()}${gVer[2].slice(1).toLowerCase()}`;
  return clean.replace(/-(?:high|xhigh|medium|low|trial|n|extra[\s_-]*high)$/i, '').trim();
}

function buildContextBreakdown(last, contextLimitTokens, compactedPending, summaryTokens, valid = []) {
  const baseUsedTokens = last.ctx > 0 ? last.ctx : last.ctxUsed || 0;
  const maxTokens = contextLimitTokens > 0 ? contextLimitTokens : null;
  let usedTokens = baseUsedTokens;
  let groups = Array.isArray(last.ctxCategories) ? last.ctxCategories.filter((g) => g && g.tokens > 0) : [];
  if (groups.length === 0 && Array.isArray(valid) && valid.length > 1 && baseUsedTokens > 0) {
    for (let i = valid.length - 2; i >= 0; i--) {
      const prevCats = valid[i]?.ctxCategories;
      if (Array.isArray(prevCats) && prevCats.length > 0) {
        const nonMsgs = prevCats.filter((g) => g && g.tokens > 0 && !/^(?:chat\s+)?messages$/i.test(String(g.label || '')));
        const fixedTok = nonMsgs.reduce((s, g) => s + g.tokens, 0);
        if (nonMsgs.length > 0 && baseUsedTokens > fixedTok) {
          groups = [...nonMsgs, { key: 'messages-inherited', label: 'Chat Messages', tokens: baseUsedTokens - fixedTok }];
        } else {
          groups = prevCats.filter((g) => g && g.tokens > 0);
        }
        break;
      }
    }
  }
  let preCompactPercent = null;

  if (compactedPending && baseUsedTokens > 0) {
    const sumEst = summaryTokens > 0 ? summaryTokens : Math.min(Math.round(baseUsedTokens * 0.12), 12000);
    const nonMsgs = groups.filter((g) => !/^(?:chat\s+)?messages$/i.test(String(g.label || '')));
    const fixedTok = nonMsgs.length
      ? nonMsgs.reduce((s, g) => s + Math.max(0, g.tokens), 0)
      : Math.min(Math.round(baseUsedTokens * 0.12), 18000);
    const estTotal = fixedTok + sumEst;
    if (estTotal < baseUsedTokens) {
      preCompactPercent = maxTokens ? Number(((baseUsedTokens / maxTokens) * 100).toFixed(1)) : null;
      usedTokens = estTotal;
      groups = nonMsgs.length
        ? [...nonMsgs, { key: 'messages-compacted', label: 'Chat Messages', tokens: sumEst }]
        : [];
    }
  }

  const pct = (tok) => (maxTokens && maxTokens > 0 ? Number(((tok / maxTokens) * 100).toFixed(1)) : null);
  const rawTotal = groups.reduce((s, g) => s + Math.max(0, g.tokens), 0);
  let categories = [];
  if (rawTotal > 0 && usedTokens > 0) {
    const apportioned = groups.map((g) => (usedTokens * Math.max(0, g.tokens)) / rawTotal);
    const counts = apportioned.map(Math.floor);
    const rem = apportioned.map((v, idx) => ({ idx, r: v - counts[idx] })).sort((a, b) => b.r - a.r);
    for (let i = 0, left = Math.max(0, usedTokens - counts.reduce((a, b) => a + b, 0)); i < left; i++) {
      counts[rem[i % rem.length].idx]++;
    }
    categories = groups.map((g, idx) => ({
      key: g.key,
      label: g.label,
      tokens: counts[idx],
      percent: pct(counts[idx])
    }));
  } else if (usedTokens > 0) {
    categories.push({ key: 'input', label: 'Chat Messages', tokens: usedTokens, percent: pct(usedTokens) });
  }
  const freeTokens = maxTokens != null ? Math.max(0, maxTokens - usedTokens) : null;
  if (freeTokens != null) {
    categories.push({ key: 'free', label: 'Free', tokens: freeTokens, percent: pct(freeTokens) });
  }
  return {
    usedTokens,
    maxTokens,
    usedPercent: pct(usedTokens),
    preCompactPercent,
    categories
  };
}

function buildModelContexts(valid, checkpointCount) {
  const hasOrchestrator = valid.some((g) => g.role === 'execution' || g.role === 'planner' || /orchestrator/i.test(g.modelName || ''));
  const map = new Map();
  let lastKey = '';
  for (const g of valid) {
    const used = g.ctx > 0 ? g.ctx : g.ctxUsed || 0;
    if (used <= 0 || !g.modelName) continue;
    const maxTok = g.maxCtx > 0 && used <= g.maxCtx ? g.maxCtx : null;
    const role = hasOrchestrator ? (g.role || 'planner') : '';
    const shortName = shortModelDisplay(g.modelName);
    const key = `${role}:${shortName.toLowerCase()}`;
    const prev = map.get(key);
    const resolvedMax = maxTok ?? prev?.maxTokens ?? null;
    map.set(key, {
      key,
      role,
      shortName,
      fullName: g.modelName,
      usedTokens: used,
      maxTokens: resolvedMax,
      usedPercent: resolvedMax ? Number(((used / resolvedMax) * 100).toFixed(1)) : null,
      compactions: 0,
      isCurrent: false
    });
    lastKey = key;
  }
  const models = [...map.values()].map((m) => ({ ...m, isCurrent: m.key === lastKey }));
  // Native compactions must come strictly from real SQLite checkpoint steps (step_type = 23),
  // never from context drop heuristics which miscount sliding compaction & model switches.
  const compactions = Math.max(0, Number(checkpointCount) || 0);
  if (models.length === 1 && compactions > 0) models[0].compactions = compactions;
  return { models, hasOrchestrator, compactions };
}

export function getDbSignature(cascadeId, conversationsDir) {
  try {
    const dbPath = path.join(conversationsDir, `${cascadeId}.db`);
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
    return `${st.mtimeMs}:${st.size}|${walSig}`;
  } catch {
    return null;
  }
}

export function createMetricsReader({ getDatabaseSync, getConfig }) {
  const metricsCache = new Map();
  const incrementalMetricsMap = new Map();
  const trajToCascadeMap = new Map();
  const cascadeToTrajMap = new Map();
  const sessionContextLimitMap = new Map();
  const MAX_METRICS_CACHE_SIZE = 30;
  const MAX_ID_MAP_SIZE = 128;

  function setBoundedMap(map, key, val, limit = MAX_ID_MAP_SIZE) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    if (map.size > limit) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
  }

  function recordTrajectoryMapping(trajId, cid) {
    const t = String(trajId || '').trim();
    const c = String(cid || '').trim();
    if (!t || !c) return;
    setBoundedMap(trajToCascadeMap, t, c);
    setBoundedMap(cascadeToTrajMap, c, t);
  }

  function setMetricsCache(dbPath, entry) {
    if (metricsCache.has(dbPath)) metricsCache.delete(dbPath);
    metricsCache.set(dbPath, entry);
    if (metricsCache.size > MAX_METRICS_CACHE_SIZE) {
      const oldestKey = metricsCache.keys().next().value;
      if (oldestKey) {
        metricsCache.delete(oldestKey);
        incrementalMetricsMap.delete(oldestKey);
      }
    }
  }

  function setIncrementalMetrics(dbPath, state) {
    if (incrementalMetricsMap.has(dbPath)) incrementalMetricsMap.delete(dbPath);
    incrementalMetricsMap.set(dbPath, state);
    if (incrementalMetricsMap.size > MAX_METRICS_CACHE_SIZE) {
      const oldestKey = incrementalMetricsMap.keys().next().value;
      if (oldestKey) incrementalMetricsMap.delete(oldestKey);
    }
  }

  function parseConversationMetrics(cascadeId, conversationsDir, extraOpts = {}) {
    const customOpenDb = extraOpts && typeof extraOpts.openDb === 'function' ? extraOpts.openDb : null;
    const DatabaseSync = customOpenDb ? null : getDatabaseSync();
    if (!customOpenDb && !DatabaseSync) return null;
    if (!cascadeId || !/^[0-9a-f-]{36}$/i.test(cascadeId)) return null;

    const cfg = getConfig() || {};
    const dbPath =
      (extraOpts && typeof extraOpts.cacheKey === 'string' && extraOpts.cacheKey) ||
      path.join(conversationsDir, `${cascadeId}.db`);
    const rawDbSig =
      (extraOpts && typeof extraOpts.rawDbSig === 'string' && extraOpts.rawDbSig) ||
      getDbSignature(cascadeId, conversationsDir);
    if (!rawDbSig) return { cid: cascadeId, cascadeId, hasData: false };

    const manualLim = cfg.manualContextLimit || 0;
    const fallbackLim = cfg.fallbackContextLimit || 256000;
    const telemetryLayout = cfg.telemetryLayout === 'detailed' ? 'detailed' : 'compact';
    const telemetryCacheMode = cfg.telemetryCacheMode === 'step' ? 'step' : 'session';
    const lsLogFile = extraOpts && typeof extraOpts.lsLogFile === 'string' ? extraOpts.lsLogFile : '';
    const lsSig = extraOpts && typeof extraOpts.lsSig === 'string' ? extraOpts.lsSig : '';
    const sig = `${rawDbSig}|lim:${manualLim}:${fallbackLim}|ly:${telemetryLayout}:${telemetryCacheMode}${lsSig ? `|ls:${lsSig}` : ''}`;

    const cached = metricsCache.get(dbPath);
    if (cached && cached.sig === sig) {
      return cached.payload;
    }

    let db;
    try {
      db = customOpenDb ? customOpenDb() : new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
      if (!cascadeToTrajMap.has(cascadeId)) {
        try {
          const metaRows = db.prepare('SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 4').all();
          for (const mr of metaRows) {
            const tid = String(mr?.trajectory_id || '').trim();
            const cid = String(mr?.cascade_id || '').trim() || cascadeId;
            if (tid) recordTrajectoryMapping(tid, cid);
          }
        } catch {}
      }
      const metaStat = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata').get();
      const rowCount = metaStat?.cnt ?? 0;
      const maxIdx = metaStat?.maxIdx ?? -1;
      if (rowCount === 0 || maxIdx < 0) {
        db.close();
        db = null;
        incrementalMetricsMap.delete(dbPath);
        const emptyPayload = { cid: cascadeId, cascadeId, hasData: false, sig };
        setMetricsCache(dbPath, { sig, payload: emptyPayload });
        return emptyPayload;
      }

      const userStepRows = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC').all();
      const userStepIdxs = userStepRows.map((row) => row.idx);
      const userStepsCount = userStepIdxs.length;
      const lastUserStepIdx = userStepsCount > 0 ? userStepIdxs[userStepsCount - 1] : -1;
      const lastUserMetaRow =
        lastUserStepIdx >= 0
          ? db.prepare('SELECT metadata, length(step_payload) AS plen FROM steps WHERE idx = ?').get(lastUserStepIdx)
          : null;
      const lastUserStepSig = extractUserStepSig(lastUserStepIdx, lastUserMetaRow);

      const stepStat = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS maxIdx FROM steps').get();
      const totalStepsCount = stepStat?.cnt ?? 0;
      const maxStepIdxAll = stepStat?.maxIdx ?? -1;

      const cpCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 23').get();
      const checkpointCount = cpCountRow?.cnt ?? 0;
      const errStepRow = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 17 OR status = 7').get();
      const stepErrorCount = errStepRow?.cnt ?? 0;
      const toolStepRow = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type NOT IN (14, 15, 17, 23)').get();
      const toolCount = toolStepRow?.cnt ?? 0;
      const lastNonErrRow = db.prepare('SELECT metadata FROM steps WHERE step_type != 14 AND status != 7 ORDER BY idx DESC LIMIT 1').get();
      const lastReqTsMs = lastNonErrRow ? extractStepStartMs(lastNonErrRow.metadata) : 0;

      const lastCpRow = db
        .prepare('SELECT idx, status, metadata, step_payload FROM steps WHERE step_type = 23 AND status = 3 ORDER BY idx DESC LIMIT 1')
        .get();
      const lastCheckpoint = parseCheckpointStepInfo(lastCpRow);
      const lastCheckpointIdx = lastCheckpoint ? lastCheckpoint.idx : -1;

      const activeStepRows = db
        .prepare('SELECT idx, step_type, status, metadata, length(step_payload) AS plen FROM steps WHERE status IN (1, 2, 8, 9, 11) ORDER BY idx DESC LIMIT 10')
        .all();

      const lastModelStepRow = db
        .prepare('SELECT idx, step_type, status, error_details, step_payload, metadata FROM steps WHERE step_type IN (15, 17, 23) ORDER BY idx DESC LIMIT 1')
        .get();

      const latestNonUserStep = db
        .prepare('SELECT idx, step_type, status, error_details, step_payload, metadata FROM steps WHERE step_type != 14 ORDER BY idx DESC LIMIT 1')
        .get();

      const lastGenMetaRow = db.prepare('SELECT size, length(data) AS dlen FROM gen_metadata WHERE idx = ?').get(maxIdx);
      const lastGenSig = lastGenMetaRow ? `${maxIdx}:${lastGenMetaRow.size}:${lastGenMetaRow.dlen}` : '';

      const turnStat = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 15 AND idx > ?').get(lastUserStepIdx);
      const rawTurnSteps = turnStat?.cnt ?? 0;

      const turnToolRows =
        lastUserStepIdx >= 0
          ? db
              .prepare(
                'SELECT idx, step_type, status, metadata FROM steps WHERE idx > ? AND step_type NOT IN (14, 15, 17, 23) ORDER BY idx DESC LIMIT 8'
              )
              .all(lastUserStepIdx)
          : [];
      const turnToolCountRow =
        lastUserStepIdx >= 0
          ? db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE idx > ? AND step_type NOT IN (14, 15, 17, 23)').get(lastUserStepIdx)
          : null;

      let inc = incrementalMetricsMap.get(dbPath);
      if (
        inc &&
        (typeof inc.totalCacheWrite !== 'number' ||
          (inc.items.length > 0 &&
            (typeof inc.items[0].modelName !== 'string' ||
              typeof inc.items[0].errCode !== 'number' ||
              typeof inc.items[0].ctxUsed !== 'number')) ||
          typeof inc.lastGenSig !== 'string' ||
          rowCount < inc.rowCount ||
          maxIdx < inc.maxIdx ||
          totalStepsCount < inc.totalStepsCount ||
          maxStepIdxAll < inc.maxStepIdxAll ||
          userStepsCount < inc.userStepsCount ||
          lastUserStepIdx < inc.lastUserStepIdx ||
          lastCheckpointIdx < inc.lastCheckpointIdx ||
          (lastUserStepIdx === inc.lastUserStepIdx && lastUserStepSig !== inc.lastUserStepSig) ||
          (rowCount === inc.rowCount && maxIdx === inc.maxIdx && lastGenSig !== inc.lastGenSig) ||
          (lastUserStepIdx !== inc.lastUserStepIdx && userStepsCount <= inc.userStepsCount))
      ) {
        inc = null;
      }

      if (inc) {
        const startIdx = inc.maxIdx;
        const deltaRows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC').all(startIdx);
        while (inc.items.length > 0 && inc.items[inc.items.length - 1].idx >= startIdx) {
          const popped = inc.items.pop();
          inc.totalIn -= popped.inTok;
          inc.totalCacheWrite -= popped.cacheWrite;
          inc.totalCache -= popped.cacheRead;
          inc.totalOut -= popped.outTok;
          inc.totalThink -= popped.thinkTok;
          inc.totalResp -= popped.respTok;
        }
        while (inc.validItems.length > 0 && inc.validItems[inc.validItems.length - 1].idx >= startIdx) {
          inc.validItems.pop();
        }
        if (inc.items.length + deltaRows.length === rowCount) {
          for (let i = 0; i < deltaRows.length; i++) {
            const p = parseGenMetadataRow(deltaRows[i]);
            inc.items.push(p);
            inc.totalIn += p.inTok;
            inc.totalCacheWrite += p.cacheWrite;
            inc.totalCache += p.cacheRead;
            inc.totalOut += p.outTok;
            inc.totalThink += p.thinkTok;
            inc.totalResp += p.respTok;
            if (p.ctx > 0 || p.outTok > 0) {
              inc.validItems.push(p);
            }
          }
          inc.rowCount = rowCount;
          inc.maxIdx = maxIdx;
          inc.userStepsCount = userStepsCount;
          inc.lastUserStepIdx = lastUserStepIdx;
          inc.lastUserStepSig = lastUserStepSig;
          inc.totalStepsCount = totalStepsCount;
          inc.maxStepIdxAll = maxStepIdxAll;
          inc.lastCheckpointIdx = lastCheckpointIdx;
          inc.lastGenSig = lastGenSig;
        } else {
          inc = null;
        }
      }

      if (!inc) {
        const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
        const items = [];
        const validItems = [];
        let totalIn = 0;
        let totalCacheWrite = 0;
        let totalCache = 0;
        let totalOut = 0;
        let totalThink = 0;
        let totalResp = 0;
        for (let i = 0; i < rows.length; i++) {
          const p = parseGenMetadataRow(rows[i]);
          items.push(p);
          totalIn += p.inTok;
          totalCacheWrite += p.cacheWrite;
          totalCache += p.cacheRead;
          totalOut += p.outTok;
          totalThink += p.thinkTok;
          totalResp += p.respTok;
          if (p.ctx > 0 || p.outTok > 0) {
            validItems.push(p);
          }
        }
        inc = {
          rowCount: rows.length,
          maxIdx: rows.length > 0 ? rows[rows.length - 1].idx : -1,
          userStepsCount,
          lastUserStepIdx,
          lastUserStepSig,
          totalStepsCount,
          maxStepIdxAll,
          lastCheckpointIdx,
          lastGenSig,
          items,
          validItems,
          totalIn,
          totalCacheWrite,
          totalCache,
          totalOut,
          totalThink,
          totalResp
        };
      }

      db.close();
      db = null;
      setIncrementalMetrics(dbPath, inc);

      const { validItems: valid, totalIn, totalCacheWrite, totalCache, totalOut, totalThink, totalResp } = inc;
      if (valid.length === 0) {
        const emptyPayload = { cid: cascadeId, cascadeId, hasData: false, sig };
        setMetricsCache(dbPath, { sig, payload: emptyPayload });
        return emptyPayload;
      }

      let turnSlice;
      if (lastUserStepIdx >= 0 && valid.some((it) => it.maxStepIdx >= 0)) {
        turnSlice = [];
        for (let i = valid.length - 1; i >= 0; i--) {
          const si = valid[i].maxStepIdx;
          if (si > lastUserStepIdx) {
            turnSlice.push(valid[i]);
          } else if (si >= 0) {
            break;
          }
        }
        turnSlice.reverse();
      } else {
        turnSlice = rawTurnSteps > 0 ? valid.slice(-rawTurnSteps) : [];
      }

      const turnSteps = turnSlice.length;
      let turnOut = 0;
      let turnThink = 0;
      let turnResp = 0;
      let turnDur = 0;
      for (let i = 0; i < turnSlice.length; i++) {
        turnOut += turnSlice[i].outTok;
        turnThink += turnSlice[i].thinkTok;
        turnResp += turnSlice[i].respTok;
        turnDur += turnSlice[i].totDur;
      }

      const last = valid[valid.length - 1];
      let nativeContextLimit = last.maxCtx > 0 ? last.maxCtx : 0;
      if (!nativeContextLimit) {
        for (let i = valid.length - 1; i >= 0; i--) {
          if (valid[i].maxCtx > 0) {
            nativeContextLimit = valid[i].maxCtx;
            break;
          }
        }
      }
      if (!nativeContextLimit) {
        for (let i = inc.items.length - 1; i >= 0; i--) {
          if (inc.items[i].maxCtx > 0) {
            nativeContextLimit = inc.items[i].maxCtx;
            break;
          }
        }
      }
      const contextLimitTokens = manualLim > 0 ? manualLim : nativeContextLimit > 0 ? nativeContextLimit : fallbackLim;
      if (nativeContextLimit > 0 || manualLim > 0) {
        setBoundedMap(sessionContextLimitMap, cascadeId, contextLimitTokens);
      }
      const MIN_STREAM_DUR_SEC = 0.12;
      const MAX_SANITY_STREAM_TPS = 3000;
      const streamTps = last.stream >= MIN_STREAM_DUR_SEC ? last.outTok / last.stream : 0;
      const e2eTps = last.totDur > 0 ? last.outTok / last.totDur : 0;
      const displayTps = streamTps > 0 && streamTps <= MAX_SANITY_STREAM_TPS ? streamTps : e2eTps;
      const ctxPct = Math.round((last.ctx / contextLimitTokens) * 100);
      const ctxClass = ctxPct >= 90 ? 'ag-ctx-crit' : ctxPct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok';
      const lastCacheRate = last.ctx > 0 ? ((last.cacheRead / last.ctx) * 100).toFixed(1) : '0.0';
      const totalPrompt = totalIn + totalCacheWrite + totalCache;
      const sessionCacheRate = totalPrompt > 0 ? ((totalCache / totalPrompt) * 100).toFixed(1) : '0.0';
      const remainCtx = Math.max(0, contextLimitTokens - last.ctx);
      const limitKStr = formatContextLimitLabel(contextLimitTokens);
      const compactedPending = Boolean(
        lastCheckpoint &&
          (last.maxStepIdx >= 0 ? lastCheckpoint.idx > last.maxStepIdx : lastCheckpoint.cpMetaIdx > last.idx)
      );
      const compactSummaryKb =
        compactedPending && lastCheckpoint && lastCheckpoint.summaryBytes > 0
          ? Number((lastCheckpoint.summaryBytes / 1024).toFixed(1))
          : 0;
      const activeCompactRow = activeStepRows.find((r) => r.step_type === 23) || null;
      const compactingNow = Boolean(activeCompactRow);
      const nonUserActive = activeStepRows.filter(
        (r) => r.step_type !== 14 && (last.maxStepIdx < 0 || r.idx > last.maxStepIdx)
      );
      const generatingPending = compactingNow || nonUserActive.length > 0;
      const latestActiveRow = activeCompactRow || nonUserActive[0] || null;
      const pendingKind = !latestActiveRow
        ? 'idle'
        : latestActiveRow.step_type === 23
        ? 'compact'
        : latestActiveRow.step_type === 15
        ? 'llm'
        : 'tool';
      const pendingStepIdx = latestActiveRow ? latestActiveRow.idx : -1;
      const pendingStartedAtMs = latestActiveRow ? extractStepStartMs(latestActiveRow.metadata) : 0;
      const pendingPayloadLen = latestActiveRow ? latestActiveRow.plen || 0 : 0;

      const latestAnyGen = inc.items.length > 0 ? inc.items[inc.items.length - 1] : null;
      let tailRetryErrCount = 0;
      let tailRetryErrMsg = '';
      for (let i = inc.items.length - 1; i >= 0; i--) {
        const it = inc.items[i];
        if (it && it.errCode === 1 && it.errMsg && (it.maxStepIdx < 0 || it.maxStepIdx >= lastUserStepIdx)) {
          tailRetryErrCount++;
          if (!tailRetryErrMsg) tailRetryErrMsg = it.errMsg;
        } else {
          break;
        }
      }

      const step17InTail = Boolean(
        latestNonUserStep &&
          latestNonUserStep.step_type === 17 &&
          (lastUserStepIdx < 0 || latestNonUserStep.idx >= lastUserStepIdx) &&
          (last.maxStepIdx < 0 || latestNonUserStep.idx > last.maxStepIdx)
      );
      const step17RawMsg = step17InTail ? extractStep17Message(latestNonUserStep) : '';
      const step17TailActive = Boolean(step17InTail && !isCancelText(step17RawMsg));
      const step17TsMs = step17TailActive ? extractStepStartMs(latestNonUserStep.metadata) : 0;
      const step17Msg = step17TailActive ? step17RawMsg : '';
      const lsRetrySinceMs = generatingPending ? pendingStartedAtMs : step17TsMs;
      const lsRetryInfo =
        (generatingPending || step17TailActive) && lsLogFile
          ? readRecentLsRetryInfo(lsLogFile, lsRetrySinceMs)
          : null;
      const pendingRetrying = Boolean(
        (generatingPending && (tailRetryErrCount > 0 || (lsRetryInfo && lsRetryInfo.attempt > 0))) ||
          (step17TailActive && lsRetryInfo && lsRetryInfo.attempt > 0 && Date.now() - lsRetryInfo.tsMs <= 240000)
      );
      const pendingRetryCount = Math.max(tailRetryErrCount, lsRetryInfo ? lsRetryInfo.attempt : 0);
      const pendingRetryReason = (lsRetryInfo && lsRetryInfo.reason) || tailRetryErrMsg || step17Msg || '';

      let stepErrMsg = '';
      if (lastModelStepRow && lastModelStepRow.idx >= lastUserStepIdx) {
        if (lastModelStepRow.status === 7) {
          const rawDetail = lastModelStepRow.error_details
            ? Buffer.from(lastModelStepRow.error_details)
                .toString('utf8')
                .replace(/[^\x20-\x7e\u4e00-\u9fff]+/g, ' ')
                .trim()
                .slice(0, 180)
            : '步骤执行失败 (ERROR)';
          if (!isCancelText(rawDetail)) stepErrMsg = rawDetail;
        } else if (step17TailActive) {
          stepErrMsg = step17Msg || 'API 调用失败 (ERROR_MESSAGE)';
        }
      }

      const latestGenErrored = Boolean(
        !generatingPending &&
          latestAnyGen &&
          latestAnyGen.errCode === 1 &&
          latestAnyGen.errMsg &&
          !isCancelText(latestAnyGen.errMsg) &&
          (lastUserStepIdx < 0 || latestAnyGen.maxStepIdx < 0 || latestAnyGen.maxStepIdx >= lastUserStepIdx)
      );
      const effectiveExecuting = generatingPending || pendingRetrying;
      const rawLastErrorMsg = !effectiveExecuting
        ? stepErrMsg || (latestGenErrored ? latestAnyGen.errMsg : '')
        : '';
      const lastErrorMsg = rawLastErrorMsg && !isCancelText(rawLastErrorMsg) ? rawLastErrorMsg : '';

      const statusLevel = lastErrorMsg
        ? 'error'
        : pendingRetrying
        ? 'retrying'
        : generatingPending
        ? 'running'
        : 'idle';
      const statusDotClass =
        statusLevel === 'error'
          ? 'ag-ctx-pending-dot ag-dot-error'
          : statusLevel === 'retrying'
          ? 'ag-ctx-pending-dot ag-dot-slow'
          : statusLevel === 'running'
          ? 'ag-ctx-pending-dot ag-dot-running'
          : 'ag-ctx-pending-dot ag-dot-idle';
      const statusTitle =
        statusLevel === 'error'
          ? `会话状态：异常 · ${lastErrorMsg.slice(0, 120)}`
          : statusLevel === 'retrying'
          ? `会话状态：等待或重试（第 ${pendingRetryCount} 次${pendingRetryReason ? `：${pendingRetryReason.slice(0, 100)}` : ''}）`
          : compactingNow
          ? '会话状态：执行中 · 上下文压缩中…'
          : generatingPending
          ? '会话状态：执行中 · 新一步执行中'
          : '会话状态：就绪 · 悬停或点击查看统计';
      const safeDotTitle = statusTitle.replace(/"/g, '&quot;');
      const statusDotHtml = `<span class="${statusDotClass}" aria-label="${safeDotTitle}"></span>`;

      const turns = buildTurnSummaries(valid, userStepIdxs, manualLim, fallbackLim);
      const inlineHtml = buildInlineTelemetryHtml({
        telemetryLayout,
        telemetryCacheMode,
        statusDotHtml,
        displayTps,
        ttft: last.ttft,
        lastCtx: last.ctx,
        limitKStr,
        ctxClass,
        ctxPct,
        compactedPending,
        outTok: last.outTok,
        lastCacheRate,
        sessionCacheRate
      });

      const streamTpsValid = streamTps > 0 && streamTps <= MAX_SANITY_STREAM_TPS;
      let sessSpeedOut = 0;
      let sessSpeedDur = 0;
      let peakTps = 0;
      let latestTps = 0;
      let modelTimeSec = 0;
      let ttftSum = 0;
      let ttftCount = 0;
      let estCostUsd = 0;
      for (let i = 0; i < valid.length; i++) {
        const it = valid[i];
        if (it.totDur > 0) modelTimeSec += it.totDur;
        if (it.ttft > 0) {
          ttftSum += it.ttft;
          ttftCount++;
        }
        const reqCost = estimateRequestCostUsd(it.modelName, {
          inputTokens: it.inTok,
          cacheReadTokens: it.cacheRead,
          outputTokens: it.outTok
        });
        estCostUsd += Number(reqCost?.costUsd || 0);
        if (it.outTok > 0) {
          const isStream = it.stream >= 0.5 && it.outTok >= 20;
          const dur = isStream ? it.stream : it.totDur;
          if (dur >= MIN_STREAM_DUR_SEC) {
            const tpsVal = it.outTok / dur;
            if (tpsVal <= MAX_SANITY_STREAM_TPS) {
              sessSpeedOut += it.outTok;
              sessSpeedDur += dur;
              if (tpsVal > peakTps) peakTps = tpsVal;
              latestTps = tpsVal;
            }
          }
        }
      }
      const sessAvgTps = sessSpeedDur > 0 ? Number((sessSpeedOut / sessSpeedDur).toFixed(1)) : Number(displayTps.toFixed(1));
      const avgTtftSec = ttftCount > 0 ? ttftSum / ttftCount : last.ttft;
      const genErrors = inc.items.filter((it) => it && it.errCode === 1).length;
      const totalErrorCount = stepErrorCount + genErrors;

      const ctxBreakdown = buildContextBreakdown(
        last,
        contextLimitTokens,
        compactedPending,
        lastCheckpoint?.summaryTokens || 0,
        valid
      );
      const multiModels = buildModelContexts(valid, checkpointCount);

      let overviewProgress = null;
      try {
        const turnUserTiming = lastUserMetaRow ? extractStepTimingMs(lastUserMetaRow.metadata) : { createdMs: 0, startedMs: 0, completedMs: 0 };
        const turnStartMs = turnUserTiming.startedMs || turnUserTiming.createdMs || 0;
        const recentActivity = [];
        for (let i = turnToolRows.length - 1; i >= 0; i--) {
          const item = parseStepToolSummary(turnToolRows[i]);
          if (item) recentActivity.push(item);
        }
        const tailActivity = recentActivity.slice(-4);
        const turnToolCount = turnToolCountRow?.cnt ?? toolCount;
        const runningStep = tailActivity.find((a) => a.status === 'running') || null;
        const phase = statusLevel === 'error'
          ? 'error'
          : pendingRetrying
          ? 'retrying'
          : compactingNow
          ? 'compacting'
          : runningStep
          ? 'tool'
          : generatingPending
          ? 'thinking'
          : 'complete';
        const turnEndMs = generatingPending || pendingRetrying ? Date.now() : (lastReqTsMs || Date.now());
        const elapsedMs = turnStartMs > 0 && turnEndMs >= turnStartMs ? turnEndMs - turnStartMs : Math.round((last.totDur || 0) * 1000);
        let tasks = [];
        try {
          const taskMdPath = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', cascadeId, 'task.md');
          if (fs.existsSync(taskMdPath)) {
            const rawTask = fs.readFileSync(taskMdPath, 'utf8');
            const matched = rawTask
              .split('\n')
              .map((line) => line.match(/^(\s*)[-*+]\s+\[([ xX/\-])\]\s+(.+)/))
              .filter(Boolean)
              .map((m) => ({
                depth: m[1].length,
                status: /x/i.test(m[2]) ? 'complete' : /[/\-]/.test(m[2]) ? 'running' : 'pending',
                title: m[3].replace(/\*\*|`/g, '').trim()
              }));
            tasks = matched.filter((t, idx) => !matched[idx + 1] || matched[idx + 1].depth <= t.depth).slice(0, 12);
          }
        } catch {}
        overviewProgress = {
          conversationId: cascadeId,
          status: phase === 'error' ? 'error' : (generatingPending || pendingRetrying || runningStep) ? 'running' : 'complete',
          phase,
          phaseDetail: runningStep?.toolName || (pendingRetrying ? pendingRetryReason : '') || (last.modelName || ''),
          retryCount: pendingRetryCount,
          toolCount: turnToolCount,
          elapsedMs,
          recentActivity: tailActivity,
          tasks
        };
      } catch {}

      const tooltipHtml = buildMetricsTooltipHtml({
        genIdx: last.idx + 1,
        streamTps,
        e2eTps,
        streamTpsValid,
        last,
        lastCacheRate,
        ctxPct,
        contextLimitTokens,
        limitKStr,
        remainCtx,
        compactedPending,
        compactSummaryKb,
        compactingNow,
        generatingPending,
        pendingRetrying,
        lastErrorMsg,
        turnSteps,
        turnOut,
        turnThink,
        turnResp,
        turnDur,
        userStepsCount,
        validCount: valid.length,
        totalStepsCount,
        totalIn,
        totalCacheWrite,
        totalCache,
        totalPrompt,
        sessionCacheRate,
        totalOut,
        totalThink,
        totalResp,
        ctxBreakdown,
        multiModels,
        sessAvgTps,
        peakTps: Number(peakTps.toFixed(1)),
        latestTps: Number(latestTps.toFixed(1)),
        avgTtftSec,
        modelTimeSec,
        estCostUsd,
        totalErrorCount,
        toolCount,
        lastReqTsMs
      });

      const payload = {
        cid: cascadeId,
        cascadeId,
        hasData: true,
        sig,
        inlineHtml,
        tooltipHtml,
        turns,
        status: {
          pendingKind,
          pendingRetrying,
          retryReason: pendingRetryReason,
          lastErrorMsg,
          totalSteps: totalStepsCount,
          totalGenerations: valid.length,
          lastModelLabel: last.modelName || ''
        },
        stats: {
          genIdx: last.idx + 1,
          tps: Math.round(displayTps),
          streamTps: Number(streamTps.toFixed(1)),
          e2eTps: Number(e2eTps.toFixed(1)),
          ttft: Number(last.ttft.toFixed(2)),
          streamDur: Number(last.stream.toFixed(2)),
          totDur: Number(last.totDur.toFixed(2)),
          ctx: last.ctx,
          inTok: last.inTok,
          cacheWrite: last.cacheWrite,
          cacheRead: last.cacheRead,
          outTok: last.outTok,
          sessionTotalTokens: totalPrompt + totalOut,
          sessionCostUsd: Number(estCostUsd.toFixed(4)),
          contextLimit: contextLimitTokens,
          limitStr: limitKStr,
          remainCtx,
          ctxPct,
          ctxClass,
          compactedPending,
          compactSummaryKb,
          compactingNow,
          generatingPending,
          lastModel: last.modelName || '',
          lastCacheRead: last.cacheRead || 0,
          pendingKind,
          pendingStepIdx,
          pendingStartedAtMs,
          pendingPayloadLen,
          pendingRetrying,
          pendingRetryCount,
          pendingRetryReason,
          lastErrorMsg,
          statusLevel,
          statusDotHtml,
          overviewProgress,
          stepCacheRate: lastCacheRate + '%',
          sessionCacheRate: sessionCacheRate + '%'
        }
      };
      setMetricsCache(dbPath, { sig, payload });
      return payload;
    } catch {
      return {
        cid: cascadeId,
        cascadeId,
        transientError: true,
        cachedPayload: cached?.payload || null
      };
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  function extractTitleSnippets(cascadeId, conversationsDir, limit = 4) {
    const DatabaseSync = typeof getDatabaseSync === 'function' ? getDatabaseSync() : null;
    if (!DatabaseSync || !cascadeId || !conversationsDir || !/^[0-9a-f-]{36}$/i.test(cascadeId)) return [];
    const dbPath = path.join(conversationsDir, `${cascadeId}.db`);
    if (!fs.existsSync(dbPath)) return [];
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
      const rows = db.prepare('SELECT idx, step_payload FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT ?').all(Math.max(1, limit));
      const out = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const sp = rows[i]?.step_payload;
        if (!sp) continue;
        const strs = extractProtoLeafStrings(Buffer.from(sp));
        const pick = strs
          .map((x) => x.replace(/[\r\n]+/g, ' ').trim())
          .find(
            (x) =>
              x.length >= 2 &&
              !/^(?:image|text|application|audio|video)\/[a-z0-9.+-]+$/i.test(x) &&
              !/^[0-9a-f-]{6,}$/i.test(x)
          );
        if (pick) out.push(pick.slice(0, 220));
      }
      return out;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  function resolveCascadeId(id, { conversationsDir = '', candidateCascadeIds = [] } = {}) {
    const raw = String(id || '').trim();
    if (!raw) return '';
    if (trajToCascadeMap.has(raw)) return trajToCascadeMap.get(raw);
    const candidates = Array.isArray(candidateCascadeIds) ? candidateCascadeIds : [];
    if (candidates.includes(raw)) return raw;

    const DatabaseSync = typeof getDatabaseSync === 'function' ? getDatabaseSync() : null;
    if (DatabaseSync && conversationsDir) {
      for (const cid of candidates) {
        const cleanCid = String(cid || '').trim();
        if (!cleanCid || !/^[0-9a-f-]{36}$/i.test(cleanCid)) continue;
        if (cascadeToTrajMap.has(cleanCid)) continue;
        const dbPath = path.join(conversationsDir, `${cleanCid}.db`);
        if (!fs.existsSync(dbPath)) continue;
        let db = null;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true, timeout: 100 });
          const rows = db.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 4').all();
          for (const r of rows) {
            const tid = String(r?.trajectory_id || '').trim();
            if (tid) recordTrajectoryMapping(tid, cleanCid);
          }
          if (trajToCascadeMap.has(raw)) return trajToCascadeMap.get(raw);
        } catch {
        } finally {
          try {
            db?.close();
          } catch {}
        }
      }
    }
    return raw;
  }

  function getSessionContextLimit(cascadeId) {
    const cid = String(cascadeId || '').trim();
    return cid ? sessionContextLimitMap.get(cid) || 0 : 0;
  }

  return { parseConversationMetrics, extractTitleSnippets, resolveCascadeId, getSessionContextLimit };
}
