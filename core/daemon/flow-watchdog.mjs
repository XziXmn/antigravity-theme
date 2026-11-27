/**
 * core/daemon/flow-watchdog.mjs — Daemon Keep-Alive for the Flow Relay
 *
 * Why this exists: once `flow.asar-patch` redirects Antigravity's model endpoint to
 * `http://127.0.0.1:<port>`, the relay daemon becomes a hard dependency of every model call.
 * If the daemon dies while app.asar is still redirected, the IDE fails with
 * `loadCodeAssist ... connection refused` and no model can load at all.
 *
 * macOS already gets this for free (`LaunchAgent` + `KeepAlive`) and Linux through
 * `systemd Restart=always`. Windows only had `schtasks /SC ONLOGON`, so a crashed, killed or
 * battery-suspended daemon stayed dead until the next logon. This module gives Windows (and
 * any other platform missing a supervisor) a cheap idempotent probe that starts the daemon
 * only when it is genuinely missing.
 *
 * Design rules:
 *  - Never spawn when a live daemon exists (a second instance kills the first, which would
 *    tear down CDP attachments and the relay for no reason).
 *  - Never spawn when the relay port answers (the daemon is healthy even if the pid file is lost).
 *  - Exit fast and silent; the repeating scheduled task calls this every few minutes.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRunningDaemonPids, getDaemonPidCandidateDirs, isPidAlive } from '../shared.mjs';

export const WATCHDOG_EXTRA_PATTERNS = Object.freeze([
  'theme-patch',
  'antigravity-font-daemon.mjs',
  'antigravity-codex-daemon.mjs'
]);

export const WATCHDOG_DEFAULT_FLOW_PORT = 18100;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveCodexThemeUserDir({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, '.gemini', 'antigravity', 'codex-theme', 'user');
}

/**
 * Read the relay port from the deployed user config without importing the whole bundle
 * controller (the watchdog must stay dependency-free and fast).
 */
export function readConfiguredFlowPort({ homeDir = os.homedir(), readFileImpl = fs.readFileSync } = {}) {
  const cfgPath = path.join(resolveCodexThemeUserDir({ homeDir }), 'config.json');
  try {
    const raw = readFileImpl(cfgPath, 'utf8');
    const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    const port = Number(parsed?.flow?.port);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch {}
  return WATCHDOG_DEFAULT_FLOW_PORT;
}

export function isWatchdogProxyEnabled({ homeDir = os.homedir(), readFileImpl = fs.readFileSync } = {}) {
  const cfgPath = path.join(resolveCodexThemeUserDir({ homeDir }), 'config.json');
  try {
    const raw = readFileImpl(cfgPath, 'utf8');
    const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (parsed?.enabled === false) return false;
    if (parsed?.modules && parsed.modules.flow === false) return false;
  } catch {}
  return true;
}

export function readAlivePidFromFiles({
  platform = process.platform,
  pidDirs = null,
  excludePids = [process.pid],
  isPidAliveImpl = isPidAlive,
  readFileImpl = fs.readFileSync
} = {}) {
  const dirs = Array.isArray(pidDirs) ? pidDirs : getDaemonPidCandidateDirs({ platform });
  const exclude = new Set((Array.isArray(excludePids) ? excludePids : []).map(Number));
  const alive = [];
  for (const dir of dirs) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/^ag-(?:codex|theme)-daemon-.*\.pid$/i.test(f)) continue;
        try {
          const pid = parseInt(String(readFileImpl(path.join(dir, f), 'utf8')).trim(), 10);
          if (Number.isInteger(pid) && pid > 0 && !exclude.has(pid) && isPidAliveImpl(pid) && !alive.includes(pid)) {
            alive.push(pid);
          }
        } catch {}
      }
    } catch {}
  }
  return alive;
}

export function probeTcpEndpoint(
  port,
  { host = '127.0.0.1', timeoutMs = 1500, connectImpl = null } = {}
) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let socket;
    try {
      socket = connectImpl
        ? connectImpl({ port, host })
        : net.connect({ port: Number(port), host });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {}
      finish(false);
    }, Math.max(100, Number(timeoutMs) || 700));
    if (typeof timer.unref === 'function') timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Pure decision helper — unit-testable without touching the OS.
 */
export function evaluateWatchdogDecision({ aliveDaemonPids = [], proxyListening = false, flowEnabled = true } = {}) {
  const pids = (Array.isArray(aliveDaemonPids) ? aliveDaemonPids : [])
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0);
  const base = { proxyListening: Boolean(proxyListening), daemonPids: pids, flowEnabled: Boolean(flowEnabled) };
  if (pids.length > 0) {
    return { ...base, action: 'noop', reason: 'daemon-alive' };
  }
  if (proxyListening) {
    // Relay answers but no daemon process owns the pid file: leave it alone, spawning would
    // only fight over the port.
    return { ...base, action: 'noop', reason: 'proxy-listening' };
  }
  return { ...base, action: 'spawn', reason: 'daemon-missing' };
}

export function spawnDaemonDetached({
  entryPath,
  nodeExecPath = process.execPath,
  spawnImpl = spawn
} = {}) {
  if (!entryPath) return { ok: false, pid: null, error: 'entry path missing' };
  try {
    const child = spawnImpl(nodeExecPath, ['--disable-warning=ExperimentalWarning', entryPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true, pid: child?.pid || null, error: '' };
  } catch (err) {
    return { ok: false, pid: null, error: err?.message || String(err) };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Run one watchdog pass.
 * @returns {Promise<{action:string, reason:string, proxyListening:boolean, daemonPids:number[],
 *   port:number, spawnedPid:number|null, error:string}>}
 */
export async function runFlowWatchdog({
  entryPath = path.join(__dirname, '..', 'daemon.mjs'),
  homeDir = os.homedir(),
  platform = process.platform,
  excludePids = [process.pid],
  findDaemonPidsImpl = null,
  probeImpl = probeTcpEndpoint,
  spawnImpl = spawn,
  port = null,
  flowEnabled = null,
  doubleCheckMs = 0,
  settleMs = 0
} = {}) {
  const resolvedPort =
    Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
      ? Number(port)
      : readConfiguredFlowPort({ homeDir });
  const relayEnabled = flowEnabled === null ? isWatchdogProxyEnabled({ homeDir }) : Boolean(flowEnabled);

  let daemonPids = [];
  if (typeof findDaemonPidsImpl === 'function') {
    try {
      daemonPids = findDaemonPidsImpl({
        platform,
        excludePids,
        extraPatterns: WATCHDOG_EXTRA_PATTERNS
      }) || [];
    } catch {
      daemonPids = [];
    }
  } else {
    daemonPids = readAlivePidFromFiles({ platform, excludePids });
    if (daemonPids.length === 0) {
      try {
        daemonPids = findRunningDaemonPids({
          platform,
          excludePids,
          extraPatterns: WATCHDOG_EXTRA_PATTERNS
        }) || [];
      } catch {
        daemonPids = [];
      }
    }
  }

  let proxyListening = false;
  try {
    proxyListening = await probeImpl(resolvedPort);
  } catch {
    proxyListening = false;
  }

  let decision = evaluateWatchdogDecision({
    aliveDaemonPids: daemonPids,
    proxyListening,
    flowEnabled: relayEnabled
  });

  if (decision.action === 'spawn' && Number(doubleCheckMs) > 0) {
    await wait(Number(doubleCheckMs));
    let recovered = false;
    try {
      recovered = await probeImpl(resolvedPort);
    } catch {
      recovered = false;
    }
    if (recovered) {
      decision = {
        proxyListening: true,
        daemonPids,
        flowEnabled: relayEnabled,
        action: 'noop',
        reason: 'proxy-recovered'
      };
    }
  }

  const out = {
    ...decision,
    port: resolvedPort,
    spawnedPid: null,
    error: ''
  };

  if (decision.action !== 'spawn') return out;

  const spawned = spawnDaemonDetached({ entryPath, spawnImpl });
  out.spawnedPid = spawned.pid;
  out.error = spawned.error;
  if (!spawned.ok) return out;

  if (Number(settleMs) > 0) {
    const deadline = Date.now() + Number(settleMs);
    while (Date.now() < deadline) {
      await wait(250);
      const alive = (() => {
        try {
          return probeImpl(resolvedPort);
        } catch {
          return Promise.resolve(false);
        }
      })();
      if (await alive) {
        out.proxyListening = true;
        break;
      }
    }
  }

  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const quiet = argv.includes('--quiet');
  const settleArg = argv.find((a) => a.startsWith('--settle-ms='));
  const settleMs = settleArg ? Number(settleArg.split('=')[1]) : 0;
  const entryArg = argv.find((a) => a.startsWith('--entry='));
  const result = await runFlowWatchdog({
    entryPath: entryArg ? entryArg.slice('--entry='.length) : undefined,
    doubleCheckMs: 600,
    settleMs: Number.isFinite(settleMs) ? settleMs : 0
  });
  if (!quiet) console.log(JSON.stringify(result));
  return result;
}

const invokedArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirect =
  invokedArg === path.resolve(__filename) || path.basename(invokedArg) === 'flow-watchdog.mjs';

if (process.env.AG_WATCHDOG_LIBRARY !== '1' && isDirect) {
  await main();
}
