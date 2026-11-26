/**
 * core/flow/asar-patch.mjs — Reversible Equal-Length Endpoint Redirect for Antigravity app.asar
 *
 * Replaces `https://daily-cloudcode-pa.googleapis.com` with an equal-length local proxy URL
 * (`http://127.0.0.1:<port>/appp...`) without unpacking app.asar.
 * Uses content-addressed original backups (`user/flow-backups/<sha16>.bak`) and upgrade-safe
 * stale-backup refresh so rollback always restores the currently installed version's original file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_ENDPOINT_FIND = 'https://daily-cloudcode-pa.googleapis.com';

export function buildEqualLengthReplacement(port = 18100, find = DEFAULT_ENDPOINT_FIND) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    throw new RangeError(`Invalid proxy port: ${port}`);
  }
  const base = `http://127.0.0.1:${p}`;
  const padLen = find.length - base.length - 1;
  if (padLen < 5) {
    throw new Error(`Proxy base "${base}" is too long for equal-length replacement of "${find}"`);
  }
  const repl = `${base}/a${'p'.repeat(padLen - 1)}`;
  if (Buffer.byteLength(repl, 'utf8') !== Buffer.byteLength(find, 'utf8')) {
    throw new Error('Equal-length invariant violated');
  }
  return repl;
}

export function countBufferOccurrences(buf, needleStr) {
  const needle = Buffer.from(needleStr, 'utf8');
  if (!needle.length) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const pos = buf.indexOf(needle, idx);
    if (pos < 0) break;
    count += 1;
    idx = pos + needle.length;
  }
  return count;
}

export function discoverAntigravityAsar({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  const candidates = [];
  if (platform === 'win32') {
    const localApp = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const progFiles = env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localApp, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(localApp, 'Programs', 'Antigravity', 'resources', 'app.asar'),
      path.join(progFiles, 'Antigravity', 'resources', 'app.asar'),
      path.join(localApp, 'Programs', 'Antigravity - Insiders', 'resources', 'app.asar')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Antigravity - Insiders.app/Contents/Resources/app.asar'
    );
  } else {
    candidates.push(
      '/usr/share/antigravity/resources/app.asar',
      '/opt/antigravity/resources/app.asar',
      path.join(homeDir, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readBackupIndex(backupDir) {
  const idxPath = path.join(backupDir, 'index.json');
  try {
    if (fs.existsSync(idxPath)) {
      const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return { latestSha: '', entries: {} };
}

function writeBackupIndex(backupDir, idx) {
  fs.mkdirSync(backupDir, { recursive: true });
  const idxPath = path.join(backupDir, 'index.json');
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

function saveOriginalBackup(backupDir, asarPath, buf) {
  fs.mkdirSync(backupDir, { recursive: true });
  const sha = sha256Buf(buf);
  const short = sha.slice(0, 16);
  const bakFile = path.join(backupDir, `${short}.bak`);
  if (!fs.existsSync(bakFile)) {
    fs.writeFileSync(bakFile, buf);
  }
  const idx = readBackupIndex(backupDir);
  idx.latestSha = sha;
  idx.entries[sha] = {
    sha,
    file: `${short}.bak`,
    asarPath,
    bytes: buf.length,
    savedAt: Date.now()
  };
  writeBackupIndex(backupDir, idx);
  return { sha, bakFile };
}

export function getAsarPatchStatus({
  asarPath = '',
  port = 18100,
  backupDir = '',
  find = DEFAULT_ENDPOINT_FIND,
  platform = process.platform
} = {}) {
  const resolvedPath = asarPath || discoverAntigravityAsar({ platform });
  const platformWarning =
    platform === 'darwin'
      ? 'macOS 修改 app.asar 会影响应用代码签名，可能需要重新 ad-hoc 签名；请谨慎启用。'
      : '';
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return {
      found: false,
      asarPath: resolvedPath,
      patched: false,
      hits: 0,
      done: 0,
      hasBackup: false,
      platformWarning,
      status: 'missing'
    };
  }
  const buf = fs.readFileSync(resolvedPath);
  const repl = buildEqualLengthReplacement(port, find);
  const hits = countBufferOccurrences(buf, find);
  const done = countBufferOccurrences(buf, repl);
  const anyLocalPatched = countBufferOccurrences(buf, 'http://127.0.0.1:') > 0 && hits === 0;
  const idx = backupDir ? readBackupIndex(backupDir) : { latestSha: '', entries: {} };
  const hasBackup = Boolean(idx.latestSha && idx.entries[idx.latestSha]);

  let status = 'original';
  if (done > 0 && hits === 0) status = 'patched';
  else if (anyLocalPatched && done === 0) status = 'patched-other-port';
  else if (hits === 0 && done === 0) status = 'anchor-missing';

  return {
    found: true,
    asarPath: resolvedPath,
    patched: status === 'patched',
    status,
    hits,
    done,
    port,
    hasBackup,
    platformWarning
  };
}

export function applyAsarPatch({
  asarPath = '',
  port = 18100,
  backupDir,
  find = DEFAULT_ENDPOINT_FIND,
  platform = process.platform,
  allowDarwin = false
} = {}) {
  if (!backupDir) throw new Error('backupDir is required for safe app.asar backup');
  if (platform === 'darwin' && !allowDarwin) {
    return {
      ok: false,
      error: 'macOS 修改 app.asar 会破坏应用签名；如需继续请在确认后传入 allowDarwin=true。'
    };
  }
  const resolvedPath = asarPath || discoverAntigravityAsar({ platform });
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return { ok: false, error: `未找到 app.asar: ${resolvedPath || '(auto-discovery failed)'}` };
  }
  const buf = fs.readFileSync(resolvedPath);
  const repl = buildEqualLengthReplacement(port, find);
  const hits = countBufferOccurrences(buf, find);
  const done = countBufferOccurrences(buf, repl);

  if (done > 0 && hits === 0) {
    return { ok: true, already: true, patchedCount: done, asarPath: resolvedPath, needsRestart: false };
  }
  if (hits === 0) {
    return { ok: false, error: '未在 app.asar 中找到默认端点锚点（可能是端口已改道或版本变更）' };
  }

  // Save content-addressed original backup before patching
  const backup = saveOriginalBackup(backupDir, resolvedPath, buf);
  const out = Buffer.from(buf);
  const findBuf = Buffer.from(find, 'utf8');
  const replBuf = Buffer.from(repl, 'utf8');
  let offset = 0;
  let replaced = 0;
  while (true) {
    const pos = out.indexOf(findBuf, offset);
    if (pos < 0) break;
    replBuf.copy(out, pos);
    replaced += 1;
    offset = pos + findBuf.length;
  }
  if (out.length !== buf.length) {
    return { ok: false, error: '等长校验失败，已中止写入' };
  }
  try {
    fs.writeFileSync(resolvedPath, out);
  } catch (err) {
    return {
      ok: false,
      error: `写入 app.asar 失败（可能正被 Antigravity 占用，请先关闭 IDE 后重试）: ${err.message}`
    };
  }
  return {
    ok: true,
    already: false,
    patchedCount: replaced,
    asarPath: resolvedPath,
    backupSha: backup.sha.slice(0, 16),
    needsRestart: true
  };
}

export function rollbackAsarPatch({
  asarPath = '',
  port = 18100,
  backupDir,
  find = DEFAULT_ENDPOINT_FIND,
  platform = process.platform
} = {}) {
  if (!backupDir) throw new Error('backupDir is required');
  const resolvedPath = asarPath || discoverAntigravityAsar({ platform });
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return { ok: false, error: `未找到 app.asar: ${resolvedPath || '(auto-discovery failed)'}` };
  }
  const liveBuf = fs.readFileSync(resolvedPath);
  const repl = buildEqualLengthReplacement(port, find);
  const liveHits = countBufferOccurrences(liveBuf, find);
  const livePatched = countBufferOccurrences(liveBuf, repl) > 0;

  // Upgrade-safety: if live file is already an unpatched official original, refresh backup and do NOT overwrite with stale backup!
  if (!livePatched && liveHits > 0) {
    saveOriginalBackup(backupDir, resolvedPath, liveBuf);
    return { ok: true, alreadyOriginal: true, asarPath: resolvedPath, needsRestart: false };
  }

  const idx = readBackupIndex(backupDir);
  const entry = idx.latestSha ? idx.entries[idx.latestSha] : null;
  if (entry) {
    const bakPath = path.join(backupDir, entry.file);
    if (fs.existsSync(bakPath)) {
      const bakBuf = fs.readFileSync(bakPath);
      if (bakBuf.length === liveBuf.length) {
        try {
          fs.writeFileSync(resolvedPath, bakBuf);
          return {
            ok: true,
            restoredFrom: entry.file,
            asarPath: resolvedPath,
            needsRestart: true
          };
        } catch (err) {
          return {
            ok: false,
            error: `还原 app.asar 失败（请先关闭 Antigravity 后重试）: ${err.message}`
          };
        }
      }
    }
  }

  // Fallback inverse equal-length replacement if backup size differs after host update
  if (livePatched) {
    const out = Buffer.from(liveBuf);
    const findBuf = Buffer.from(find, 'utf8');
    const replBuf = Buffer.from(repl, 'utf8');
    let offset = 0;
    while (true) {
      const pos = out.indexOf(replBuf, offset);
      if (pos < 0) break;
      findBuf.copy(out, pos);
      offset = pos + replBuf.length;
    }
    try {
      fs.writeFileSync(resolvedPath, out);
      return { ok: true, restoredByInverse: true, asarPath: resolvedPath, needsRestart: true };
    } catch (err) {
      return { ok: false, error: `还原 app.asar 失败: ${err.message}` };
    }
  }

  return { ok: false, error: '未找到可用的原件备份且当前文件未处于已改道状态' };
}
