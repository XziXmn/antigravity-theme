/**
 * tests/flow-compactor.test.mjs — Unit tests for Codex CLI-Style Virtual Compactor & Contract Bounds
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_FLOW_CONFIG,
  normalizeFlowConfig,
  sanitizeFlowPatch
} from '../core/flow/contract.mjs';
import {
  CODEX_COMPACTION_MARKER,
  estimateModelContextWindow,
  splitHistoryForCodexCompact,
  isNativeCompactionRequest,
  rewriteNativeCompactionRequest,
  buildCompactionSummaryPayload,
  buildCompactedContents,
  createFlowCompactor
} from '../core/flow/compactor.mjs';
import { createMetricsReader } from '../core/daemon/sqlite-metrics.mjs';
import { DatabaseSync } from 'node:sqlite';

function makeTurn(role, text, extraParts = []) {
  return { role, parts: [{ text }, ...extraParts] };
}

test('contract normalizes and clamps compaction settings safely', () => {
  assert.equal(DEFAULT_FLOW_CONFIG.compactEnabled, false);
  assert.equal(DEFAULT_FLOW_CONFIG.compactThresholdPct, 70);
  assert.equal(DEFAULT_FLOW_CONFIG.compactKeepTailTokens, 20000);

  const clamped = normalizeFlowConfig({
    compactEnabled: true,
    compactThresholdPct: 120,
    compactKeepTailTokens: 100,
    compactModel: '-bad-flag'
  });
  assert.equal(clamped.compactEnabled, true);
  assert.equal(clamped.compactThresholdPct, 88);
  assert.equal(clamped.compactKeepTailTokens, 4000);
  assert.equal(clamped.compactModel, '');

  const base = { flow: { ...DEFAULT_FLOW_CONFIG } };
  sanitizeFlowPatch(base, {
    flow: {
      compactEnabled: true,
      compactThresholdPct: 80,
      compactKeepTailTokens: 40000,
      compactModel: 'gemini-3.8-flash-low'
    }
  });
  assert.equal(base.flow.compactEnabled, true);
  assert.equal(base.flow.compactThresholdPct, 80);
  assert.equal(base.flow.compactKeepTailTokens, 40000);
  assert.equal(base.flow.compactModel, 'gemini-3.8-flash-low');
});

test('splitHistoryForCodexCompact preserves tail budget and never splits functionCall/functionResponse pairs', () => {
  const longBody = 'A'.repeat(24000); // ~6000 tokens per turn
  const contents = [
    makeTurn('user', 'U0: ' + longBody),
    makeTurn('model', 'M0: ' + longBody),
    makeTurn('user', 'U1: ' + longBody),
    makeTurn('model', 'M1: ' + longBody),
    makeTurn('user', 'U2: run tool please'),
    { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { Path: '/tmp/a.js' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: longBody } } }] },
    makeTurn('model', 'M3: final answer ' + 'B'.repeat(4000)),
    makeTurn('user', 'U4: follow up question'),
    makeTurn('model', 'M4: final reply')
  ];

  const split = splitHistoryForCodexCompact(contents, { keepTailTokens: 10000 });
  assert.equal(split.canCompact, true);
  // Cut point MUST land on a pure user turn (U2 at index 4 or U4 at index 8), never on index 6 (functionResponse)
  const cutTurn = contents[split.splitIdx];
  assert.equal(cutTurn.role, 'user');
  assert.ok(!cutTurn.parts.some((p) => p.functionResponse));
  assert.ok(split.head.length >= 4);
  assert.ok(split.anchorFingerprint);
});

test('buildCompactedContents injects first-person anchor and resists anchor drift', () => {
  const contents = [
    makeTurn('user', 'initial goal '.repeat(200)),
    makeTurn('model', 'ack '.repeat(200)),
    makeTurn('user', 'step 1 '.repeat(200)),
    makeTurn('model', 'done 1 '.repeat(200)),
    makeTurn('user', 'Anchor User Turn'),
    makeTurn('model', 'Latest reply')
  ];
  const split = splitHistoryForCodexCompact(contents, { keepTailTokens: 100 });
  assert.equal(split.canCompact, true);

  const built = buildCompactedContents(contents, {
    splitIdx: split.splitIdx,
    anchorFingerprint: split.anchorFingerprint,
    summaryText: 'Completed step 1 and verified outputs.'
  });
  assert.equal(built.applied, true);
  assert.ok(built.contents[0].parts[0].text.includes(CODEX_COMPACTION_MARKER));
  assert.ok(!/Another language model/i.test(built.contents[0].parts[0].text));
  assert.equal(built.contents[2].parts[0].text, 'Anchor User Turn');

  // Drift protection: mismatched fingerprint must refuse to apply rather than corrupt history
  const badBuilt = buildCompactedContents(contents, {
    splitIdx: split.splitIdx,
    anchorFingerprint: 'deadbeef00000000',
    summaryText: 'Summary'
  });
  assert.equal(badBuilt.applied, false);
});

test('isNativeCompactionRequest and rewriteNativeCompactionRequest strip tools and inlineData', () => {
  const nativePayload = {
    model: 'gemini-4-neon',
    request: {
      systemInstruction: { parts: [{ text: 'Create a conversation checkpoint summary.' }] },
      contents: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'Inspect this' }] },
        { role: 'model', parts: [{ text: 'Done' }] },
        { role: 'user', parts: [{ text: 'Please compact the conversation into a checkpoint.' }] }
      ]
    }
  };
  assert.equal(isNativeCompactionRequest(nativePayload), true);
  const rewritten = rewriteNativeCompactionRequest(nativePayload);
  assert.equal(rewritten.request.tools, undefined);
  assert.ok(rewritten.request.contents[0].parts[0].text.includes('媒体附件已省略'));
  assert.ok(rewritten.request.contents[2].parts.some((p) => p.text.includes('Codex 精简压缩规范')));

  const summaryPayload = buildCompactionSummaryPayload(
    {
      model: 'gemini-4-neon',
      request: {
        tools: [{ functionDeclarations: [{ name: 'run_command' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        contents: []
      }
    },
    nativePayload.request.contents.slice(0, 2)
  );
  assert.equal(summaryPayload.request.tools, undefined);
  assert.equal(summaryPayload.request.toolConfig, undefined);
});

test('createFlowCompactor persists snapshots and rolls back atomically on failed upstream summary', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-compactor-'));
  try {
    const cid = '11111111-2222-3333-4444-555555555555';
    const compactor = createFlowCompactor({ compactionDir: tmpDir });
    const bigText = 'Detailed engineering context '.repeat(300);
    const samplePayload = {
      model: 'gemini-4-neon',
      request: {
        contents: [
          makeTurn('user', 'U0 ' + bigText),
          makeTurn('model', 'M0 ' + bigText),
          makeTurn('user', 'U1 ' + bigText),
          makeTurn('model', 'M1 ' + bigText),
          makeTurn('user', 'U2 latest question'),
          makeTurn('model', 'M2 latest answer')
        ]
      }
    };
    compactor.captureTurnPayload(cid, samplePayload, { model: 'gemini-4-neon' });

    const okRes = await compactor.runCompaction(cid, {
      upstream: 'https://daily-cloudcode-pa.googleapis.com',
      authHeaders: { authorization: 'Bearer test' },
      keepTailTokens: 200,
      sendUpstream: async () => ({
        status: 200,
        body: 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"## 当前目标与用户约束\\n已完成第一阶段构建与测试验证，所有文件路径 core/flow/compactor.mjs 已检查。"}]}}]}}\n\n'
      })
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.status.active, true);
    assert.equal(okRes.status.count, 1);

    // Reload from disk in a fresh compactor instance
    const compactor2 = createFlowCompactor({ compactionDir: tmpDir });
    assert.equal(compactor2.getStatus(cid).active, true);
    const cloned = structuredClone(samplePayload);
    const applied = compactor2.applyToPayload(cid, cloned);
    assert.equal(applied.applied, true);
    assert.ok(cloned.request.contents.length < samplePayload.request.contents.length);

    // Atomic rollback on HTTP 500: existing snapshot must remain untouched
    compactor2.captureTurnPayload(cid, samplePayload, { model: 'gemini-4-neon' });
    const failRes = await compactor2.runCompaction(cid, {
      upstream: 'https://daily-cloudcode-pa.googleapis.com',
      authHeaders: { authorization: 'Bearer test' },
      keepTailTokens: 200,
      sendUpstream: async () => ({ status: 500, body: 'upstream error' })
    });
    assert.equal(failRes.ok, false);
    assert.equal(compactor2.getStatus(cid).active, true);
    assert.equal(compactor2.getStatus(cid).count, 1);

    compactor2.clearCompaction(cid);
    assert.equal(compactor2.getStatus(cid).active, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('estimateModelContextWindow matches 512k Gemini 4 window, shouldAutoCompact honors contextWindow, and long tool chains snap safely to model anchor', () => {
  assert.equal(estimateModelContextWindow('gemini-4-hydrogen-medium'), 512000);
  assert.equal(estimateModelContextWindow('gemini-4-neon-high'), 512000);
  assert.equal(estimateModelContextWindow('claude-opus-5-5-high'), 200000);
  assert.equal(estimateModelContextWindow('gemini-2.5-pro'), 1000000);

  // Long agentic tool-call chain after a single user message: must fall back to model anchor without splitting call/response pairs
  const chain = [makeTurn('user', 'U0: start long agentic task ' + 'X'.repeat(8000))];
  for (let i = 0; i < 30; i += 1) {
    chain.push({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { idx: i, pad: 'Y'.repeat(1200) } } }] });
    chain.push({ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { idx: i, content: 'Z'.repeat(3000) } } }] });
  }
  const split = splitHistoryForCodexCompact(chain, { keepTailTokens: 20000 });
  assert.equal(split.canCompact, true);
  assert.equal(split.anchorMode, 'model');
  assert.equal(chain[split.splitIdx].role, 'model');
  assert.ok(chain[split.splitIdx].parts.some((p) => p.functionCall));

  const built = buildCompactedContents(chain, {
    splitIdx: split.splitIdx,
    anchorMode: split.anchorMode,
    anchorFingerprint: split.anchorFingerprint,
    summaryText: 'Completed first 20 tool calls.'
  });
  assert.equal(built.applied, true);
  assert.equal(built.contents[0].role, 'user');
  assert.equal(built.contents[1].role, 'model');
  assert.ok(built.contents[1].parts.some((p) => p.functionCall));
  assert.equal(built.contents[2].role, 'user');
  assert.ok(built.contents[2].parts.some((p) => p.functionResponse));

  const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const compactor = createFlowCompactor();
  compactor.captureTurnPayload(cid, { model: 'gemini-4-hydrogen-medium', request: { contents: chain } }, { model: 'gemini-4-hydrogen-medium' });
  assert.equal(
    compactor.shouldAutoCompact(cid, {
      promptTokenCount: 420000,
      model: 'gemini-4-hydrogen-medium',
      thresholdPct: 80,
      keepTailTokens: 20000
    }),
    true
  );
  assert.equal(
    compactor.shouldAutoCompact(cid, {
      promptTokenCount: 165000,
      model: 'gemini-4-hydrogen-medium',
      contextWindow: 200000,
      thresholdPct: 80,
      keepTailTokens: 20000
    }),
    true
  );
});

test('metricsReader.resolveCascadeId maps trajectory_id to cascade_id from trajectory_meta', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-traj-map-'));
  const cascadeId = 'b7afbd4c-b283-4bce-baca-e48eb3dee864';
  const trajectoryId = '1437b883-d200-4e46-9f5a-98697ac47ac7';
  const dbPath = path.join(tmpDir, `${cascadeId}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)');
  db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 1)').run(
    trajectoryId,
    cascadeId
  );
  db.close();

  try {
    const reader = createMetricsReader({ getDatabaseSync: () => DatabaseSync, getConfig: () => ({}) });
    const resolved = reader.resolveCascadeId(trajectoryId, {
      conversationsDir: tmpDir,
      candidateCascadeIds: [cascadeId]
    });
    assert.equal(resolved, cascadeId);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
});

test('createFlowCompactor supports incremental multi-round compaction and recordNativeHijack', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-compactor-inc-'));
  try {
    const cid = '11111111-2222-4333-8444-555555555555';
    const compactor = createFlowCompactor({ storeDir: tmpDir });

    const makeTurns = (n) => {
      const arr = [];
      for (let i = 0; i < n; i++) {
        arr.push({ role: 'user', parts: [{ text: `User turn ${i}: ${'x'.repeat(3200)}` }] });
        arr.push({ role: 'model', parts: [{ text: `Model reply ${i}: ${'y'.repeat(3200)}` }] });
      }
      return arr;
    };

    const round1Turns = makeTurns(18);
    compactor.captureTurnPayload(cid, { model: 'gemini-4-hydrogen-medium', request: { contents: round1Turns } });

    const seenLengths = [];
    const sendUpstream = async ({ payloadObj }) => {
      const c = payloadObj?.request?.contents || payloadObj?.contents || [];
      seenLengths.push(c.length);
      return {
        status: 200,
        body: 'data: {"candidates":[{"content":{"parts":[{"text":"## Summary\\nCompleted turns cleanly with full context preserved for incremental handoff."}]}}]}\n\n'
      };
    };

    const r1 = await compactor.runCompaction(cid, {
      sendUpstream,
      upstream: 'https://example.invalid',
      authHeaders: { authorization: 'Bearer test' },
      keepTailTokens: 8000,
      reason: 'auto'
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.status.count, 1);

    // Round 2 adds more turns: incremental compaction must run on compacted effective history (smaller than full raw)
    const round2Turns = makeTurns(30);
    compactor.captureTurnPayload(cid, { model: 'gemini-4-hydrogen-medium', request: { contents: round2Turns } });
    const r2 = await compactor.runCompaction(cid, {
      sendUpstream,
      upstream: 'https://example.invalid',
      authHeaders: { authorization: 'Bearer test' },
      keepTailTokens: 8000,
      reason: 'auto'
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.status.count, 2);
    assert.equal(compactor.recordNativeHijack(cid).count, 3);
    assert.equal(compactor.getStatus(cid).count, 3);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
});
