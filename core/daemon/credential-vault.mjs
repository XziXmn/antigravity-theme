/**
 * core/daemon/credential-vault.mjs — OS Credential Vault & Desktop/CLI Sync
 *
 * Isolates per-account Antigravity OAuth credentials inside the native OS credential store
 * (Windows Credential Manager / macOS Keychain / Linux Secret Service) without writing
 * plaintext secrets to workspace files, and optionally synchronizes Desktop state.vscdb
 * and CLI credential files on account switch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const ACTIVE_TARGET = 'gemini:antigravity';
export const ACTIVE_USERNAME = 'antigravity';
export const ACTIVE_SERVICE = 'gemini';
export const VAULT_SERVICE = 'antigravity-theme-account';

const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CRED_EMAIL_RE = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;

export function normalizeCredEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return CRED_EMAIL_RE.test(value) ? value : '';
}

/**
 * Extracts id_token_email (or nested base64 token email) from a credential JSON payload.
 */
export function extractCredentialEmail(bufferOrText) {
  if (!bufferOrText) return '';
  try {
    const text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString('utf8') : String(bufferOrText);
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return '';
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return '';
    const direct = normalizeCredEmail(parsed.id_token_email || parsed.email);
    if (direct) return direct;
    if (typeof parsed.id_token === 'string' && parsed.id_token.includes('.')) {
      const jwtEmail = decodeJwtEmail(parsed.id_token);
      if (jwtEmail) return jwtEmail;
    }
    if (parsed.token && typeof parsed.token === 'object') {
      const nested = normalizeCredEmail(parsed.token.id_token_email || parsed.token.email);
      if (nested) return nested;
      if (typeof parsed.token.id_token === 'string' && parsed.token.id_token.includes('.')) {
        const jwtEmail = decodeJwtEmail(parsed.token.id_token);
        if (jwtEmail) return jwtEmail;
      }
    }
    if (typeof parsed.token === 'string' && parsed.token) {
      const inner = Buffer.from(parsed.token, 'base64');
      try {
        return extractCredentialEmail(inner);
      } finally {
        inner.fill(0);
      }
    }
  } catch {}
  return '';
}

export function decodeJwtEmail(idToken) {
  if (!idToken || typeof idToken !== 'string') return '';
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return '';
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return normalizeCredEmail(json?.email);
  } catch {
    return '';
  }
}

export function shortCredentialHash(bufferOrText) {
  if (!bufferOrText) return '';
  const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12).toUpperCase();
}

export function vaultTargetFor(accountId) {
  const id = String(accountId || '').trim();
  if (!ACCOUNT_ID_RE.test(id)) throw new Error('Invalid account identifier');
  return `antigravity-theme:account:${id}`;
}

function splitPosixTarget(target) {
  if (target === ACTIVE_TARGET) return { service: ACTIVE_SERVICE, account: ACTIVE_USERNAME };
  const prefix = 'antigravity-theme:account:';
  if (target.startsWith(prefix)) {
    const account = target.slice(prefix.length);
    if (!ACCOUNT_ID_RE.test(account)) throw new Error('Invalid account identifier');
    return { service: VAULT_SERVICE, account };
  }
  throw new Error('Unsupported credential target');
}

function mismatchResult(actualEmail, expectedEmail) {
  return {
    ok: false,
    mismatch: true,
    actualEmail,
    expectedEmail,
    error: `Active credential belongs to ${actualEmail}, expected ${expectedEmail}`
  };
}

// ---------------------------------------------------------------------------
// Minimal Protobuf helpers for Desktop state.vscdb antigravityUnifiedStateSync
// ---------------------------------------------------------------------------
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

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: Number(result), nextOffset: pos };
    }
    shift += 7n;
    if (shift > 63n) throw new Error('Varint overflow');
  }
  throw new Error('Truncated varint');
}

function encodeProtoFieldBytes(fieldNum, payloadBuf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(payloadBuf.length), payloadBuf]);
}

function encodeProtoFieldString(fieldNum, str) {
  return encodeProtoFieldBytes(fieldNum, Buffer.from(String(str), 'utf8'));
}

function skipProtoField(buf, offset, wireType) {
  if (wireType === 0) return decodeVarint(buf, offset).nextOffset;
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const len = decodeVarint(buf, offset);
    return len.nextOffset + len.value;
  }
  if (wireType === 5) return offset + 4;
  throw new Error(`Unsupported wire type ${wireType}`);
}

function decodeProtoFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    const field = tag.value >> 3;
    const wireType = tag.value & 7;
    pos = tag.nextOffset;
    if (wireType === 2) {
      const len = decodeVarint(buf, pos);
      pos = len.nextOffset;
      fields.push({ field, wireType, bytes: buf.subarray(pos, pos + len.value) });
      pos += len.value;
    } else if (wireType === 0) {
      const val = decodeVarint(buf, pos);
      fields.push({ field, wireType, value: val.value });
      pos = val.nextOffset;
    } else {
      pos = skipProtoField(buf, pos, wireType);
    }
  }
  return fields;
}

export function buildUnifiedOAuthTokenTopicBase64({
  accessToken,
  refreshToken,
  expirySeconds,
  tokenType = 'Bearer',
  idToken = ''
}) {
  const parts = [];
  if (accessToken) parts.push(encodeProtoFieldString(1, accessToken));
  if (tokenType) parts.push(encodeProtoFieldString(2, tokenType));
  if (refreshToken) parts.push(encodeProtoFieldString(3, refreshToken));
  if (Number.isFinite(Number(expirySeconds)) && Number(expirySeconds) > 0) {
    const tsBuf = Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(Math.floor(Number(expirySeconds)))]);
    parts.push(encodeProtoFieldBytes(4, tsBuf));
  }
  if (idToken) parts.push(encodeProtoFieldString(5, idToken));

  const oauthInfoB64 = Buffer.concat(parts).toString('base64');
  const valMsg = encodeProtoFieldString(1, oauthInfoB64);
  const entryMsg = Buffer.concat([
    encodeProtoFieldString(1, 'oauthTokenInfoSentinelKey'),
    encodeProtoFieldBytes(2, valMsg)
  ]);
  return encodeProtoFieldBytes(1, entryMsg).toString('base64');
}

export function parseUnifiedOAuthTokenTopicBase64(topicBase64) {
  if (!topicBase64 || typeof topicBase64 !== 'string') return null;
  try {
    const topicBuf = Buffer.from(topicBase64.trim(), 'base64');
    const entries = decodeProtoFields(topicBuf).filter((f) => f.field === 1 && f.bytes);
    for (const entry of entries) {
      const eFields = decodeProtoFields(entry.bytes);
      const keyF = eFields.find((f) => f.field === 1 && f.bytes);
      const valF = eFields.find((f) => f.field === 2 && f.bytes);
      if (!keyF || !valF || keyF.bytes.toString('utf8') !== 'oauthTokenInfoSentinelKey') continue;
      const vFields = decodeProtoFields(valF.bytes);
      const b64F = vFields.find((f) => f.field === 1 && f.bytes);
      if (!b64F) continue;
      const innerBuf = Buffer.from(b64F.bytes.toString('utf8'), 'base64');
      const infoFields = decodeProtoFields(innerBuf);
      const out = { accessToken: '', tokenType: 'Bearer', refreshToken: '', expirySeconds: null, idToken: '' };
      for (const f of infoFields) {
        if (f.field === 1 && f.bytes) out.accessToken = f.bytes.toString('utf8');
        else if (f.field === 2 && f.bytes) out.tokenType = f.bytes.toString('utf8');
        else if (f.field === 3 && f.bytes) out.refreshToken = f.bytes.toString('utf8');
        else if (f.field === 4 && f.bytes) {
          const tsF = decodeProtoFields(f.bytes).find((x) => x.field === 1 && typeof x.value === 'number');
          if (tsF) out.expirySeconds = tsF.value;
        } else if (f.field === 5 && f.bytes) out.idToken = f.bytes.toString('utf8');
      }
      return out;
    }
  } catch {}
  return null;
}

export function buildUnifiedUserStatusTopicBase64({ email, name = '' }) {
  const userParts = [];
  if (name) userParts.push(encodeProtoFieldString(1, name));
  if (email) userParts.push(encodeProtoFieldString(2, email));
  const userBuf = Buffer.concat(userParts);
  const valMsg = encodeProtoFieldString(1, userBuf.toString('base64'));
  const entryMsg = Buffer.concat([encodeProtoFieldString(1, 'userStatusSentinelKey'), encodeProtoFieldBytes(2, valMsg)]);
  return encodeProtoFieldBytes(1, entryMsg).toString('base64');
}

export function parseUnifiedUserStatusTopicBase64(topicBase64) {
  if (!topicBase64 || typeof topicBase64 !== 'string') return null;
  try {
    const topicBuf = Buffer.from(topicBase64.trim(), 'base64');
    const entries = decodeProtoFields(topicBuf).filter((f) => f.field === 1 && f.bytes);
    for (const entry of entries) {
      const eFields = decodeProtoFields(entry.bytes);
      const keyF = eFields.find((f) => f.field === 1 && f.bytes);
      const valF = eFields.find((f) => f.field === 2 && f.bytes);
      if (!keyF || !valF || keyF.bytes.toString('utf8') !== 'userStatusSentinelKey') continue;
      const vFields = decodeProtoFields(valF.bytes);
      const b64F = vFields.find((f) => f.field === 1 && f.bytes);
      if (!b64F) continue;
      const innerBuf = Buffer.from(b64F.bytes.toString('utf8'), 'base64');
      const infoFields = decodeProtoFields(innerBuf);
      const out = { name: '', email: '' };
      for (const f of infoFields) {
        if (f.field === 1 && f.bytes) out.name = f.bytes.toString('utf8');
        else if (f.field === 2 && f.bytes) out.email = f.bytes.toString('utf8');
      }
      return out;
    }
  } catch {}
  return null;
}

/**
 * Synchronizes OAuth tokens and active email into Desktop state.vscdb & CLI files when present.
 */
export function syncDesktopAndCliCredentials({
  accessToken = '',
  refreshToken = '',
  expirySeconds = null,
  idToken = '',
  email = '',
  name = '',
  getDatabaseSync = null,
  dirs = {}
} = {}) {
  const results = { vscdbUpdated: [], cliUpdated: [], errors: [] };
  const homeDir = dirs.homeDir || os.homedir();
  const appDataDir = dirs.appDataDir || process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');

  const vscdbCandidates = Array.isArray(dirs.vscdbPaths)
    ? dirs.vscdbPaths
    : process.platform === 'darwin'
    ? [
        path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
      ]
    : process.platform === 'win32'
    ? [
        path.join(appDataDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(appDataDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
      ]
    : [
        path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(homeDir, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
      ];

  const DatabaseSync = typeof getDatabaseSync === 'function' ? getDatabaseSync() : null;
  if (DatabaseSync && (accessToken || refreshToken)) {
    const tokenTopic = buildUnifiedOAuthTokenTopicBase64({ accessToken, refreshToken, expirySeconds, idToken });
    for (const dbPath of vscdbCandidates) {
      if (!dbPath || !fs.existsSync(dbPath)) continue;
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { timeout: 500 });
        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
          'antigravityUnifiedStateSync.oauthToken',
          tokenTopic
        );
        if (email) {
          db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
            'antigravityUnifiedStateSync.userStatus',
            buildUnifiedUserStatusTopicBase64({ email, name })
          );
        }
        results.vscdbUpdated.push(dbPath);
      } catch (err) {
        results.errors.push(`${dbPath}: ${err?.message || err}`);
      } finally {
        try {
          if (db) db.close();
        } catch {}
      }
    }
  }

  const googleAccountsPath = dirs.googleAccountsPath || path.join(homeDir, '.gemini', 'google_accounts.json');
  if (email && fs.existsSync(googleAccountsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(googleAccountsPath, 'utf8'));
      const oldList = Array.isArray(raw?.old) ? raw.old.filter((e) => normalizeCredEmail(e) !== normalizeCredEmail(email)) : [];
      if (raw?.active && normalizeCredEmail(raw.active) !== normalizeCredEmail(email)) {
        oldList.unshift(raw.active);
      }
      const next = { ...(raw && typeof raw === 'object' ? raw : {}), active: email, old: oldList.slice(0, 12) };
      fs.writeFileSync(googleAccountsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      results.cliUpdated.push(googleAccountsPath);
    } catch (err) {
      results.errors.push(`google_accounts.json: ${err?.message || err}`);
    }
  }

  const oauthCredsPath = dirs.oauthCredsPath || path.join(homeDir, '.gemini', 'oauth_creds.json');
  if (accessToken && fs.existsSync(oauthCredsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(oauthCredsPath, 'utf8'));
      const next = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        ...(idToken ? { id_token: idToken } : {}),
        ...(expirySeconds ? { expiry_date: Number(expirySeconds) * 1000 } : {}),
        token_type: 'Bearer'
      };
      fs.writeFileSync(oauthCredsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      results.cliUpdated.push(oauthCredsPath);
    } catch (err) {
      results.errors.push(`oauth_creds.json: ${err?.message || err}`);
    }
  }

  return results;
}

/**
 * Clears cached desktop OAuth state so Antigravity can enter its native sign-in screen
 * when adding a new account via the built-in login flow.
 */
export function clearDesktopOAuthState({ getDatabaseSync = null, dirs = {} } = {}) {
  const homeDir = dirs.homeDir || os.homedir();
  const appDataDir = dirs.appDataDir || process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const vscdbCandidates = Array.isArray(dirs.vscdbPaths)
    ? dirs.vscdbPaths
    : process.platform === 'darwin'
    ? [
        path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
      ]
    : process.platform === 'win32'
    ? [
        path.join(appDataDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(appDataDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
      ]
    : [
        path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(homeDir, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
      ];
  const DatabaseSync = typeof getDatabaseSync === 'function' ? getDatabaseSync() : null;
  const cleared = [];
  if (DatabaseSync) {
    for (const dbPath of vscdbCandidates) {
      if (!dbPath || !fs.existsSync(dbPath)) continue;
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { timeout: 500 });
        db.prepare("DELETE FROM ItemTable WHERE key IN ('antigravityUnifiedStateSync.oauthToken', 'antigravityUnifiedStateSync.userStatus')").run();
        cleared.push(dbPath);
      } catch {} finally {
        try { if (db) db.close(); } catch {}
      }
    }
  }
  return { cleared };
}

// ---------------------------------------------------------------------------
// Native OS Credential Store (Win32 CredManager / macOS Keychain / Linux secret-tool)
// ---------------------------------------------------------------------------
const WIN32_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class AgThemeWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWriteW([In] ref CREDENTIAL userCredential, uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDeleteW(string target, uint type, int flags);

  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);

  public static byte[] ReadBytes(string target) {
    IntPtr ptr;
    if (!CredReadW(target, 1, 0, out ptr)) return null;
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return new byte[0];
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
      return bytes;
    } finally {
      CredFree(ptr);
    }
  }

  public static void WriteBytes(string target, string username, byte[] bytes) {
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL cred = new CREDENTIAL();
      cred.Flags = 0;
      cred.Type = 1;
      cred.TargetName = target;
      cred.UserName = username;
      cred.CredentialBlobSize = (uint)bytes.Length;
      cred.CredentialBlob = blob;
      cred.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
      if (!CredWriteW(ref cred, 0)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }

  public static void DeleteTarget(string target) {
    CredDeleteW(target, 1, 0);
  }
}
"@
`;

function cleanPowerShellError(text) {
  return String(text || '')
    .replace(/^#<\s*CLIXML\s*<Objs[\s\S]*?<\/Objs>\s*/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runWin32CredAction(action, payloadObj) {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj || {}), 'utf8').toString('base64');
  const ps = `${WIN32_SCRIPT}
$p = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64}')) | ConvertFrom-Json
$act = '${action}'
if ($act -eq 'read') {
  $b = [AgThemeWinCred]::ReadBytes($p.target)
  if ($null -eq $b) { '{"exists":false}' }
  else {
    $b64 = [Convert]::ToBase64String($b)
    @{ exists = $true; b64 = $b64 } | ConvertTo-Json -Compress
  }
} elseif ($act -eq 'write') {
  $b = [Convert]::FromBase64String($p.b64)
  [AgThemeWinCred]::WriteBytes($p.target, $p.username, $b)
  '{"ok":true}'
} elseif ($act -eq 'delete') {
  [AgThemeWinCred]::DeleteTarget($p.target)
  '{"ok":true}'
}
`;
  const encodedPs = Buffer.from(ps, 'utf16le').toString('base64');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPs], {
    encoding: 'utf8',
    timeout: 12000,
    windowsHide: true
  });
  if (res.status !== 0) {
    const errMsg = cleanPowerShellError(res.stderr || res.stdout || '') || 'Win32 Credential Manager failed';
    throw new Error(errMsg);
  }
  const line =
    String(res.stdout || '')
      .trim()
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.trim().startsWith('{')) || '{}';
  return JSON.parse(line);
}

export function createCredentialVault({ platform = process.platform } = {}) {
  let linuxSecretToolCached = null;

  function hasLinuxSecretTool() {
    if (linuxSecretToolCached !== null) return linuxSecretToolCached;
    try {
      const r = spawnSync('which', ['secret-tool'], { encoding: 'utf8', timeout: 2000 });
      linuxSecretToolCached = r.status === 0;
    } catch {
      linuxSecretToolCached = false;
    }
    return linuxSecretToolCached;
  }

  function getCapability() {
    if (platform === 'win32') return { supported: true, backend: 'win32-credman', reason: '' };
    if (platform === 'darwin') return { supported: true, backend: 'macos-keychain', reason: '' };
    if (platform === 'linux') {
      if (hasLinuxSecretTool()) return { supported: true, backend: 'linux-secret-tool', reason: '' };
      return { supported: false, backend: 'none', reason: 'secret-tool unavailable on Linux' };
    }
    return { supported: false, backend: 'none', reason: `Unsupported platform: ${platform}` };
  }

  function readTargetRaw(target) {
    const cap = getCapability();
    if (!cap.supported) return { exists: false, raw: '', error: cap.reason };
    if (platform === 'win32') {
      const res = runWin32CredAction('read', { target });
      if (!res.exists) return { exists: false, raw: '' };
      const buf = Buffer.from(res.b64 || '', 'base64');
      try {
        return { exists: true, raw: buf.toString('utf8') };
      } finally {
        buf.fill(0);
      }
    }
    if (platform === 'darwin') {
      const { service, account } = splitPosixTarget(target);
      const r = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
        encoding: 'utf8',
        timeout: 4000
      });
      if (r.status !== 0) return { exists: false, raw: '' };
      return { exists: true, raw: String(r.stdout || '').replace(/\r?\n$/, '') };
    }
    if (platform === 'linux') {
      const { service, account } = splitPosixTarget(target);
      const r = spawnSync('secret-tool', ['lookup', 'service', service, 'account', account], {
        encoding: 'utf8',
        timeout: 4000
      });
      if (r.status !== 0 || !r.stdout) return { exists: false, raw: '' };
      return { exists: true, raw: String(r.stdout || '').replace(/\r?\n$/, '') };
    }
    return { exists: false, raw: '' };
  }

  function writeTargetRaw(target, rawText, username = ACTIVE_USERNAME) {
    const cap = getCapability();
    if (!cap.supported) throw new Error(cap.reason);
    const text = String(rawText || '');
    if (platform === 'win32') {
      runWin32CredAction('write', {
        target,
        username,
        b64: Buffer.from(text, 'utf8').toString('base64')
      });
      return;
    }
    if (platform === 'darwin') {
      const { service, account } = splitPosixTarget(target);
      execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', text], {
        timeout: 4000
      });
      return;
    }
    if (platform === 'linux') {
      const { service, account } = splitPosixTarget(target);
      const r = spawnSync('secret-tool', ['store', `--label=${target}`, 'service', service, 'account', account], {
        input: text,
        encoding: 'utf8',
        timeout: 4000
      });
      if (r.status !== 0) throw new Error(r.stderr || 'secret-tool store failed');
    }
  }

  function deleteTargetRaw(target) {
    const cap = getCapability();
    if (!cap.supported) return;
    if (platform === 'win32') {
      runWin32CredAction('delete', { target });
      return;
    }
    if (platform === 'darwin') {
      const { service, account } = splitPosixTarget(target);
      spawnSync('security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 4000 });
      return;
    }
    if (platform === 'linux') {
      const { service, account } = splitPosixTarget(target);
      spawnSync('secret-tool', ['clear', 'service', service, 'account', account], { timeout: 4000 });
    }
  }

  function readInfo(target) {
    const res = readTargetRaw(target);
    if (!res.exists || !res.raw) return { exists: false, email: '', hash: '' };
    return {
      exists: true,
      email: extractCredentialEmail(res.raw),
      hash: shortCredentialHash(res.raw)
    };
  }

  return {
    getCapability,
    readActiveInfo: () => readInfo(ACTIVE_TARGET),
    readActiveRaw: () => readTargetRaw(ACTIVE_TARGET),
    clearActiveSystemCredential: () => {
      deleteTargetRaw(ACTIVE_TARGET);
      return { ok: true };
    },
    readSavedInfo: (accountId) => readInfo(vaultTargetFor(accountId)),
    readSavedRaw: (accountId) => readTargetRaw(vaultTargetFor(accountId)),
    writeSavedRaw(accountId, rawText, { expectedEmail = '' } = {}) {
      const actualEmail = extractCredentialEmail(rawText);
      const exp = normalizeCredEmail(expectedEmail);
      if (exp && actualEmail && actualEmail !== exp) {
        return mismatchResult(actualEmail, exp);
      }
      writeTargetRaw(vaultTargetFor(accountId), rawText, accountId);
      return { ok: true, email: actualEmail || exp, hash: shortCredentialHash(rawText) };
    },
    saveActiveTo(accountId, { expectedEmail = '' } = {}) {
      const active = readTargetRaw(ACTIVE_TARGET);
      if (!active.exists || !active.raw) {
        return { ok: false, missing: true, error: 'Active system credential not found' };
      }
      const actualEmail = extractCredentialEmail(active.raw);
      const exp = normalizeCredEmail(expectedEmail);
      if (exp && actualEmail && actualEmail !== exp) {
        return mismatchResult(actualEmail, exp);
      }
      writeTargetRaw(vaultTargetFor(accountId), active.raw, accountId);
      return { ok: true, email: actualEmail, hash: shortCredentialHash(active.raw) };
    },
    restoreToActive(accountId, { expectedEmail = '' } = {}) {
      const saved = readTargetRaw(vaultTargetFor(accountId));
      if (!saved.exists || !saved.raw) {
        return { ok: false, missing: true, error: 'Saved credential not found in vault' };
      }
      const actualEmail = extractCredentialEmail(saved.raw);
      const exp = normalizeCredEmail(expectedEmail);
      if (exp && actualEmail && actualEmail !== exp) {
        return mismatchResult(actualEmail, exp);
      }
      writeTargetRaw(ACTIVE_TARGET, saved.raw, ACTIVE_USERNAME);
      return { ok: true, email: actualEmail || exp, hash: shortCredentialHash(saved.raw), raw: saved.raw };
    },
    deleteSaved: (accountId) => deleteTargetRaw(vaultTargetFor(accountId))
  };
}
