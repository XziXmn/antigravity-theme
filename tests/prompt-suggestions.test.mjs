/**
 * tests/prompt-suggestions.test.mjs — Prompt Suggestions Engine, Text Cleaning & Worker Rotation Race Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  cleanPromptSuggestionText,
  createPromptSuggestionEngine
} from '../core/daemon/prompt-suggest.mjs';

function createMockChild(bin, args) {
  const child = new EventEmitter();
  child.bin = bin;
  child.args = args;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.written = [];
  child.stdin = {
    ended: false,
    destroyed: false,
    write(chunk) {
      child.written.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
  child.stdout = new EventEmitter();
  child.stdout.destroyed = false;
  child.stdout.destroy = function () {
    this.destroyed = true;
  };
  child.stderr = new EventEmitter();
  child.stderr.destroyed = false;
  child.stderr.resume = function () {};
  child.stderr.destroy = function () {
    this.destroyed = true;
  };
  child.kill = (sig = 'SIGTERM') => {
    child.killed = true;
    child.signals.push(sig);
    return true;
  };
  child.emitStdout = (obj) => {
    const line = typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n';
    child.stdout.emit('data', Buffer.from(line, 'utf8'));
  };
  child.finishExit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  return child;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('cleanPromptSuggestionText strips quotes, markers, and filters NONE or empty strings', () => {
  assert.equal(cleanPromptSuggestionText('“帮我跑一下单元测试”'), '帮我跑一下单元测试');
  assert.equal(cleanPromptSuggestionText('⟫ 提交这次改动吧\n多余第二行'), '提交这次改动吧');
  assert.equal(cleanPromptSuggestionText('NONE'), '');
  assert.equal(cleanPromptSuggestionText('none'), '');
  assert.equal(cleanPromptSuggestionText('无'), '');
  assert.equal(cleanPromptSuggestionText('a'), '');
  assert.equal(cleanPromptSuggestionText('```text\ncode\n```'), '');
});

test('createPromptSuggestionEngine degrades cleanly when disabled or agy binary is missing', async () => {
  const disabledEngine = createPromptSuggestionEngine({
    getConfig: () => ({ enabled: true, modules: { promptSuggestions: false } }),
    resolveBin: () => ''
  });
  assert.equal(
    await disabledEngine.suggest({ fingerprint: 'fp-1', lastUser: 'hi', lastAssistant: 'hello' }),
    ''
  );

  const missingBinEngine = createPromptSuggestionEngine({
    getConfig: () => ({ enabled: true, modules: { promptSuggestions: true } }),
    resolveBin: () => ''
  });
  assert.equal(
    await missingBinEngine.suggest({ fingerprint: 'fp-2', lastUser: 'hi', lastAssistant: 'hello' }),
    ''
  );
  missingBinEngine.stop();
});

test('worker rotation waits for old agy exit, ignores stale events, and never leaks under syncState heartbeat (Issue #8)', async () => {
  const spawned = [];
  const cfg = {
    enabled: true,
    promptSuggestionModel: 'gemini-3.8-flash-low',
    modules: { promptSuggestions: true }
  };
  const engine = createPromptSuggestionEngine({
    getConfig: () => cfg,
    resolveBin: () => '/usr/local/bin/agy',
    spawnImpl: (bin, args) => {
      const c = createMockChild(bin, args);
      spawned.push(c);
      return c;
    },
    stopKillTimeoutMs: 200,
    restartGraceMs: 20,
    maxTurnsPerWorker: 1
  });

  engine.syncState();
  assert.equal(spawned.length, 1);
  const workerA = spawned[0];

  // Warmup worker A
  workerA.emitStdout({ event: 'init' });
  assert.equal(workerA.written.length, 1, 'warmup prompt should be written');
  workerA.emitStdout({ event: 'result', result: { response: 'OK' } });
  assert.equal(engine.getStatus().warmed, true);

  // Run 1 turn -> hits maxTurnsPerWorker = 1 and triggers rotation
  const suggestPromise = engine.suggest({
    fingerprint: 'fp-rotate-1',
    lastUser: '修一下 bug',
    lastAssistant: '已修好并测试通过'
  });
  assert.equal(workerA.written.length, 2);
  workerA.emitStdout({ event: 'result', result: { response: '帮我提交并推送' } });
  assert.equal(await suggestPromise, '帮我提交并推送');

  // Worker A was asked to stop via SIGTERM, but has NOT exited yet
  assert.deepEqual(workerA.signals, ['SIGTERM']);
  assert.equal(engine.getStatus().stoppingCount, 1);
  assert.equal(engine.getStatus().starting, true);

  // Heartbeat syncState() ticks while Worker A is still shutting down -> MUST NOT spawn Worker B concurrently
  engine.syncState();
  engine.syncState();
  await wait(40);
  assert.equal(spawned.length, 1, 'must wait for old worker exit before spawning replacement');

  // Stray output from retiring Worker A must be ignored
  workerA.emitStdout({ event: 'init' });
  assert.equal(workerA.written.length, 2, 'stale init must not write warmup');

  // Worker A finally exits -> streams destroyed, single Worker B spawns after grace delay
  workerA.finishExit(0, 'SIGTERM');
  assert.equal(workerA.stdin.destroyed, true);
  assert.equal(workerA.stdout.destroyed, true);
  assert.equal(workerA.stderr.destroyed, true);
  assert.equal(engine.getStatus().stoppingCount, 0);

  await wait(45);
  assert.equal(spawned.length, 2, 'exactly one replacement worker B should spawn after A exits');
  const workerB = spawned[1];
  assert.equal(engine.getStatus().running, true);

  // Even if an old child somehow emits a late exit/error after B is active, B must stay owned
  workerA.emit('error', new Error('late error'));
  workerA.emit('exit', 0, null);
  engine.syncState();
  assert.equal(spawned.length, 2, 'late events from A must never null B or trigger worker C');
  assert.equal(engine.getStatus().running, true);

  // Clean shutdown
  engine.stop();
  workerB.finishExit(0, 'SIGTERM');
});

test('stop() escalates to SIGKILL when a hung agy worker ignores SIGTERM', async () => {
  const spawned = [];
  const cfg = {
    enabled: true,
    promptSuggestionModel: 'gemini-3.8-flash-low',
    modules: { promptSuggestions: true }
  };
  const engine = createPromptSuggestionEngine({
    getConfig: () => cfg,
    resolveBin: () => '/usr/local/bin/agy',
    spawnImpl: (bin, args) => {
      const c = createMockChild(bin, args);
      spawned.push(c);
      return c;
    },
    stopKillTimeoutMs: 35,
    restartGraceMs: 15
  });

  engine.syncState();
  const workerA = spawned[0];
  engine.stop({ wantRestart: true });
  assert.deepEqual(workerA.signals, ['SIGTERM']);

  // Worker A ignores SIGTERM -> watchdog sends SIGKILL
  await wait(60);
  assert.deepEqual(workerA.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(workerA.stdin.destroyed, true);

  // Once killed process exits, replacement starts cleanly
  workerA.finishExit(null, 'SIGKILL');
  await wait(40);
  assert.equal(spawned.length, 2);

  engine.stop();
  spawned[1].finishExit(0, 'SIGTERM');
});

test('model switch serializes teardown before spawning new model and disabling during rotation cancels restart', async () => {
  const spawned = [];
  const cfg = {
    enabled: true,
    promptSuggestionModel: 'gemini-3.8-flash-low',
    modules: { promptSuggestions: true }
  };
  const engine = createPromptSuggestionEngine({
    getConfig: () => cfg,
    resolveBin: () => '/usr/local/bin/agy',
    spawnImpl: (bin, args) => {
      const c = createMockChild(bin, args);
      spawned.push(c);
      return c;
    },
    stopKillTimeoutMs: 200,
    restartGraceMs: 15
  });

  engine.syncState();
  assert.equal(spawned.length, 1);
  const workerA = spawned[0];

  // Switch model while Worker A is running -> must retire A first, NOT spawn B concurrently
  cfg.promptSuggestionModel = 'gemini-4-neon-medium';
  engine.syncState();
  assert.deepEqual(workerA.signals, ['SIGTERM']);
  assert.equal(spawned.length, 1, 'model switch must not spawn concurrently while old worker is alive');

  workerA.finishExit(0, 'SIGTERM');
  await wait(40);
  assert.equal(spawned.length, 2);
  assert.ok(spawned[1].args.includes('gemini-4-neon-medium'));

  // Now trigger another model switch, then disable before workerB exits -> must NOT spawn workerC
  cfg.promptSuggestionModel = 'gemini-3.8-flash-high';
  engine.syncState();
  cfg.modules.promptSuggestions = false;
  engine.syncState();
  spawned[1].finishExit(0, 'SIGTERM');
  await wait(40);
  assert.equal(spawned.length, 2, 'disabling promptSuggestions during rotation must cancel pending spawn');
});

test('runUtilityPrompt executes isolated one-shot call and never reuses promptSuggestions warm worker', async () => {
  const spawned = [];
  let execCalls = 0;
  const engine = createPromptSuggestionEngine({
    getConfig: () => ({ enabled: true, promptSuggestionModel: 'gemini-3.8-flash-low', modules: { promptSuggestions: true } }),
    resolveBin: () => '/usr/local/bin/agy',
    spawnImpl: (bin, args) => {
      const c = createMockChild(bin, args);
      spawned.push(c);
      return c;
    },
    execFileImpl: async (_bin, args) => {
      execCalls += 1;
      assert.ok(args.includes('--print'));
      return { stdout: '重构账号管理与预测卡片\n' };
    }
  });

  engine.syncState();
  assert.equal(spawned.length, 1);
  // Warm up the persistent worker
  spawned[0].stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init' }) + '\n'));
  spawned[0].stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: { response: 'OK' } }) + '\n'));
  await wait(20);
  const writesBefore = spawned[0].written.length;

  const out = await engine.runUtilityPrompt('总结会话标题');
  assert.equal(out, '重构账号管理与预测卡片');
  assert.equal(execCalls, 1);
  assert.equal(spawned[0].written.length, writesBefore, 'runUtilityPrompt must not write to persistent suggestion worker');
  engine.stop();
  spawned[0].finishExit(0, 'SIGTERM');
});
