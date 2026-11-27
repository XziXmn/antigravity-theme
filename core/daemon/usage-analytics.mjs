/**
 * core/daemon/usage-analytics.mjs — Incremental SQLite Usage & Quota Analytics Engine
 *
 * Scans Antigravity conversation SQLite DBs with O(1) signature caching, attributes
 * requests to accounts via account-timeline.json, aggregates quota consumption across
 * 5h/weekly resets from quota-samples.json, projects monthly quota utilization per model
 * pool, and builds daily / weekly / cumulative heatmap datasets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseGenMetadataRow, extractStepStartMs } from './protobuf.mjs';
import { normalizeCredEmail } from './credential-vault.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// Reference USD per 1M tokens (approximate API pricing for comparison only)
const MODEL_PRICING_TABLE = [
  { match: /opus/i, input: 15.0, cacheRead: 1.5, output: 75.0 },
  { match: /sonnet/i, input: 3.0, cacheRead: 0.3, output: 15.0 },
  { match: /haiku/i, input: 0.8, cacheRead: 0.08, output: 4.0 },
  { match: /neon|2\.5[- ]?pro|ultra/i, input: 1.25, cacheRead: 0.31, output: 10.0 },
  { match: /hydrogen|carbon|argon/i, input: 1.25, cacheRead: 0.31, output: 10.0 },
  { match: /flash/i, input: 0.15, cacheRead: 0.0375, output: 0.6 },
  { match: /gpt[-_ ]?oss|120b/i, input: 0.5, cacheRead: 0.125, output: 1.5 }
];
const DEFAULT_PRICING = { input: 1.0, cacheRead: 0.25, output: 5.0 };

export function resolveModelPricing(modelName = '') {
  const s = String(modelName || '');
  for (const row of MODEL_PRICING_TABLE) {
    if (row.match.test(s)) return row;
  }
  return DEFAULT_PRICING;
}

export function estimateRequestCostUsd(modelName, { inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 } = {}) {
  const p = resolveModelPricing(modelName);
  const inCost = (Math.max(0, inputTokens) / 1e6) * p.input;
  const cacheCost = (Math.max(0, cacheReadTokens) / 1e6) * p.cacheRead;
  const outCost = (Math.max(0, outputTokens) / 1e6) * p.output;
  const uncachedEquivalent = (Math.max(0, cacheReadTokens) / 1e6) * p.input;
  return {
    costUsd: inCost + cacheCost + outCost,
    savedUsd: Math.max(0, uncachedEquivalent - cacheCost)
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function formatLocalYmd(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getIsoWeekKey(ms) {
  const d = new Date(ms);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utc - yearStart) / DAY_MS + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getRangeStartMs(range = 'month', nowMs = Date.now()) {
  const d = new Date(nowMs);
  if (range === 'today') {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (range === 'week') {
    const day = d.getDay() || 7;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day - 1));
    return monday.getTime();
  }
  if (range === 'month') {
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
  if (range === 'year') {
    return new Date(d.getFullYear(), 0, 1).getTime();
  }
  return 0;
}

export function resolveAccountAtTimestamp(ts, timeline = [], fallbackEmail = 'default') {
  if (!Array.isArray(timeline) || timeline.length === 0) return fallbackEmail || 'default';
  let chosen = timeline[0].email;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].sinceMs <= ts) {
      chosen = timeline[i].email;
    } else {
      break;
    }
  }
  return chosen || fallbackEmail || 'default';
}

function assignHeatmapLevel(val, maxVal) {
  if (!val || val <= 0 || !maxVal || maxVal <= 0) return 0;
  const ratio = val / maxVal;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

export function classifyModelQuotaPool(modelName = '') {
  const s = String(modelName || '').toLowerCase();
  if (s.includes('claude') || s.includes('gpt') || s.includes('opus') || s.includes('sonnet') || s.includes('haiku') || s.includes('120b')) {
    return 'claude-gpt';
  }
  if (s.includes('gemini') || s.includes('neon') || s.includes('hydrogen') || s.includes('carbon') || s.includes('argon') || s.includes('flash') || s.includes('pro')) {
    return 'gemini';
  }
  return 'other';
}

function extractDbEvents(dbPath, DatabaseSync, fallbackMs = 0, cid = '') {
  let db = null;
  const resolvedCid = cid || path.basename(dbPath, '.db');
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    if (!rows || rows.length === 0) return [];

    const stepTimeMap = new Map();
    const stepRows = db.prepare('SELECT idx, metadata FROM steps').all();
    let latestStepMs = 0;
    for (const sr of stepRows) {
      const ms = extractStepStartMs(sr.metadata);
      if (ms > 0) {
        stepTimeMap.set(sr.idx, ms);
        if (ms > latestStepMs) latestStepMs = ms;
      }
    }

    const rawEvents = [];
    for (const row of rows) {
      const meta = parseGenMetadataRow(row);
      if (!meta || !meta.modelName) continue;
      const directTs = meta.maxStepIdx >= 0 ? stepTimeMap.get(meta.maxStepIdx) || 0 : 0;
      const tps =
        meta.stream >= 0.5 && meta.outTok >= 20
          ? meta.outTok / meta.stream
          : meta.totDur > 0 && meta.outTok > 0
          ? meta.outTok / meta.totDur
          : null;
      rawEvents.push({
        cid: resolvedCid,
        genIdx: meta.idx ?? 0,
        ts: directTs,
        model: meta.modelName,
        role: meta.role || '',
        inputTokens: meta.inTok || 0,
        cacheWriteTokens: meta.cacheWrite || 0,
        cacheReadTokens: meta.cacheRead || 0,
        outputTokens: meta.outTok || 0,
        thinkingTokens: meta.thinkTok || 0,
        ttft: meta.ttft || 0,
        stream: meta.stream || 0,
        totDur: meta.totDur || 0,
        maxCtx: meta.maxCtx || 0,
        errCode: meta.errCode || 0,
        errMsg: meta.errMsg || '',
        tps: tps && Number.isFinite(tps) && tps > 0 && tps < 2000 ? tps : null
      });
    }

    // Two-pass timestamp resolution: never jump unlinked historical errors to latestStepMs
    let prevValidTs = 0;
    for (let i = 0; i < rawEvents.length; i++) {
      if (rawEvents[i].ts > 0) {
        prevValidTs = rawEvents[i].ts;
        continue;
      }
      let nextValidTs = 0;
      for (let j = i + 1; j < rawEvents.length; j++) {
        if (rawEvents[j].ts > 0) {
          nextValidTs = rawEvents[j].ts;
          break;
        }
      }
      rawEvents[i].ts = prevValidTs || nextValidTs || latestStepMs || fallbackMs;
    }

    return rawEvents.filter((ev) => ev.ts > 0);
  } catch {
    return [];
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

export function sanitizePoolSeries(sortedList) {
  const list = Array.isArray(sortedList) ? sortedList : [];
  if (list.length < 3) return list.slice();
  const out = [list[0]];
  let i = 1;
  while (i < list.length - 1) {
    const prev = out[out.length - 1];
    const cur = list[i];
    const next = list[i + 1];
    const dtPrev = cur.ts - prev.ts;
    const dtNext = next.ts - cur.ts;
    const prevWr = prev.weeklyReset ? Date.parse(prev.weeklyReset) : NaN;
    const curWr = cur.weeklyReset ? Date.parse(cur.weeklyReset) : NaN;

    // 1. Cross-account cluster glitch: 1-3 consecutive samples (<45m total span) whose weeklyReset all deviate >=30m
    //    from prev while the sample right after the cluster agrees with prev (<5m)
    if (Number.isFinite(prevWr) && Number.isFinite(curWr) && Math.abs(curWr - prevWr) >= 30 * 60_000) {
      let clusterEnd = -1;
      for (let j = i; j < Math.min(list.length - 1, i + 3); j++) {
        const cWr = list[j].weeklyReset ? Date.parse(list[j].weeklyReset) : NaN;
        if (!Number.isFinite(cWr) || Math.abs(cWr - prevWr) < 30 * 60_000) break;
        const after = list[j + 1];
        if (after.ts - prev.ts > 45 * 60_000) break;
        const afterWr = after.weeklyReset ? Date.parse(after.weeklyReset) : NaN;
        if (Number.isFinite(afterWr) && Math.abs(afterWr - prevWr) < 5 * 60_000) {
          clusterEnd = j;
          break;
        }
      }
      if (clusterEnd >= i) {
        i = clusterEnd + 1;
        continue;
      }
    }

    // 2. Single-sample spike glitch within <20m that immediately drops back to previous reset/level
    if (
      dtPrev < 20 * 60_000 &&
      dtNext < 20 * 60_000 &&
      typeof prev.fiveHourPct === 'number' &&
      typeof cur.fiveHourPct === 'number' &&
      typeof next.fiveHourPct === 'number' &&
      cur.fiveHourPct - prev.fiveHourPct >= 20 &&
      next.fiveHourPct <= prev.fiveHourPct + 2 &&
      prev.fiveHourReset &&
      next.fiveHourReset === prev.fiveHourReset
    ) {
      i += 1;
      continue;
    }

    out.push(cur);
    i += 1;
  }
  out.push(list[list.length - 1]);
  return out;
}

export function detectWindowReset(prevPct, curPct, prevResetStr, curResetStr, dtMs, windowMs, curTs) {
  if (typeof prevPct !== 'number' || typeof curPct !== 'number') return false;
  // Server slides resetTime forward while idle at 100%; never treat 100% -> 100% as a reset
  if (prevPct >= 100 && curPct >= 100) return false;
  const prevR = prevResetStr ? Date.parse(prevResetStr) : NaN;
  const curR = curResetStr ? Date.parse(curResetStr) : NaN;
  if (Number.isFinite(prevR) && Number.isFinite(curR)) {
    if (curR - prevR >= windowMs * 0.4) return true;
    if (curTs && prevR <= curTs && curPct > prevPct + 5) return true;
  }
  // Manual / early platform-wide reset (e.g., official early weekly wipe): <=85% jumps back to >=95%
  if (
    curPct >= 95 &&
    prevPct <= 85 &&
    curPct - prevPct >= 20 &&
    (!Number.isFinite(prevR) || !Number.isFinite(curR) || curR - prevR >= 2 * HOUR_MS)
  ) {
    return true;
  }
  if (Number.isFinite(prevR) && Number.isFinite(curR)) return false;
  // When curResetStr is cleared at 100% upon expiry after a prior <100% sample, detect reset across prevR
  if (Number.isFinite(prevR) && curTs && curTs >= prevR - 60_000 && curPct > prevPct + 5) {
    return true;
  }
  if (dtMs >= windowMs * 0.5 && curPct > prevPct + 15) return true;
  return false;
}

function computeOlsSlope(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / points.length;
  const meanY = sumY / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    num += dx * (p.y - meanY);
    den += dx * dx;
  }
  if (den <= 1e-6) return 0;
  return Math.max(0, num / den);
}

/**
 * Walks sorted quota samples for a single (email, pool) series, filtering transient
 * cross-account glitches, counting resets & post-reset consumption, and extracting
 * EWMA 5h burn rate + OLS weekly slope.
 */
function walkPoolSeriesDrops(rawList, { nowMs, onFiveHourDrop, onWeeklyDrop } = {}) {
  const list = sanitizePoolSeries(rawList);
  let fiveHourDrop = 0;
  let weeklyDrop = 0;
  let fiveHourResets = 0;
  let weeklyResets = 0;
  let last5hResetTs = 0;
  let lastWkResetTs = 0;
  let recent24h5hDrop = 0;
  let recent24hStartTs = null;
  let ewma5hRatePerHour = 0;
  let ewmaHasInit = false;
  let paired5hSum = 0;
  let pairedWkSum = 0;
  const weeklyPts = [];
  const fiveHourSteps = [];

  const recentCutoff = nowMs - 24 * HOUR_MS;
  const first = list[0];
  const baseTs = first?.ts || nowMs;
  if (list.length === 1 && first) {
    if (typeof first.fiveHourPct === 'number' && first.fiveHourPct < 100) {
      fiveHourDrop = 100 - first.fiveHourPct;
    }
    if (typeof first.weeklyPct === 'number' && first.weeklyPct < 100) {
      weeklyDrop = 100 - first.weeklyPct;
    }
  } else if (first) {
    weeklyPts.push({ x: 0, y: 0 });
  }

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    const dtMs = Math.max(0, cur.ts - prev.ts);
    const dtHours = dtMs / HOUR_MS;

    let step5h = 0;
    let reset5h = false;
    if (typeof prev.fiveHourPct === 'number' && typeof cur.fiveHourPct === 'number') {
      reset5h =
        detectWindowReset(prev.fiveHourPct, cur.fiveHourPct, prev.fiveHourReset, cur.fiveHourReset, dtMs, 5 * HOUR_MS, cur.ts) &&
        (!last5hResetTs || cur.ts - last5hResetTs >= 2.5 * HOUR_MS);
      if (reset5h) {
        fiveHourResets += 1;
        last5hResetTs = cur.ts;
        step5h = Math.max(0, 100 - cur.fiveHourPct);
      } else if (cur.fiveHourPct < prev.fiveHourPct) {
        step5h = prev.fiveHourPct - cur.fiveHourPct;
      }
      if (step5h > 0) {
        fiveHourDrop += step5h;
        fiveHourSteps.push({ ts: cur.ts, prevTs: prev.ts, step: step5h });
        if (onFiveHourDrop) onFiveHourDrop(cur.ts, step5h);
        if (cur.ts >= recentCutoff) {
          recent24h5hDrop += step5h;
          if (recent24hStartTs === null || prev.ts < recent24hStartTs) {
            recent24hStartTs = Math.max(recentCutoff, prev.ts);
          }
        }
        // EWMA over active segments (>=30s, <=2.5h) to ignore idle gaps and micro-jitter
        if (!reset5h && dtHours >= 1 / 120 && dtHours <= 2.5 && cur.ts >= nowMs - 8 * HOUR_MS) {
          const instRate = Math.min(100, step5h / dtHours);
          ewma5hRatePerHour = ewmaHasInit ? 0.45 * instRate + 0.55 * ewma5hRatePerHour : instRate;
          ewmaHasInit = true;
        }
      }
    }

    let stepWk = 0;
    let resetWk = false;
    if (typeof prev.weeklyPct === 'number' && typeof cur.weeklyPct === 'number') {
      resetWk =
        detectWindowReset(prev.weeklyPct, cur.weeklyPct, prev.weeklyReset, cur.weeklyReset, dtMs, 7 * DAY_MS, cur.ts) &&
        (!lastWkResetTs || cur.ts - lastWkResetTs >= 6 * HOUR_MS);
      if (resetWk) {
        weeklyResets += 1;
        lastWkResetTs = cur.ts;
        stepWk = Math.max(0, 100 - cur.weeklyPct);
      } else if (cur.weeklyPct < prev.weeklyPct) {
        stepWk = prev.weeklyPct - cur.weeklyPct;
      }
      if (stepWk > 0) {
        weeklyDrop += stepWk;
        if (onWeeklyDrop) onWeeklyDrop(cur.ts, stepWk);
      }
    }

    if (!reset5h && !resetWk && step5h > 0 && stepWk > 0) {
      paired5hSum += step5h;
      pairedWkSum += stepWk;
    }
    weeklyPts.push({ x: (cur.ts - baseTs) / DAY_MS, y: weeklyDrop });
  }

  const lastTs = list[list.length - 1]?.ts || baseTs;
  const observedDays = Math.max(0, (lastTs - baseTs) / DAY_MS);
  const olsDailyWeeklyRate = observedDays >= 0.25 ? computeOlsSlope(weeklyPts) : 0;

  // 60-minute active sliding window for 5h burn rate with 0.5h floor damping against 5-min bursts
  const win1hCutoff = lastTs - HOUR_MS;
  let drop1h = 0;
  let firstIn1hTs = lastTs;
  for (const s of fiveHourSteps) {
    if (s.ts >= win1hCutoff) {
      drop1h += s.step;
      const startAnchor = Math.max(win1hCutoff, s.prevTs);
      if (startAnchor < firstIn1hTs) firstIn1hTs = startAnchor;
    }
  }
  const span1hHours = Math.max(0.5, (lastTs - firstIn1hTs) / HOUR_MS);
  const sliding1h5hRate = drop1h > 0 ? Math.min(80, drop1h / span1hHours) : 0;

  return {
    cleanList: list,
    fiveHourDrop,
    weeklyDrop,
    fiveHourResets,
    weeklyResets,
    resets: fiveHourResets + weeklyResets,
    recent24h5hDrop,
    recent24hSpanHours: recent24hStartTs !== null ? Math.max(1, (nowMs - recent24hStartTs) / HOUR_MS) : 0,
    ewma5hRatePerHour: Number(ewma5hRatePerHour.toFixed(2)),
    sliding1h5hRate: Number(sliding1h5hRate.toFixed(2)),
    olsDailyWeeklyRate: Number(olsDailyWeeklyRate.toFixed(2)),
    paired5hSum,
    pairedWkSum,
    observedDays
  };
}

export function computeQuotaStats(samples, { startMs = 0, accountFilter = 'all', nowMs = Date.now() } = {}) {
  const byEmailKey = new Map();
  for (const s of samples) {
    if (!s || !Number.isFinite(s.ts) || s.ts < startMs) continue;
    const email = normalizeCredEmail(s.email) || 'default';
    if (accountFilter !== 'all' && email !== accountFilter) continue;
    const rawKey = s.key === 'claude' ? 'claude-gpt' : s.key || 'gemini';
    const k = `${email}|${rawKey}`;
    if (!byEmailKey.has(k)) byEmailKey.set(k, []);
    byEmailKey.get(k).push(s);
  }

  let quota5hConsumedPct = 0;
  let quotaWeeklyConsumedPct = 0;
  let quotaResets = 0;
  const perAccount = new Map();
  const perPool = new Map();
  const dailyQuotaDrop = new Map();

  for (const [k, list] of byEmailKey.entries()) {
    list.sort((a, b) => a.ts - b.ts);
    const [email, poolKey] = k.split('|');
    if (!perAccount.has(email)) perAccount.set(email, { fiveHourDrop: 0, weeklyDrop: 0, resets: 0 });
    if (!perPool.has(poolKey)) {
      perPool.set(poolKey, {
        key: poolKey,
        fiveHourDrop: 0,
        weeklyDrop: 0,
        fiveHourResets: 0,
        weeklyResets: 0,
        resets: 0,
        recent24h5hDrop: 0,
        recent24hSpanHours: 0,
        ewma5hRates: [],
        sliding1h5hRates: [],
        olsDailyRates: [],
        perAcctDailyRates: [],
        paired5hSum: 0,
        pairedWkSum: 0,
        acctCountWithSamples: 0,
        firstSampleTs: list[0]?.ts || nowMs,
        firstSampleWeeklyPct: null,
        lastSampleTs: list[list.length - 1]?.ts || nowMs,
        latestFiveHourPct: null,
        latestWeeklyPct: null,
        latestFiveHourReset: '',
        latestWeeklyReset: '',
        // For accountFilter === 'all', keep per-account latest percentages separately
        accountSnapshots: new Map()
      });
    }

    const accStat = perAccount.get(email);
    const poolStat = perPool.get(poolKey);
    const walk = walkPoolSeriesDrops(list, {
      nowMs,
      onFiveHourDrop: (ts, step) => {
        const ymd = formatLocalYmd(ts);
        dailyQuotaDrop.set(ymd, (dailyQuotaDrop.get(ymd) || 0) + step);
      }
    });
    const cleanSeries = walk.cleanList.length > 0 ? walk.cleanList : list;
    const firstSample = cleanSeries[0];
    const lastSample = cleanSeries[cleanSeries.length - 1];
    if (firstSample?.ts && firstSample.ts <= poolStat.firstSampleTs) {
      poolStat.firstSampleTs = firstSample.ts;
      if (typeof firstSample.weeklyPct === 'number') poolStat.firstSampleWeeklyPct = firstSample.weeklyPct;
    } else if (poolStat.firstSampleWeeklyPct === null && typeof firstSample?.weeklyPct === 'number') {
      poolStat.firstSampleWeeklyPct = firstSample.weeklyPct;
    }
    if (lastSample?.ts && lastSample.ts > poolStat.lastSampleTs) poolStat.lastSampleTs = lastSample.ts;
    if (lastSample) {
      if (typeof lastSample.fiveHourPct === 'number') {
        poolStat.latestFiveHourPct = lastSample.fiveHourPct;
        poolStat.latestFiveHourReset = lastSample.fiveHourReset || '';
      }
      if (typeof lastSample.weeklyPct === 'number') {
        poolStat.latestWeeklyPct = lastSample.weeklyPct;
        poolStat.latestWeeklyReset = lastSample.weeklyReset || '';
      }
      poolStat.accountSnapshots.set(email, lastSample);
    }

    quota5hConsumedPct += walk.fiveHourDrop;
    quotaWeeklyConsumedPct += walk.weeklyDrop;
    quotaResets += walk.resets;

    accStat.fiveHourDrop += walk.fiveHourDrop;
    accStat.weeklyDrop += walk.weeklyDrop;
    accStat.resets += walk.resets;

    poolStat.fiveHourDrop += walk.fiveHourDrop;
    poolStat.weeklyDrop += walk.weeklyDrop;
    poolStat.fiveHourResets += walk.fiveHourResets;
    poolStat.weeklyResets += walk.weeklyResets;
    poolStat.resets += walk.resets;
    poolStat.recent24h5hDrop += walk.recent24h5hDrop;
    poolStat.recent24hSpanHours = Math.max(poolStat.recent24hSpanHours, walk.recent24hSpanHours);
    poolStat.paired5hSum += walk.paired5hSum || 0;
    poolStat.pairedWkSum += walk.pairedWkSum || 0;
    poolStat.acctCountWithSamples += 1;
    if (walk.ewma5hRatePerHour > 0) poolStat.ewma5hRates.push(walk.ewma5hRatePerHour);
    if (walk.sliding1h5hRate > 0) poolStat.sliding1h5hRates.push(walk.sliding1h5hRate);
    if (walk.olsDailyWeeklyRate > 0) poolStat.olsDailyRates.push(walk.olsDailyWeeklyRate);
    if (walk.weeklyDrop > 0) {
      poolStat.perAcctDailyRates.push(walk.weeklyDrop / Math.max(0.25, walk.observedDays || 0.25));
    }
  }

  return { quota5hConsumedPct, quotaWeeklyConsumedPct, quotaResets, perAccount, perPool, dailyQuotaDrop };
}

export function inferPreSampleResets({
  eventTimestamps = [],
  preTimelineEventTimestamps = [],
  firstSampleTs = 0,
  firstSampleWeeklyPct = null,
  startMs = 0,
  fiveHourResetTime = '',
  weeklyResetTime = ''
} = {}) {
  const events = Array.isArray(eventTimestamps) ? eventTimestamps : [];
  const preTlEvents = Array.isArray(preTimelineEventTimestamps) ? preTimelineEventTimestamps : [];
  if (events.length === 0 && preTlEvents.length === 0) return { fiveHourResets: 0, weeklyResets: 0 };

  const cur5hResetMs = fiveHourResetTime ? Date.parse(fiveHourResetTime) : NaN;
  const curWkResetMs = weeklyResetTime ? Date.parse(weeklyResetTime) : NaN;
  const sampleBound5h = firstSampleTs > 0 ? firstSampleTs : Infinity;
  const sampleBoundWk = firstSampleTs > 0 ? firstSampleTs : Infinity;

  const fiveHourBuckets = new Set();
  if (Number.isFinite(cur5hResetMs)) {
    const cur5hStartMs = cur5hResetMs - 5 * HOUR_MS;
    const upper = Math.min(cur5hStartMs, sampleBound5h);
    for (const ts of events) {
      if (ts >= startMs && ts < upper) {
        fiveHourBuckets.add(Math.floor((cur5hStartMs - ts) / (5 * HOUR_MS)));
      }
    }
  }

  const weeklyBuckets = new Set();
  if (Number.isFinite(curWkResetMs)) {
    const curWkStartMs = curWkResetMs - 7 * DAY_MS;
    const upper = Math.min(curWkStartMs, sampleBoundWk);
    for (const ts of events) {
      if (ts >= startMs && ts < upper) {
        weeklyBuckets.add(Math.floor((curWkStartMs - ts) / (7 * DAY_MS)));
      }
    }
    // If account-timeline wasn't initialized yet during prior usage, and this account's very first sample
    // starts right at a fresh weekly cycle (100% within ±12h of curWkStartMs), count that 1 cycle reset.
    if (
      weeklyBuckets.size === 0 &&
      preTlEvents.length > 0 &&
      firstSampleTs > 0 &&
      typeof firstSampleWeeklyPct === 'number' &&
      firstSampleWeeklyPct >= 95 &&
      Math.abs(firstSampleTs - curWkStartMs) <= 12 * HOUR_MS &&
      preTlEvents.some((ts) => ts >= startMs && ts < curWkStartMs)
    ) {
      weeklyBuckets.add(0);
    }
  }

  return {
    fiveHourResets: fiveHourBuckets.size,
    weeklyResets: weeklyBuckets.size
  };
}

/**
 * Hybrid open-source-style quota projection combining:
 * 1) Sliding-window observed consumption & cross-reset history,
 * 2) EWMA short-term 5h active burn rate + OLS weekly slope,
 * 3) Same-dimension per-account rate normalization (preventing multi-account distortion),
 * 4) Separate current-week vs month-to-date token baselines (guaranteeing month >= week).
 */
export function projectPoolMonthlyQuota({
  monthPoolStat = null,
  poolTokens = 0,
  poolCostUsd = 0,
  curWeekPoolTokens = null,
  curWeekPoolCostUsd = null,
  monthPoolTokens = null,
  monthPoolCostUsd = null,
  activeDaysInMonth = 0,
  fiveHourRemainingPct = null,
  weeklyRemainingPct = null,
  fiveHourResetTime = '',
  weeklyResetTime = '',
  accountCount = 1,
  nowMs = Date.now()
} = {}) {
  const now = new Date(nowMs);
  const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const nextMonthStartMs = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const daysInMonth = Math.max(28, Math.round((nextMonthStartMs - monthStartMs) / DAY_MS));
  const elapsedMonthDays = Math.max(0.25, (nowMs - monthStartMs) / DAY_MS);
  const remainingMonthDays = Math.max(0, (nextMonthStartMs - nowMs) / DAY_MS);

  const curWeekUsedPct = typeof weeklyRemainingPct === 'number' ? Math.max(0, 100 - weeklyRemainingPct) : 0;
  const cur5hUsedPct = typeof fiveHourRemainingPct === 'number' ? Math.max(0, 100 - fiveHourRemainingPct) : 0;

  const rawMonthWeekly = monthPoolStat ? monthPoolStat.weeklyDrop : 0;
  const rawMonth5h = monthPoolStat ? monthPoolStat.fiveHourDrop : 0;
  const monthWeeklyUsedPct = Math.max(rawMonthWeekly, curWeekUsedPct);
  const month5hUsedPct = Math.max(rawMonth5h, cur5hUsedPct);

  const firstSampleMs = monthPoolStat?.firstSampleTs ? Math.max(monthStartMs, monthPoolStat.firstSampleTs) : nowMs - 5 * HOUR_MS;
  const observedDays = Math.max(0.25, Math.min(elapsedMonthDays, (nowMs - firstSampleMs) / DAY_MS));

  const accountsMult = Math.max(1, accountCount);
  let daysToNextWeeklyReset = 7;
  let weekElapsedDays = 3.5;
  if (weeklyResetTime) {
    const wr = Date.parse(weeklyResetTime);
    if (Number.isFinite(wr) && wr > nowMs) {
      daysToNextWeeklyReset = Math.min(7, Math.max(0.05, (wr - nowMs) / DAY_MS));
      weekElapsedDays = Math.max(0.2, 7 - daysToNextWeeklyReset);
    }
  }

  let hoursTo5hReset = 5;
  let fiveHourElapsedHours = 2.5;
  if (fiveHourResetTime) {
    const fhr = Date.parse(fiveHourResetTime);
    if (Number.isFinite(fhr) && fhr > nowMs) {
      hoursTo5hReset = Math.min(5, Math.max(0.05, (fhr - nowMs) / HOUR_MS));
      fiveHourElapsedHours = Math.max(0.2, 5 - hoursTo5hReset);
    }
  }

  // Empirical coupling ratio between 5h drop and weekly drop
  const fiveHourToWeeklyRatio =
    monthPoolStat?.paired5hSum >= 5 && monthPoolStat?.pairedWkSum > 0
      ? Math.min(0.6, Math.max(0.08, monthPoolStat.pairedWkSum / monthPoolStat.paired5hSum))
      : month5hUsedPct >= 5 && monthWeeklyUsedPct > 0
      ? Math.min(0.6, Math.max(0.08, monthWeeklyUsedPct / month5hUsedPct))
      : 0.25;

  // Per-account normalized daily weekly-quota burn rate (% of 1 account's weekly quota / day)
  const avg = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const perAcctOlsRate = avg(monthPoolStat?.olsDailyRates);
  const perAcctSampleAvg =
    avg(monthPoolStat?.perAcctDailyRates) ||
    (monthPoolStat && monthPoolStat.weeklyDrop > 0
      ? monthPoolStat.weeklyDrop / (observedDays * Math.max(1, monthPoolStat.acctCountWithSamples || 1))
      : 0);
  const currentWinDailyWeeklyRate = curWeekUsedPct > 0 ? curWeekUsedPct / Math.max(0.35, weekElapsedDays) : 0;

  // Empirical Bayes smoothing against 7-day uniform prior (14.3%/d) when observation span is short (<2.5d)
  const PRIOR_DAILY_PCT = 14.3;
  const PRIOR_DAYS = 1.2;
  const acctMultSamples = Math.max(1, monthPoolStat?.acctCountWithSamples || 1);
  const perAcctWeeklyDrop = monthPoolStat ? monthPoolStat.weeklyDrop / acctMultSamples : curWeekUsedPct;
  const smoothedSampleRate =
    observedDays < 2.5 && perAcctWeeklyDrop > 0
      ? (perAcctWeeklyDrop + PRIOR_DAILY_PCT * PRIOR_DAYS) / (observedDays + PRIOR_DAYS)
      : perAcctSampleAvg;
  const smoothedCurWinRate =
    weekElapsedDays < 2.5 && curWeekUsedPct > 0
      ? (curWeekUsedPct + PRIOR_DAILY_PCT * PRIOR_DAYS) / (weekElapsedDays + PRIOR_DAYS)
      : currentWinDailyWeeklyRate;

  let perAcctDailyWeeklyRate = 0;
  if (perAcctOlsRate > 0 && smoothedSampleRate > 0 && smoothedCurWinRate > 0 && observedDays >= 2.5) {
    perAcctDailyWeeklyRate = perAcctOlsRate * 0.45 + smoothedSampleRate * 0.3 + smoothedCurWinRate * 0.25;
  } else if (smoothedSampleRate > 0 && smoothedCurWinRate > 0) {
    perAcctDailyWeeklyRate = smoothedSampleRate * 0.55 + smoothedCurWinRate * 0.45;
  } else {
    perAcctDailyWeeklyRate = Math.max(perAcctOlsRate, smoothedSampleRate, smoothedCurWinRate);
  }

  // Sliding 1h 5h active hourly burn rate damped with current 5h window average
  const sliding5h = avg(monthPoolStat?.sliding1h5hRates);
  const ewma5h = avg(monthPoolStat?.ewma5hRates);
  const active5hSignal = sliding5h > 0 ? sliding5h : ewma5h;
  const current5hAvgRate = cur5hUsedPct > 0 ? cur5hUsedPct / Math.max(0.5, fiveHourElapsedHours) : 0;
  const burnRate5hPerHour =
    active5hSignal > 0 && current5hAvgRate > 0
      ? active5hSignal * 0.5 + current5hAvgRate * 0.5
      : Math.max(active5hSignal, current5hAvgRate);

  const recentHours = monthPoolStat?.recent24hSpanHours > 0 ? monthPoolStat.recent24hSpanHours : 5;
  const recent24h5hHourlyRate =
    monthPoolStat && monthPoolStat.recent24h5hDrop > 0
      ? monthPoolStat.recent24h5hDrop / (Math.max(1, recentHours) * Math.max(1, monthPoolStat.acctCountWithSamples || 1))
      : burnRate5hPerHour;
  const impliedDailyWeeklyFrom5h = recent24h5hHourlyRate * 6 * fiveHourToWeeklyRatio;

  let velocityFactor = 1.0;
  let paceTrend = 'steady';
  if (perAcctDailyWeeklyRate > 0.5 && impliedDailyWeeklyFrom5h > 0) {
    const ratio = impliedDailyWeeklyFrom5h / perAcctDailyWeeklyRate;
    velocityFactor = Math.max(0.7, Math.min(1.45, 0.75 + 0.25 * ratio));
    if (ratio >= 1.25) paceTrend = 'accelerating';
    else if (ratio <= 0.72) paceTrend = 'cooling';
  } else if (cur5hUsedPct >= 75 && curWeekUsedPct < 20) {
    paceTrend = 'accelerating';
    velocityFactor = 1.15;
  } else if (cur5hUsedPct <= 5 && curWeekUsedPct <= 5) {
    paceTrend = 'idle';
  }

  const blendedPerAcctDailyWeeklyRate =
    perAcctDailyWeeklyRate > 0
      ? perAcctDailyWeeklyRate * velocityFactor
      : impliedDailyWeeklyFrom5h > 0
      ? impliedDailyWeeklyFrom5h * 0.6
      : 0;

  // Aggregate across accounts for monthly pool capacity
  const totalDailyWeeklyRate = blendedPerAcctDailyWeeklyRate * accountsMult;
  const remCurrentWeek = typeof weeklyRemainingPct === 'number' ? Math.max(0, weeklyRemainingPct) : 100 * accountsMult;
  const extraResetWeeks =
    remainingMonthDays > daysToNextWeeklyReset ? Math.ceil((remainingMonthDays - daysToNextWeeklyReset) / 7) : 0;
  const physicalMaxAddWeekly = remCurrentWeek + extraResetWeeks * 100 * accountsMult;

  const projectedAddWeekly = Math.min(physicalMaxAddWeekly, Math.max(0, totalDailyWeeklyRate * remainingMonthDays));
  const monthProjectedWeeklyPct = Math.round(monthWeeklyUsedPct + projectedAddWeekly);

  // Current week window projection (uses per-account rate against single-account-normalized remainingPct)
  const weekProjectedAdd = Math.min(remCurrentWeek, Math.max(0, blendedPerAcctDailyWeeklyRate * daysToNextWeeklyReset));
  const weekProjectedPct = Math.min(100, Math.round(curWeekUsedPct + weekProjectedAdd));

  const monthTotalWeeklyCapacity = Math.round((daysInMonth / 7) * 100 * accountsMult);
  const monthProjectedUtilPct =
    monthTotalWeeklyCapacity > 0 ? Math.min(100, Math.round((monthProjectedWeeklyPct / monthTotalWeeklyCapacity) * 100)) : 0;

  const daily5hPct =
    monthPoolStat && monthPoolStat.fiveHourDrop > 0
      ? monthPoolStat.fiveHourDrop / observedDays
      : cur5hUsedPct > 0
      ? Math.max(cur5hUsedPct, impliedDailyWeeklyFrom5h / Math.max(0.05, fiveHourToWeeklyRatio))
      : 0;
  const monthProjected5hCycles = Number(((month5hUsedPct + daily5hPct * velocityFactor * remainingMonthDays) / 100).toFixed(1));

  // Separate current 7-day rolling week vs calendar month token/cost baselines
  const baseWeekTokens = typeof curWeekPoolTokens === 'number' ? curWeekPoolTokens : poolTokens;
  const baseWeekCost = typeof curWeekPoolCostUsd === 'number' ? curWeekPoolCostUsd : poolCostUsd;
  const baseMonthTokens = typeof monthPoolTokens === 'number' ? monthPoolTokens : Math.max(poolTokens, baseWeekTokens);
  const baseMonthCost = typeof monthPoolCostUsd === 'number' ? monthPoolCostUsd : Math.max(poolCostUsd, baseWeekCost);

  const tokensPerWeeklyPct =
    curWeekUsedPct >= 3 && baseWeekTokens > 0
      ? baseWeekTokens / curWeekUsedPct
      : monthWeeklyUsedPct > 0 && baseMonthTokens > 0
      ? baseMonthTokens / monthWeeklyUsedPct
      : 0;
  const costPerWeeklyPct =
    curWeekUsedPct >= 3 && baseWeekCost > 0
      ? baseWeekCost / curWeekUsedPct
      : monthWeeklyUsedPct > 0 && baseMonthCost > 0
      ? baseMonthCost / monthWeeklyUsedPct
      : 0;

  const weekProjectedTokens =
    tokensPerWeeklyPct > 0
      ? Math.max(Math.round(baseWeekTokens), Math.round(baseWeekTokens + weekProjectedAdd * tokensPerWeeklyPct))
      : Math.round(baseWeekTokens);
  const weekProjectedCostUsd = Number(
    (costPerWeeklyPct > 0 ? Math.max(baseWeekCost, baseWeekCost + weekProjectedAdd * costPerWeeklyPct) : baseWeekCost).toFixed(2)
  );

  // Calendar month projection: month-to-date actual + remainingMonthDays projected additions
  const effActiveDays = Math.max(1, activeDaysInMonth || observedDays);
  const sqliteDailyTokens = baseMonthTokens > 0 ? baseMonthTokens / effActiveDays : 0;
  const sqliteDailyCost = baseMonthCost > 0 ? baseMonthCost / effActiveDays : 0;
  const quotaMonthTokens =
    tokensPerWeeklyPct > 0
      ? Math.round(baseMonthTokens + projectedAddWeekly * tokensPerWeeklyPct)
      : monthWeeklyUsedPct > 0
      ? Math.round((baseMonthTokens / monthWeeklyUsedPct) * monthProjectedWeeklyPct)
      : Math.round(baseMonthTokens);
  const calendarMonthTokens = Math.round(baseMonthTokens + sqliteDailyTokens * remainingMonthDays * 0.85);
  const rawMonthProjectedTokens =
    observedDays < 2 && activeDaysInMonth >= 3
      ? Math.round(quotaMonthTokens * 0.5 + calendarMonthTokens * 0.5)
      : quotaMonthTokens;

  const quotaMonthCost =
    costPerWeeklyPct > 0
      ? baseMonthCost + projectedAddWeekly * costPerWeeklyPct
      : monthWeeklyUsedPct > 0
      ? (baseMonthCost / monthWeeklyUsedPct) * monthProjectedWeeklyPct
      : baseMonthCost;
  const calendarMonthCost = baseMonthCost + sqliteDailyCost * remainingMonthDays * 0.85;
  const rawMonthProjectedCost =
    observedDays < 2 && activeDaysInMonth >= 3
      ? quotaMonthCost * 0.5 + calendarMonthCost * 0.5
      : quotaMonthCost;

  // Only enforce month >= week when the current 7-day rolling window finishes inside this calendar month
  const weekFitsInMonth = remainingMonthDays >= daysToNextWeeklyReset;
  const monthProjectedTokens = weekFitsInMonth
    ? Math.max(Math.round(baseMonthTokens), weekProjectedTokens, rawMonthProjectedTokens)
    : Math.max(Math.round(baseMonthTokens), rawMonthProjectedTokens);
  const monthProjectedCostUsd = Number(
    (weekFitsInMonth
      ? Math.max(baseMonthCost, weekProjectedCostUsd, rawMonthProjectedCost)
      : Math.max(baseMonthCost, rawMonthProjectedCost)
    ).toFixed(2)
  );

  const estDeplete5hHours =
    typeof fiveHourRemainingPct === 'number' && fiveHourRemainingPct > 0 && burnRate5hPerHour > 0.2
      ? Number((fiveHourRemainingPct / burnRate5hPerHour).toFixed(1))
      : null;
  const estDepleteWeeklyDays =
    typeof weeklyRemainingPct === 'number' && weeklyRemainingPct > 0 && blendedPerAcctDailyWeeklyRate > 0.2
      ? Number((weeklyRemainingPct / blendedPerAcctDailyWeeklyRate).toFixed(1))
      : null;

  const fiveHourSafeUntilReset = Boolean(
    typeof fiveHourRemainingPct === 'number' &&
      fiveHourRemainingPct > 0 &&
      (estDeplete5hHours === null || estDeplete5hHours >= hoursTo5hReset)
  );
  const weeklySafeUntilReset = Boolean(
    typeof weeklyRemainingPct === 'number' &&
      weeklyRemainingPct > 0 &&
      (estDepleteWeeklyDays === null || estDepleteWeeklyDays >= daysToNextWeeklyReset)
  );

  return {
    month5hConsumedPct: Math.round(month5hUsedPct),
    monthWeeklyConsumedPct: Math.round(monthWeeklyUsedPct),
    monthFiveHourResets: monthPoolStat?.fiveHourResets || 0,
    monthWeeklyResets: monthPoolStat?.weeklyResets || 0,
    weekProjectedPct,
    weekProjectedTokens,
    weekProjectedCostUsd,
    monthProjectedWeeklyPct,
    monthProjectedTokens,
    monthProjectedCostUsd,
    monthTotalWeeklyCapacity,
    monthProjectedUtilPct,
    monthProjected5hCycles,
    weeklyDailyRatePct: Number(blendedPerAcctDailyWeeklyRate.toFixed(1)),
    burnRate5hPerHour: Number(burnRate5hPerHour.toFixed(1)),
    hoursTo5hReset: Number(hoursTo5hReset.toFixed(1)),
    daysToNextWeeklyReset: Number(daysToNextWeeklyReset.toFixed(1)),
    remainingMonthDays: Number(remainingMonthDays.toFixed(1)),
    fiveHourSafeUntilReset,
    weeklySafeUntilReset,
    paceTrend,
    estDeplete5hHours,
    estDepleteWeeklyDays
  };
}

export function createUsageAnalytics({ getDatabaseSync, conversationsDir, userDir, nowFn = () => Date.now() } = {}) {
  const fileCache = new Map(); // dbPath -> { sig, events }

  function scanAllEvents({ force = false } = {}) {
    const DatabaseSync = typeof getDatabaseSync === 'function' ? getDatabaseSync() : null;
    if (!DatabaseSync) return [];
    if (force) fileCache.clear();

    const seenPaths = new Set();
    const allEvents = [];

    const convDirs = [];
    if (conversationsDir && fs.existsSync(conversationsDir)) {
      convDirs.push(conversationsDir);
      if (path.basename(path.dirname(conversationsDir)).toLowerCase() === 'antigravity') {
        const cliConvDir = path.join(path.dirname(path.dirname(conversationsDir)), 'antigravity-cli', 'conversations');
        if (fs.existsSync(cliConvDir) && cliConvDir !== conversationsDir) {
          convDirs.push(cliConvDir);
        }
      }
    }

    const seenEventKeys = new Set();
    for (const dir of convDirs) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.db')) continue;
        const dbPath = path.join(dir, ent.name);
        seenPaths.add(dbPath);

        const st = fs.statSync(dbPath, { throwIfNoEntry: false });
        if (!st) continue;
        const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
        const sig = `${st.mtimeMs}:${st.size}|${wst ? `${wst.mtimeMs}:${wst.size}` : '0:0'}`;

        let cached = fileCache.get(dbPath);
        if (!cached || cached.sig !== sig) {
          const cid = path.basename(dbPath, '.db');
          const events = extractDbEvents(dbPath, DatabaseSync, st.mtimeMs, cid);
          cached = { sig, events };
          fileCache.set(dbPath, cached);
        }
        for (const ev of cached.events) {
          const dedupeKey = `${ev.cid}:${ev.genIdx}:${ev.ts}`;
          if (!seenEventKeys.has(dedupeKey)) {
            seenEventKeys.add(dedupeKey);
            allEvents.push(ev);
          }
        }
      }
    }

    for (const k of fileCache.keys()) {
      if (!seenPaths.has(k)) fileCache.delete(k);
    }
    return allEvents;
  }

  function computeStreaks(heatmap, nowMs) {
    let currentStreakDays = 0;
    let longestStreakDays = 0;
    let peakDayTokens = 0;
    let peakDayDate = '';
    let run = 0;
    for (const c of heatmap) {
      if (c.tokens > peakDayTokens) {
        peakDayTokens = c.tokens;
        peakDayDate = c.date;
      }
      if (c.tokens > 0 || c.requests > 0) {
        run += 1;
        if (run > longestStreakDays) longestStreakDays = run;
      } else {
        run = 0;
      }
    }
    // Current streak counts backwards from today (allowing today to be 0 if yesterday was active)
    const todayYmd = formatLocalYmd(nowMs);
    for (let i = heatmap.length - 1; i >= 0; i--) {
      const c = heatmap[i];
      if (c.tokens > 0 || c.requests > 0) {
        currentStreakDays += 1;
      } else if (c.date === todayYmd && currentStreakDays === 0) {
        continue;
      } else {
        break;
      }
    }
    return { currentStreakDays, longestStreakDays, peakDayTokens, peakDayDate };
  }

  function getDashboardData({ range = 'month', account = 'all', heatmapDays = 365, reqLimit = 2000, force = false } = {}) {
    const nowMs = nowFn();
    const startMs = getRangeStartMs(range, nowMs);
    const todayStartMs = getRangeStartMs('today', nowMs);
    const weekStartMs = getRangeStartMs('week', nowMs);
    const monthStartMs = getRangeStartMs('month', nowMs);
    const accountFilter = account === 'all' || !account ? 'all' : normalizeCredEmail(account) || account;

    const accountsStore = readJsonSafe(path.join(userDir, 'accounts.json'), {});
    const savedAccounts = Array.isArray(accountsStore.accounts) ? accountsStore.accounts : [];
    const activeAcct = savedAccounts.find((a) => a.id === accountsStore.activeId) || null;
    const fallbackEmail = activeAcct?.email || (savedAccounts[0]?.email || 'default');

    const rawTimeline = readJsonSafe(path.join(userDir, 'account-timeline.json'), []);
    const timeline = (Array.isArray(rawTimeline) ? rawTimeline : [])
      .filter((e) => e && e.email && Number.isFinite(e.sinceMs))
      .sort((a, b) => a.sinceMs - b.sinceMs);

    const rawSamples = readJsonSafe(path.join(userDir, 'quota-samples.json'), []);
    const samples = Array.isArray(rawSamples) ? rawSamples : [];

    const events = scanAllEvents({ force });

    const summary = {
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheHitPct: 0,
      requests: 0,
      activeDays: 0,
      estCostUsd: 0,
      cacheSavedUsd: 0,
      avgTps: 0,
      quota5hConsumedPct: 0,
      quotaWeeklyConsumedPct: 0,
      quotaResets: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      peakDayDate: '',
      todayTokens: 0,
      todayCostUsd: 0,
      monthTokens: 0,
      monthCostUsd: 0
    };

    const acctMap = new Map();
    const allAcctMap = new Map();
    const modelMap = new Map();
    const dailyMap = new Map();
    const weeklyMap = new Map();
    const monthlyMap = new Map();
    const filteredForExtras = [];
    const heatmapMap = new Map();
    const poolWeekTotals = new Map();
    const poolMonthTotals = new Map();
    const poolEventTs = new Map();
    const preTimelinePoolEventTs = new Map();
    const timelineFirstMs = timeline[0]?.sinceMs || 0;
    const monthActiveDaysSet = new Set();

    const heatSpanDays = Math.max(30, Math.min(365, Number(heatmapDays) || 365));
    const heatStartMs = new Date(
      new Date(nowMs).getFullYear(),
      new Date(nowMs).getMonth(),
      new Date(nowMs).getDate() - (heatSpanDays - 1)
    ).getTime();

    let tpsSum = 0;
    let tpsCount = 0;
    const foundEmails = new Set();
    if (fallbackEmail && fallbackEmail !== 'default') foundEmails.add(normalizeCredEmail(fallbackEmail));
    for (const a of savedAccounts) if (a?.email) foundEmails.add(normalizeCredEmail(a.email));

    for (const ev of events) {
      const totalTok = ev.inputTokens + ev.cacheReadTokens + ev.outputTokens;
      const evEmail = resolveAccountAtTimestamp(ev.ts, timeline, fallbackEmail);
      if (evEmail && evEmail !== 'default') foundEmails.add(normalizeCredEmail(evEmail) || evEmail);

      const { costUsd, savedUsd } = estimateRequestCostUsd(ev.model, ev);
      const ymd = formatLocalYmd(ev.ts);

      if (timelineFirstMs > 0 && ev.ts >= startMs && ev.ts < timelineFirstMs) {
        const prePool = classifyModelQuotaPool(ev.model);
        if (!preTimelinePoolEventTs.has(prePool)) preTimelinePoolEventTs.set(prePool, []);
        preTimelinePoolEventTs.get(prePool).push(ev.ts);
      }

      if (ev.ts >= heatStartMs && (accountFilter === 'all' || evEmail === accountFilter)) {
        const evPool = classifyModelQuotaPool(ev.model);
        if (ev.ts >= weekStartMs) {
          const wt = poolWeekTotals.get(evPool) || { tokens: 0, costUsd: 0 };
          wt.tokens += totalTok;
          wt.costUsd += costUsd;
          poolWeekTotals.set(evPool, wt);
        }
        if (ev.ts >= monthStartMs) {
          const mt = poolMonthTotals.get(evPool) || { tokens: 0, costUsd: 0 };
          mt.tokens += totalTok;
          mt.costUsd += costUsd;
          poolMonthTotals.set(evPool, mt);
          monthActiveDaysSet.add(ymd);
        }
        if (ev.ts >= todayStartMs) {
          summary.todayTokens += totalTok;
          summary.todayCostUsd += costUsd;
        }
        if (ev.ts >= monthStartMs) {
          summary.monthTokens += totalTok;
          summary.monthCostUsd += costUsd;
        }
        if (!heatmapMap.has(ymd)) {
          heatmapMap.set(ymd, {
            date: ymd,
            tokens: 0,
            outputTokens: 0,
            requests: 0,
            costUsd: 0,
            quotaDropPct: 0,
            byModel: {},
            byAccount: {}
          });
        }
        const hDay = heatmapMap.get(ymd);
        hDay.tokens += totalTok;
        hDay.outputTokens += ev.outputTokens;
        hDay.requests += 1;
        hDay.costUsd += costUsd;
        hDay.byModel[ev.model] = (hDay.byModel[ev.model] || 0) + totalTok;
        hDay.byAccount[evEmail] = (hDay.byAccount[evEmail] || 0) + totalTok;

        const wk = getIsoWeekKey(ev.ts);
        if (!weeklyMap.has(wk)) {
          weeklyMap.set(wk, { weekKey: wk, requests: 0, totalTokens: 0, outputTokens: 0, estCostUsd: 0, quotaDropPct: 0 });
        }
        const wAgg = weeklyMap.get(wk);
        wAgg.requests += 1;
        wAgg.totalTokens += totalTok;
        wAgg.outputTokens += ev.outputTokens;
        wAgg.estCostUsd += costUsd;

        const mk = ymd.slice(0, 7);
        if (!monthlyMap.has(mk)) {
          monthlyMap.set(mk, { monthKey: mk, requests: 0, totalTokens: 0, outputTokens: 0, estCostUsd: 0, quotaDropPct: 0 });
        }
        const mAgg = monthlyMap.get(mk);
        mAgg.requests += 1;
        mAgg.totalTokens += totalTok;
        mAgg.outputTokens += ev.outputTokens;
        mAgg.estCostUsd += costUsd;
      }

      if (ev.ts >= startMs && (accountFilter === 'all' || evEmail === accountFilter)) {
        const evPool = classifyModelQuotaPool(ev.model);
        if (!poolEventTs.has(evPool)) poolEventTs.set(evPool, []);
        poolEventTs.get(evPool).push(ev.ts);
      }

      if (ev.ts < startMs) continue;

      if (!allAcctMap.has(evEmail)) {
        const meta = savedAccounts.find((a) => normalizeCredEmail(a.email) === evEmail);
        allAcctMap.set(evEmail, {
          email: evEmail,
          planName: meta?.planName || '',
          lastQuota: meta?.lastQuota || null,
          requests: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estCostUsd: 0
        });
      }
      const allAccAgg = allAcctMap.get(evEmail);
      allAccAgg.requests += 1;
      allAccAgg.inputTokens += ev.inputTokens;
      allAccAgg.cacheReadTokens += ev.cacheReadTokens;
      allAccAgg.outputTokens += ev.outputTokens;
      allAccAgg.totalTokens += totalTok;
      allAccAgg.estCostUsd += costUsd;

      if (accountFilter !== 'all' && evEmail !== accountFilter) continue;

      summary.requests += 1;
      summary.inputTokens += ev.inputTokens;
      summary.cacheReadTokens += ev.cacheReadTokens;
      summary.outputTokens += ev.outputTokens;
      summary.thinkingTokens += ev.thinkingTokens;
      summary.totalTokens += totalTok;
      summary.estCostUsd += costUsd;
      summary.cacheSavedUsd += savedUsd;
      if (ev.tps) {
        tpsSum += ev.tps;
        tpsCount += 1;
      }

      if (!acctMap.has(evEmail)) {
        const meta = savedAccounts.find((a) => normalizeCredEmail(a.email) === evEmail);
        acctMap.set(evEmail, {
          email: evEmail,
          planName: meta?.planName || '',
          lastQuota: meta?.lastQuota || null,
          requests: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estCostUsd: 0
        });
      }
      const accAgg = acctMap.get(evEmail);
      accAgg.requests += 1;
      accAgg.inputTokens += ev.inputTokens;
      accAgg.cacheReadTokens += ev.cacheReadTokens;
      accAgg.outputTokens += ev.outputTokens;
      accAgg.totalTokens += totalTok;
      accAgg.estCostUsd += costUsd;

      filteredForExtras.push({
        id: `${ev.cid}:${ev.genIdx}:${ev.ts}`,
        cid: ev.cid,
        genIdx: ev.genIdx,
        ts: ev.ts,
        model: ev.model,
        role: ev.role || '',
        accountEmail: evEmail,
        inputTokens: ev.inputTokens,
        cacheWriteTokens: ev.cacheWriteTokens || 0,
        cacheReadTokens: ev.cacheReadTokens,
        outputTokens: ev.outputTokens,
        thinkingTokens: ev.thinkingTokens || 0,
        totalTokens: totalTok,
        costUsd,
        savedUsd,
        tps: ev.tps || 0,
        ttft: ev.ttft || 0,
        stream: ev.stream || 0,
        totDur: ev.totDur || 0,
        maxCtx: ev.maxCtx || 0,
        errCode: ev.errCode || 0,
        errMsg: ev.errMsg || '',
        isError: Boolean(ev.errCode && ev.errCode !== 0)
      });

      const modKey = ev.model;
      if (!modelMap.has(modKey)) {
        modelMap.set(modKey, {
          model: ev.model,
          quotaPool: classifyModelQuotaPool(ev.model),
          requests: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estCostUsd: 0
        });
      }
      const modAgg = modelMap.get(modKey);
      modAgg.requests += 1;
      modAgg.inputTokens += ev.inputTokens;
      modAgg.cacheReadTokens += ev.cacheReadTokens;
      modAgg.outputTokens += ev.outputTokens;
      modAgg.totalTokens += totalTok;
      modAgg.estCostUsd += costUsd;

      if (!dailyMap.has(ymd)) {
        dailyMap.set(ymd, { date: ymd, requests: 0, totalTokens: 0, outputTokens: 0, estCostUsd: 0, quotaDropPct: 0 });
      }
      const dAgg = dailyMap.get(ymd);
      dAgg.requests += 1;
      dAgg.totalTokens += totalTok;
      dAgg.outputTokens += ev.outputTokens;
      dAgg.estCostUsd += costUsd;
    }

    const qStats = computeQuotaStats(samples, { startMs, accountFilter, nowMs });
    const monthQStats = computeQuotaStats(samples, { startMs: monthStartMs, accountFilter, nowMs });
    const heatQStats = computeQuotaStats(samples, { startMs: heatStartMs, accountFilter, nowMs });

    summary.quota5hConsumedPct = Math.round(qStats.quota5hConsumedPct);
    summary.quotaWeeklyConsumedPct = Math.round(qStats.quotaWeeklyConsumedPct);
    summary.quotaResets = qStats.quotaResets;

    for (const [ymd, drop] of qStats.dailyQuotaDrop.entries()) {
      if (dailyMap.has(ymd)) dailyMap.get(ymd).quotaDropPct += Math.round(drop);
    }
    for (const [ymd, drop] of heatQStats.dailyQuotaDrop.entries()) {
      if (heatmapMap.has(ymd)) heatmapMap.get(ymd).quotaDropPct += Math.round(drop);
      const dt = new Date(ymd + 'T12:00:00').getTime();
      const wk = getIsoWeekKey(dt);
      if (weeklyMap.has(wk)) weeklyMap.get(wk).quotaDropPct += Math.round(drop);
      const mk = ymd.slice(0, 7);
      if (monthlyMap.has(mk)) monthlyMap.get(mk).quotaDropPct += Math.round(drop);
    }

    const totalPromptTok = summary.inputTokens + summary.cacheReadTokens;
    summary.cacheHitPct = totalPromptTok > 0 ? Number(((summary.cacheReadTokens / totalPromptTok) * 100).toFixed(1)) : 0;
    summary.activeDays = dailyMap.size;
    summary.avgTps = tpsCount > 0 ? Number((tpsSum / tpsCount).toFixed(1)) : 0;
    summary.estCostUsd = Number(summary.estCostUsd.toFixed(4));
    summary.cacheSavedUsd = Number(summary.cacheSavedUsd.toFixed(4));

    const allAccountQStats = computeQuotaStats(samples, { startMs, accountFilter: 'all', nowMs });
    const activeAcctEmailNorm = activeAcct ? normalizeCredEmail(activeAcct.email) : '';

    for (const sa of savedAccounts) {
      const em = normalizeCredEmail(sa?.email);
      if (!em || allAcctMap.has(em)) continue;
      allAcctMap.set(em, {
        email: em,
        planName: sa?.planName || '',
        lastQuota: sa?.lastQuota || null,
        requests: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estCostUsd: 0
      });
    }

    const extractPrimaryFiveHourPct = (accMeta, em) => {
      const groups = Array.isArray(accMeta?.lastQuota?.groups) ? accMeta.lastQuota.groups : [];
      const gem = groups.find((g) => g?.key === 'gemini') || groups[0];
      if (typeof gem?.fiveHour?.remainingPct === 'number') return gem.fiveHour.remainingPct;
      const gemSnap = allAccountQStats.perPool.get('gemini')?.accountSnapshots?.get(em);
      if (typeof gemSnap?.fiveHourPct === 'number') return gemSnap.fiveHourPct;
      return null;
    };

    const accountComparison = [...allAcctMap.values()]
      .map((a) => {
        const pt = a.inputTokens + a.cacheReadTokens;
        const qs = allAccountQStats.perAccount.get(a.email) || { fiveHourDrop: 0, weeklyDrop: 0, resets: 0 };
        return {
          ...a,
          isCurrent: Boolean(activeAcctEmailNorm && a.email === activeAcctEmailNorm),
          fiveHourRemainingPct: extractPrimaryFiveHourPct(a, a.email),
          cacheHitPct: pt > 0 ? Number(((a.cacheReadTokens / pt) * 100).toFixed(1)) : 0,
          estCostUsd: Number(a.estCostUsd.toFixed(4)),
          quota5hConsumedPct: Math.round(qs.fiveHourDrop),
          quotaWeeklyConsumedPct: Math.round(qs.weeklyDrop),
          quotaResets: qs.resets
        };
      })
      .sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || b.totalTokens - a.totalTokens);

    const accounts = [...acctMap.values()]
      .map((a) => {
        const pt = a.inputTokens + a.cacheReadTokens;
        const qs = qStats.perAccount.get(a.email) || { fiveHourDrop: 0, weeklyDrop: 0, resets: 0 };
        return {
          ...a,
          cacheHitPct: pt > 0 ? Number(((a.cacheReadTokens / pt) * 100).toFixed(1)) : 0,
          estCostUsd: Number(a.estCostUsd.toFixed(4)),
          quota5hConsumedPct: Math.round(qs.fiveHourDrop),
          quotaWeeklyConsumedPct: Math.round(qs.weeklyDrop),
          quotaResets: qs.resets
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const models = [...modelMap.values()]
      .map((m) => {
        const pt = m.inputTokens + m.cacheReadTokens;
        return {
          ...m,
          cacheHitPct: pt > 0 ? Number(((m.cacheReadTokens / pt) * 100).toFixed(1)) : 0,
          estCostUsd: Number(m.estCostUsd.toFixed(4)),
          sharePct: summary.totalTokens > 0 ? Number(((m.totalTokens / summary.totalTokens) * 100).toFixed(1)) : 0
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    let maxTok = 0;
    let maxCost = 0;
    let maxReq = 0;
    let maxQuota = 0;
    for (const d of heatmapMap.values()) {
      if (d.tokens > maxTok) maxTok = d.tokens;
      if (d.costUsd > maxCost) maxCost = d.costUsd;
      if (d.requests > maxReq) maxReq = d.requests;
      if (d.quotaDropPct > maxQuota) maxQuota = d.quotaDropPct;
    }

    const heatmap = [];
    const cursor = new Date(heatStartMs);
    for (let i = 0; i < heatSpanDays; i++) {
      const ymd = formatLocalYmd(cursor.getTime());
      const cell = heatmapMap.get(ymd) || {
        date: ymd,
        tokens: 0,
        outputTokens: 0,
        requests: 0,
        costUsd: 0,
        quotaDropPct: 0,
        byModel: {},
        byAccount: {}
      };
      heatmap.push({
        ...cell,
        costUsd: Number(cell.costUsd.toFixed(4)),
        levels: {
          tokens: assignHeatmapLevel(cell.tokens, maxTok),
          cost: assignHeatmapLevel(cell.costUsd, maxCost),
          requests: assignHeatmapLevel(cell.requests, maxReq),
          quota: assignHeatmapLevel(cell.quotaDropPct, maxQuota)
        }
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    const streaks = computeStreaks(heatmap, nowMs);
    summary.currentStreakDays = streaks.currentStreakDays;
    summary.longestStreakDays = streaks.longestStreakDays;
    summary.peakDayTokens = streaks.peakDayTokens;
    summary.peakDayDate = streaks.peakDayDate;

    // Resolve per-model-pool real-time quota + monthly projection
    const targetAcctObj =
      accountFilter !== 'all'
        ? savedAccounts.find((a) => normalizeCredEmail(a.email) === accountFilter) || null
        : activeAcct;
    const poolKeys = new Set([...qStats.perPool.keys(), ...monthQStats.perPool.keys()]);
    const targetGroups = Array.isArray(targetAcctObj?.lastQuota?.groups) ? targetAcctObj.lastQuota.groups : [];
    for (const g of targetGroups) {
      if (g?.key) poolKeys.add(g.key === 'claude' ? 'claude-gpt' : g.key);
    }
    const poolRank = (k) => (k === 'gemini' ? 0 : k === 'claude-gpt' ? 1 : 2);
    const poolLabelMap = { gemini: 'Gemini', 'claude-gpt': 'Claude / GPT' };

    const activeAccountCount = accountFilter === 'all' ? Math.max(1, savedAccounts.filter((a) => !a.disabled).length) : 1;

    const quotaByPool = [...poolKeys]
      .filter(Boolean)
      .map((poolKey) => {
        const ps = qStats.perPool.get(poolKey) || {
          fiveHourDrop: 0,
          weeklyDrop: 0,
          fiveHourResets: 0,
          weeklyResets: 0,
          resets: 0,
          latestFiveHourPct: null,
          latestWeeklyPct: null,
          latestFiveHourReset: '',
          latestWeeklyReset: '',
          accountSnapshots: new Map()
        };
        const mPs = monthQStats.perPool.get(poolKey) || ps;
        const liveGroup = targetGroups.find((g) => (g.key === 'claude' ? 'claude-gpt' : g.key) === poolKey);

        // When accountFilter === 'all', compute average remaining across participating accounts or fallback to active
        let fiveHourRemainingPct =
          typeof liveGroup?.fiveHour?.remainingPct === 'number' ? liveGroup.fiveHour.remainingPct : ps.latestFiveHourPct;
        let weeklyRemainingPct =
          typeof liveGroup?.weekly?.remainingPct === 'number' ? liveGroup.weekly.remainingPct : ps.latestWeeklyPct;
        if (accountFilter === 'all' && savedAccounts.length > 1) {
          const enabledAccts = savedAccounts.filter((a) => !a.disabled);
          const fhVals = [];
          const wkVals = [];
          for (const acc of enabledAccts) {
            const accGroups = Array.isArray(acc.lastQuota?.groups) ? acc.lastQuota.groups : [];
            const g = accGroups.find((x) => (x.key === 'claude' ? 'claude-gpt' : x.key) === poolKey);
            const snap = mPs.accountSnapshots?.get(normalizeCredEmail(acc.email));
            const fh = typeof g?.fiveHour?.remainingPct === 'number' ? g.fiveHour.remainingPct : snap?.fiveHourPct;
            const wk = typeof g?.weekly?.remainingPct === 'number' ? g.weekly.remainingPct : snap?.weeklyPct;
            if (typeof fh === 'number') fhVals.push(fh);
            if (typeof wk === 'number') wkVals.push(wk);
          }
          if (fhVals.length > 0) fiveHourRemainingPct = Math.round(fhVals.reduce((a, b) => a + b, 0) / fhVals.length);
          if (wkVals.length > 0) weeklyRemainingPct = Math.round(wkVals.reduce((a, b) => a + b, 0) / wkVals.length);
        }

        const fiveHourResetTime = liveGroup?.fiveHour?.resetTime || ps.latestFiveHourReset || '';
        const weeklyResetTime = liveGroup?.weekly?.resetTime || ps.latestWeeklyReset || '';

        const poolModels = models.filter((m) => m.quotaPool === poolKey);
        const requests = poolModels.reduce((s, m) => s + (m.requests || 0), 0);
        const totalTokens = poolModels.reduce((s, m) => s + (m.totalTokens || 0), 0);
        const estCostUsd = Number(poolModels.reduce((s, m) => s + (m.estCostUsd || 0), 0).toFixed(4));
        const fiveHourConsumedPct = Math.round(ps.fiveHourDrop);
        const weeklyConsumedPct = Math.round(ps.weeklyDrop);
        const tokensPerPct = fiveHourConsumedPct > 0 && totalTokens > 0 ? Math.round(totalTokens / fiveHourConsumedPct) : 0;

        const inferredResets = inferPreSampleResets({
          eventTimestamps: poolEventTs.get(poolKey) || [],
          preTimelineEventTimestamps: preTimelinePoolEventTs.get(poolKey) || [],
          firstSampleTs: ps.firstSampleTs || 0,
          firstSampleWeeklyPct: ps.firstSampleWeeklyPct ?? null,
          startMs,
          fiveHourResetTime,
          weeklyResetTime
        });
        const sampledFiveHourResets = ps.fiveHourResets || 0;
        const sampledWeeklyResets = ps.weeklyResets || 0;
        const totalFiveHourResets = sampledFiveHourResets + inferredResets.fiveHourResets;
        const totalWeeklyResets = sampledWeeklyResets + inferredResets.weeklyResets;

        const weeklyResetMs = weeklyResetTime ? Date.parse(weeklyResetTime) : NaN;
        const rollingWkStartMs =
          Number.isFinite(weeklyResetMs) && weeklyResetMs > nowMs ? weeklyResetMs - 7 * DAY_MS : weekStartMs;
        let rollingWkTokens = 0;
        let rollingWkCostUsd = 0;
        for (const ev of events) {
          if (ev.ts < rollingWkStartMs) continue;
          if (classifyModelQuotaPool(ev.model) !== poolKey) continue;
          const evEmail = resolveAccountAtTimestamp(ev.ts, timeline, fallbackEmail);
          if (accountFilter !== 'all' && evEmail !== accountFilter) continue;
          rollingWkTokens += ev.inputTokens + ev.cacheReadTokens + ev.outputTokens;
          rollingWkCostUsd += estimateRequestCostUsd(ev.model, ev).costUsd;
        }
        const curWkBase =
          rollingWkTokens > 0
            ? { tokens: rollingWkTokens, costUsd: rollingWkCostUsd }
            : poolWeekTotals.get(poolKey) || { tokens: totalTokens, costUsd: estCostUsd };
        const monthBase = poolMonthTotals.get(poolKey) || { tokens: totalTokens, costUsd: estCostUsd };

        const projection = projectPoolMonthlyQuota({
          monthPoolStat: mPs,
          poolTokens: totalTokens,
          poolCostUsd: estCostUsd,
          curWeekPoolTokens: curWkBase.tokens,
          curWeekPoolCostUsd: curWkBase.costUsd,
          monthPoolTokens: monthBase.tokens,
          monthPoolCostUsd: monthBase.costUsd,
          activeDaysInMonth: monthActiveDaysSet.size,
          fiveHourRemainingPct,
          weeklyRemainingPct,
          fiveHourResetTime,
          weeklyResetTime,
          accountCount: activeAccountCount,
          nowMs
        });

        return {
          key: poolKey,
          label: liveGroup?.label || poolLabelMap[poolKey] || poolKey,
          fiveHourConsumedPct,
          weeklyConsumedPct,
          fiveHourResets: totalFiveHourResets,
          weeklyResets: totalWeeklyResets,
          sampledFiveHourResets,
          sampledWeeklyResets,
          inferredFiveHourResets: inferredResets.fiveHourResets,
          inferredWeeklyResets: inferredResets.weeklyResets,
          resets: totalFiveHourResets + totalWeeklyResets,
          fiveHourRemainingPct,
          weeklyRemainingPct,
          fiveHourResetTime,
          weeklyResetTime,
          requests,
          totalTokens,
          estCostUsd,
          tokensPerPct,
          models: poolModels.slice(0, 4).map((m) => ({
            model: m.model,
            totalTokens: m.totalTokens,
            sharePct: totalTokens > 0 ? Math.round((m.totalTokens / totalTokens) * 100) : 0
          })),
          projection
        };
      })
      .sort((a, b) => poolRank(a.key) - poolRank(b.key) || b.totalTokens - a.totalTokens);

    // Attach monthly projected quota consumption estimate per individual model proportionally within its pool
    const poolByKey = new Map(quotaByPool.map((p) => [p.key, p]));
    const enrichedModels = models.map((m) => {
      const p = poolByKey.get(m.quotaPool);
      if (!p || !p.totalTokens || !p.projection) {
        return { ...m, estMonthWeeklyQuotaPct: 0, estMonth5hCycles: 0 };
      }
      const inPoolShare = m.totalTokens / p.totalTokens;
      return {
        ...m,
        estMonthWeeklyQuotaPct: Math.round(p.projection.monthProjectedWeeklyPct * inPoolShare),
        estMonth5hCycles: Number((p.projection.monthProjected5hCycles * inPoolShare).toFixed(1))
      };
    });

    // Build Powertools-inspired 32-pt sparkline, cache-drop annotations & model health timeline
    const spLen = 32;
    const sparkline = Array.from({ length: spLen }, () => ({ requests: 0, tokens: 0, costUsd: 0 }));
    const spMinTs = startMs > 0 ? startMs : filteredForExtras.reduce((m, e) => (e.ts < m ? e.ts : m), nowMs - 7 * 86400000);
    const spWidth = Math.max(1, nowMs - spMinTs);
    let errorCount = 0;

    // Annotate cache drops (180s max gap, exclude compaction via minKeepRatio=0.6)
    const orderedReqs = filteredForExtras.slice().sort((a, b) => a.ts - b.ts);
    const anomalyMap = new Map();
    const lastByModel = new Map();
    const healthByModel = new Map();
    for (const r of orderedReqs) {
      if (r.isError) errorCount++;
      const idx = Math.min(spLen - 1, Math.max(0, Math.floor(((r.ts - spMinTs) / spWidth) * spLen)));
      sparkline[idx].requests += 1;
      sparkline[idx].tokens += r.totalTokens;
      sparkline[idx].costUsd += r.costUsd;

      if (!healthByModel.has(r.model)) healthByModel.set(r.model, []);
      healthByModel.get(r.model).push(!r.isError);

      if (!r.isError && r.cid) {
        const key = `${r.cid}::${r.model}`;
        const curInTot = r.inputTokens + r.cacheReadTokens;
        const curHit = curInTot > 0 ? Number(((r.cacheReadTokens / curInTot) * 100).toFixed(1)) : null;
        const prev = lastByModel.get(key);
        if (prev && curHit !== null && curInTot >= 4000 && curInTot >= prev.totalIn * 0.6) {
          const gap = r.ts - prev.ts;
          if (gap >= 0 && gap <= 180000 && prev.cache >= 4000 && prev.hit >= 50) {
            if (r.cacheReadTokens === 0) {
              anomalyMap.set(r.id, { kind: 'cleared', prevHit: prev.hit, curHit: 0 });
            } else if (prev.hit - curHit >= 40 && curHit < 20 && r.cacheReadTokens < prev.cache * 0.5) {
              anomalyMap.set(r.id, { kind: 'dropped', prevHit: prev.hit, curHit });
            }
          }
        }
        if (curInTot >= 2000 && curHit !== null) {
          lastByModel.set(key, { ts: r.ts, cache: r.cacheReadTokens, hit: curHit, totalIn: curInTot });
        }
      }
    }

    const effReqLimit = Math.max(100, Math.min(5000, Number(reqLimit) || 2000));
    const totalRequestsCount = orderedReqs.length;
    const recentRequests = orderedReqs
      .slice(-effReqLimit)
      .reverse()
      .map((r) => {
        const inTot = r.inputTokens + r.cacheReadTokens;
        return {
          id: r.id,
          cid: r.cid,
          genIdx: r.genIdx,
          ts: r.ts,
          model: r.model,
          role: r.role || '',
          accountEmail: r.accountEmail,
          status: r.isError ? 'error' : 'success',
          tps: Number((r.tps || 0).toFixed(1)),
          ttftMs: Math.round((r.ttft || 0) * 1000),
          streamMs: Math.round((r.stream || 0) * 1000),
          totDurMs: Math.round((r.totDur || 0) * 1000),
          durationMs: Math.round(((r.totDur || (r.ttft || 0) + (r.stream || 0))) * 1000),
          inputTokens: r.inputTokens,
          cacheWriteTokens: r.cacheWriteTokens || 0,
          cacheReadTokens: r.cacheReadTokens,
          cacheHitPct: inTot > 0 ? Number(((r.cacheReadTokens / inTot) * 100).toFixed(1)) : null,
          outputTokens: r.outputTokens,
          thinkingTokens: r.thinkingTokens || 0,
          totalTokens: r.totalTokens,
          maxCtx: r.maxCtx || 0,
          costUsd: Number((r.costUsd || 0).toFixed(4)),
          cacheSavedUsd: Number((r.savedUsd || 0).toFixed(4)),
          errCode: r.errCode || 0,
          errMsg: r.errMsg || '',
          cacheAnomaly: anomalyMap.get(r.id) || null
        };
      });

    const modelHealth = [...healthByModel.entries()]
      .map(([model, arr]) => {
        const okCount = arr.filter(Boolean).length;
        const segs = [];
        const bucketCnt = Math.min(28, arr.length);
        for (let b = 0; b < bucketCnt; b++) {
          const sIdx = Math.floor((b * arr.length) / bucketCnt);
          const eIdx = Math.max(sIdx + 1, Math.floor(((b + 1) * arr.length) / bucketCnt));
          const slice = arr.slice(sIdx, eIdx);
          segs.push(slice.every(Boolean));
        }
        return {
          model,
          total: arr.length,
          successRate: arr.length > 0 ? Math.round((okCount / arr.length) * 100) : 100,
          segs
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    summary.errorCount = errorCount;

    return {
      ok: true,
      range,
      account: accountFilter,
      activeAccountEmail: activeAcct ? normalizeCredEmail(activeAcct.email) : fallbackEmail !== 'default' ? fallbackEmail : '',
      quotaByPool,
      generatedAt: nowMs,
      availableAccounts: [...foundEmails].filter(Boolean).sort(),
      summary,
      sparkline,
      recentRequests,
      totalRequestsCount,
      modelHealth,
      accounts,
      accountComparison,
      models: enrichedModels,
      daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      weekly: [...weeklyMap.values()].sort((a, b) => a.weekKey.localeCompare(b.weekKey)),
      monthly: [...monthlyMap.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey)),
      heatmap
    };
  }

  return {
    getDashboardData
  };
}
