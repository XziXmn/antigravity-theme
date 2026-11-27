/**
 * core/daemon/accounts.mjs — Multi-Account Store, Timeline Attribution & Quota Sampler
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeCredEmail, syncDesktopAndCliCredentials, clearDesktopOAuthState } from './credential-vault.mjs';
import { parseOAuthTokenPayload, startLoopbackOAuthFlow } from './account-oauth.mjs';
import { syncOnboardingStorageFile } from '../installer/relaunch-worker.mjs';

const MAX_TIMELINE_ENTRIES = 512;
const MAX_QUOTA_SAMPLES = 4000;
const QUOTA_SAMPLE_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const AUTO_SWITCH_COOLDOWN_MS = 120 * 1000;
const SAMPLE_MIN_GAP_MS = 5 * 60 * 1000;
const PENDING_SWITCH_TTL_MS = 5 * 60 * 1000;

function sanitizePendingSwitch(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const targetId = typeof raw.targetId === 'string' ? raw.targetId : '';
  const targetEmail = normalizeCredEmail(raw.targetEmail);
  const atMs = Number(raw.atMs);
  if (!targetId || !targetEmail || !Number.isFinite(atMs) || nowMs - atMs >= PENDING_SWITCH_TTL_MS) {
    return null;
  }
  return { targetId, targetEmail, atMs };
}

function readOnboardingState(appStoragePath = '') {
  const target =
    appStoragePath ||
    (process.env.APPDATA ? path.join(process.env.APPDATA, 'Antigravity', 'app_storage.json') : '');
  if (!target) return null;
  try {
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rawEmail = parsed['agy.onboarding.lastLoginUsername'] ?? parsed['jetski.onboarding.lastLoginUsername'] ?? '';
    const rawTos = parsed['agy.onboarding.lastLoginIsGcpTos'] ?? parsed['jetski.onboarding.lastLoginIsGcpTos'];
    const email = normalizeCredEmail(rawEmail);
    const isGcpTos =
      rawTos === 'true' || rawTos === true ? true : rawTos === 'false' || rawTos === false ? false : null;
    return email ? { email, isGcpTos } : null;
  } catch {
    return null;
  }
}

export const DEFAULT_AUTO_SWITCH_CONFIG = Object.freeze({
  enabled: false,
  pool: 'gemini',
  window: 'fiveHour',
  thresholdPct: 5,
  autoRelaunch: true
});

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeAutoSwitch(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pool = src.pool === 'claude-gpt' ? 'claude-gpt' : 'gemini';
  const win = src.window === 'weekly' ? 'weekly' : 'fiveHour';
  const thr = Number(src.thresholdPct);
  return {
    enabled: Boolean(src.enabled),
    pool,
    window: win,
    thresholdPct: Number.isFinite(thr) ? Math.max(0, Math.min(50, Math.round(thr))) : 5,
    autoRelaunch: src.autoRelaunch !== false
  };
}

function pickGroupQuotaPct(quota, poolKey = 'gemini', windowKey = 'fiveHour') {
  if (!quota || !Array.isArray(quota.groups)) return null;
  const g = quota.groups.find((x) => x.key === poolKey || (poolKey === 'claude-gpt' && x.key === 'claude'));
  if (!g) return null;
  const w = windowKey === 'weekly' ? g.weekly : g.fiveHour;
  if (!w || typeof w.remainingPct !== 'number') return null;
  return w.remainingPct;
}

export function createAccountsManager({
  userDir,
  vault,
  lsClient = null,
  getDatabaseSync = null,
  relaunchHost = null,
  openExternalUrl = null,
  nowFn = () => Date.now(),
  fetchImpl = globalThis.fetch,
  oauthPairs = null,
  log = () => {}
} = {}) {
  const accountsPath = path.join(userDir, 'accounts.json');
  const timelinePath = path.join(userDir, 'account-timeline.json');
  const samplesPath = path.join(userDir, 'quota-samples.json');

  let oauthInProgress = false;
  let lastAutoSwitchNotice = null;
  let lastRefreshAllAtMs = 0;

  function loadStore() {
    const raw = readJsonSafe(accountsPath, {});
    const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter((a) => a && typeof a.id === 'string') : [];
    return {
      schemaVersion: 1,
      activeId: typeof raw.activeId === 'string' ? raw.activeId : '',
      privacyMask: Boolean(raw.privacyMask),
      pendingNativeLogin: Boolean(raw.pendingNativeLogin),
      pendingSwitch: sanitizePendingSwitch(raw.pendingSwitch, nowFn()),
      lastAutoSwitchAtMs: Number(raw.lastAutoSwitchAtMs) || 0,
      autoSwitch: normalizeAutoSwitch(raw.autoSwitch),
      accounts
    };
  }

  function saveStore(store) {
    atomicWriteJson(accountsPath, store);
  }

  function appendTimeline(email, ts = nowFn()) {
    const norm = normalizeCredEmail(email);
    if (!norm) return;
    const raw = readJsonSafe(timelinePath, []);
    const list = Array.isArray(raw) ? raw.filter((e) => e && e.email && Number.isFinite(e.sinceMs)) : [];
    const last = list[list.length - 1];
    if (last && normalizeCredEmail(last.email) === norm) return;
    list.push({ email: norm, sinceMs: ts });
    atomicWriteJson(timelinePath, list.slice(-MAX_TIMELINE_ENTRIES));
  }

  function recordQuotaSamples(email, quota, ts = nowFn()) {
    const norm = normalizeCredEmail(email);
    if (!norm || !quota || !Array.isArray(quota.groups) || quota.groups.length === 0) return;
    const raw = readJsonSafe(samplesPath, []);
    const cutoff = ts - QUOTA_SAMPLE_MAX_AGE_MS;
    const list = Array.isArray(raw) ? raw.filter((s) => s && Number.isFinite(s.ts) && s.ts >= cutoff) : [];

    let changed = false;
    for (const g of quota.groups) {
      if (!g || !g.key) continue;
      const fhPct = typeof g.fiveHour?.remainingPct === 'number' ? g.fiveHour.remainingPct : null;
      const wkPct = typeof g.weekly?.remainingPct === 'number' ? g.weekly.remainingPct : null;
      if (fhPct === null && wkPct === null) continue;

      let prev = null;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].email === norm && list[i].key === g.key) {
          prev = list[i];
          break;
        }
      }
      if (prev && ts - prev.ts < SAMPLE_MIN_GAP_MS && prev.fiveHourPct === fhPct && prev.weeklyPct === wkPct) {
        continue;
      }
      if (prev && prev.fiveHourPct === fhPct && prev.weeklyPct === wkPct && ts - prev.ts < 30 * 60 * 1000) {
        continue;
      }
      list.push({
        ts,
        email: norm,
        key: g.key,
        fiveHourPct: fhPct,
        fiveHourReset: g.fiveHour?.resetTime || '',
        weeklyPct: wkPct,
        weeklyReset: g.weekly?.resetTime || ''
      });
      changed = true;
    }
    if (changed) {
      atomicWriteJson(samplesPath, list.slice(-MAX_QUOTA_SAMPLES));
    }
  }

  function upsertAccountRecord(store, { email, alias = '', planName = '', credHash = '', hasCredential = false, quota = null, quotaSource = '' }) {
    const norm = normalizeCredEmail(email);
    if (!norm) throw new Error('Valid email is required');
    const ts = nowFn();
    let acct = store.accounts.find((a) => normalizeCredEmail(a.email) === norm);
    if (!acct) {
      const id = `acc_${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10)}`;
      acct = {
        id,
        email: norm,
        alias: String(alias || '').trim().slice(0, 40),
        planName: String(planName || '').trim(),
        disabled: false,
        hasCredential: Boolean(hasCredential),
        credHash: String(credHash || ''),
        quotaSource: quotaSource || '',
        lastQuota: quota || null,
        addedAt: ts,
        updatedAt: ts
      };
      store.accounts.push(acct);
    } else {
      if (alias) acct.alias = String(alias).trim().slice(0, 40);
      if (planName) acct.planName = String(planName).trim();
      if (credHash) acct.credHash = String(credHash);
      if (hasCredential) acct.hasCredential = true;
      if (quota) acct.lastQuota = quota;
      if (quotaSource) acct.quotaSource = quotaSource;
      acct.updatedAt = ts;
    }
    return acct;
  }

  function reconcileQuotaWindow(win, nowMs) {
    if (!win || typeof win !== 'object') return null;
    const resetTime = typeof win.resetTime === 'string' ? win.resetTime.trim() : '';
    const resetMs = resetTime ? Date.parse(resetTime) : NaN;
    if (Number.isFinite(resetMs) && resetMs <= nowMs) {
      return {
        ...win,
        remainingFraction: 1,
        remainingPct: 100,
        resetTime: '',
        resetInSec: 0,
        expiredReset: true
      };
    }
    const resetInSec = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : win.resetInSec ?? null;
    return { ...win, resetInSec };
  }

  function reconcileOfflineQuotaSnapshot(quota, nowMs) {
    if (!quota || typeof quota !== 'object') return null;
    const groups = Array.isArray(quota.groups)
      ? quota.groups.map((g) => ({
          ...g,
          fiveHour: reconcileQuotaWindow(g.fiveHour, nowMs),
          weekly: reconcileQuotaWindow(g.weekly, nowMs)
        }))
      : [];
    const buckets = Array.isArray(quota.buckets)
      ? quota.buckets.map((b) => reconcileQuotaWindow(b, nowMs) || b)
      : [];
    return { ...quota, groups, buckets };
  }

  function getOverview() {
    const store = loadStore();
    const now = nowFn();
    const cap = vault ? vault.getCapability() : { supported: false, backend: 'none', reason: 'vault unavailable' };
    const activeCred = cap.supported ? vault.readActiveInfo() : { exists: false, email: '', hash: '' };
    const pendingSwitch = sanitizePendingSwitch(store.pendingSwitch, now);
    const activeByCred = activeCred.email
      ? store.accounts.find((a) => normalizeCredEmail(a.email) === activeCred.email)
      : null;
    const effectiveActiveId = activeByCred ? activeByCred.id : store.activeId;
    return {
      ok: true,
      activeId: effectiveActiveId,
      activeSystemEmail: activeCred.email || '',
      privacyMask: store.privacyMask,
      pendingNativeLogin: store.pendingNativeLogin,
      pendingSwitch,
      autoSwitch: store.autoSwitch,
      vaultCapability: cap,
      oauthInProgress,
      lastAutoSwitchNotice,
      accounts: store.accounts.map((a) => ({
        ...a,
        lastQuota: reconcileOfflineQuotaSnapshot(a.lastQuota, now),
        isActive: a.id === effectiveActiveId,
        isPendingTarget: Boolean(pendingSwitch && a.id === pendingSwitch.targetId)
      }))
    };
  }

  async function captureCurrentAccount({ alias = '' } = {}) {
    const cap = vault ? vault.getCapability() : { supported: false, reason: 'vault unavailable' };
    if (!cap.supported) throw new Error(cap.reason || 'OS credential vault unsupported');

    let identity = null;
    if (lsClient && typeof lsClient.getUserIdentity === 'function') {
      identity = await lsClient.getUserIdentity().catch(() => null);
    }
    const activeInfo = vault.readActiveInfo();
    const email = normalizeCredEmail(identity?.email || activeInfo.email);
    if (!email) {
      throw new Error('No active Antigravity account detected. Please sign in first.');
    }

    const store = loadStore();
    const existing = store.accounts.find((a) => normalizeCredEmail(a.email) === email);
    const targetId = existing ? existing.id : `acc_${crypto.createHash('sha1').update(email).digest('hex').slice(0, 10)}`;

    const backup = vault.saveActiveTo(targetId, { expectedEmail: email });
    if (!backup.ok) {
      throw new Error(backup.error || 'Failed to capture current credential');
    }

    let quota = null;
    if (lsClient && typeof lsClient.getQuotaStatus === 'function') {
      quota = await lsClient.getQuotaStatus({ force: false }).catch(() => null);
    }
    const acct = upsertAccountRecord(store, {
      email,
      alias,
      planName: identity?.planName || quota?.planName || '',
      credHash: backup.hash,
      hasCredential: true,
      quota: quota && quota.ok ? quota : null,
      quotaSource: quota && quota.ok ? 'local-ls' : ''
    });
    store.activeId = acct.id;
    store.pendingNativeLogin = false;
    saveStore(store);
    appendTimeline(email);
    if (quota && quota.ok) recordQuotaSamples(email, quota);
    return { ok: true, account: acct, overview: getOverview() };
  }

  async function refreshOneAccountQuota(store, acct, { activeEmail = '' } = {}) {
    const norm = normalizeCredEmail(acct.email);
    const pending = sanitizePendingSwitch(store.pendingSwitch, nowFn());
    const isCurrent = pending
      ? false
      : activeEmail
      ? norm === activeEmail
      : acct.id === store.activeId;
    if (isCurrent && lsClient && typeof lsClient.getQuotaStatus === 'function') {
      const q = await lsClient.getQuotaStatus({ force: true }).catch(() => null);
      if (q && q.ok) {
        acct.lastQuota = q;
        if (q.planName) acct.planName = q.planName;
        acct.quotaSource = 'local-ls';
        acct.quotaError = '';
        acct.updatedAt = nowFn();
        recordQuotaSamples(norm, q);
        return { ok: true, id: acct.id, source: 'local-ls' };
      }
    }

    // Never call external private CloudCode APIs for inactive accounts;
    // preserve last official client snapshot and reconcile any elapsed reset windows offline.
    acct.lastQuota = reconcileOfflineQuotaSnapshot(acct.lastQuota, nowFn());
    acct.quotaSource = 'cached';
    acct.quotaError = '';
    return { ok: true, id: acct.id, source: 'cached', offline: true };
  }

  async function refreshQuota(accountId = 'all', { minIntervalMs = 0 } = {}) {
    const now = nowFn();
    if ((accountId === 'all' || accountId === 'active') && minIntervalMs > 0 && lastRefreshAllAtMs > 0 && now - lastRefreshAllAtMs < minIntervalMs) {
      return { ok: true, throttled: true, overview: getOverview() };
    }
    const store = loadStore();
    const activeInfo = vault && vault.getCapability().supported ? vault.readActiveInfo() : { email: '' };
    const targets =
      accountId === 'all' || accountId === 'active'
        ? store.accounts.filter((a) => !a.disabled)
        : store.accounts.filter((a) => a.id === accountId);

    const results = [];
    for (const a of targets) {
      results.push(await refreshOneAccountQuota(store, a, { activeEmail: activeInfo.email }));
    }
    if (accountId === 'all' || accountId === 'active') lastRefreshAllAtMs = nowFn();
    saveStore(store);
    return { ok: true, results, overview: getOverview() };
  }

  async function switchAccount(accountId, { auto = false, relaunch = true } = {}) {
    const cap = vault ? vault.getCapability() : { supported: false, reason: 'vault unavailable' };
    if (!cap.supported) throw new Error(cap.reason || 'OS credential vault unsupported');

    const store = loadStore();
    const target = store.accounts.find((a) => a.id === accountId);
    if (!target) throw new Error('Account not found');
    if (target.disabled) throw new Error('Account is disabled');

    const ts = nowFn();
    if (auto && ts - store.lastAutoSwitchAtMs < AUTO_SWITCH_COOLDOWN_MS) {
      throw new Error('Auto-switch cooldown active');
    }

    const current = store.accounts.find((a) => a.id === store.activeId);
    const hasPending = Boolean(sanitizePendingSwitch(store.pendingSwitch, ts));
    if (current && current.id !== target.id && !hasPending) {
      const backup = vault.saveActiveTo(current.id, { expectedEmail: current.email });
      if (backup.ok) {
        current.hasCredential = true;
        current.credHash = backup.hash;
      }
    }

    const savedInfo = typeof vault.readSavedInfo === 'function' ? vault.readSavedInfo(target.id) : null;
    if (savedInfo && savedInfo.exists) {
      if (savedInfo.email && normalizeCredEmail(savedInfo.email) !== normalizeCredEmail(target.email)) {
        target.hasCredential = false;
        saveStore(store);
        throw new Error(`Saved credential belongs to ${savedInfo.email}, not ${target.email}`);
      }
      if (current && current.id !== target.id && current.credHash && savedInfo.hash && savedInfo.hash === current.credHash) {
        target.hasCredential = false;
        saveStore(store);
        throw new Error('Saved credential duplicates active account; please re-add target account');
      }
    }

    const restored = vault.restoreToActive(target.id, { expectedEmail: target.email });
    if (!restored.ok) {
      if (restored.mismatch || restored.missing) {
        target.hasCredential = false;
        saveStore(store);
      }
      throw new Error(restored.error || 'Failed to restore target credential');
    }

    target.hasCredential = true;
    target.credHash = restored.hash;
    target.lastUsedAtMs = ts;
    target.updatedAt = ts;
    store.activeId = target.id;
    store.pendingSwitch = {
      targetId: target.id,
      targetEmail: normalizeCredEmail(target.email),
      atMs: ts
    };
    if (auto) store.lastAutoSwitchAtMs = ts;
    saveStore(store);
    appendTimeline(target.email, ts);

    // Sync Desktop state.vscdb & CLI credentials if OAuth fields are present
    const parsedCred = parseOAuthTokenPayload(restored.raw);
    let syncRes = null;
    if (parsedCred && (parsedCred.accessToken || parsedCred.refreshToken)) {
      syncRes = syncDesktopAndCliCredentials({
        accessToken: parsedCred.accessToken,
        refreshToken: parsedCred.refreshToken,
        expirySeconds: parsedCred.expiryDate ? Math.floor(parsedCred.expiryDate / 1000) : null,
        idToken: parsedCred.idToken,
        email: target.email,
        getDatabaseSync
      });
    }

    const onboardingSync =
      target.onboardingAccepted || target.quotaSource === 'local-ls' || Boolean(target.lastQuota?.ok)
        ? {
            email: normalizeCredEmail(target.email),
            isGcpTos: typeof target.isGcpTos === 'boolean' ? target.isGcpTos : null
          }
        : null;

    let relaunched = false;
    let manualRestartRequired = false;
    let relaunchError = '';
    if (relaunch && typeof relaunchHost === 'function') {
      try {
        const rRes = await relaunchHost({ force: true, onboardingSync });
        if (rRes && rRes.ok === false) {
          manualRestartRequired = true;
          relaunchError = rRes.reason || rRes.error || 'Relaunch skipped';
        } else {
          relaunched = true;
        }
      } catch (err) {
        manualRestartRequired = true;
        relaunchError = err?.message || String(err || 'Relaunch failed');
      }
    } else if (relaunch) {
      manualRestartRequired = true;
    } else if (onboardingSync) {
      syncOnboardingStorageFile(onboardingSync);
    }

    return {
      ok: true,
      account: target,
      auto,
      relaunched,
      manualRestartRequired,
      relaunchError,
      syncRes,
      overview: getOverview()
    };
  }

  async function startOAuthAddAccount() {
    const cap = vault ? vault.getCapability() : { supported: false, reason: 'vault unavailable' };
    if (!cap.supported) throw new Error(cap.reason || 'OS credential vault unsupported');
    if (oauthInProgress) throw new Error('OAuth login already in progress');
    oauthInProgress = true;
    try {
      const res = await startLoopbackOAuthFlow({
        pairs: oauthPairs,
        openUrl: openExternalUrl,
        fetchImpl
      });
      if (!res.email) throw new Error('Could not determine Google account email');
      const store = loadStore();
      const id =
        store.accounts.find((a) => normalizeCredEmail(a.email) === res.email)?.id ||
        `acc_${crypto.createHash('sha1').update(res.email).digest('hex').slice(0, 10)}`;
      const saved = vault.writeSavedRaw(id, res.credJson, { expectedEmail: res.email });
      if (!saved.ok) throw new Error(saved.error || 'Failed to store credential');

      const acct = upsertAccountRecord(store, {
        email: res.email,
        planName: '',
        credHash: saved.hash,
        hasCredential: true,
        quota: null,
        quotaSource: 'cached'
      });
      saveStore(store);
      return { ok: true, account: acct, overview: getOverview() };
    } finally {
      oauthInProgress = false;
    }
  }

  async function prepareNativeLoginAdd({ relaunch = true } = {}) {
    const cap = vault ? vault.getCapability() : { supported: false, reason: 'vault unavailable' };
    if (!cap.supported) throw new Error(cap.reason || 'OS credential vault unsupported');

    const store = loadStore();
    const current = store.accounts.find((a) => a.id === store.activeId);
    const activeInfo = vault.readActiveInfo();
    if (activeInfo.exists && activeInfo.email) {
      const targetId =
        current?.id ||
        store.accounts.find((a) => normalizeCredEmail(a.email) === activeInfo.email)?.id ||
        `acc_${crypto.createHash('sha1').update(activeInfo.email).digest('hex').slice(0, 10)}`;
      const backup = vault.saveActiveTo(targetId, { expectedEmail: activeInfo.email });
      if (backup.ok) {
        upsertAccountRecord(store, {
          email: activeInfo.email,
          credHash: backup.hash,
          hasCredential: true
        });
      }
    }

    if (typeof vault.clearActiveSystemCredential === 'function') {
      vault.clearActiveSystemCredential();
    }
    clearDesktopOAuthState({ getDatabaseSync });
    store.activeId = '';
    store.pendingSwitch = null;
    store.pendingNativeLogin = true;
    saveStore(store);

    let relaunched = false;
    let relaunchError = '';
    if (relaunch && typeof relaunchHost === 'function') {
      try {
        await relaunchHost();
        relaunched = true;
      } catch (err) {
        relaunchError = err?.message || String(err || 'Relaunch failed');
      }
    }
    return { ok: true, pendingNativeLogin: true, relaunched, relaunchError, overview: getOverview() };
  }

  async function observeLiveStatus({ identity = null, quota = null } = {}) {
    const store = loadStore();
    const now = nowFn();
    const activeInfo = vault && vault.getCapability().supported ? vault.readActiveInfo() : { email: '', hash: '' };
    const email = normalizeCredEmail(identity?.email || activeInfo.email);
    if (!email) return { ok: true, skipped: true };

    const pending = sanitizePendingSwitch(store.pendingSwitch, now);
    if (pending) {
      if (email === pending.targetEmail) {
        store.pendingSwitch = null;
        saveStore(store);
      } else {
        // Old Antigravity process is still alive before restart completes; ignore stale identity/quota writes
        return { ok: true, skipped: true, pendingSwitch: pending };
      }
    }

    appendTimeline(email);
    if (quota && quota.ok) {
      recordQuotaSamples(email, quota);
    }

    let acct = store.accounts.find((a) => normalizeCredEmail(a.email) === email);
    if (store.pendingNativeLogin && activeInfo.exists && activeInfo.email === email) {
      try {
        await captureCurrentAccount();
        const reloaded = loadStore();
        reloaded.pendingNativeLogin = false;
        saveStore(reloaded);
        acct = reloaded.accounts.find((a) => normalizeCredEmail(a.email) === email) || acct;
        log(`[Accounts] Auto-captured newly signed-in account: ${email}`);
      } catch {}
    } else if (acct) {
      let dirty = false;
      if (store.activeId !== acct.id) {
        store.activeId = acct.id;
        dirty = true;
      }
      const ob = readOnboardingState();
      if (ob && ob.email === email) {
        if (!acct.onboardingAccepted) {
          acct.onboardingAccepted = true;
          dirty = true;
        }
        if (typeof ob.isGcpTos === 'boolean' && acct.isGcpTos !== ob.isGcpTos) {
          acct.isGcpTos = ob.isGcpTos;
          dirty = true;
        }
      }
      if (quota && quota.ok) {
        acct.lastQuota = quota;
        acct.quotaSource = 'local-ls';
        acct.onboardingAccepted = true;
        if (quota.planName) acct.planName = quota.planName;
        acct.lastUsedAtMs = now;
        acct.updatedAt = now;
        dirty = true;
      }
      if (dirty) saveStore(store);
    }

    // Check auto-switch threshold
    const as = store.autoSwitch;
    if (as.enabled && quota && quota.ok && nowFn() - store.lastAutoSwitchAtMs >= AUTO_SWITCH_COOLDOWN_MS) {
      const curPct = pickGroupQuotaPct(quota, as.pool, as.window);
      if (curPct !== null && curPct <= as.thresholdPct) {
        const candidates = store.accounts
          .filter((a) => a.id !== acct?.id && !a.disabled && a.hasCredential)
          .map((a) => ({ account: a, pct: pickGroupQuotaPct(a.lastQuota, as.pool, as.window) ?? -1 }))
          .filter((x) => x.pct > as.thresholdPct)
          .sort((a, b) => b.pct - a.pct);

        if (candidates.length > 0) {
          const best = candidates[0].account;
          try {
            const switched = await switchAccount(best.id, { auto: true, relaunch: as.autoRelaunch });
            lastAutoSwitchNotice = {
              id: `sw_${nowFn()}`,
              fromEmail: email,
              toEmail: best.email,
              reasonPct: curPct,
              atMs: nowFn()
            };
            log(`[Accounts] Auto-switched ${email} (${curPct}%) -> ${best.email}`);
            return { ok: true, autoSwitched: true, notice: lastAutoSwitchNotice, ...switched };
          } catch (err) {
            log(`[Accounts] Auto-switch failed: ${err?.message || err}`);
          }
        }
      }
    }
    return { ok: true, autoSwitched: false };
  }

  async function dispatchAction(payload = {}) {
    const act = String(payload?.action || '').trim();
    switch (act) {
      case 'get_overview':
        return getOverview();
      case 'capture_current':
        return await captureCurrentAccount({ alias: payload.alias || '' });
      case 'start_oauth_add':
        return await startOAuthAddAccount();
      case 'prepare_native_add':
        return await prepareNativeLoginAdd({ relaunch: payload.relaunch !== false });
      case 'refresh_quota':
        return await refreshQuota(payload.accountId || 'all', { minIntervalMs: Number(payload.minIntervalMs) || 0 });
      case 'switch_account':
        return await switchAccount(payload.accountId, {
          auto: false,
          relaunch: payload.relaunch !== false
        });
      case 'update_meta': {
        const store = loadStore();
        const acct = store.accounts.find((a) => a.id === payload.accountId);
        if (!acct) throw new Error('Account not found');
        if (typeof payload.alias === 'string') acct.alias = payload.alias.trim().slice(0, 40);
        if (typeof payload.disabled === 'boolean') acct.disabled = payload.disabled;
        acct.updatedAt = nowFn();
        saveStore(store);
        return { ok: true, account: acct, overview: getOverview() };
      }
      case 'remove_account': {
        const store = loadStore();
        const idx = store.accounts.findIndex((a) => a.id === payload.accountId);
        if (idx === -1) throw new Error('Account not found');
        const [removed] = store.accounts.splice(idx, 1);
        if (store.activeId === removed.id) store.activeId = '';
        saveStore(store);
        if (vault) {
          try {
            vault.deleteSaved(removed.id);
          } catch {}
        }
        return { ok: true, removedId: removed.id, overview: getOverview() };
      }
      case 'update_auto_switch': {
        const store = loadStore();
        store.autoSwitch = normalizeAutoSwitch({ ...store.autoSwitch, ...(payload.config || {}) });
        saveStore(store);
        return { ok: true, overview: getOverview() };
      }
      case 'set_privacy_mask': {
        const store = loadStore();
        store.privacyMask = Boolean(payload.enabled);
        saveStore(store);
        return { ok: true, overview: getOverview() };
      }
      case 'ack_notice':
        lastAutoSwitchNotice = null;
        return { ok: true, overview: getOverview() };
      default:
        return { ok: false, error: `Unknown account action: ${act}` };
    }
  }

  return {
    getOverview,
    captureCurrentAccount,
    startOAuthAddAccount,
    prepareNativeLoginAdd,
    refreshQuota,
    switchAccount,
    observeLiveStatus,
    dispatchAction
  };
}
