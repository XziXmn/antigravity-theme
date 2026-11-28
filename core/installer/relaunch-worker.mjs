/**
 * core/installer/relaunch-worker.mjs — Static Pure-Node Windows Antigravity Relaunch Worker
 * Replaces dynamic PowerShell / .lnk / WScript.Shell shortcuts to avoid antivirus false positives.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sleepSync, stripUtf8Bom } from '../shared.mjs';

const ALLOWED_EXE_RE = /^Antigravity(?:\s*-\s*Insiders)?\.exe$/i;
const CLEAN_ENV_KEYS = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN'];

export function validateRelaunchJob(job, { existsSyncImpl = fs.existsSync } = {}) {
  if (!job || typeof job !== 'object') {
    return { valid: false, reason: 'Job must be an object' };
  }
  const targetExe = typeof job.targetExe === 'string' ? job.targetExe.trim() : '';
  if (!targetExe || !path.isAbsolute(targetExe)) {
    return { valid: false, reason: 'targetExe must be an absolute path' };
  }
  const baseName = path.basename(targetExe);
  if (!ALLOWED_EXE_RE.test(baseName)) {
    return { valid: false, reason: `Unsupported executable name: ${baseName}` };
  }
  if (!existsSyncImpl(targetExe)) {
    return { valid: false, reason: `Executable not found: ${targetExe}` };
  }
  return { valid: true, targetExe, baseName };
}

export function buildCleanLaunchEnv(baseEnv = process.env) {
  const clean = { ...baseEnv };
  for (const key of CLEAN_ENV_KEYS) {
    delete clean[key];
  }
  return clean;
}

export function getDefaultAppStoragePath() {
  const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appDataDir, 'Antigravity', 'app_storage.json');
}

export function syncOnboardingStorageFile(onboardingSync, storagePath = getDefaultAppStoragePath()) {
  const cleanEmail =
    onboardingSync && typeof onboardingSync.email === 'string' ? onboardingSync.email.trim().toLowerCase() : '';
  if (!cleanEmail) return { ok: true, skipped: true };
  const cleanTos = typeof onboardingSync?.isGcpTos === 'boolean' ? onboardingSync.isGcpTos : null;

  try {
    if (!fs.existsSync(storagePath)) {
      return { ok: true, skipped: true, reason: 'app_storage_missing' };
    }
    const raw = stripUtf8Bom(fs.readFileSync(storagePath, 'utf8'));
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'app_storage.json is not an object' };
    }
    obj['agy.onboarding.lastLoginUsername'] = cleanEmail;
    if (cleanTos !== null) {
      obj['agy.onboarding.lastLoginIsGcpTos'] = String(cleanTos);
    }
    const tmpPath = `${storagePath}.ag.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, storagePath);
    return { ok: true, skipped: false, email: cleanEmail };
  } catch (err) {
    return { ok: false, error: err?.message || String(err || 'onboarding sync failed') };
  }
}

export function listMatchingWindowsPids(exeName, { spawnSyncImpl = spawnSync } = {}) {
  if (!exeName) return [];
  try {
    const res = spawnSyncImpl('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 4000
    });
    const out = String(res?.stdout || '').trim();
    if (!out || /INFO:\s*No tasks/i.test(out)) return [];
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const cols = line
        .trim()
        .split('","')
        .map((s) => s.replace(/^"|"$/g, ''));
      if (cols.length >= 2 && cols[0].toLowerCase() === exeName.toLowerCase()) {
        const pid = Number(cols[1]);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function appendWorkerLog(logPath, line) {
  if (!logPath) return;
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${line}\n`, 'utf8');
  } catch {}
}

export function runWindowsRelaunchJob(job) {
  const check = validateRelaunchJob(job);
  if (!check.valid) {
    appendWorkerLog(job?.logPath, `invalid job: ${check.reason}`);
    return { ok: false, error: check.reason };
  }

  const { targetExe, baseName } = check;
  const logPath = typeof job.logPath === 'string' ? job.logPath : '';
  appendWorkerLog(logPath, `relaunch worker started pid=${process.pid} target=${targetExe}`);

  // Let IPC / CDP send response back to UI before closing Antigravity
  sleepSync(350);

  // 1. Try graceful close via taskkill /IM
  try {
    spawnSync('taskkill', ['/IM', baseName], { windowsHide: true, stdio: 'ignore', timeout: 4000 });
  } catch {}

  const gracefulDeadline = Date.now() + 3000;
  while (Date.now() < gracefulDeadline) {
    if (listMatchingWindowsPids(baseName).length === 0) break;
    sleepSync(250);
  }

  // 2. Force-terminate remaining processes & wait for SingletonLock release
  if (listMatchingWindowsPids(baseName).length > 0) {
    try {
      spawnSync('taskkill', ['/F', '/IM', baseName, '/T'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch {}
    const forceDeadline = Date.now() + 6000;
    while (Date.now() < forceDeadline) {
      if (listMatchingWindowsPids(baseName).length === 0) break;
      sleepSync(250);
    }
  }

  // 2b. Clean up orphaned language_server.exe processes from the same Antigravity install dir
  // so stale processes cannot linger and overwrite OS credentials after account switch.
  try {
    const installDirEsc = path.dirname(targetExe).replace(/'/g, "''");
    const psCleanLs = `Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${installDirEsc}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCleanLs], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 4000
    });
  } catch {}

  sleepSync(450);

  // 3. Sync onboarding state in app_storage.json atomically
  if (job.onboardingSync) {
    const obRes = syncOnboardingStorageFile(job.onboardingSync);
    appendWorkerLog(logPath, `onboarding sync: ${JSON.stringify(obRes)}`);
  }

  // 4. Spawn fresh Antigravity instance with clean env and --remote-debugging-port=0
  try {
    const child = spawn(targetExe, ['--remote-debugging-port=0'], {
      cwd: path.dirname(targetExe),
      env: buildCleanLaunchEnv(process.env),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    appendWorkerLog(logPath, `spawned ${baseName} pid=${child.pid || 'unknown'}`);
    return { ok: true, pid: child.pid || null };
  } catch (err) {
    const msg = err?.message || String(err || 'spawn failed');
    appendWorkerLog(logPath, `spawn error: ${msg}`);
    return { ok: false, error: msg };
  }
}

const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectMain) {
  const jobPath = process.argv[2];
  if (!jobPath) process.exit(1);
  try {
    const job = JSON.parse(stripUtf8Bom(fs.readFileSync(jobPath, 'utf8')));
    const res = runWindowsRelaunchJob(job);
    try {
      fs.rmSync(jobPath, { force: true });
    } catch {}
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    process.exit(1);
  }
}
