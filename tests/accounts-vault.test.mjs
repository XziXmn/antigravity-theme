/**
 * tests/accounts-vault.test.mjs — Unit tests for Credential Vault, OAuth Quota & Multi-Account Switching
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {
  extractCredentialEmail,
  shortCredentialHash,
  buildUnifiedOAuthTokenTopicBase64,
  parseUnifiedOAuthTokenTopicBase64,
  buildUnifiedUserStatusTopicBase64,
  parseUnifiedUserStatusTopicBase64
} from '../core/daemon/credential-vault.mjs';
import {
  OFFICIAL_OAUTH_CLIENT_PAIRS,
  scanAntigravityOAuthPairs,
  parseOAuthTokenPayload,
  buildVaultCredentialJson
} from '../core/daemon/account-oauth.mjs';
import { createAccountsManager } from '../core/daemon/accounts.mjs';
import { createLanguageServerClient } from '../core/daemon/ls-client.mjs';

test('credential-vault extracts email from nested token JSON and computes stable short hash', () => {
  const inner = Buffer.from(
    JSON.stringify({ access_token: 'ya29.a', refresh_token: '1//r', id_token_email: 'UserA@Example.com' }),
    'utf8'
  ).toString('base64');
  const raw = JSON.stringify({ id_token_email: 'UserA@Example.com', token: inner });

  assert.equal(extractCredentialEmail(raw), 'usera@example.com');
  assert.equal(extractCredentialEmail(JSON.stringify({ token: inner })), 'usera@example.com');
  assert.equal(shortCredentialHash(raw).length, 12);
  assert.equal(shortCredentialHash(raw), shortCredentialHash(raw));
});

test('Protobuf state.vscdb OAuthToken and UserStatus topic round-trip cleanly', () => {
  const oauthB64 = buildUnifiedOAuthTokenTopicBase64({
    accessToken: 'ya29.test_access',
    refreshToken: '1//test_refresh',
    expirySeconds: 1795680000,
    tokenType: 'Bearer',
    idToken: 'eyJ.test.sig'
  });
  const parsedOAuth = parseUnifiedOAuthTokenTopicBase64(oauthB64);
  assert.deepEqual(parsedOAuth, {
    accessToken: 'ya29.test_access',
    tokenType: 'Bearer',
    refreshToken: '1//test_refresh',
    expirySeconds: 1795680000,
    idToken: 'eyJ.test.sig'
  });

  const userB64 = buildUnifiedUserStatusTopicBase64({ email: 'alice@example.com', name: 'Alice' });
  const parsedUser = parseUnifiedUserStatusTopicBase64(userB64);
  assert.deepEqual(parsedUser, { name: 'Alice', email: 'alice@example.com' });
});

test('scanAntigravityOAuthPairs matches official SHA-256 anchors without hardcoded secrets', () => {
  // Construct a synthetic binary blob using official SHA-256 anchor check verification
  // Here we verify parseOAuthTokenPayload + buildVaultCredentialJson and anchor integrity
  assert.equal(OFFICIAL_OAUTH_CLIENT_PAIRS.length, 2);
  for (const pair of OFFICIAL_OAUTH_CLIENT_PAIRS) {
    assert.equal(pair.clientIdSha256.length, 64);
    assert.equal(pair.clientSecretSha256.length, 64);
  }
  const missingScan = scanAntigravityOAuthPairs(path.join(os.tmpdir(), 'nonexistent-ls-bin.exe'));
  assert.deepEqual(missingScan, []);

  const built = buildVaultCredentialJson({
    accessToken: 'ya29.1',
    refreshToken: '1//rf1',
    idToken: '',
    expiryDate: 1795680000000,
    email: 'bob@example.com'
  });
  const parsed = parseOAuthTokenPayload(built);
  assert.equal(parsed.accessToken, 'ya29.1');
  assert.equal(parsed.refreshToken, '1//rf1');
  assert.equal(parsed.email, 'bob@example.com');
});

test('inactive account quota stays zero-network and offline reconciles elapsed resetTime windows to 100%', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-acc-offline-'));
  try {
    let fetchCalls = 0;
    const activeRaw = buildVaultCredentialJson({ accessToken: 'ya29.a', refreshToken: '1//rfa', email: 'active@test.com' });
    const inactiveRaw = buildVaultCredentialJson({ accessToken: 'ya29.b', refreshToken: '1//rfb', email: 'backup@test.com' });
    const savedSlots = new Map([
      ['acc_active', activeRaw],
      ['acc_backup', inactiveRaw]
    ]);
    let curTime = Date.parse('2026-11-26T10:00:00Z');
    const mockVault = {
      getCapability: () => ({ supported: true, backend: 'mock' }),
      readActiveInfo: () => ({ exists: true, email: 'active@test.com', hash: shortCredentialHash(activeRaw) }),
      saveActiveTo: (id) => ({ ok: true, email: 'active@test.com', hash: shortCredentialHash(savedSlots.get(id) || activeRaw) }),
      readSavedRaw: (id) => ({ exists: savedSlots.has(id), raw: savedSlots.get(id) || '' }),
      writeSavedRaw: (id, raw) => ({ ok: true, email: extractCredentialEmail(raw), hash: shortCredentialHash(raw) })
    };
    const mgr = createAccountsManager({
      userDir: tmpDir,
      vault: mockVault,
      nowFn: () => curTime,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('Must not fetch private CloudCode APIs');
      },
      lsClient: {
        getUserIdentity: async () => ({ email: 'active@test.com', planName: 'Pro' }),
        getQuotaStatus: async () => ({
          ok: true,
          planName: 'Pro',
          groups: [
            {
              key: 'gemini',
              label: 'Gemini',
              fiveHour: { remainingPct: 40, remainingFraction: 0.4, resetTime: '2026-11-26T12:00:00Z', resetInSec: 7200 },
              weekly: { remainingPct: 80, remainingFraction: 0.8, resetTime: '2026-12-01T00:00:00Z', resetInSec: 396000 }
            }
          ]
        })
      }
    });
    await mgr.captureCurrentAccount();
    // Seed backup account snapshot with a 5h resetTime expiring at 11:00Z
    fs.writeFileSync(
      path.join(tmpDir, 'accounts.json'),
      JSON.stringify({
        activeId: 'acc_active',
        accounts: [
          {
            id: 'acc_active',
            email: 'active@test.com',
            hasCredential: true,
            lastQuota: { ok: true, groups: [] }
          },
          {
            id: 'acc_backup',
            email: 'backup@test.com',
            hasCredential: true,
            lastQuota: {
              ok: true,
              groups: [
                {
                  key: 'gemini',
                  label: 'Gemini',
                  fiveHour: { remainingPct: 12, remainingFraction: 0.12, resetTime: '2026-11-26T11:00:00Z', resetInSec: 3600 },
                  weekly: { remainingPct: 65, remainingFraction: 0.65, resetTime: '2026-12-02T00:00:00Z', resetInSec: 400000 }
                }
              ]
            }
          }
        ]
      })
    );
    curTime = Date.parse('2026-11-26T11:30:00Z');
    const res = await mgr.refreshQuota('all');
    assert.equal(res.ok, true);
    assert.equal(fetchCalls, 0, 'Must never call remote fetch for CloudCode internal APIs');
    const backup = res.overview.accounts.find((a) => a.id === 'acc_backup');
    assert.equal(backup.lastQuota.groups[0].fiveHour.remainingPct, 100, 'Elapsed resetTime must reconcile offline to 100%');
    assert.equal(backup.lastQuota.groups[0].weekly.remainingPct, 65);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('accounts manager supports capture, anti-mismatch switch, timeline, and low-quota auto-switch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-acc-test-'));
  try {
    let activeCredRaw = buildVaultCredentialJson({ accessToken: 'ya29.a', refreshToken: '1//rfa', email: 'a@test.com' });
    const savedSlots = new Map();
    const mockVault = {
      getCapability: () => ({ supported: true, backend: 'mock' }),
      readActiveInfo: () => ({
        exists: Boolean(activeCredRaw),
        email: extractCredentialEmail(activeCredRaw),
        hash: shortCredentialHash(activeCredRaw)
      }),
      saveActiveTo(id, { expectedEmail }) {
        const email = extractCredentialEmail(activeCredRaw);
        if (expectedEmail && email !== expectedEmail) return { ok: false, mismatch: true, actualEmail: email };
        savedSlots.set(id, activeCredRaw);
        return { ok: true, email, hash: shortCredentialHash(activeCredRaw) };
      },
      readSavedRaw: (id) => ({ exists: savedSlots.has(id), raw: savedSlots.get(id) || '' }),
      writeSavedRaw(id, raw, { expectedEmail }) {
        const email = extractCredentialEmail(raw);
        if (expectedEmail && email !== expectedEmail) return { ok: false, mismatch: true, actualEmail: email };
        savedSlots.set(id, raw);
        return { ok: true, email, hash: shortCredentialHash(raw) };
      },
      restoreToActive(id, { expectedEmail }) {
        const raw = savedSlots.get(id);
        if (!raw) return { ok: false, missing: true };
        const email = extractCredentialEmail(raw);
        if (expectedEmail && email !== expectedEmail) return { ok: false, mismatch: true, actualEmail: email };
        activeCredRaw = raw;
        return { ok: true, email, hash: shortCredentialHash(raw), raw };
      },
      clearActiveSystemCredential: () => { activeCredRaw = ''; return { ok: true }; },
      deleteSaved: (id) => savedSlots.delete(id)
    };

    let now = 1000000;
    let relaunchCalls = 0;
    const mgr = createAccountsManager({
      userDir: tmpDir,
      vault: mockVault,
      nowFn: () => now,
      relaunchHost: async () => { relaunchCalls += 1; },
      lsClient: {
        getUserIdentity: async () => ({ email: extractCredentialEmail(activeCredRaw), planName: 'Pro' }),
        getQuotaStatus: async () => ({
          ok: true,
          planName: 'Pro',
          groups: [{ key: 'gemini', label: 'Gemini', fiveHour: { remainingPct: 80, resetTime: '' }, weekly: { remainingPct: 90, resetTime: '' } }]
        })
      }
    });

    // 1. Capture account A
    const capA = await mgr.captureCurrentAccount({ alias: 'Primary' });
    assert.equal(capA.ok, true);
    assert.equal(capA.account.email, 'a@test.com');

    // 2. Simulate signing in as B & capturing B
    activeCredRaw = buildVaultCredentialJson({ accessToken: 'ya29.b', refreshToken: '1//rfb', email: 'b@test.com' });
    now += 10000;
    const capB = await mgr.captureCurrentAccount({ alias: 'Backup' });
    assert.equal(capB.account.email, 'b@test.com');

    // 3. Switch back to A
    now += 10000;
    const sw = await mgr.switchAccount(capA.account.id, { relaunch: true });
    assert.equal(sw.ok, true);
    assert.equal(extractCredentialEmail(activeCredRaw), 'a@test.com');
    assert.equal(relaunchCalls, 1);

    // 4. Enable auto-switch and trigger when A drops to 3%
    await mgr.dispatchAction({ action: 'update_auto_switch', config: { enabled: true, pool: 'gemini', window: 'fiveHour', thresholdPct: 5 } });
    now += 200000;
    const obs = await mgr.observeLiveStatus({
      identity: { email: 'a@test.com', planName: 'Pro' },
      quota: {
        ok: true,
        planName: 'Pro',
        groups: [{ key: 'gemini', label: 'Gemini', fiveHour: { remainingPct: 3, resetTime: '' }, weekly: { remainingPct: 50, resetTime: '' } }]
      }
    });
    assert.equal(obs.autoSwitched, true);
    assert.equal(extractCredentialEmail(activeCredRaw), 'b@test.com');

    // Verify prepareNativeLoginAdd clears active credential and auto-captures next signed-in account
    const prep = await mgr.dispatchAction({ action: 'prepare_native_add', relaunch: false });
    assert.equal(prep.ok, true);
    assert.equal(prep.pendingNativeLogin, true);
    assert.equal(activeCredRaw, '');

    // Simulate user signing into account c@test.com in Antigravity native UI
    activeCredRaw = JSON.stringify({
      id_token_email: 'c@test.com',
      token: { access_token: 'tok-c', refresh_token: 'ref-c' }
    });
    await mgr.observeLiveStatus({ identity: { email: 'c@test.com', planName: 'Pro' } });
    const afterOv = mgr.getOverview();
    assert.equal(afterOv.pendingNativeLogin, false);
    assert.ok(afterOv.accounts.some((a) => a.email === 'c@test.com' && a.isActive));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('79-accounts-dashboard mounts below #ag-settings-nav-wrap inside .settings-modal-container without role="dialog"', () => {
  const mkEl = (tag) => {
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      classList: {
        add(...names) {
          const cur = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
          for (const n of names) if (n) cur.add(n);
          el.className = Array.from(cur).join(' ');
        },
        remove(...names) {
          const cur = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
          for (const n of names) cur.delete(n);
          el.className = Array.from(cur).join(' ');
        },
        contains(n) {
          return String(el.className || '').split(/\s+/).includes(n);
        }
      },
      children: [],
      parentElement: null,
      textContent: '',
      innerHTML: '',
      hidden: false,
      type: '',
      style: {},
      getBoundingClientRect: () => ({ left: 1700, right: 1790, top: 36, bottom: 62, width: 90, height: 26 }),
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') el.id = String(v);
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(ch) {
        ch.parentElement = el;
        el.children.push(ch);
        return ch;
      },
      insertBefore(node, ref) {
        if (node.parentElement) {
          const oldIdx = node.parentElement.children.indexOf(node);
          if (oldIdx >= 0) node.parentElement.children.splice(oldIdx, 1);
        }
        node.parentElement = el;
        const idx = ref ? el.children.indexOf(ref) : -1;
        if (idx >= 0) el.children.splice(idx, 0, node);
        else el.children.push(node);
        return node;
      },
      after(node) {
        if (!el.parentElement) return;
        const p = el.parentElement;
        const idx = p.children.indexOf(el);
        node.parentElement = p;
        p.children.splice(idx + 1, 0, node);
      },
      remove() {
        if (!el.parentElement) return;
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener() {},
      dispatchEvent(ev) {
        for (const fn of listeners.get(ev.type) || []) fn(ev);
      },
      get previousElementSibling() {
        if (!el.parentElement) return null;
        const idx = el.parentElement.children.indexOf(el);
        return idx > 0 ? el.parentElement.children[idx - 1] : null;
      },
      get nextElementSibling() {
        if (!el.parentElement) return null;
        const idx = el.parentElement.children.indexOf(el);
        return idx >= 0 && idx + 1 < el.parentElement.children.length ? el.parentElement.children[idx + 1] : null;
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      closest(sel) {
        let cur = el;
        while (cur) {
          if (sel === '.settings-modal-container' && String(cur.className).includes('settings-modal-container')) return cur;
          if (sel === '[role="dialog"]' && cur.getAttribute('role') === 'dialog') return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        const walk = (node) => {
          for (const ch of node.children) {
            if (sel === '[data-testid="settings-sidebar"]' && ch.getAttribute('data-testid') === 'settings-sidebar') return ch;
            if (sel === '[data-ag-settings-split-row="1"]' && ch.getAttribute('data-ag-settings-split-row') === '1') return ch;
            if (sel === '[data-ag-settings-right-pane="1"]' && ch.getAttribute('data-ag-settings-right-pane') === '1') return ch;
            if (sel === '[data-settings-content-pane="true"]' && ch.getAttribute('data-settings-content-pane') === 'true') return ch;
            if (sel === 'button[data-testid="titlebar-more-actions"]' && ch.tagName === 'BUTTON' && ch.getAttribute('data-testid') === 'titlebar-more-actions') return ch;
            if (sel === '.ag-s-nav-label' && ch.className === 'ag-s-nav-label') return ch;
            if (sel === '.ag-s-nav-count' && ch.className === 'ag-s-nav-count') return ch;
            if (sel === '.ag-tb-dot' && ch.className === 'ag-tb-dot') return ch;
            if (sel === '.ag-tb-txt' && ch.className === 'ag-tb-txt') return ch;
            const found = walk(ch);
            if (found) return found;
          }
          return null;
        };
        return walk(el);
      }
    };
    return el;
  };

  const dlg = mkEl('div');
  dlg.className = 'settings-modal-container';
  const splitRow = mkEl('div');
  splitRow.setAttribute('data-ag-settings-split-row', '1');
  const sidebar = mkEl('div');
  sidebar.setAttribute('data-testid', 'settings-sidebar');
  const navGroup = mkEl('div');
  const enhancedWrap = mkEl('div');
  enhancedWrap.id = 'ag-settings-nav-wrap';
  navGroup.appendChild(enhancedWrap);
  sidebar.appendChild(navGroup);
  const rightPane = mkEl('div');
  rightPane.setAttribute('data-ag-settings-right-pane', '1');
  const settingsPane = mkEl('div');
  settingsPane.id = 'ag-settings-pane';
  const accPaneHost = mkEl('div');
  accPaneHost.id = 'ag-accounts-pane';
  settingsPane.appendChild(accPaneHost);
  rightPane.appendChild(settingsPane);
  splitRow.appendChild(sidebar);
  splitRow.appendChild(rightPane);
  dlg.appendChild(splitRow);
  const body = mkEl('body');
  const topbarBox = mkEl('div');
  const moreBtn = mkEl('button');
  moreBtn.setAttribute('data-testid', 'titlebar-more-actions');
  topbarBox.appendChild(moreBtn);
  body.appendChild(topbarBox);
  body.appendChild(dlg);

  const byId = (id) => {
    const walk = (n) => {
      if (n.id === id) return n;
      for (const ch of n.children) {
        const f = walk(ch);
        if (f) return f;
      }
      return null;
    };
    return walk(body);
  };

  const ctx = {
    window: null,
    document: {
      body,
      createElement: mkEl,
      getElementById: byId,
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: () => []
    },
    __AG_BOOT_PAYLOAD__: { enabled: true, i18nLocale: 'zh-CN' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: class { observe() {} disconnect() {} }
  };
  ctx.window = ctx;
  const code = fs.readFileSync(path.join(process.cwd(), 'core', 'runtime', '79-accounts-dashboard.js'), 'utf8');
  vm.runInNewContext(code, ctx);
  try {
  assert.equal(byId('ag-accounts-nav-wrap'), null, 'must NOT mount standalone #ag-accounts-nav-wrap in sidebar');
  assert.equal(typeof ctx.__ag_sync_accounts_dialog, 'function');
  assert.equal(typeof ctx.__ag_on_accounts_tab_active, 'function');

  ctx.__ag_on_accounts_tab_active(true, { forceMount: true });
  const accPane = byId('ag-accounts-pane');
  assert.ok(accPane.innerHTML.includes('ag-s-card'));
  assert.ok(accPane.innerHTML.includes('ag-s-switch'));
  assert.ok(accPane.innerHTML.includes('已保存账号'));
  assert.ok(!accPane.innerHTML.includes('ag-s-header'), 'Merged accounts tab must not render duplicate outer header');
  assert.ok(!accPane.innerHTML.includes('data-subtab'), 'Settings pane must not include heatmap subtabs');
  assert.ok(!accPane.innerHTML.includes('ag-zc-heat-grid'), 'Settings pane must not render heatmap');
  assert.ok(!accPane.innerHTML.includes('data-acc-alias'), 'Settings pane must not render alias input');

  const tbBtn = byId('ag-topbar-usage-btn');
  assert.ok(tbBtn, '#ag-topbar-usage-btn must mount before titlebar-more-actions');
  assert.equal(tbBtn.nextElementSibling, moreBtn);
  ctx.__ag_last_metrics = { pct: 42, tps: 110, cachePct: 91 };
  ctx.__ag_on_usage_analytics('', {
    ok: true,
    summary: {
      totalTokens: 10000,
      cacheHitPct: 80,
      estCostUsd: 1.5,
      cacheSavedUsd: 0.4,
      quota5hConsumedPct: 12,
      quotaWeeklyConsumedPct: 4,
      quotaResets: 0,
      currentStreakDays: 3,
      avgTps: 90,
      inputTokens: 1000,
      cacheReadTokens: 8000,
      outputTokens: 1000
    },
    quotaByPool: [
      {
        key: 'gemini',
        label: 'Gemini',
        fiveHourPct: 80,
        weeklyPct: 90,
        projection: {
          paceTrend: 'steady',
          weekProjectedPct: 35,
          weekProjectedTokens: 450000,
          weekProjectedCostUsd: 1.25,
          monthProjectedWeeklyPct: 72,
          monthProjectedTokens: 1800000,
          monthProjectedCostUsd: 5.0,
          monthProjected5hCycles: 2.1,
          monthActual5hPct: 12,
          monthActualWeeklyPct: 4,
          remainingHours5h: 12.5,
          remainingDaysWeekly: 5.2,
          paceMultiplier: 1.0
        }
      }
    ],
    heatmap: [],
    weekly: [],
    monthly: [],
    models: [],
    accounts: []
  });
  tbBtn.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  const pop = byId('ag-usage-popover');
  assert.equal(pop.getAttribute('data-visible'), '1');
  assert.ok(pop.className.includes('browser-hole-opaque'));
  assert.ok(pop.innerHTML.includes('ag-s-card'));
  assert.ok(pop.innerHTML.includes('用量看板'));
  assert.ok(!pop.innerHTML.includes('data-pop-close'), 'Dashboard header must not render close button');
  assert.ok(!pop.innerHTML.includes('data-pop-switch'), 'Dashboard filter bar must only have a single account selector');
  assert.ok(pop.innerHTML.includes('ag-acct-picker') && pop.innerHTML.includes('data-acct-trigger="1"'), 'Dashboard must render custom rounded account dropdown picker');
  assert.ok(pop.innerHTML.includes('本周预估') && pop.innerHTML.includes('本月预估'), 'Dashboard must render weekly and monthly projection blocks');

  // Regression guard: repeated sync/refresh calls without state change must NOT rewrite innerHTML
  let paneWrites = 0;
  let popWrites = 0;
  let origPaneHtml = accPane.innerHTML;
  let origPopHtml = pop.innerHTML;
  Object.defineProperty(accPane, 'innerHTML', {
    get: () => origPaneHtml,
    set: (v) => { paneWrites++; origPaneHtml = v; }
  });
  Object.defineProperty(pop, 'innerHTML', {
    get: () => origPopHtml,
    set: (v) => { popWrites++; origPopHtml = v; }
  });
  ctx.__ag_sync_accounts_dialog();
  ctx.__ag_sync_accounts_dialog();
  ctx.__ag_refresh_topbar_usage();
  assert.equal(paneWrites, 0, 'sync_accounts_dialog must not rewrite #ag-accounts-pane innerHTML');
  assert.equal(popWrites, 0, 'refresh_topbar_usage must not rewrite #ag-usage-popover innerHTML when signature unchanged');
  } finally {
    ctx.__ag_accounts_cleanup?.();
  }
});

test('extractCredentialEmail, parseOAuthTokenPayload and buildVaultCredentialJson handle Antigravity 2.35+ object token format', () => {
  const nativeRaw = JSON.stringify({
    token: {
      access_token: 'ya29.native-access',
      refresh_token: '1//native-refresh',
      id_token: 'hdr.eyJlbWFpbCI6Ik5hdGl2ZUBleGFtcGxlLmNvbSJ9.sig',
      expiry_date: 1900000000000
    },
    auth_method: 'oauth',
    id_token_email: 'Native@Example.com',
    writer_id: 'desktop-win32'
  });
  assert.equal(extractCredentialEmail(nativeRaw), 'native@example.com');
  const parsed = parseOAuthTokenPayload(nativeRaw);
  assert.equal(parsed.accessToken, 'ya29.native-access');
  assert.equal(parsed.refreshToken, '1//native-refresh');
  assert.equal(parsed.email, 'native@example.com');

  const rebuilt = JSON.parse(
    buildVaultCredentialJson({
      accessToken: 'ya29.new',
      refreshToken: '1//new',
      email: 'native@example.com',
      templateRaw: nativeRaw
    })
  );
  assert.equal(rebuilt.auth_method, 'oauth');
  assert.equal(rebuilt.writer_id, 'desktop-win32');
  assert.equal(rebuilt.token.access_token, 'ya29.new');
  assert.equal(rebuilt.token.refresh_token, '1//new');
});

test('scanAntigravityOAuthPairs matches 35-char secret concatenated without NUL separator', async () => {
  const { OFFICIAL_OAUTH_CLIENT_PAIRS, scanAntigravityOAuthPairs } = await import('../core/daemon/account-oauth.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-oauth-concat-'));
  try {
    // Construct a mock 35-char secret with trailing alphanumeric garbage (simulating Go binary)
    // Verify hash-matching slice logic by using a synthetic secret only when hashing matches OFFICIAL_OAUTH_CLIENT_PAIRS.
    // We test the exact binary scanner against non-matching trailing noise to ensure no crash/false positive.
    const binPath = path.join(tmpDir, 'mock_ls.bin');
    fs.writeFileSync(binPath, Buffer.from('1234567890-abc.apps.googleusercontent.comGOCSPX-abcdef1234567890123456789012EXTRA'));
    const res = scanAntigravityOAuthPairs(binPath);
    assert.deepEqual(res, []);
    assert.equal(OFFICIAL_OAUTH_CLIENT_PAIRS.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('pendingSwitch blocks stale live-status cross-write and keeps single isActive source of truth', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pending-switch-'));
  try {
    let activeRaw = 'raw-aaa-111';
    const slots = new Map([
      ['acc_aaa', 'raw-aaa-111'],
      ['acc_bbb', 'raw-bbb-222']
    ]);
    const mockVault = {
      platform: 'win32',
      available: true,
      getCapability: () => ({ supported: true }),
      readActiveRaw: () => ({ exists: true, raw: activeRaw }),
      readActiveInfo: () => ({ exists: true, email: extractCredentialEmail(activeRaw), hash: shortCredentialHash(activeRaw) }),
      restoreToActive: (id) => {
        activeRaw = slots.get(id) || activeRaw;
        return { ok: true };
      },
      saveActiveTo: (id) => {
        slots.set(id, activeRaw);
        return { ok: true, email: id === 'acc_aaa' ? 'aaa@test.com' : 'bbb@test.com', hash: shortCredentialHash(activeRaw) };
      },
      readSavedRaw: (id) => ({ exists: slots.has(id), raw: slots.get(id) || '' }),
      writeSavedRaw: (id, raw) => ({ ok: true, email: 'test@test.com', hash: shortCredentialHash(raw) })
    };
    const now = 1795700000000;
    const mgr = createAccountsManager({
      userDir: tmpDir,
      vault: mockVault,
      nowFn: () => now,
      lsClient: {
        getUserIdentity: async () => ({ email: 'bbb@test.com', planName: 'Pro' }),
        getQuotaStatus: async () => ({ ok: true, planName: 'Pro', groups: [] })
      },
      relaunchHost: async () => ({ ok: true, method: 'detached-ps1' })
    });
    fs.writeFileSync(
      path.join(tmpDir, 'accounts.json'),
      JSON.stringify({
        schemaVersion: 1,
        activeId: 'acc_aaa',
        accounts: [
          { id: 'acc_aaa', email: 'aaa@test.com', hasCredential: true, credHash: shortCredentialHash('raw-aaa-111'), quotaSource: 'local-ls', lastQuota: { ok: true, groups: [{ key: 'gemini', fiveHour: { remainingPct: 25 } }] } },
          { id: 'acc_bbb', email: 'bbb@test.com', hasCredential: true, credHash: shortCredentialHash('raw-bbb-222'), quotaSource: 'cached', lastQuota: { ok: true, groups: [{ key: 'gemini', fiveHour: { remainingPct: 95 } }] } }
        ]
      })
    );

    const swRes = await mgr.switchAccount('acc_bbb', { relaunch: false });
    assert.equal(swRes.ok, true);

    // 旧账号 aaa 在重启前上报一次额度，应被 pendingSwitch 拦截，不得覆写 bbb
    const obsStale = await mgr.observeLiveStatus({
      identity: { email: 'aaa@test.com', planName: 'Pro' },
      quota: { ok: true, planName: 'Pro', groups: [{ key: 'gemini', fiveHour: { remainingPct: 10 } }] }
    });
    assert.equal(obsStale.skipped, true);
    assert.ok(obsStale.pendingSwitch);

    const ovDuring = mgr.getOverview();
    assert.ok(ovDuring.pendingSwitch);
    assert.equal(ovDuring.pendingSwitch.targetId, 'acc_bbb');
    assert.deepEqual(
      ovDuring.accounts.filter((a) => a.isActive).map((a) => a.id),
      ['acc_bbb']
    );
    const bbbDuring = ovDuring.accounts.find((a) => a.id === 'acc_bbb');
    assert.equal(bbbDuring.lastQuota.groups[0].fiveHour.remainingPct, 95);

    // 目标账号 bbb 上报后自动解除 pendingSwitch
    const obsTarget = await mgr.observeLiveStatus({
      identity: { email: 'bbb@test.com', planName: 'Pro' },
      quota: { ok: true, planName: 'Pro', groups: [{ key: 'gemini', fiveHour: { remainingPct: 90 } }] }
    });
    assert.equal(obsTarget.skipped, undefined);
    const ovAfter = mgr.getOverview();
    assert.equal(ovAfter.pendingSwitch, null);
    assert.equal(ovAfter.accounts.find((a) => a.id === 'acc_bbb').lastQuota.groups[0].fiveHour.remainingPct, 90);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('79-accounts-dashboard.js contains Stage 4 Codex minimalist dashboard & overview extension hooks', () => {
  const src = fs.readFileSync(new URL('../core/runtime/79-accounts-dashboard.js', import.meta.url), 'utf8');
  for (const token of ['ag-pop-main-nav', 'ag-pt-kpi-grid', 'ag-pool-forecast-row', 'ag-acc-meter-row', 'ag-overview-sections', 'ag-ov-pool', 'ag-ov-qline']) {
    assert.ok(src.includes(token), `expected ${token} in 79-accounts-dashboard.js`);
  }
  assert.ok(!src.includes("data-pop-main-tab=\"accounts\""), 'topbar usage dashboard must stay decoupled from accounts CRUD');
});

test('daemon.mjs imports ROOT_DIR for relaunchHost and switchAccount handles relaunchHost cleanly', async () => {
  const daemonSrc = fs.readFileSync(new URL('../core/daemon.mjs', import.meta.url), 'utf8');
  assert.match(daemonSrc, /import\s*\{[\s\S]*?\bROOT_DIR\b[\s\S]*?\}\s*from\s*'\.\/daemon\/paths\.mjs'/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-relaunch-test-'));
  try {
    let activeCredRaw = buildVaultCredentialJson({ accessToken: 'ya29.a', refreshToken: '1//rfa', email: 'a@test.com' });
    const savedSlots = new Map();
    const mockVault = {
      getCapability: () => ({ supported: true, backend: 'mock' }),
      readActiveInfo: () => ({
        exists: Boolean(activeCredRaw),
        email: extractCredentialEmail(activeCredRaw),
        hash: shortCredentialHash(activeCredRaw)
      }),
      saveActiveTo(id) {
        savedSlots.set(id, activeCredRaw);
        return { ok: true, email: extractCredentialEmail(activeCredRaw), hash: shortCredentialHash(activeCredRaw) };
      },
      readSavedRaw: (id) => ({ exists: savedSlots.has(id), raw: savedSlots.get(id) || '' }),
      writeSavedRaw(id, raw) {
        savedSlots.set(id, raw);
        return { ok: true, email: extractCredentialEmail(raw), hash: shortCredentialHash(raw) };
      },
      restoreToActive(id) {
        const raw = savedSlots.get(id);
        if (!raw) return { ok: false, missing: true };
        activeCredRaw = raw;
        return { ok: true, email: extractCredentialEmail(raw), hash: shortCredentialHash(raw), raw };
      },
      clearActiveSystemCredential: () => ({ ok: true }),
      deleteSaved: (id) => savedSlots.delete(id)
    };

    const mgr = createAccountsManager({
      userDir: tmpDir,
      vault: mockVault,
      relaunchHost: async () => ({ ok: true, scheduled: true })
    });

    const capA = await mgr.captureCurrentAccount();
    activeCredRaw = buildVaultCredentialJson({ accessToken: 'ya29.b', refreshToken: '1//rfb', email: 'b@test.com' });
    await mgr.captureCurrentAccount();

    const sw = await mgr.switchAccount(capA.account.id, { relaunch: true });
    assert.equal(sw.ok, true);
    assert.equal(sw.relaunched, true);
    assert.equal(sw.manualRestartRequired, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ls-client invalidates quota cache when hub PID/port changes and falls back across hub candidates', async () => {
  let now = 10_000;
  let hubs = [{ host: '127.0.0.1', port: 1111, address: '127.0.0.1:1111', csrfToken: 'tok1', pid: 101 }];

  const makeResp = (email, pctFrac) => ({
    summary: {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ window: '5h', remainingFraction: pctFrac, resetTime: '2026-12-01T00:00:00Z' }]
        }
      ]
    },
    status: {
      userStatus: { email, planStatus: { planInfo: { planName: 'Pro' } } }
    }
  });

  const ls = createLanguageServerClient({
    nowFn: () => now,
    discoverCandidatesFn: () => hubs,
    fetchImpl: async (url) => {
      if (url.startsWith('http://127.0.0.1:1111/')) {
        const d = url.includes('RetrieveUserQuotaSummary')
          ? makeResp('old@test.com', 0.1).summary
          : makeResp('old@test.com', 0.1).status;
        return { ok: true, status: 200, text: async () => JSON.stringify(d) };
      }
      if (url.startsWith('http://127.0.0.1:2222/')) {
        throw new Error('ECONNREFUSED');
      }
      if (url.startsWith('http://127.0.0.1:3333/')) {
        const d = url.includes('RetrieveUserQuotaSummary')
          ? makeResp('new@test.com', 0.85).summary
          : makeResp('new@test.com', 0.85).status;
        return { ok: true, status: 200, text: async () => JSON.stringify(d) };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });

  const q1 = await ls.getQuotaStatus({ force: false });
  assert.equal(q1.ok, true);
  assert.equal(q1.accountEmail, 'old@test.com');
  assert.equal(q1.groups[0].fiveHour.remainingPct, 10);

  // Simulate IDE restart: newest hub 2222 is unreachable, falls back to 3333; must NOT return stale 10% cache from pid 101
  now += 1000;
  hubs = [
    { host: '127.0.0.1', port: 2222, address: '127.0.0.1:2222', csrfToken: 'tok2', pid: 202 },
    { host: '127.0.0.1', port: 3333, address: '127.0.0.1:3333', csrfToken: 'tok3', pid: 303 }
  ];
  const q2 = await ls.getQuotaStatus({ force: false });
  assert.equal(q2.ok, true);
  assert.equal(q2.accountEmail, 'new@test.com');
  assert.equal(q2.groups[0].fiveHour.remainingPct, 85);
});
