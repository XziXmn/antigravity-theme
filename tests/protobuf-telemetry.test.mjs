/**
 * tests/protobuf-telemetry.test.mjs — Unit tests for Protobuf wire decoding, retry log parsing & telemetry layout formatting
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AG_DAEMON_LIBRARY = '1';

const {
  parseProto,
  parseGenMetadataRow,
  extractMaxStepIdx,
  extractProtoLeafStrings,
  extractStep17Message,
  isCancelText,
  readRecentLsRetryInfo
} = await import('../core/daemon.mjs');

const {
  fmtTok,
  computeSegPcts,
  buildInlineTelemetryHtml,
  buildTurnSummaries
} = await import('../core/daemon/telemetry-renderer.mjs');

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

function fieldVarint(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}

function fieldBytes(fn, bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(buf.length), buf]);
}

test('parseGenMetadataRow decodes token usage, TTFT, streaming duration, model name, and step indices', () => {
  const usage = Buffer.concat([
    fieldVarint(2, 2400),
    fieldVarint(3, 600),
    fieldVarint(4, 150),
    fieldVarint(5, 18000),
    fieldVarint(9, 250),
    fieldVarint(10, 350)
  ]);
  const ctxMeta = fieldVarint(4, 512000);
  const chatStart = fieldBytes(10, ctxMeta);
  const ttft = Buffer.concat([fieldVarint(1, 1), fieldVarint(2, 250000000)]);
  const stream = Buffer.concat([fieldVarint(1, 2), fieldVarint(2, 500000000)]);
  const meta17 = Buffer.concat([fieldVarint(5, 1), fieldBytes(3, 'Model unavailable')]);
  const chat = Buffer.concat([
    fieldBytes(4, usage),
    fieldBytes(9, chatStart),
    fieldBytes(11, ttft),
    fieldBytes(12, stream),
    fieldBytes(21, 'Gemini 4 Hydrogen (XHigh)'),
    fieldBytes(17, meta17)
  ]);
  const packedSteps = Buffer.concat([encodeVarint(14), encodeVarint(16), encodeVarint(15)]);
  const top = Buffer.concat([fieldBytes(1, chat), fieldBytes(2, packedSteps)]);

  const parsed = parseGenMetadataRow({ idx: 7, data: top });
  assert.equal(parsed.idx, 7);
  assert.equal(parsed.inTok, 2400);
  assert.equal(parsed.outTok, 600);
  assert.equal(parsed.cacheWrite, 150);
  assert.equal(parsed.cacheRead, 18000);
  assert.equal(parsed.ctx, 20550);
  assert.equal(parsed.maxCtx, 512000);
  assert.equal(parsed.maxStepIdx, 16);
  assert.equal(parsed.modelName, 'Gemini 4 Hydrogen (Extra High)');
  assert.equal(parsed.thinkTok, 250);
  assert.equal(parsed.respTok, 350);
  assert.equal(parsed.ttft, 1.25);
  assert.equal(parsed.stream, 2.5);
  assert.equal(parsed.totDur, 3.75);
  assert.equal(parsed.errCode, 1);
  assert.equal(parsed.errMsg, 'Model unavailable');
});

test('extractMaxStepIdx handles both single varint and packed varint buffer', () => {
  assert.equal(extractMaxStepIdx(42), 42);
  assert.equal(extractMaxStepIdx(Buffer.concat([encodeVarint(3), encodeVarint(99), encodeVarint(18)])), 99);
  assert.equal(extractMaxStepIdx(Buffer.alloc(0)), -1);
});

test('extractStep17Message extracts clean error leaf string and strips trailing UUID artifacts', () => {
  const uuid = 'a1a51091-fd1b-437d-a034-e4dbc428c4ca-17';
  const innerErr = Buffer.concat([
    fieldBytes(1, 'API error: TLS handshake timeout'),
    fieldBytes(2, uuid)
  ]);
  const payload = fieldBytes(1, innerErr);
  const leaves = extractProtoLeafStrings(payload);
  assert.ok(leaves.includes('API error: TLS handshake timeout'));
  assert.ok(!leaves.some((s) => s.includes(uuid)));

  const msg = extractStep17Message({ step_payload: payload });
  assert.equal(msg, 'API error: TLS handshake timeout');
});

test('isCancelText distinguishes user cancellations from real service errors', () => {
  assert.equal(isCancelText('context canceled'), true);
  assert.equal(isCancelText('rpc error: code = Canceled desc = context canceled'), true);
  assert.equal(isCancelText('Cancelled by user'), true);
  assert.equal(isCancelText('API request failed (503 Service Unavailable)'), false);
});

test('readRecentLsRetryInfo parses unanchored google.Init prefix lines and ignores telemetry noise', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-codex-log-'));
  const logFile = path.join(tmpDir, 'language_server.log');
  try {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const lines = [
      `ERROR: logging before google.Init: I${mm}${dd} ${hh}:${mi}:${ss}.123456 999 executor.go:42] Run: attempt 6 failed (Model unavailable), retrying in 13s`,
      `I${mm}${dd} ${hh}:${mi}:${ss}.999999 999 llm_monitor.go:10] play.googleapis.com/log CallWithRetry: attempt 1 failed (noise), retrying in 1s`
    ];
    fs.writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');

    const info = readRecentLsRetryInfo(logFile, now.getTime() - 10000, now);
    assert.ok(info);
    assert.equal(info.attempt, 6);
    assert.equal(info.reason, 'Model unavailable');
    assert.equal(info.delay, '13s');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildInlineTelemetryHtml renders Codex compact layout by default and detailed layout on demand', () => {
  const dot = '<span class="ag-ctx-pending-dot ag-dot-idle"></span>';
  const compactHtml = buildInlineTelemetryHtml({
    telemetryLayout: 'compact',
    telemetryCacheMode: 'session',
    statusDotHtml: dot,
    displayTps: 220,
    ttft: 1.4,
    lastCtx: 230949,
    limitKStr: '512k',
    ctxClass: 'ag-ctx-warn',
    ctxPct: 45,
    compactedPending: false,
    outTok: 1540,
    lastCacheRate: '98.9',
    sessionCacheRate: '90.7'
  });
  assert.ok(compactHtml.includes('220 tok/s'));
  assert.ok(compactHtml.includes('Ctx <span class="ag-ctx-warn">45%</span>'));
  assert.ok(compactHtml.includes('Cache 90.7%'));
  assert.ok(!compactHtml.includes('TTFT'));

  const detailedHtml = buildInlineTelemetryHtml({
    telemetryLayout: 'detailed',
    telemetryCacheMode: 'step',
    statusDotHtml: dot,
    displayTps: 220,
    ttft: 1.4,
    lastCtx: 230949,
    limitKStr: '512k',
    ctxClass: 'ag-ctx-warn',
    ctxPct: 45,
    compactedPending: true,
    outTok: 1540,
    lastCacheRate: '98.9',
    sessionCacheRate: '90.7'
  });
  assert.ok(detailedHtml.includes('TTFT 1.4s'));
  assert.ok(detailedHtml.includes('Ctx 已压缩'));
  assert.ok(detailedHtml.includes('Out 1.5k'));
});

test('computeSegPcts & buildTurnSummaries compute balanced bar percentages and turn rollups', () => {
  const pcts = computeSegPcts([10, 990], 100, 2);
  assert.ok(pcts[0] >= 2);
  assert.ok(Math.abs(pcts[0] + pcts[1] - 100) < 0.3);

  const turns = buildTurnSummaries(
    [
      {
        idx: 0,
        inTok: 1000,
        outTok: 200,
        cacheWrite: 0,
        cacheRead: 9000,
        ctx: 10000,
        maxCtx: 512000,
        maxStepIdx: 3,
        modelName: 'Gemini 4 Hydrogen (XHigh)',
        thinkTok: 50,
        respTok: 150,
        ttft: 0.8,
        stream: 1.0,
        totDur: 1.8
      }
    ],
    [1],
    0,
    256000
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnIndex, 1);
  assert.equal(turns[0].tps, 200);
  assert.equal(turns[0].cacheRate, '90.0%');
  assert.equal(fmtTok(1500), '1.5k');
  assert.equal(fmtTok(1500000), '1.50M');
});

test('buildMetricsTooltipHtml renders dual-column Powertools layout and preserves #ag-live-metrics-pill CSS', async () => {
  const { buildMetricsTooltipHtml } = await import('../core/daemon/telemetry-renderer.mjs');
  const html = buildMetricsTooltipHtml({
    genIdx: 12,
    streamTps: 90,
    e2eTps: 45,
    streamTpsValid: true,
    last: {
      modelName: 'Gemini 4 Hydrogen (XHigh)',
      inTok: 40000,
      cacheRead: 36000,
      cacheWrite: 1200,
      respTok: 280,
      thinkTok: 420,
      ttft: 0.6,
      stream: 1.4,
      totDur: 2.0,
      stepIdx: 12
    },
    lastCacheRate: '91.5%',
    ctxPct: 56,
    contextLimitTokens: 256000,
    limitKStr: '256k',
    remainCtx: '112k',
    compactedPending: false,
    compactSummaryKb: 0,
    compactingNow: false,
    generatingPending: false,
    pendingRetrying: false,
    lastErrorMsg: '',
    turnSteps: 2,
    turnOut: 700,
    turnThink: 420,
    turnResp: 280,
    turnDur: 2.0,
    userStepsCount: 4,
    validCount: 10,
    totalStepsCount: 12,
    totalIn: 120000,
    totalCacheWrite: 12000,
    totalCache: 108000,
    totalPrompt: 228000,
    sessionCacheRate: '89.0%',
    totalOut: 4200,
    totalThink: 1800,
    totalResp: 2400,
    ctxBreakdown: {
      usedTokens: 143360,
      maxTokens: 256000,
      usedPercent: 56.0,
      categories: [
        { key: 'system', label: 'System', tokens: 12000, percent: 8.4 },
        { key: 'skills', label: 'Skills', tokens: 8000, percent: 5.6 },
        { key: 'history', label: 'History', tokens: 123360, percent: 86.0 }
      ]
    },
    sessAvgTps: 84,
    peakTps: 128,
    latestTps: 90,
    avgTtftSec: 0.7,
    modelTimeSec: 18.4,
    estCostUsd: 0.14,
    totalErrorCount: 0,
    toolCount: 6,
    lastReqTsMs: Date.now() - 30000
  });
  assert.ok(html.includes('ag-tt-dual-grid'));
  assert.ok(html.includes('ag-tt-kpi-pair'));
  assert.ok(html.includes('ag-tt-mini-pair'));
  assert.ok(html.includes('响应耗时'));
  assert.ok(html.includes('本步输出'));
  assert.ok(!html.includes('ag-tt-btn-compact'));
  assert.ok(!html.includes('ag-tt-btn-heatmap'));
  assert.ok(!html.includes('ag-tt-gen-chip'));
  assert.ok(!html.includes('ag-tt-footer'));
  assert.ok(!html.includes('ag-tt-flow-bar'));
  assert.ok(html.includes('上下文窗口'));
  assert.ok(html.includes('会话统计'));
  assert.ok(html.includes('技能'));

  // Uint8Array input (as returned by node:sqlite) must decode ctxCategories cleanly
  const grpMsg = Buffer.concat([fieldBytes(1, 'System Prompt'), fieldVarint(4, 12000)]);
  const bdMsg = fieldBytes(1, grpMsg);
  const u8CtxMeta = Buffer.concat([fieldBytes(3, bdMsg), fieldVarint(4, 512000)]);
  const u8ChatStart = fieldBytes(10, u8CtxMeta);
  const u8Usage = Buffer.concat([fieldVarint(2, 500), fieldVarint(3, 100), fieldVarint(5, 11500)]);
  const u8Chat = Buffer.concat([fieldBytes(4, u8Usage), fieldBytes(9, u8ChatStart)]);
  const u8Top = fieldBytes(1, u8Chat);
  const u8Parsed = parseGenMetadataRow({ idx: 9, data: new Uint8Array(u8Top) });
  assert.ok(u8Parsed);
  assert.ok(Array.isArray(u8Parsed.ctxCategories));
  assert.equal(u8Parsed.ctxCategories.length, 1);
  assert.equal(u8Parsed.ctxCategories[0].label, 'System Prompt');

  const css = fs.readFileSync(new URL('../core/styles/30-telemetry.css', import.meta.url), 'utf8');
  assert.ok(css.includes('#ag-live-metrics-pill'));
});
