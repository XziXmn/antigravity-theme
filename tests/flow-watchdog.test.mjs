/**
 * tests/flow-watchdog.test.mjs — Relay keep-alive decisions, config probing & Windows task hardening
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WATCHDOG_DEFAULT_FLOW_PORT,
  evaluateWatchdogDecision,
  isWatchdogProxyEnabled,
  probeTcpEndpoint,
  readConfiguredFlowPort,
  resolveCodexThemeUserDir,
  runFlowWatchdog,
  spawnDaemonDetached
} from '../core/daemon/flow-watchdog.mjs';
import { buildWindowsTaskTuneScript, tuneWindowsScheduledTask } from '../core/installer/service.mjs';

function makeHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-watchdog-'));
  const userDir = resolveCodexThemeUserDir({ homeDir: home });
  fs.mkdirSync(userDir, { recursive: true });
  if (config !== undefined) {
    const raw = typeof config === 'string' ? config : JSON.stringify(config, null, 2);
    fs.writeFileSync(path.join(userDir, 'config.json'), raw, 'utf8');
  }
  return home;
}

test('watchdog never spawns while a daemon is alive or the relay port answers', () => {
  assert.equal(evaluateWatchdogDecision({}).action, 'spawn');
  assert.equal(evaluateWatchdogDecision({}).reason, 'daemon-missing');

  const alive = evaluateWatchdogDecision({ aliveDaemonPids: [4321] });
  assert.equal(alive.action, 'noop');
  assert.equal(alive.reason, 'daemon-alive');
  assert.deepEqual(alive.daemonPids, [4321]);

  const listening = evaluateWatchdogDecision({ proxyListening: true });
  assert.equal(listening.action, 'noop');
  assert.equal(listening.reason, 'proxy-listening');

  // Garbage pid entries are ignored instead of causing a spawn storm.
  assert.equal(evaluateWatchdogDecision({ aliveDaemonPids: [0, -3, 'x', null] }).action, 'spawn');
});

test('watchdog reads the relay port and module switch from the deployed user config', () => {
  const home = makeHome({ enabled: true, modules: { flow: true }, flow: { port: 23456 } });
  assert.equal(readConfiguredFlowPort({ homeDir: home }), 23456);
  assert.equal(isWatchdogProxyEnabled({ homeDir: home }), true);

  const off = makeHome({ enabled: true, modules: { flow: false }, flow: { port: 18100 } });
  assert.equal(isWatchdogProxyEnabled({ homeDir: off }), false);

  const disabled = makeHome({ enabled: false, modules: { flow: true }, flow: { port: 18100 } });
  assert.equal(isWatchdogProxyEnabled({ homeDir: disabled }), false);

  // Missing / corrupt / out-of-range config falls back to the default relay port.
  assert.equal(readConfiguredFlowPort({ homeDir: makeHome(undefined) }), WATCHDOG_DEFAULT_FLOW_PORT);
  assert.equal(readConfiguredFlowPort({ homeDir: makeHome('{not json') }), WATCHDOG_DEFAULT_FLOW_PORT);
  assert.equal(readConfiguredFlowPort({ homeDir: makeHome({ flow: { port: 80 } }) }), WATCHDOG_DEFAULT_FLOW_PORT);
  assert.equal(
    readConfiguredFlowPort({ homeDir: makeHome({ flow: { port: '18101' } }) }),
    18101,
    'numeric strings are accepted'
  );
});

test('probeTcpEndpoint reports closed ports as false and never rejects', async () => {
  const closed = await probeTcpEndpoint(1, { timeoutMs: 300 });
  assert.equal(closed, false);
  const thrown = await probeTcpEndpoint(18100, {
    connectImpl: () => {
      throw new Error('boom');
    }
  });
  assert.equal(thrown, false);
});

test('runFlowWatchdog spawns only when both the daemon and the relay are gone', async () => {
  const home = makeHome({ enabled: true, modules: { flow: true }, flow: { port: 18100 } });
  const entry = path.join(home, 'core', 'daemon.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// stub\n', 'utf8');

  const spawned = [];
  const spawnImpl = () => {
    const child = { pid: 9001, unref() {} };
    spawned.push(child);
    return child;
  };

  const needStart = await runFlowWatchdog({
    entryPath: entry,
    homeDir: home,
    platform: 'win32',
    findDaemonPidsImpl: () => [],
    probeImpl: async () => false,
    spawnImpl,
    settleMs: 0
  });
  assert.equal(needStart.action, 'spawn');
  assert.equal(needStart.spawnedPid, 9001);
  assert.equal(spawned.length, 1);

  const daemonAlive = await runFlowWatchdog({
    entryPath: entry,
    homeDir: home,
    platform: 'win32',
    findDaemonPidsImpl: () => [555],
    probeImpl: async () => false,
    spawnImpl,
    settleMs: 0
  });
  assert.equal(daemonAlive.action, 'noop');
  assert.equal(daemonAlive.reason, 'daemon-alive');
  assert.equal(spawned.length, 1, 'a live daemon must never be duplicated');

  const relayAlive = await runFlowWatchdog({
    entryPath: entry,
    homeDir: home,
    platform: 'win32',
    findDaemonPidsImpl: () => [],
    probeImpl: async () => true,
    spawnImpl,
    settleMs: 0
  });
  assert.equal(relayAlive.action, 'noop');
  assert.equal(relayAlive.reason, 'proxy-listening');
  assert.equal(spawned.length, 1);
});

test('spawnDaemonDetached detaches stdio and reports failures instead of throwing', () => {
  const calls = [];
  const res = spawnDaemonDetached({
    entryPath: 'C:/core/daemon.mjs',
    nodeExecPath: 'node',
    spawnImpl: (bin, argv, opts) => {
      calls.push({ bin, argv, opts });
      return { pid: 4242, unref() {} };
    }
  });
  assert.equal(res.ok, true);
  assert.equal(res.pid, 4242);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.ok(calls[0].argv.includes('--disable-warning=ExperimentalWarning'));

  const failed = spawnDaemonDetached({
    entryPath: 'C:/core/daemon.mjs',
    spawnImpl: () => {
      throw new Error('spawn exploded');
    }
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /spawn exploded/);

  assert.equal(spawnDaemonDetached({ entryPath: '' }).ok, false);
});

test('Windows scheduled task tuning keeps the daemon alive across battery, crash and logoff', () => {
  const script = buildWindowsTaskTuneScript();
  assert.match(script, /AllowStartIfOnBatteries/);
  assert.match(script, /DontStopIfGoingOnBatteries/);
  assert.match(script, /RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(script, /MultipleInstances IgnoreNew/);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /Set-ScheduledTask/);
  assert.match(script, /\$env:AG_TASK_NAME/);
  assert.match(script, /\$env:AG_VBS_PATH/);

  let seenEnv = null;
  const ok = tuneWindowsScheduledTask({
    taskName: 'AntigravityCodexThemeDaemon',
    vbsPath: 'C:/x/AntigravityCodexThemeDaemon.vbs',
    spawnSyncImpl: (bin, argv, opts) => {
      seenEnv = opts.env;
      assert.equal(bin, 'powershell');
      assert.ok(argv.includes('-NoProfile'));
      return { status: 0, stdout: 'tuned\n', stderr: '' };
    }
  });
  assert.equal(ok.ok, true);
  assert.equal(seenEnv.AG_TASK_NAME, 'AntigravityCodexThemeDaemon');
  assert.equal(seenEnv.AG_VBS_PATH, 'C:/x/AntigravityCodexThemeDaemon.vbs');

  const missing = tuneWindowsScheduledTask({
    taskName: 'AntigravityCodexThemeDaemon',
    vbsPath: 'C:/x/AntigravityCodexThemeDaemon.vbs',
    spawnSyncImpl: () => ({ status: 0, stdout: 'task-missing\n', stderr: '' })
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'task-missing');

  const broken = tuneWindowsScheduledTask({
    taskName: 't',
    vbsPath: 'v',
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'denied' })
  });
  assert.equal(broken.ok, false);
});
