/**
 * core/daemon/account-oauth.mjs — OAuth2 Loopback Flow & Standard Google Token Refresh
 *
 * Never hardcodes OAuth client secrets in source code. Pairs are resolved dynamically at runtime
 * from the locally installed Antigravity language_server binary (verified via SHA-256 anchors)
 * or optional environment overrides.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { decodeJwtEmail, normalizeCredEmail } from './credential-vault.mjs';
import { discoverLiveHub, parseQuotaSummary } from './ls-client.mjs';

export const OFFICIAL_OAUTH_CLIENT_PAIRS = Object.freeze([
  {
    key: 'antigravity_default',
    clientIdSha256: 'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea',
    clientSecretSha256: '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60'
  },
  {
    key: 'antigravity_enterprise',
    clientIdSha256: '69dee430c4e956f6b672b99a846566d6a86814999fc3b3b050697c0d65ea80c3',
    clientSecretSha256: 'a2ddedc84850a9c48b7e01d61700848083bf0e10fb8d6c99c496803e8b48ced0'
  }
]);

export const ANTIGRAVITY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

const OAUTH_GOOGLE_SUFFIX = '.apps.googleusercontent.com';
const OAUTH_SECRET_TAG = 'GOCSP' + 'X-';

let cachedPairs = null;
let cachedBinPath = '';

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

/**
 * Streams a binary file in chunks to locate SHA-256-verified official OAuth client pairs.
 */
export function scanAntigravityOAuthPairs(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return [];
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const OVERLAP = 512;
  const fd = fs.openSync(binPath, 'r');
  const idByHash = new Map();
  const secByHash = new Map();
  const wantedIds = new Set(OFFICIAL_OAUTH_CLIENT_PAIRS.map((p) => p.clientIdSha256));
  const wantedSecs = new Set(OFFICIAL_OAUTH_CLIENT_PAIRS.map((p) => p.clientSecretSha256));

  try {
    const stat = fs.fstatSync(fd);
    let offset = 0;
    let tailBuf = Buffer.alloc(0);
    const idAnchor = Buffer.from(OAUTH_GOOGLE_SUFFIX, 'utf8');
    const secAnchor = Buffer.from(OAUTH_SECRET_TAG, 'utf8');

    while (offset < stat.size && (idByHash.size < wantedIds.size || secByHash.size < wantedSecs.size)) {
      const readLen = Math.min(CHUNK_SIZE, stat.size - offset);
      const chunk = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fd, chunk, 0, readLen, offset);
      if (bytesRead <= 0) break;
      const work = tailBuf.length > 0 ? Buffer.concat([tailBuf, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);

      if (idByHash.size < wantedIds.size) {
        let idx = 0;
        while ((idx = work.indexOf(idAnchor, idx)) !== -1) {
          const start = Math.max(0, idx - 64);
          const slice = work.subarray(start, idx + idAnchor.length).toString('utf8');
          const m = slice.match(/[0-9]{10,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/);
          if (m) {
            const h = sha256Hex(m[0]);
            if (wantedIds.has(h) && !idByHash.has(h)) idByHash.set(h, m[0]);
          }
          idx += idAnchor.length;
        }
      }

      if (secByHash.size < wantedSecs.size) {
        let idx = 0;
        while ((idx = work.indexOf(secAnchor, idx)) !== -1) {
          const end = Math.min(work.length, idx + 48);
          const slice = work.subarray(idx, end).toString('utf8');
          const m = slice.match(/^GOCSPX-[a-zA-Z0-9_-]{17,41}/);
          if (m) {
            const raw = m[0];
            // Go binaries concatenate string literals without NUL terminators; probe exact lengths (35 first).
            const lens = raw.length >= 35 ? [35] : [];
            for (let l = Math.min(48, raw.length); l >= 24; l--) {
              if (l !== 35) lens.push(l);
            }
            for (const len of lens) {
              const cand = raw.slice(0, len);
              const h = sha256Hex(cand);
              if (wantedSecs.has(h) && !secByHash.has(h)) {
                secByHash.set(h, cand);
                break;
              }
            }
          }
          idx += secAnchor.length;
        }
      }

      tailBuf = work.length > OVERLAP ? Buffer.from(work.subarray(work.length - OVERLAP)) : Buffer.from(work);
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  const out = [];
  for (const spec of OFFICIAL_OAUTH_CLIENT_PAIRS) {
    const clientId = idByHash.get(spec.clientIdSha256);
    const clientSecret = secByHash.get(spec.clientSecretSha256);
    if (clientId && clientSecret) {
      out.push({ key: spec.key, clientId, clientSecret });
    }
  }
  return out;
}

export function discoverLanguageServerBinaries() {
  const candidates = [];
  if (process.env.AG_LANGUAGE_SERVER_BIN) {
    candidates.push(process.env.AG_LANGUAGE_SERVER_BIN);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    for (const appName of ['antigravity', 'Antigravity', 'Antigravity - Insiders']) {
      candidates.push(path.join(localApp, 'Programs', appName, 'resources', 'bin', 'language_server.exe'));
      for (const bin of ['language_server_windows_x64.exe', 'language_server_windows_arm64.exe']) {
        candidates.push(path.join(localApp, 'Programs', appName, 'resources', 'app', 'extensions', 'antigravity', 'bin', bin));
      }
    }
  } else if (process.platform === 'darwin') {
    for (const appName of ['Antigravity.app', 'Antigravity - Insiders.app']) {
      candidates.push(path.join('/Applications', appName, 'Contents', 'Resources', 'bin', 'language_server'));
      candidates.push(path.join(home, 'Applications', appName, 'Contents', 'Resources', 'bin', 'language_server'));
      for (const bin of ['language_server_macos_arm', 'language_server_macos_x64']) {
        candidates.push(path.join('/Applications', appName, 'Contents', 'Resources', 'app', 'extensions', 'antigravity', 'bin', bin));
        candidates.push(path.join(home, 'Applications', appName, 'Contents', 'Resources', 'app', 'extensions', 'antigravity', 'bin', bin));
      }
    }
  } else {
    for (const base of ['/usr/share/antigravity', '/opt/antigravity', path.join(home, '.local/share/antigravity')]) {
      candidates.push(path.join(base, 'resources', 'bin', 'language_server'));
      candidates.push(path.join(base, 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_linux_x64'));
    }
  }
  return candidates.filter((p) => p && fs.existsSync(p));
}

export function resolveOAuthClientPairs({ binPaths = null } = {}) {
  if (process.env.AG_OAUTH_CLIENT_ID && process.env.AG_OAUTH_CLIENT_SECRET) {
    return [
      {
        key: 'env_override',
        clientId: process.env.AG_OAUTH_CLIENT_ID.trim(),
        clientSecret: process.env.AG_OAUTH_CLIENT_SECRET.trim()
      }
    ];
  }
  const bins = Array.isArray(binPaths) ? binPaths : discoverLanguageServerBinaries();
  for (const bin of bins) {
    if (cachedBinPath === bin && Array.isArray(cachedPairs) && cachedPairs.length > 0) {
      return cachedPairs;
    }
    try {
      const pairs = scanAntigravityOAuthPairs(bin);
      if (pairs.length > 0) {
        cachedBinPath = bin;
        cachedPairs = pairs;
        return pairs;
      }
    } catch {}
  }
  return [];
}

/**
 * Extracts normalized OAuth fields from raw credential JSON stored in OS vault.
 */
export function parseOAuthTokenPayload(rawText) {
  if (!rawText) return null;
  try {
    const outer = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
    if (!outer || typeof outer !== 'object') return null;
    let inner = outer;
    if (outer.token && typeof outer.token === 'object') {
      inner = outer.token;
    } else if (typeof outer.token === 'string' && outer.token) {
      try {
        const decoded = JSON.parse(Buffer.from(outer.token, 'base64').toString('utf8'));
        if (decoded && typeof decoded === 'object') inner = decoded;
      } catch {}
    }
    const accessToken = String(inner.access_token || outer.access_token || '').trim();
    const refreshToken = String(inner.refresh_token || outer.refresh_token || '').trim();
    const idToken = String(inner.id_token || outer.id_token || '').trim();
    let expiryDate = Number(inner.expiry_date || outer.expiry_date || 0) || null;
    if (!expiryDate && typeof (inner.expiry || outer.expiry) === 'string') {
      const parsedMs = Date.parse(inner.expiry || outer.expiry);
      if (Number.isFinite(parsedMs) && parsedMs > 0) expiryDate = parsedMs;
    }
    const email = normalizeCredEmail(outer.id_token_email || inner.id_token_email || outer.email || decodeJwtEmail(idToken));
    return { accessToken, refreshToken, idToken, expiryDate, email, outer, inner };
  } catch {
    return null;
  }
}

export function buildVaultCredentialJson({
  accessToken,
  refreshToken,
  idToken = '',
  expiryDate = null,
  expiresIn = null,
  email = '',
  templateRaw = ''
}) {
  let baseOuter = {};
  let baseTokenObj = null;
  let useLegacyString = false;
  if (templateRaw) {
    try {
      const parsed = typeof templateRaw === 'string' ? JSON.parse(templateRaw) : templateRaw;
      if (parsed && typeof parsed === 'object') {
        baseOuter = { ...parsed };
        if (parsed.token && typeof parsed.token === 'object') {
          baseTokenObj = { ...parsed.token };
        } else if (typeof parsed.token === 'string') {
          useLegacyString = true;
        }
      }
    } catch {}
  }

  const expiryMs = Number(expiryDate || 0);
  const hasExpiryMs = Number.isFinite(expiryMs) && expiryMs > 0;
  const expiryIso = hasExpiryMs ? new Date(expiryMs).toISOString() : '';
  const resolvedExpiresIn =
    Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
      ? Math.round(Number(expiresIn))
      : hasExpiryMs
      ? Math.max(0, Math.round((expiryMs - Date.now()) / 1000))
      : null;

  const inner = {
    ...(baseTokenObj || {}),
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    ...(idToken ? { id_token: idToken } : {}),
    ...(hasExpiryMs ? { expiry_date: expiryMs, expiry: expiryIso } : {}),
    ...(resolvedExpiresIn !== null ? { expires_in: resolvedExpiresIn } : {}),
    ...(email && useLegacyString ? { id_token_email: email } : {})
  };

  if (useLegacyString) {
    const encodedToken = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    return JSON.stringify({
      ...baseOuter,
      ...(email ? { id_token_email: email } : {}),
      token: encodedToken
    });
  }

  return JSON.stringify({
    ...baseOuter,
    token: inner,
    auth_method: baseOuter.auth_method || 'consumer',
    ...(email ? { id_token_email: email } : {})
  });
}

export async function refreshAccessToken(refreshToken, { pairs = null, fetchImpl = globalThis.fetch } = {}) {
  const rt = String(refreshToken || '').trim();
  if (!rt) throw new Error('Missing refresh token');
  const resolvedPairs = Array.isArray(pairs) && pairs.length > 0 ? pairs : resolveOAuthClientPairs();
  if (resolvedPairs.length === 0) {
    throw new Error('Antigravity OAuth client pair not found on this machine');
  }
  let lastErr = null;
  for (const pair of resolvedPairs) {
    const body = new URLSearchParams({
      client_id: pair.clientId,
      client_secret: pair.clientSecret,
      refresh_token: rt,
      grant_type: 'refresh_token'
    }).toString();
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      return {
        accessToken: String(data.access_token),
        refreshToken: String(data.refresh_token || rt),
        idToken: String(data.id_token || ''),
        expiresIn: Number(data.expires_in || 3600),
        expiryDate: Date.now() + Number(data.expires_in || 3600) * 1000,
        clientKey: pair.key
      };
    }
    lastErr = new Error(data.error_description || data.error || `OAuth refresh failed (${res.status})`);
    if (data.error === 'invalid_grant') throw lastErr;
  }
  throw lastErr || new Error('OAuth refresh failed');
}

export async function fetchGoogleUserInfo(accessToken, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && data.email ? { email: normalizeCredEmail(data.email), name: String(data.name || '').trim() } : null;
}

/**
 * Runs a local HTTP loopback OAuth2 authorization code flow via the user's default browser.
 */
export async function startLoopbackOAuthFlow({
  pairs = null,
  openUrl = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180000
} = {}) {
  const resolvedPairs = Array.isArray(pairs) && pairs.length > 0 ? pairs : resolveOAuthClientPairs();
  if (resolvedPairs.length === 0) {
    throw new Error('Antigravity OAuth client pair not found on this machine');
  }
  const pair = resolvedPairs[0];
  const state = crypto.randomBytes(16).toString('hex');

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const server = http.createServer();

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {}
      if (err) reject(err);
      else resolve(value);
    };

    server.on('request', async (req, res) => {
      try {
        const ra = String(req.socket?.remoteAddress || '');
        if (ra && ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        if (reqUrl.pathname !== '/auth/callback' && reqUrl.pathname !== '/oauth-callback') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const errParam = reqUrl.searchParams.get('error');
        if (errParam) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Authorization Cancelled</h3><p>You can close this window.</p>');
          finish(new Error(`OAuth cancelled: ${errParam}`));
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const cbState = reqUrl.searchParams.get('state');
        if (!code || cbState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Invalid OAuth State</h3>');
          finish(new Error('Invalid OAuth callback state'));
          return;
        }

        const addr = server.address();
        const redirectUri = `http://localhost:${addr.port}/auth/callback`;
        const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: pair.clientId,
            client_secret: pair.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          }).toString()
        });
        const tokData = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokData.access_token) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Token Exchange Failed</h3>');
          finish(new Error(tokData.error_description || tokData.error || 'Token exchange failed'));
          return;
        }

        const accessToken = String(tokData.access_token);
        const refreshToken = String(tokData.refresh_token || '');
        const idToken = String(tokData.id_token || '');
        const expiryDate = Date.now() + Number(tokData.expires_in || 3600) * 1000;
        const userInfo = await fetchGoogleUserInfo(accessToken, { fetchImpl }).catch(() => null);
        const email = normalizeCredEmail(userInfo?.email || decodeJwtEmail(idToken));

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px"><h2>Antigravity 登录成功</h2><p>${email || 'Account linked'}. 请返回 Antigravity 查看账号面板。</p></body></html>`
        );
        finish(null, {
          email,
          name: userInfo?.name || '',
          accessToken,
          refreshToken,
          idToken,
          expiryDate,
          credJson: buildVaultCredentialJson({
            accessToken,
            refreshToken,
            idToken,
            expiryDate,
            expiresIn: tokData.expires_in,
            email
          })
        });
      } catch (err) {
        finish(err);
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      const redirectUri = `http://localhost:${addr.port}/auth/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', pair.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', ANTIGRAVITY_OAUTH_SCOPES);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent select_account');
      authUrl.searchParams.set('state', state);

      if (typeof openUrl === 'function') {
        try {
          openUrl(authUrl.toString());
        } catch {}
      }
      timer = setTimeout(() => {
        finish(new Error('OAuth login timed out'));
      }, timeoutMs);
    });
  });
}

const CLOUDCODE_QUOTA_BASES = Object.freeze([
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
]);

export function resolveAntigravityUserAgent() {
  let lsVer = '';
  try {
    lsVer = String(discoverLiveHub()?.lsVersion || '').trim();
  } catch {}
  const ver = lsVer || '2.36.0';
  const plat = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `antigravity/${ver} ${plat}/${arch}`;
}

export function normalizeCloudCodePlanName(lcaData) {
  if (!lcaData || typeof lcaData !== 'object') return '';
  const raw = String(
    lcaData?.paidTier?.name ||
      lcaData?.paidTier?.id ||
      lcaData?.currentTier?.name ||
      lcaData?.currentTier?.id ||
      ''
  ).trim();
  if (!raw) return '';
  if (/ultra/i.test(raw)) return 'Ultra';
  if (/pro/i.test(raw)) return 'Pro';
  if (/plus/i.test(raw)) return 'Plus';
  if (/enterprise|teams/i.test(raw)) return 'Enterprise';
  if (/free|standard|legacy|antigravity/i.test(raw)) return 'Free';
  return raw;
}

export function parseAvailableModelsQuota(rawJson, nowMs = Date.now(), { planName = '' } = {}) {
  const modelsMap = rawJson?.models && typeof rawJson.models === 'object' ? rawJson.models : null;
  if (!modelsMap) return null;

  const pools = new Map();
  for (const [modelId, info] of Object.entries(modelsMap)) {
    if (!info || typeof info !== 'object') continue;
    const qi = info.quotaInfo && typeof info.quotaInfo === 'object' ? info.quotaInfo : null;
    if (!qi) continue;
    const hasFrac = typeof qi.remainingFraction === 'number' && Number.isFinite(qi.remainingFraction);
    const resetTime = typeof qi.resetTime === 'string' ? qi.resetTime.trim() : '';
    if (!hasFrac && !resetTime) continue;

    const label = String(info.displayName || modelId || '').trim();
    const low = `${modelId} ${label}`.toLowerCase();
    const isGemini = /\bgemini\b/.test(low);
    const is3p = /\bclaude\b|\bgpt\b|\bopus\b|\bsonnet\b/.test(low);
    const key = isGemini && !is3p ? 'gemini' : is3p ? 'claude-gpt' : '';
    if (!key) continue;

    const resetMs = resetTime ? Date.parse(resetTime) : NaN;
    const expired = Number.isFinite(resetMs) && resetMs <= nowMs;
    const frac = expired ? 1 : hasFrac ? Math.max(0, Math.min(1, qi.remainingFraction)) : null;
    const pct = frac === null ? null : Math.round(frac * 100);
    const resetInSec = expired
      ? 0
      : Number.isFinite(resetMs)
      ? Math.max(0, Math.round((resetMs - nowMs) / 1000))
      : null;

    const existing = pools.get(key);
    const candWin = {
      remainingFraction: frac,
      remainingPct: pct,
      resetTime: expired ? '' : resetTime,
      resetInSec,
      ...(expired ? { expiredReset: true } : {})
    };
    if (!existing || (pct !== null && (existing.remainingPct === null || pct < existing.remainingPct))) {
      pools.set(key, candWin);
    }
  }

  if (pools.size === 0) return null;
  const order = ['gemini', 'claude-gpt'];
  const groups = [];
  const buckets = [];
  for (const key of order) {
    const win = pools.get(key);
    if (!win) continue;
    const label = key === 'gemini' ? 'Gemini' : 'Claude / GPT';
    groups.push({ key, label, fiveHour: win, weekly: null });
    buckets.push({
      key,
      label,
      remainingFraction: win.remainingFraction,
      remainingPct: win.remainingPct,
      resetTime: win.resetTime,
      resetInSec: win.resetInSec,
      modelCount: 0
    });
  }
  return {
    ok: true,
    fetchedAt: nowMs,
    planName: String(planName || '').trim(),
    availablePromptCredits: null,
    availableFlowCredits: null,
    groups,
    buckets
  };
}

async function postCloudCodeJson(url, headers, bodyObj, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj || {}),
      signal: ctrl ? ctrl.signal : undefined
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? '' : String(data?.error?.message || data?.error || `HTTP ${res.status}`)
    };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err?.message || String(err || 'request failed') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetches official per-account quota via Google OAuth2 + CloudCode Assist control-plane APIs
 * (daily-cloudcode-pa.googleapis.com -> loadCodeAssist + retrieveUserQuotaSummary / fetchAvailableModels).
 */
export async function fetchAccountCloudCodeQuota({
  rawCredentialJson = '',
  accessToken: inputAccessToken = '',
  refreshToken: inputRefreshToken = '',
  email = '',
  pairs = null,
  fetchImpl = globalThis.fetch,
  nowFn = () => Date.now(),
  timeoutMs = 10000,
  userAgent = ''
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch unavailable', quota: null, planName: '', refreshedCredJson: '' };
  }
  const parsed = rawCredentialJson ? parseOAuthTokenPayload(rawCredentialJson) : null;
  let accessToken = String(inputAccessToken || parsed?.accessToken || '').trim();
  let refreshToken = String(inputRefreshToken || parsed?.refreshToken || '').trim();
  let idToken = String(parsed?.idToken || '').trim();
  let expiryDate = parsed?.expiryDate || null;
  let didRefresh = false;
  let refreshedExpiresIn = null;
  const nowMs = nowFn();

  const ensureFreshToken = async (forceRefresh = false) => {
    const isFresh = Boolean(accessToken && expiryDate && expiryDate - nowMs > 120_000);
    if (!forceRefresh && isFresh) return accessToken;
    if (!refreshToken) {
      if (accessToken && !forceRefresh) return accessToken;
      throw new Error('Missing OAuth refresh token');
    }
    const tok = await refreshAccessToken(refreshToken, { pairs, fetchImpl });
    accessToken = tok.accessToken;
    refreshToken = tok.refreshToken || refreshToken;
    if (tok.idToken) idToken = tok.idToken;
    expiryDate = tok.expiryDate || nowMs + 3600_000;
    refreshedExpiresIn = tok.expiresIn || 3600;
    didRefresh = true;
    return accessToken;
  };

  try {
    await ensureFreshToken(false);
  } catch (err) {
    const msg = err?.message || String(err || 'OAuth refresh failed');
    const isRevoked = /invalid_grant|revoked|expired/i.test(msg);
    return {
      ok: false,
      error: isRevoked ? 'OAuth token expired or revoked; please re-add account' : msg,
      quota: null,
      planName: '',
      refreshedCredJson: ''
    };
  }

  const ua = userAgent || resolveAntigravityUserAgent();
  const buildHeaders = (tok) => ({
    Authorization: `Bearer ${tok}`,
    'Content-Type': 'application/json',
    'User-Agent': ua
  });

  const callWithAuthRetry = async (baseUrl, epPath, bodyObj) => {
    let res = await postCloudCodeJson(`${baseUrl}${epPath}`, buildHeaders(accessToken), bodyObj, {
      fetchImpl,
      timeoutMs
    });
    if (res.status === 401 && refreshToken) {
      try {
        await ensureFreshToken(true);
        res = await postCloudCodeJson(`${baseUrl}${epPath}`, buildHeaders(accessToken), bodyObj, {
          fetchImpl,
          timeoutMs
        });
      } catch (err) {
        return { ok: false, status: 401, data: null, error: err?.message || 'Unauthorized' };
      }
    }
    return res;
  };

  let lastErr = '';
  for (const baseUrl of CLOUDCODE_QUOTA_BASES) {
    const lcaRes = await callWithAuthRetry(baseUrl, '/v1internal:loadCodeAssist', {
      metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' }
    });
    const proj = String(lcaRes.data?.cloudaicompanionProject || '').trim();
    const planName = normalizeCloudCodePlanName(lcaRes.data);
    const reqBody = proj ? { project: proj } : {};

    const sumRes = await callWithAuthRetry(baseUrl, '/v1internal:retrieveUserQuotaSummary', reqBody);
    const doneNow = nowFn();
    const sumParsed = sumRes.ok && sumRes.data ? parseQuotaSummary(sumRes.data, doneNow, { planName }) : null;
    let quota = sumParsed;

    if (!quota) {
      const famRes = await callWithAuthRetry(baseUrl, '/v1internal:fetchAvailableModels', reqBody);
      if (famRes.ok && famRes.data) {
        quota = parseAvailableModelsQuota(famRes.data, nowFn(), { planName });
      }
      if (!quota) {
        lastErr = sumRes.error || famRes.error || lcaRes.error || 'CloudCode quota unavailable';
      }
    }

    if (quota) {
      const refreshedCredJson = didRefresh
        ? buildVaultCredentialJson({
            accessToken,
            refreshToken,
            idToken,
            expiryDate,
            expiresIn: refreshedExpiresIn,
            email: normalizeCredEmail(email || parsed?.email || ''),
            templateRaw: rawCredentialJson
          })
        : '';
      return {
        ok: true,
        quota,
        planName: quota.planName || planName,
        project: proj,
        refreshedCredJson,
        error: ''
      };
    }

    if (sumRes.status === 401 || sumRes.status === 403 || lcaRes.status === 403) {
      lastErr = sumRes.error || lcaRes.error || `HTTP ${sumRes.status || lcaRes.status}`;
      break;
    }
  }

  return {
    ok: false,
    error: lastErr || 'CloudCode quota request failed',
    quota: null,
    planName: '',
    refreshedCredJson: ''
  };
}
