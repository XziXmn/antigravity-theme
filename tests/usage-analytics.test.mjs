/**
 * tests/usage-analytics.test.mjs — Unit tests for Usage Analytics, Quota Reset Accounting & Monthly Projection
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  estimateRequestCostUsd,
  resolveAccountAtTimestamp,
  sanitizePoolSeries,
  detectWindowReset,
  inferPreSampleResets,
  computeQuotaStats,
  projectPoolMonthlyQuota,
  createUsageAnalytics
} from '../core/daemon/usage-analytics.mjs';

function encodeVarint(num) {
  const bytes = [];
  let n = BigInt(num);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNum, val) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(val)]);
}

function buildGenMetaBlob({ inputTokens, cacheReadTokens, outputTokens, modelName, stepIdx = 0, errCode = 0 }) {
  const usage = Buffer.concat([
    encodeVarintField(2, inputTokens),
    encodeVarintField(3, outputTokens),
    encodeVarintField(5, cacheReadTokens)
  ]);
  const ttft = encodeVarintField(1, 1);
  const stream = encodeVarintField(1, 2);
  const parts = [
    encodeBytes(4, usage),
    encodeBytes(11, ttft),
    encodeBytes(12, stream),
    encodeBytes(21, Buffer.from(modelName, 'utf8'))
  ];
  if (errCode) parts.push(encodeBytes(17, encodeVarintField(5, errCode)));
  const chat = Buffer.concat(parts);
  return Buffer.concat([encodeBytes(1, chat), encodeVarintField(2, stepIdx)]);
}

function buildStepMetaBlob(ms) {
  const sec = Math.floor(ms / 1000);
  const tsMsg = encodeVarintField(1, sec);
  return encodeBytes(1, tsMsg);
}

test('estimateRequestCostUsd and resolveAccountAtTimestamp compute accurate costs and attribution', () => {
  const { costUsd, savedUsd } = estimateRequestCostUsd('Gemini 4 Neon (High)', {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 100_000
  });
  assert.ok(Math.abs(costUsd - (1.25 + 0.31 + 1.0)) < 0.001);
  assert.ok(Math.abs(savedUsd - (1.25 - 0.31)) < 0.001);

  const timeline = [
    { email: 'a@test.com', sinceMs: 1000 },
    { email: 'b@test.com', sinceMs: 5000 }
  ];
  assert.equal(resolveAccountAtTimestamp(500, timeline), 'a@test.com');
  assert.equal(resolveAccountAtTimestamp(3000, timeline), 'a@test.com');
  assert.equal(resolveAccountAtTimestamp(5000, timeline), 'b@test.com');
  assert.equal(resolveAccountAtTimestamp(9000, timeline), 'b@test.com');
});

test('computeQuotaStats counts consumption across 5h and weekly resets accurately', () => {
  const t0 = Date.parse('2026-11-10T01:00:00.000Z');
  const h = 3_600_000;
  const samples = [
    // Window 1: drops 100 -> 20 (consumes 80% 5h, 15% weekly)
    { ts: t0, email: 'u@test.com', key: 'gemini', fiveHourPct: 100, fiveHourReset: '2026-11-10T06:00:00Z', weeklyPct: 100, weeklyReset: '2026-11-17T01:00:00Z' },
    { ts: t0 + 3 * h, email: 'u@test.com', key: 'gemini', fiveHourPct: 20, fiveHourReset: '2026-11-10T06:00:00Z', weeklyPct: 85, weeklyReset: '2026-11-17T01:00:00Z' },
    // 5h Reset happens -> sampled at 88% (already consumed 12% after reset), weekly continues down to 81% (+4%)
    { ts: t0 + 7 * h, email: 'u@test.com', key: 'gemini', fiveHourPct: 88, fiveHourReset: '2026-11-10T11:00:00Z', weeklyPct: 81, weeklyReset: '2026-11-17T01:00:00Z' },
    // Drops 88 -> 58 (+30% 5h), then next week resets weekly -> sampled at 90% (+10% new week)
    { ts: t0 + 9 * h, email: 'u@test.com', key: 'gemini', fiveHourPct: 58, fiveHourReset: '2026-11-10T11:00:00Z', weeklyPct: 75, weeklyReset: '2026-11-17T01:00:00Z' },
    { ts: t0 + 180 * h, email: 'u@test.com', key: 'gemini', fiveHourPct: 95, fiveHourReset: '2026-11-17T16:00:00Z', weeklyPct: 90, weeklyReset: '2026-11-24T01:00:00Z' }
  ];

  const stats = computeQuotaStats(samples, { startMs: 0, accountFilter: 'u@test.com', nowMs: t0 + 180 * h });
  // 5h drops: 80 + 12 (post reset1) + 30 + 5 (post reset2) = 127
  assert.equal(Math.round(stats.quota5hConsumedPct), 127);
  // Weekly drops: 15 + 4 + 6 + 10 (post weekly reset) = 35
  assert.equal(Math.round(stats.quotaWeeklyConsumedPct), 35);
  const gem = stats.perPool.get('gemini');
  assert.equal(gem.fiveHourResets, 2);
  assert.equal(gem.weeklyResets, 1);
});

test('projectPoolMonthlyQuota adapts monthly projection for velocity changes and reset limits', () => {
  const nowMs = new Date(2026, 10, 16, 12, 0, 0).getTime(); // Nov 16 (mid-month of 30d month)
  const slow = projectPoolMonthlyQuota({
    monthPoolStat: {
      weeklyDrop: 40,
      fiveHourDrop: 120,
      fiveHourResets: 2,
      weeklyResets: 0,
      recent24h5hDrop: 5,
      recent24hSpanHours: 20,
      firstSampleTs: new Date(2026, 10, 2, 0, 0, 0).getTime()
    },
    fiveHourRemainingPct: 95,
    weeklyRemainingPct: 60,
    weeklyResetTime: new Date(2026, 10, 20, 0, 0, 0).toISOString(),
    nowMs
  });
  const accel = projectPoolMonthlyQuota({
    monthPoolStat: {
      weeklyDrop: 40,
      fiveHourDrop: 120,
      fiveHourResets: 2,
      weeklyResets: 0,
      recent24h5hDrop: 90,
      recent24hSpanHours: 6,
      firstSampleTs: new Date(2026, 10, 2, 0, 0, 0).getTime()
    },
    poolTokens: 2400000,
    poolCostUsd: 3.6,
    fiveHourRemainingPct: 10,
    weeklyRemainingPct: 60,
    weeklyResetTime: new Date(2026, 10, 20, 0, 0, 0).toISOString(),
    nowMs
  });

  assert.equal(slow.paceTrend, 'cooling');
  assert.equal(accel.paceTrend, 'accelerating');
  assert.ok(accel.monthProjectedWeeklyPct > slow.monthProjectedWeeklyPct);
  assert.ok(accel.monthProjected5hCycles > slow.monthProjected5hCycles);
  assert.ok(accel.monthProjectedUtilPct > 0 && accel.monthProjectedUtilPct <= 100);
  assert.ok(accel.weekProjectedPct > 0 && accel.weekProjectedPct <= 100);
  assert.ok(accel.weekProjectedTokens > 2400000);
  assert.ok(accel.weekProjectedCostUsd > 3.6);
  assert.ok(accel.monthProjectedTokens >= accel.weekProjectedTokens);
  assert.ok(accel.monthProjectedCostUsd >= accel.weekProjectedCostUsd);
});

test('createUsageAnalytics aggregates SQLite DBs, per-pool projections, models, and heatmap cleanly', async () => {
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({ DatabaseSync: null }));
  if (!DatabaseSync) return;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ana-test-'));
  const convDir = path.join(tmpRoot, 'conversations');
  const userDir = path.join(tmpRoot, 'user');
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

  try {
    const nowMs = Date.parse('2026-11-26T12:00:00.000Z');
    const day1 = Date.parse('2026-11-24T10:00:00.000Z');
    const day2 = Date.parse('2026-11-26T10:00:00.000Z');

    const dbPath = path.join(convDir, '11111111-1111-1111-1111-111111111111.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);');
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db.prepare('INSERT INTO steps VALUES (1, 14, 3, ?)').run(buildStepMetaBlob(day1));
    db.prepare('INSERT INTO steps VALUES (2, 14, 3, ?)').run(buildStepMetaBlob(day2));
    db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
      buildGenMetaBlob({ inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 500, modelName: 'Gemini 4 Neon', stepIdx: 1 })
    );
    db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(
      buildGenMetaBlob({ inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 1000, modelName: 'Claude Opus 5.5', stepIdx: 2 })
    );
    db.close();

    fs.writeFileSync(
      path.join(userDir, 'account-timeline.json'),
      JSON.stringify([
        { email: 'alice@test.com', sinceMs: day1 - 1000 },
        { email: 'bob@test.com', sinceMs: day2 - 1000 }
      ])
    );
    fs.writeFileSync(
      path.join(userDir, 'quota-samples.json'),
      JSON.stringify([
        { ts: day1, email: 'alice@test.com', key: 'gemini', fiveHourPct: 100, weeklyPct: 100 },
        { ts: day1 + 600000, email: 'alice@test.com', key: 'gemini', fiveHourPct: 60, weeklyPct: 90 },
        { ts: day2, email: 'bob@test.com', key: 'gemini', fiveHourPct: 90, weeklyPct: 80 },
        { ts: day2 + 600000, email: 'bob@test.com', key: 'gemini', fiveHourPct: 70, weeklyPct: 75 },
        { ts: day2, email: 'bob@test.com', key: 'claude-gpt', fiveHourPct: 100, weeklyPct: 100 },
        { ts: day2 + 600000, email: 'bob@test.com', key: 'claude-gpt', fiveHourPct: 80, weeklyPct: 96 }
      ])
    );

    const analytics = createUsageAnalytics({
      getDatabaseSync: () => DatabaseSync,
      conversationsDir: convDir,
      userDir,
      nowFn: () => nowMs
    });

    const dashAll = analytics.getDashboardData({ range: 'month', account: 'all', heatmapDays: 90 });
    assert.equal(dashAll.ok, true);
    assert.equal(dashAll.summary.requests, 2);
    assert.equal(dashAll.summary.totalTokens, 16500);
    assert.equal(dashAll.summary.quota5hConsumedPct, 80); // gemini (40+20) + claude (20)
    assert.equal(dashAll.summary.quotaWeeklyConsumedPct, 19); // gemini (10+5) + claude (4)
    assert.equal(dashAll.quotaByPool.length, 2);
    const gemPool = dashAll.quotaByPool.find((p) => p.key === 'gemini');
    assert.ok(gemPool.projection && gemPool.projection.monthProjectedWeeklyPct >= 15);
    assert.equal(dashAll.models.length, 2);
    assert.ok(dashAll.models.every((m) => typeof m.estMonthWeeklyQuotaPct === 'number'));
    assert.equal(dashAll.heatmap.length, 90);

    const dashAlice = analytics.getDashboardData({ range: 'month', account: 'alice@test.com', heatmapDays: 90 });
    assert.equal(dashAlice.summary.requests, 1);
    assert.equal(dashAlice.summary.totalTokens, 5500);
    assert.equal(dashAlice.summary.quota5hConsumedPct, 40);
    assert.ok(Array.isArray(dashAlice.accountComparison) && dashAlice.accountComparison.length >= 2, 'accountComparison must retain all accounts even when filtered');
    assert.ok(dashAlice.accountComparison.some((a) => a.email === 'bob@test.com' && a.totalTokens === 11000));

    // Verify extractDbEvents preserves cid/genIdx so distinct DBs sharing identical timestamps are not deduped
    const dbPath2 = path.join(convDir, '22222222-2222-2222-2222-222222222222.db');
    const db2 = new DatabaseSync(dbPath2);
    db2.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);');
    db2.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db2.prepare('INSERT INTO steps VALUES (1, 14, 3, ?)').run(buildStepMetaBlob(day1));
    db2.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
      buildGenMetaBlob({ inputTokens: 500, cacheReadTokens: 1000, outputTokens: 200, modelName: 'Gemini 4 Hydrogen (High)', stepIdx: 1 })
    );
    db2.close();
    const dashAfter2 = analytics.getDashboardData({ range: 'month', account: 'all', heatmapDays: 90, force: true });
    assert.equal(dashAfter2.summary.requests, 3);
    assert.ok(dashAfter2.models.some((m) => m.model === 'Gemini 4 Hydrogen (High)' && m.requests === 1));

    // Stage 4: sparkline, recentRequests, modelHealth & summary.errorCount
    assert.ok(Array.isArray(dashAll.sparkline) && dashAll.sparkline.length > 0);
    assert.ok(Array.isArray(dashAll.recentRequests) && dashAll.recentRequests.length === 2);
    assert.equal(dashAll.totalRequestsCount, 2);
    assert.ok(dashAll.recentRequests[0].cacheAnomaly === null || typeof dashAll.recentRequests[0].cacheAnomaly === 'object');
    assert.ok(Array.isArray(dashAll.modelHealth) && dashAll.modelHealth.length > 0);
    assert.equal(typeof dashAll.summary.errorCount, 'number');
    assert.equal(typeof dashAll.summary.todayTokens, 'number');
    assert.equal(typeof dashAll.summary.monthTokens, 'number');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('usage-analytics keeps unlinked historical errors at neighbor timestamps and counts quota resets without false positives', async (t) => {
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    t.skip('node:sqlite unavailable');
    return;
  }
  const { DatabaseSync } = sqlite;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ua-err-'));
  try {
    const convDir = path.join(tmpRoot, 'conversations');
    const userDir = path.join(tmpRoot, 'user');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartSec = Math.floor(todayStart.getTime() / 1000) * 1000;
    const nowSec = Math.floor(Date.now() / 1000) * 1000;
    const tOld = Math.max(todayStartSec + 1000, nowSec - 4 * 3600 * 1000);
    const tNew = Math.max(tOld + 2000, nowSec - 5 * 60 * 1000);
    const db = new DatabaseSync(path.join(convDir, 'conv-err.db'));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);');
    db.prepare('INSERT INTO steps VALUES (0, ?)').run(buildStepMetaBlob(tOld));
    db.prepare('INSERT INTO steps VALUES (1, ?)').run(buildStepMetaBlob(tNew));
    // Valid old step at idx 0
    db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
      buildGenMetaBlob({ inputTokens: 100, cacheReadTokens: 200, outputTokens: 50, modelName: 'Gemini 4 Hydrogen (Medium)', stepIdx: 0 })
    );
    // Unlinked error row at idx 1 (stepIdx=999 not in steps) -> must inherit tOld, NOT tNew
    db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(
      buildGenMetaBlob({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, modelName: 'Gemini 4 Neon (High)', stepIdx: 999, errCode: 500 })
    );
    // Latest valid step at idx 2 -> tNew
    db.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(
      buildGenMetaBlob({ inputTokens: 200, cacheReadTokens: 300, outputTokens: 80, modelName: 'Gemini 4 Hydrogen (Medium)', stepIdx: 1 })
    );
    db.close();

    const ua = createUsageAnalytics({ getDatabaseSync: () => DatabaseSync, conversationsDir: convDir, userDir });
    const dash = ua.getDashboardData({ range: 'today', account: 'all', heatmapDays: 30, force: true });
    const errReq = dash.recentRequests.find((r) => r.status === 'error');
    assert.ok(errReq, 'error request must exist');
    assert.equal(errReq.ts, tOld, 'unlinked historical error must anchor to preceding tOld rather than latestStepMs');
    assert.equal(dash.recentRequests[0].status, 'success', 'latest request must stay at top');

    // Quota reset accuracy: small jitter within same reset window = 0 resets; real window jump = 1 reset
    const baseMs = Date.now() - 10 * 3600 * 1000;
    const qStats = computeQuotaStats(
      [
        { ts: baseMs, email: 'a@b.com', key: 'gemini', fiveHourPct: 80, fiveHourReset: '2026-11-27T05:00:00Z', weeklyPct: 60, weeklyReset: '2026-12-03T08:00:00Z' },
        { ts: baseMs + 10 * 60_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 82, fiveHourReset: '2026-11-27T05:00:00Z', weeklyPct: 60, weeklyReset: '2026-12-03T08:00:00Z' },
        { ts: baseMs + 4 * 3600_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 95, fiveHourReset: '2026-11-27T10:00:00Z', weeklyPct: 58, weeklyReset: '2026-12-03T08:00:00Z' }
      ],
      { accountFilter: 'a@b.com', nowMs: Date.now() }
    );
    assert.equal(qStats.perPool.get('gemini').fiveHourResets, 1);
    assert.equal(qStats.perPool.get('gemini').weeklyResets, 0);
    assert.ok(errReq.model === 'Gemini 4 Neon (High)' && typeof errReq.ttftMs === 'number' && typeof errReq.thinkingTokens === 'number');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('sanitizePoolSeries filters cross-account glitches, detectWindowReset ignores 100->100 idle slides, inferPreSampleResets counts pre-sample cycles, and projection keeps month >= week', () => {
  const t0 = Date.parse('2026-11-26T10:00:00Z');
  const glitched = [
    { ts: t0, email: 'a@b.com', key: 'gemini', fiveHourPct: 50, fiveHourReset: '2026-11-26T14:44:25Z', weeklyPct: 60, weeklyReset: '2026-12-03T08:45:37Z' },
    { ts: t0 + 10 * 60_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 75, fiveHourReset: '2026-11-26T14:43:21Z', weeklyPct: 75, weeklyReset: '2026-12-03T09:43:21Z' },
    { ts: t0 + 15 * 60_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 45, fiveHourReset: '2026-11-26T14:44:25Z', weeklyPct: 58, weeklyReset: '2026-12-03T08:45:37Z' }
  ];
  const cleaned = sanitizePoolSeries(glitched);
  assert.equal(cleaned.length, 2, 'transient cross-account weeklyReset glitch must be stripped');

  // 100% -> 100% idle slide is NOT a reset
  assert.equal(
    detectWindowReset(100, 100, '2026-11-27T01:00:00Z', '2026-11-27T05:00:00Z', 4 * 3600_000, 5 * 3600_000, Date.parse('2026-11-27T01:30:00Z')),
    false
  );
  // 1% -> 100% with empty curResetStr past prevResetStr IS a reset
  assert.equal(
    detectWindowReset(1, 100, '2026-11-26T19:44:25Z', '', 3600_000, 5 * 3600_000, Date.parse('2026-11-26T19:44:48Z')),
    true
  );

  // Pre-sample history resets: events on Nov 22 & Nov 24 before weekly window start (Nov 26)
  const preRes = inferPreSampleResets({
    eventTimestamps: [Date.parse('2026-11-22T10:00:00Z'), Date.parse('2026-11-24T12:00:00Z')],
    firstSampleTs: Date.parse('2026-11-26T08:45:00Z'),
    startMs: Date.parse('2026-11-01T00:00:00Z'),
    fiveHourResetTime: '2026-11-27T05:43:41Z',
    weeklyResetTime: '2026-12-03T08:45:37Z'
  });
  assert.equal(preRes.weeklyResets, 1);
  assert.ok(preRes.fiveHourResets >= 1);

  // Hybrid projection sanity: monthProjectedTokens >= weekProjectedTokens, safe-until-reset flags accurate
  const nowMs = Date.parse('2026-11-27T01:20:00Z');
  const qStats = computeQuotaStats(
    [
      { ts: nowMs - 2 * 3600_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 98, fiveHourReset: '2026-11-27T05:43:41Z', weeklyPct: 68, weeklyReset: '2026-12-03T08:45:37Z' },
      { ts: nowMs - 3600_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 94, fiveHourReset: '2026-11-27T05:43:41Z', weeklyPct: 66, weeklyReset: '2026-12-03T08:45:37Z' },
      { ts: nowMs, email: 'a@b.com', key: 'gemini', fiveHourPct: 90, fiveHourReset: '2026-11-27T05:43:41Z', weeklyPct: 63, weeklyReset: '2026-12-03T08:45:37Z' }
    ],
    { accountFilter: 'a@b.com', nowMs }
  );
  const proj = projectPoolMonthlyQuota({
    monthPoolStat: qStats.perPool.get('gemini'),
    poolTokens: 1_200_000_000,
    poolCostUsd: 520,
    curWeekPoolTokens: 400_000_000,
    curWeekPoolCostUsd: 160,
    monthPoolTokens: 1_200_000_000,
    monthPoolCostUsd: 520,
    activeDaysInMonth: 6,
    fiveHourRemainingPct: 90,
    weeklyRemainingPct: 63,
    fiveHourResetTime: '2026-11-27T05:43:41Z',
    weeklyResetTime: '2026-12-03T08:45:37Z',
    accountCount: 3,
    nowMs
  });
  assert.ok(proj.monthProjectedTokens >= proj.weekProjectedTokens, 'month tokens projection must be >= week projection');
  assert.ok(proj.monthProjectedCostUsd >= proj.weekProjectedCostUsd, 'month cost projection must be >= week projection');
  assert.equal(proj.fiveHourSafeUntilReset, true, '4%/h burn with 90% left should safely last 4.4h until reset');

  // Cluster glitch: 2 consecutive cross-account samples within 45m must be stripped
  const clusterGlitched = [
    { ts: t0, email: 'a@b.com', key: 'gemini', fiveHourPct: 50, fiveHourReset: '2026-11-26T14:44:25Z', weeklyPct: 60, weeklyReset: '2026-12-03T08:45:37Z' },
    { ts: t0 + 8 * 60_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 80, fiveHourReset: '2026-11-26T14:43:21Z', weeklyPct: 80, weeklyReset: '2026-12-03T09:43:21Z' },
    { ts: t0 + 14 * 60_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 75, fiveHourReset: '2026-11-26T14:43:21Z', weeklyPct: 75, weeklyReset: '2026-12-03T09:43:21Z' },
    { ts: t0 + 20 * 60_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 45, fiveHourReset: '2026-11-26T14:44:25Z', weeklyPct: 58, weeklyReset: '2026-12-03T08:45:37Z' }
  ];
  assert.equal(sanitizePoolSeries(clusterGlitched).length, 2, '2-sample cross-account cluster glitch must be stripped');

  // Cold-start day-1 burst (63% remaining on day 1): Empirical Bayes smoothing prevents 0.5d panic depletion
  const coldStartStats = computeQuotaStats(
    [
      { ts: nowMs - 14 * 3600_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 100, fiveHourReset: '2026-11-27T05:43:41Z', weeklyPct: 100, weeklyReset: '2026-12-03T08:45:37Z' },
      { ts: nowMs, email: 'a@b.com', key: 'gemini', fiveHourPct: 53, fiveHourReset: '2026-11-27T05:43:41Z', weeklyPct: 37, weeklyReset: '2026-12-03T08:45:37Z' }
    ],
    { accountFilter: 'a@b.com', nowMs }
  );
  const coldProj = projectPoolMonthlyQuota({
    monthPoolStat: coldStartStats.perPool.get('gemini'),
    poolTokens: 180_000_000,
    poolCostUsd: 82,
    curWeekPoolTokens: 180_000_000,
    curWeekPoolCostUsd: 82,
    monthPoolTokens: 180_000_000,
    monthPoolCostUsd: 82,
    activeDaysInMonth: 2,
    fiveHourRemainingPct: 53,
    weeklyRemainingPct: 37,
    fiveHourResetTime: '2026-11-27T05:43:41Z',
    weeklyResetTime: '2026-12-03T08:45:37Z',
    accountCount: 1,
    nowMs
  });
  assert.ok(coldProj.estDepleteWeeklyDays >= 0.8, `Empirical Bayes smoothing should prevent <0.8d panic depletion (got ${coldProj.estDepleteWeeklyDays})`);
  assert.equal(coldProj.remainingMonthDays, 3.6);

  // Official early / manual platform-wide weekly reset (e.g., 40% -> 100% after 1.5 days, resetTime shifts +1.5d)
  const manualStats = computeQuotaStats(
    [
      { ts: nowMs - 36 * 3600_000, email: 'a@b.com', key: 'gemini', fiveHourPct: 20, fiveHourReset: '2026-11-26T00:00:00Z', weeklyPct: 40, weeklyReset: '2026-12-01T12:00:00Z' },
      { ts: nowMs, email: 'a@b.com', key: 'gemini', fiveHourPct: 100, fiveHourReset: '2026-11-27T06:00:00Z', weeklyPct: 100, weeklyReset: '2026-12-03T00:00:00Z' }
    ],
    { accountFilter: 'a@b.com', nowMs }
  );
  assert.equal(manualStats.perPool.get('gemini').weeklyResets, 1, 'manual/early weekly reset must be counted even when resetTime shifts <2.8d');

  // Pre-timeline fallback: account whose first sample starts at fresh 100% weekly cycle after prior pre-timeline usage
  const preTlRes = inferPreSampleResets({
    eventTimestamps: [],
    preTimelineEventTimestamps: [Date.parse('2026-11-24T12:00:00Z')],
    firstSampleTs: Date.parse('2026-11-26T08:45:39Z'),
    firstSampleWeeklyPct: 100,
    startMs: Date.parse('2026-11-01T00:00:00Z'),
    fiveHourResetTime: '2026-11-27T05:43:41Z',
    weeklyResetTime: '2026-12-03T08:45:37Z'
  });
  assert.equal(preTlRes.weeklyResets, 1, 'pre-timeline usage before fresh 100% weekly cycle must count 1 weekly reset');
});

test('accountComparison includes weeklyRemainingPct, pre-timeline events do not leak false resets to new accounts, and low usage does not explode to 100%', async (t) => {
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    t.skip('node:sqlite unavailable');
    return;
  }
  const { DatabaseSync } = sqlite;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ua-new-acct-'));
  try {
    const convDir = path.join(tmpRoot, 'conversations');
    const userDir = path.join(tmpRoot, 'user');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const nowMs = Date.parse('2026-11-28T16:25:00Z');
    // Old pre-timeline usage belonged to old@test.com
    const db = new DatabaseSync(path.join(convDir, 'conv-old.db'));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);');
    db.prepare('INSERT INTO steps VALUES (0, ?)').run(buildStepMetaBlob(Date.parse('2026-11-24T10:00:00Z')));
    db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
      buildGenMetaBlob({ inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500, modelName: 'Gemini 4 Neon (High)', stepIdx: 0 })
    );
    db.close();

    fs.writeFileSync(
      path.join(userDir, 'account-timeline.json'),
      JSON.stringify([
        { email: 'old@test.com', sinceMs: Date.parse('2026-11-26T08:00:00Z') },
        { email: 'new@test.com', sinceMs: Date.parse('2026-11-28T15:50:00Z') }
      ])
    );
    fs.writeFileSync(
      path.join(userDir, 'accounts.json'),
      JSON.stringify({
        activeId: 'acc_new',
        accounts: [
          {
            id: 'acc_old',
            email: 'old@test.com',
            lastQuota: { ok: true, groups: [{ key: 'gemini', fiveHour: { remainingPct: 100 }, weekly: { remainingPct: 12 } }] }
          },
          {
            id: 'acc_new',
            email: 'new@test.com',
            lastQuota: {
              ok: true,
              groups: [
                {
                  key: 'gemini',
                  fiveHour: { remainingPct: 95, resetTime: '2026-11-28T20:50:00Z' },
                  weekly: { remainingPct: 97, resetTime: '2026-12-05T10:50:00Z' }
                }
              ]
            }
          }
        ]
      })
    );
    fs.writeFileSync(
      path.join(userDir, 'quota-samples.json'),
      JSON.stringify([
        {
          ts: Date.parse('2026-11-28T15:56:00Z'),
          email: 'new@test.com',
          key: 'gemini',
          fiveHourPct: 100,
          fiveHourReset: '2026-11-28T20:50:00Z',
          weeklyPct: 99,
          weeklyReset: '2026-12-05T10:50:00Z'
        },
        {
          ts: Date.parse('2026-11-28T16:20:00Z'),
          email: 'new@test.com',
          key: 'gemini',
          fiveHourPct: 95,
          fiveHourReset: '2026-11-28T20:50:00Z',
          weeklyPct: 97,
          weeklyReset: '2026-12-05T10:50:00Z'
        }
      ])
    );

    const ua = createUsageAnalytics({
      getDatabaseSync: () => DatabaseSync,
      conversationsDir: convDir,
      userDir,
      nowFn: () => nowMs
    });
    const dash = ua.getDashboardData({ range: 'month', account: 'new@test.com', force: true });
    const gem = dash.quotaByPool.find((p) => p.key === 'gemini');
    assert.equal(gem.weeklyResets, 0, 'brand-new account must not inherit pre-timeline weekly resets from old account');
    assert.equal(gem.fiveHourResets, 0);
    assert.ok(gem.projection.weekProjectedPct < 80, `low 3% usage must not explode to 100% weekly projection (got ${gem.projection.weekProjectedPct}%)`);

    const cmpOld = dash.accountComparison.find((a) => a.email === 'old@test.com');
    const cmpNew = dash.accountComparison.find((a) => a.email === 'new@test.com');
    assert.equal(cmpOld.weeklyRemainingPct, 12);
    assert.equal(cmpNew.weeklyRemainingPct, 97);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
});
