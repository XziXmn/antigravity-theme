/**
 * Part 79: Unified Codex & Native Antigravity Accounts Pane +
 * ZCode-inspired Usage Dashboard & 3-Mode Adaptive Heatmap (Floating Popover)
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const boot = typeof __AG_BOOT_PAYLOAD__ !== 'undefined' && __AG_BOOT_PAYLOAD__ ? __AG_BOOT_PAYLOAD__ : {};
  if (boot.enabled === false) return;

  const PREV_ACC = window.__ag_accounts_cleanup;
  if (typeof PREV_ACC === 'function') {
    try { PREV_ACC(); } catch {}
  }

  let disposed = false;
  let accountsTabActive = false;
  let boundPane = null;
  let boundTopbarBtn = null;
  let boundPopover = null;
  let observer = null;
  let syncTimer = null;

  let lastPaneSig = '';
  let lastPopSig = '';
  let lastResolvedCurrentAcct = '';
  let acctAutoRefreshTimer = null;
  let liveQuotaTickTimer = null;
  let popAutoRefreshTimer = null;
  let topbarMetricsCache = null;
  let topbarMetricsFetching = false;

  try {
    localStorage.removeItem('ag_usage_dock_mode');
    localStorage.removeItem('ag_usage_aux_width');
  } catch {}

  const VALID_POP_RANGES = ['today', 'week', 'month', 'year', 'all'];
  const VALID_HEAT_MODES = ['daily', 'weekly', 'cumulative'];
  const VALID_HEAT_METRICS = ['tokens', 'cost', 'requests', 'quota'];
  const VALID_TOPBAR_MODES = ['quota', 'sessionTokens', 'todayTokens', 'monthTokens', 'monthCost', 'icon'];

  function loadUsagePopPrefs() {
    try {
      const raw = localStorage.getItem('ag_usage_pop_prefs');
      if (!raw) return {};
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  }
  const savedPopPrefs = loadUsagePopPrefs();

  const ui = {
    popoverOpen: false,
    popTrendTab: 'models', // 'models' | 'accounts'
    popMainTab: 'overview', // 'overview' | 'requests'
    reqStatus: 'all', // 'all' | 'success' | 'error' | 'drop'
    reqPageSize: 80,
    selectedReqId: '',
    acctPlanFilter: 'all', // 'all' | 'ultra' | 'pro' | 'free'
    acctQuotaWin: '5h', // '5h' | 'weekly'
    acctSearchQuery: '',
    ovProgressCollapsed: false,
    overviewQuotaCollapsed: false,
    loadingAccounts: false,
    loadingAnalytics: false,
    busyAction: '',
    banner: null,
    overview: null,
    analytics: null,
    range: VALID_POP_RANGES.includes(savedPopPrefs.range) ? savedPopPrefs.range : 'month',
    accountFilter: '__current__', // default: active account; user can switch to 'all' or specific email
    acctMenuOpen: false,
    heatDisplayMode: VALID_HEAT_MODES.includes(savedPopPrefs.heatDisplayMode) ? savedPopPrefs.heatDisplayMode : 'daily',
    heatMetric: VALID_HEAT_METRICS.includes(savedPopPrefs.heatMetric) ? savedPopPrefs.heatMetric : 'tokens',
    heatSpanDays: 182,
    selectedHeatKey: ''
  };

  function saveUsagePopPrefs() {
    try {
      localStorage.setItem(
        'ag_usage_pop_prefs',
        JSON.stringify({
          range: ui.range,
          heatDisplayMode: ui.heatDisplayMode,
          heatMetric: ui.heatMetric
        })
      );
    } catch {}
  }

  function getLoc() {
    const loc = String(window.__ag_settings_locale || boot.i18nLocale || 'zh-CN').trim();
    if (loc === 'en' || loc === 'zh-TW' || loc === 'zh-SG') return loc;
    return 'zh-CN';
  }

  function getStr() {
    const loc = getLoc();
    if (loc === 'en') {
      return {
        navTitle: 'Accounts',
        pageTitle: 'Accounts',
        pageSub: 'OS vault credential isolation, local official quota sync & offline reset tracking.',
        tabAccounts: 'Saved Accounts',
        captureBtn: 'Capture Current',
        oauthBtn: 'Add via OAuth',
        nativeAddBtn: 'Sign-out & Add',
        refreshAllBtn: 'Sync Current',
        privacyMask: 'Mask emails',
        privacyDesc: 'Hide middle characters of email addresses across cards and charts.',
        autoSwitch: 'Auto-switch on low quota',
        autoSwitchDesc: 'Switch to the highest-quota backup account automatically when the active pool drops below threshold.',
        pool: 'Pool',
        window: 'Window',
        win5h: '5h',
        win7d: 'Weekly',
        threshold: 'Threshold',
        autoRelaunch: 'Relaunch IDE after switch',
        activeBadge: 'Active',
        disabledBadge: 'Disabled',
        switchBtn: 'Switch',
        refreshBtn: 'Refresh',
        disableBtn: 'Disable',
        enableBtn: 'Enable',
        removeBtn: 'Remove',
        noAccounts: 'No saved accounts yet. Click "Capture Current" to back up the active account or add another via OAuth.',
        pendingNativeHint: 'Signed out to blank state. Sign in with your new Google account in Antigravity and it will be captured automatically.',
        rangeToday: 'Today',
        rangeWeek: 'Week',
        rangeMonth: 'Month',
        rangeYear: 'Year',
        rangeAll: 'All',
        curAccountOpt: 'Current',
        allAccounts: 'All accounts',
        kpiTokens: 'Token Usage',
        kpiCost: 'Est. Cost',
        kpiQuota: '5h / Weekly Used',
        kpiStreak: 'Streak / Speed',
        heatmapTitle: 'Activity Heatmap',
        heatDaily: 'Daily',
        heatWeekly: 'Weekly',
        heatCum: 'Cumulative',
        trendTitle: 'Breakdown',
        acctTableTitle: 'Accounts',
        modelTableTitle: 'Models',
        mTokens: 'Tokens',
        mCost: 'Cost',
        mRequests: 'Reqs',
        mQuota: 'Quota',
        days90: '90d',
        days182: '26w',
        days365: '52w',
        less: 'Less',
        more: 'More',
        dayDetail: 'Selected',
        popTitle: 'Usage',
        manageAccounts: 'Accounts',
        quickSwitch: 'Switch account',
        busyCapture: 'Capturing active credential…',
        busyOauth: 'Complete Google sign-in in your browser…',
        busyNativeAdd: 'Backing up current account & clearing session…',
        busyRefresh: 'Refreshing account quotas…',
        busySwitch: 'Switching account & syncing credentials…',
        okCaptured: 'Captured account',
        poolQuotaTitle: 'Quota & Forecast',
        weekProjLbl: 'This Week',
        monthProjLbl: 'This Month',
        projDepleteLbl: 'Est. Left',
        resetsLbl: 'Resets',
        peakLbl: 'peak',
        paceAccel: 'Accelerating',
        paceSteady: 'Steady',
        paceCool: 'Cooling',
        paceIdle: 'Idle',
        showClaudeLbl: 'Show Claude / GPT quota'
      };
    }
    if (loc === 'zh-TW') {
      return {
        navTitle: '帳號管理',
        pageTitle: '帳號管理',
        pageSub: '系統憑證庫隔離切換、本機官方用戶端額度同步與離線重置推算。',
        tabAccounts: '已儲存帳號',
        captureBtn: '擷取目前帳號',
        oauthBtn: 'OAuth 新增',
        nativeAddBtn: '切無登入新增',
        refreshAllBtn: '同步目前額度',
        privacyMask: '隱私遮罩',
        privacyDesc: '在帳號列表與統計圖表中隱藏信箱中間字元。',
        autoSwitch: '低額度自動切換',
        autoSwitchDesc: '當活躍模型池剩餘額度低於閾值時，自動切換至餘量最高的備用帳號。',
        pool: '模型池',
        window: '視窗',
        win5h: '5h',
        win7d: '週額',
        threshold: '閾值',
        autoRelaunch: '切換後平滑重啟客戶端',
        activeBadge: '目前使用',
        disabledBadge: '已停用',
        switchBtn: '切換',
        refreshBtn: '刷新',
        disableBtn: '停用',
        enableBtn: '啟用',
        removeBtn: '刪除',
        noAccounts: '尚無已儲存帳號。可點擊「擷取目前帳號」備份，或透過「OAuth 新增」/「切無登入新增」加入。',
        pendingNativeHint: '已安全備份原帳號並切換至無登入狀態，請在客戶端內登入新帳號，登入後系統將自動捕獲入庫。',
        rangeToday: '今日',
        rangeWeek: '本週',
        rangeMonth: '本月',
        rangeYear: '本年',
        rangeAll: '全部',
        curAccountOpt: '目前帳號',
        allAccounts: '全部帳號',
        kpiTokens: 'Token 消耗',
        kpiCost: '參考費用',
        kpiQuota: '5h / 週額消耗',
        kpiStreak: '連續活躍 / 均速',
        heatmapTitle: '活躍熱力圖',
        heatDaily: '按日',
        heatWeekly: '按週',
        heatCum: '累計',
        trendTitle: '用量明細',
        acctTableTitle: '帳號對比',
        modelTableTitle: '模型分佈',
        mTokens: 'Token',
        mCost: '費用',
        mRequests: '請求',
        mQuota: '額度',
        days90: '90天',
        days182: '半年',
        days365: '全年',
        less: '少',
        more: '多',
        dayDetail: '已選',
        popTitle: '用量看板',
        manageAccounts: '帳號管理',
        quickSwitch: '快速切號',
        busyCapture: '正在擷取目前憑證…',
        busyOauth: '請在開啟的瀏覽器中完成 Google 授權…',
        busyNativeAdd: '正在備份目前帳號並切換至無登入態…',
        busyRefresh: '正在刷新帳號額度…',
        busySwitch: '正在切換帳號並同步憑證…',
        okCaptured: '已成功擷取帳號',
        poolQuotaTitle: '額度與預測',
        weekProjLbl: '本週預估',
        monthProjLbl: '本月預估',
        projDepleteLbl: '約餘時長',
        resetsLbl: '已重置',
        peakLbl: '峰值',
        paceAccel: '速率上升 ↑',
        paceSteady: '平穩 →',
        paceCool: '放緩 ↓',
        paceIdle: '低活躍',
        showClaudeLbl: '顯示 Claude / GPT 額度'
      };
    }
    return {
      navTitle: '账号管理',
      pageTitle: '账号管理',
      pageSub: '系统凭据保险库隔离切换、本机官方客户端额度同步与离线重置推算。',
      tabAccounts: '已保存账号',
      captureBtn: '捕获当前账号',
      oauthBtn: 'OAuth 添加',
      nativeAddBtn: '切无登录添加',
      refreshAllBtn: '同步当前额度',
      privacyMask: '隐私打码',
      privacyDesc: '在账号卡片与统计表中隐藏邮箱中间字符。',
      autoSwitch: '低额度自动切号',
      autoSwitchDesc: '当活跃模型池剩余额度低于阈值时，自动切换至余量最高的备用账号（含 120s 冷却防抖）。',
      pool: '模型池',
      window: '窗口',
      win5h: '5h',
      win7d: '周额',
      threshold: '阈值',
      autoRelaunch: '切号后平滑重启客户端',
      activeBadge: '当前使用',
      disabledBadge: '已停用',
      switchBtn: '切换',
      refreshBtn: '刷新',
      disableBtn: '停用',
      enableBtn: '启用',
      removeBtn: '删除',
      noAccounts: '尚未保存任何账号。可点击「捕获当前账号」备份，或使用「OAuth 添加」/「切无登录添加」新增账号。',
      pendingNativeHint: '已安全备份原账号并切换为无登录态，请在客户端原生界面登录新账号，登录完成后将自动捕获入库。',
      rangeToday: '今日',
      rangeWeek: '本周',
      rangeMonth: '本月',
      rangeYear: '本年',
      rangeAll: '全部',
      curAccountOpt: '当前账号',
      allAccounts: '全部账号',
      kpiTokens: 'Token 消耗',
      kpiCost: '参考费用',
      kpiQuota: '5h / 周额已耗',
      kpiStreak: '连用 / 均速',
      heatmapTitle: '活跃热力图',
      heatDaily: '按日',
      heatWeekly: '按周',
      heatCum: '累计',
      trendTitle: '用量明细',
      acctTableTitle: '账号对比',
      modelTableTitle: '模型分布',
      mTokens: 'Token',
      mCost: '费用',
      mRequests: '请求',
      mQuota: '额度',
      days90: '90天',
      days182: '半年',
      days365: '全年',
      less: '少',
      more: '多',
      dayDetail: '已选',
      popTitle: '用量看板',
      manageAccounts: '账号管理',
      quickSwitch: '快速切号',
      busyCapture: '正在捕获当前系统凭据…',
      busyOauth: '请在打开的浏览器中完成 Google 授权…',
      busyNativeAdd: '正在备份原账号并切换为无登录态…',
      busyRefresh: '正在刷新账号额度…',
      busySwitch: '正在切换账号并同步凭据…',
      okCaptured: '已成功捕获账号',
      poolQuotaTitle: '额度与预测',
      weekProjLbl: '本周预估',
      monthProjLbl: '本月预估',
      projDepleteLbl: '约余时长',
      resetsLbl: '已重置',
      peakLbl: '峰值',
      paceAccel: '速率上升 ↑',
      paceSteady: '平稳 →',
      paceCool: '放缓 ↓',
      paceIdle: '低活跃',
      showClaudeLbl: '显示 Claude / GPT 额度'
    };
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
  }

  function fmtReset(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const m = Math.ceil(sec / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return h + 'h' + (rm ? rm + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24 ? (h % 24) + 'h' : '');
  }

  function fmtResetIso(isoStr, nowMs = Date.now()) {
    if (!isoStr) return '';
    const ms = Date.parse(isoStr);
    if (!Number.isFinite(ms) || ms <= nowMs) return '';
    return fmtReset(Math.floor((ms - nowMs) / 1000));
  }

  function maskEmail(email, masked) {
    const e = String(email || '');
    if (!masked || !e.includes('@')) return e;
    const [u, dom] = e.split('@');
    const head = u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***';
    return head + '@' + dom;
  }

  function isShowClaudeQuotaEnabled() {
    const prefs = window.__ag_ui_prefs && typeof window.__ag_ui_prefs === 'object' ? window.__ag_ui_prefs : {};
    if (prefs.showClaudeQuota !== undefined) return Boolean(prefs.showClaudeQuota);
    return Boolean(boot.userConfig?.showClaudeQuota ?? boot.showClaudeQuota);
  }

  function filterVisibleQuotaGroups(groups) {
    const list = Array.isArray(groups) ? groups : [];
    if (isShowClaudeQuotaEnabled()) return list;
    const nonClaude = list.filter((g) => !/claude|gpt/i.test(`${g?.key || ''} ${g?.label || ''}`));
    return nonClaude.length > 0 ? nonClaude : list.slice(0, 1);
  }

  function getActiveAccountEmail() {
    const ov = ui.overview;
    const accts = Array.isArray(ov?.accounts) ? ov.accounts : [];
    const activeAcct = accts.find((a) => a.isActive) || null;
    if (activeAcct?.email) return String(activeAcct.email).trim().toLowerCase();
    if (ov?.activeSystemEmail) return String(ov.activeSystemEmail).trim().toLowerCase();
    if (ui.analytics?.activeAccountEmail) return String(ui.analytics.activeAccountEmail).trim().toLowerCase();
    return '';
  }

  function resolveEffectiveAccountFilter() {
    if (ui.accountFilter === 'all') return 'all';
    if (!ui.accountFilter || ui.accountFilter === '__current__') {
      return getActiveAccountEmail() || 'all';
    }
    return ui.accountFilter;
  }

  function resolveLiveQuotaWin(win, nowMs = Date.now()) {
    if (!win || typeof win !== 'object') return null;
    let remainingPct = typeof win.remainingPct === 'number' ? Math.max(0, Math.min(100, win.remainingPct)) : null;
    let resetInSec = typeof win.resetInSec === 'number' && Number.isFinite(win.resetInSec) ? Math.max(0, win.resetInSec) : 0;
    const resetMs = win.resetTime ? Date.parse(win.resetTime) : NaN;
    if (Number.isFinite(resetMs)) {
      const liveSec = Math.round((resetMs - nowMs) / 1000);
      if (liveSec <= 0) {
        remainingPct = 100;
        resetInSec = 0;
      } else {
        resetInSec = liveSec;
      }
    }
    return { remainingPct, resetInSec };
  }

  function getLivePrimaryQuota() {
    const demoTop = window.__ag_demo_mode?.topbar;
    if (demoTop && typeof demoTop.quotaPct === 'number') {
      return { label: demoTop.label || 'Gemini', pct: demoTop.quotaPct, resetInSec: demoTop.resetInSec || 0, planName: demoTop.planName || 'Ultra' };
    }
    const q = window.__ag_quota_state;
    const groups = Array.isArray(q?.groups) ? q.groups : [];
    const g = groups.find((x) => x.key === 'gemini') || groups[0];
    if (!g) return null;
    const w5 = resolveLiveQuotaWin(g.fiveHour);
    if (!w5) return null;
    return { label: g.label || 'Gemini', pct: w5.remainingPct, resetInSec: w5.resetInSec, planName: q?.planName || '' };
  }

  function getQuotaSig() {
    const q = window.__ag_quota_state;
    if (!q || !Array.isArray(q.groups)) return '';
    return q.planName + '|' + q.groups.map((g) => `${g.key}:${g.fiveHour?.remainingPct ?? ''}:${g.weekly?.remainingPct ?? ''}`).join(',');
  }

  const pendingAccountsReqs = new Map();
  const pendingAnalyticsReqs = new Map();

  window.__ag_on_accounts_response = function (reqId, payload) {
    const cb = pendingAccountsReqs.get(reqId);
    if (cb) {
      pendingAccountsReqs.delete(reqId);
      cb(payload);
    } else if (payload && payload.overview) {
      ui.overview = payload.overview;
      renderPane();
      if (ui.popoverOpen) renderUsagePopover();
    }
  };

  window.__ag_on_usage_analytics = function (reqId, payload) {
    const cb = pendingAnalyticsReqs.get(reqId);
    if (cb) {
      pendingAnalyticsReqs.delete(reqId);
      cb(payload);
    } else if (payload && payload.ok) {
      ui.analytics = payload;
      if (ui.popoverOpen) renderUsagePopover();
    }
  };

  function callAccounts(action, params = {}) {
    return new Promise((resolve) => {
      if (typeof window.__agAccountsAction !== 'function') {
        resolve({ ok: false, error: 'Backend accounts service requires daemon restart' });
        return;
      }
      const reqId = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const timer = setTimeout(() => {
        pendingAccountsReqs.delete(reqId);
        resolve({ ok: false, error: 'Request timed out' });
      }, 190000);
      pendingAccountsReqs.set(reqId, (res) => {
        clearTimeout(timer);
        resolve(res || { ok: false });
      });
      try {
        window.__agAccountsAction(JSON.stringify({ reqId, action, ...params }));
      } catch (err) {
        clearTimeout(timer);
        pendingAccountsReqs.delete(reqId);
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  function callAnalytics(params = {}) {
    return new Promise((resolve) => {
      if (typeof window.__agUsageAnalytics !== 'function') {
        resolve({ ok: false, error: 'Backend analytics service requires daemon restart' });
        return;
      }
      const reqId = 'ana_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const timer = setTimeout(() => {
        pendingAnalyticsReqs.delete(reqId);
        resolve({ ok: false, error: 'Request timed out' });
      }, 20000);
      pendingAnalyticsReqs.set(reqId, (res) => {
        clearTimeout(timer);
        resolve(res || { ok: false });
      });
      try {
        window.__agUsageAnalytics(JSON.stringify({ reqId, ...params }));
      } catch (err) {
        clearTimeout(timer);
        pendingAnalyticsReqs.delete(reqId);
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  async function refreshOverview() {
    if (window.__ag_demo_mode?.overview) {
      ui.loadingAccounts = false;
      ui.overview = window.__ag_demo_mode.overview;
      renderPane();
      if (ui.popoverOpen) renderUsagePopover();
      return;
    }
    ui.loadingAccounts = true;
    renderPane();
    const res = await callAccounts('get_overview');
    ui.loadingAccounts = false;
    if (res && res.ok) {
      ui.overview = res;
      if (ui.banner?.error) ui.banner = null;
      const resolvedCur = getActiveAccountEmail();
      if (ui.accountFilter === '__current__' && resolvedCur && resolvedCur !== lastResolvedCurrentAcct) {
        lastResolvedCurrentAcct = resolvedCur;
        if (ui.popoverOpen) void refreshAnalytics(false);
      }
    } else if (res && res.error) {
      ui.banner = { error: true, text: res.error };
    }
    renderPane();
    if (ui.popoverOpen) renderUsagePopover();
  }

  async function refreshAnalytics(force = false, { silent = false } = {}) {
    if (window.__ag_demo_mode?.analytics) {
      ui.loadingAnalytics = false;
      ui.analytics = window.__ag_demo_mode.analytics;
      if (ui.analytics.summary) {
        topbarMetricsCache = {
          todayTokens: ui.analytics.summary.todayTokens || 0,
          todayCostUsd: ui.analytics.summary.todayCostUsd || 0,
          monthTokens: ui.analytics.summary.monthTokens || 0,
          monthCostUsd: ui.analytics.summary.monthCostUsd || 0,
          at: Date.now()
        };
        refreshTopbarBadge();
      }
      if (ui.popoverOpen) renderUsagePopover();
      return;
    }
    if (!silent && !ui.analytics) {
      ui.loadingAnalytics = true;
      if (ui.popoverOpen) renderUsagePopover();
    }
    const effectiveAccount = resolveEffectiveAccountFilter();
    if (ui.accountFilter === '__current__') {
      lastResolvedCurrentAcct = getActiveAccountEmail();
    }
    const res = await callAnalytics({
      range: ui.range,
      account: effectiveAccount,
      heatmapDays: 365,
      force
    });
    ui.loadingAnalytics = false;
    if (res && res.ok) {
      ui.analytics = res;
      if (res.summary) {
        topbarMetricsCache = {
          todayTokens: res.summary.todayTokens || 0,
          todayCostUsd: res.summary.todayCostUsd || 0,
          monthTokens: res.summary.monthTokens || 0,
          monthCostUsd: res.summary.monthCostUsd || 0,
          at: Date.now()
        };
        refreshTopbarBadge();
      }
      if (ui.banner?.error) ui.banner = null;
    } else if (res && res.error && !silent) {
      ui.banner = { error: true, text: res.error };
    }
    if (ui.popoverOpen) renderUsagePopover();
  }

  function renderQuotaRow(tag, win, { showReset = true } = {}) {
    if (!win) return '';
    const pct = typeof win.remainingPct === 'number' ? Math.max(0, Math.min(100, win.remainingPct)) : null;
    const tone = pct === null ? '' : pct <= 20 ? 'is-crit' : pct <= 50 ? 'is-warn' : '';
    const resetStr = showReset && pct !== null && pct < 100 && win.resetInSec > 0 ? fmtReset(win.resetInSec) : '';
    return (
      '<div class="ag-acc-qrow">' +
      '<span>' + esc(tag) + '</span>' +
      '<span class="ag-acc-qtrack"><span class="ag-acc-qfill ' + tone + '" style="width:' + (pct ?? 0) + '%"></span></span>' +
      '<span>' + (pct === null ? '—' : pct + '%') + '</span>' +
      '<span class="ag-acc-qreset">' + esc(resetStr) + '</span>' +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // ZCode-Inspired Adaptive 3-Mode Heatmap (Daily / Weekly / Cumulative)
  // Zero horizontal scrollbars; 1fr columns scale across popover & side panel.
  // ---------------------------------------------------------------------------
  function levelForMetric(val, maxVal) {
    if (!val || val <= 0 || !maxVal || maxVal <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((val / maxVal) * 4)));
  }

  function getCellMetricVal(c, metric) {
    if (!c) return 0;
    if (metric === 'cost') return Number(c.costUsd) || 0;
    if (metric === 'requests') return Number(c.requests) || 0;
    if (metric === 'quota') return Number(c.quotaDropPct) || 0;
    return Number(c.tokens) || 0;
  }

  function fmtMetricVal(val, metric) {
    if (metric === 'cost') return '$' + Number(val || 0).toFixed(2);
    if (metric === 'requests') return (Number(val) || 0) + ' reqs';
    if (metric === 'quota') return '-' + Math.round(Number(val) || 0) + '%';
    return fmtTok(val || 0) + ' tok';
  }

  function renderZCodeHeatmapSection(s, ana, { spanDays = 182, showSpanTabs = false } = {}) {
    const rawHeat = Array.isArray(ana?.heatmap) ? ana.heatmap : [];
    const sliceHeat = rawHeat.slice(-spanDays);
    if (!sliceHeat.length) {
      return '<div class="ag-s-row-desc" style="text-align:center;padding:18px 0">—</div>';
    }

    // Pad leading days to Sunday (day 0) so row 0 is always Sunday like GitHub/ZCode
    let cells = sliceHeat;
    const firstDt = sliceHeat[0]?.date ? new Date(sliceHeat[0].date + 'T00:00:00') : null;
    const padStart = firstDt && Number.isFinite(firstDt.getDay()) ? firstDt.getDay() : 0;
    if (padStart > 0) {
      cells = Array.from({ length: padStart }, () => null).concat(sliceHeat);
    }

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) {
      const colCells = cells.slice(i, i + 7);
      while (colCells.length < 7) colCells.push(null);
      weeks.push(colCells);
    }
    const weekCols = Math.max(1, weeks.length);
    const metric = ui.heatMetric || 'tokens';
    const mode = ui.heatDisplayMode || 'daily';

    // Build columns according to ZCode daily / weekly / cumulative model
    let columns = [];
    if (mode === 'daily') {
      columns = weeks.map((week, wIdx) => {
        const firstOfMonth = week.find((c) => c?.date?.endsWith('-01'));
        const monthDate = firstOfMonth?.date || week[0]?.date || week.find(Boolean)?.date || '';
        return {
          key: 'w-' + wIdx,
          monthDate,
          colHover: false,
          summaryObj: null,
          cells: week.map((c, dIdx) => {
            if (!c) return { empty: true, key: `pad-${wIdx}-${dIdx}` };
            const val = getCellMetricVal(c, metric);
            const lvl = c.levels ? c.levels[metric] || 0 : 0;
            const tip = `${c.date}: ${fmtTok(c.tokens)} tok · $${(c.costUsd || 0).toFixed(2)} · ${c.requests} reqs · -${c.quotaDropPct || 0}%`;
            return {
              empty: false,
              key: c.date,
              date: c.date,
              level: lvl,
              hasUsage: val > 0,
              tip
            };
          })
        };
      });
    } else {
      const weekTotals = weeks.map((w) => w.reduce((acc, c) => acc + getCellMetricVal(c, metric), 0));
      const weekReqs = weeks.map((w) => w.reduce((acc, c) => acc + (c?.requests || 0), 0));
      const weekTokens = weeks.map((w) => w.reduce((acc, c) => acc + (c?.tokens || 0), 0));
      const weekCosts = weeks.map((w) => w.reduce((acc, c) => acc + (c?.costUsd || 0), 0));
      const weekQuotas = weeks.map((w) => w.reduce((acc, c) => acc + (c?.quotaDropPct || 0), 0));

      const values =
        mode === 'weekly'
          ? weekTotals
          : weekTotals.reduce((acc, v) => {
              acc.push((acc.length ? acc[acc.length - 1] : 0) + v);
              return acc;
            }, []);
      const maxVal = Math.max(0, ...values);

      let cumTok = 0;
      let cumCost = 0;
      let cumReq = 0;
      let cumQuota = 0;
      columns = weeks.map((week, wIdx) => {
        cumTok += weekTokens[wIdx];
        cumCost += weekCosts[wIdx];
        cumReq += weekReqs[wIdx];
        cumQuota += weekQuotas[wIdx];
        const firstReal = week.find(Boolean);
        const lastReal = [...week].reverse().find(Boolean);
        const rangeLabel = firstReal && lastReal ? `${firstReal.date} ~ ${lastReal.date}` : `W${wIdx + 1}`;
        const firstOfMonth = week.find((c) => c?.date?.endsWith('-01'));
        const monthDate = firstOfMonth?.date || week[0]?.date || firstReal?.date || '';

        const v = values[wIdx] || 0;
        const lvl = levelForMetric(v, maxVal);
        const filledRows = v > 0 && maxVal > 0 ? Math.min(7, Math.max(1, Math.ceil((v / maxVal) * 7))) : 0;

        const dispTok = mode === 'weekly' ? weekTokens[wIdx] : cumTok;
        const dispCost = mode === 'weekly' ? weekCosts[wIdx] : cumCost;
        const dispReq = mode === 'weekly' ? weekReqs[wIdx] : cumReq;
        const dispQuota = mode === 'weekly' ? weekQuotas[wIdx] : cumQuota;
        const tip = `${rangeLabel}: ${fmtTok(dispTok)} tok · $${dispCost.toFixed(2)} · ${dispReq} reqs · -${dispQuota}%`;

        return {
          key: `${mode}-${wIdx}`,
          monthDate,
          colHover: true,
          rangeLabel,
          tip,
          summaryObj: {
            title: `${mode === 'weekly' ? s.heatWeekly : s.heatCum} (${rangeLabel})`,
            tokens: dispTok,
            costUsd: dispCost,
            requests: dispReq,
            quotaDropPct: dispQuota,
            valText: fmtMetricVal(v, metric)
          },
          cells: week.map((_, dIdx) => {
            const isFilled = dIdx >= 7 - filledRows;
            return {
              empty: false,
              key: `${mode}-${wIdx}`,
              date: `${mode}-${wIdx}`,
              level: isFilled ? lvl : 0,
              hasUsage: isFilled && v > 0,
              tip
            };
          })
        };
      });
    }

    // Build aligned month spans matching ZCode's resolveHeatmapColumnMonthDate & buildHeatmapMonthLabels
    const monthLabels = [];
    for (const col of columns) {
      const mKey = col.monthDate ? col.monthDate.slice(0, 7) : '';
      const last = monthLabels[monthLabels.length - 1];
      if (last && last.key === mKey) {
        last.span += 1;
      } else {
        const mNum = Number(mKey.slice(5, 7));
        const mText =
          mNum >= 1 && mNum <= 12
            ? getLoc() === 'en'
              ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mNum - 1]
              : mNum + '月'
            : '';
        monthLabels.push({ key: mKey || `m-${monthLabels.length}`, label: mText, span: 1 });
      }
    }
    const maxLabels = 12;
    const hideStart = Math.max(0, monthLabels.length - maxLabels);
    for (let i = 0; i < hideStart; i++) {
      monthLabels[i].label = '';
    }
    if (monthLabels[0] && monthLabels[0].span <= 1 && monthLabels.length > 1) {
      monthLabels[0].label = '';
    }

    const colsHtml = columns
      .map((col) => {
        const isColSel = col.colHover && ui.selectedHeatKey === col.key;
        return (
          '<div class="ag-zc-heat-col' +
          (col.colHover ? ' is-col-mode' : '') +
          (isColSel ? ' is-selected' : '') +
          '">' +
          col.cells
            .map((cell) => {
              if (cell.empty) {
                return '<span class="ag-zc-heat-cell" style="opacity:0;pointer-events:none"></span>';
              }
              const sel = !col.colHover && ui.selectedHeatKey === cell.key;
              return (
                '<button type="button" class="ag-zc-heat-cell' +
                (cell.hasUsage ? ' has-usage' : '') +
                (sel ? ' is-selected' : '') +
                '" data-level="' + cell.level + '" data-heat-date="' + esc(cell.key) + '" title="' + esc(cell.tip) + '"></button>'
              );
            })
            .join('') +
          '</div>'
        );
      })
      .join('');

    const monthsHtml =
      '<div class="ag-zc-heat-months" style="--ag-heat-cols:' + weekCols + '">' +
      monthLabels
        .map((m) => '<div class="ag-zc-heat-month" style="grid-column:span ' + m.span + '">' + esc(m.label) + '</div>')
        .join('') +
      '</div>';

    const spanSegHtml = showSpanTabs
      ? '<div class="ag-s-seg">' +
        [[90, s.days90], [182, s.days182], [365, s.days365]]
          .map(([d, lbl]) => '<button type="button" class="ag-s-seg-btn" data-heat-span="' + d + '" aria-pressed="' + (ui.heatSpanDays === d ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
          .join('') +
        '</div>'
      : '';

    const modeSegHtml =
      '<div class="ag-s-seg">' +
      [['daily', s.heatDaily], ['weekly', s.heatWeekly], ['cumulative', s.heatCum]]
        .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-heat-mode="' + k + '" aria-pressed="' + (mode === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
        .join('') +
      '</div>';

    // Detail bar when user clicks any cell or column
    let detailHtml = '';
    if (ui.selectedHeatKey) {
      if (mode === 'daily') {
        const hit = sliceHeat.find((c) => c.date === ui.selectedHeatKey);
        if (hit) {
          detailHtml =
            '<div class="ag-heat-summary-bar">' +
            '<span><b>' + esc(s.dayDetail) + ' ' + esc(hit.date) + '</b>: ' + esc(fmtTok(hit.tokens)) + ' tok · $' + esc((hit.costUsd || 0).toFixed(2)) + ' · ' + esc(hit.requests) + ' reqs · -' + esc(hit.quotaDropPct || 0) + '%</span>' +
            '<span style="opacity:0.78">' +
            Object.entries(hit.byModel || {}).slice(0, 3).map(([m, t]) => esc(m) + ': ' + esc(fmtTok(t))).join(' · ') +
            '</span></div>';
        }
      } else {
        const hitCol = columns.find((c) => c.key === ui.selectedHeatKey);
        if (hitCol?.summaryObj) {
          const so = hitCol.summaryObj;
          detailHtml =
            '<div class="ag-heat-summary-bar">' +
            '<span><b>' + esc(so.title) + '</b></span>' +
            '<span>' + esc(fmtTok(so.tokens)) + ' tok · $' + esc(so.costUsd.toFixed(2)) + ' · ' + esc(so.requests) + ' reqs · -' + esc(so.quotaDropPct) + '%</span>' +
            '</div>';
        }
      }
    }

    const spanSumVal = sliceHeat.reduce((acc, c) => acc + getCellMetricVal(c, metric), 0);
    const spanPeakVal = sliceHeat.reduce((mx, c) => Math.max(mx, getCellMetricVal(c, metric)), 0);
    const metricLabelMap = { tokens: s.mTokens, cost: s.mCost, requests: s.mRequests, quota: s.mQuota };
    const metricReadoutHtml =
      '<span class="ag-heat-metric-pill">' +
      esc(metricLabelMap[metric] || s.mTokens) + ': <b>' + esc(fmtMetricVal(spanSumVal, metric)) + '</b>' +
      (spanPeakVal > 0 ? ' · ' + esc(s.peakLbl) + ' ' + esc(fmtMetricVal(spanPeakVal, metric)) : '') +
      '</span>';

    return (
      '<div class="ag-s-card"><div class="ag-s-row">' +
      '<div class="ag-s-section-head">' +
      '<span class="ag-s-section-title">' + esc(s.heatmapTitle) + '</span>' +
      '<div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">' + spanSegHtml + modeSegHtml + '</div>' +
      '</div>' +
      '<div class="ag-zc-heat-grid" style="--ag-heat-cols:' + weekCols + '">' + colsHtml + '</div>' +
      monthsHtml +
      '<div class="ag-heat-footer">' +
      '<div style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<div class="ag-s-seg">' +
      [['tokens', s.mTokens], ['cost', s.mCost], ['requests', s.mRequests], ['quota', s.mQuota]]
        .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-heat-metric="' + k + '" aria-pressed="' + (metric === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
        .join('') +
      '</div>' +
      metricReadoutHtml +
      '</div>' +
      '<span class="ag-heat-legend"><span>' + esc(s.less) + '</span>' +
      '<span class="ag-zc-heat-cell" data-level="0"></span><span class="ag-zc-heat-cell" data-level="1"></span><span class="ag-zc-heat-cell" data-level="2"></span><span class="ag-zc-heat-cell" data-level="3"></span><span class="ag-zc-heat-cell" data-level="4"></span>' +
      '<span>' + esc(s.more) + '</span></span>' +
      '</div>' +
      detailHtml +
      '</div></div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Per-Model Pool Quota + Dynamic Monthly Projection Cards
  // ---------------------------------------------------------------------------
  function renderModelQuotaProjectionSection(s, ana) {
    const rawPools = Array.isArray(ana?.quotaByPool) ? ana.quotaByPool : [];
    const pools = filterVisibleQuotaGroups(rawPools);
    if (!pools.length) return '';

    const poolSwatches = {
      gemini: 'var(--ag-zc-chart-1)',
      'claude-gpt': 'var(--ag-zc-chart-2)',
      other: 'var(--ag-zc-chart-3)'
    };

    const items = pools
      .map((p) => {
        const fhRem = typeof p.fiveHourRemainingPct === 'number' ? Math.max(0, Math.min(100, p.fiveHourRemainingPct)) : null;
        const wkRem = typeof p.weeklyRemainingPct === 'number' ? Math.max(0, Math.min(100, p.weeklyRemainingPct)) : null;
        const fhTone = fhRem === null ? '' : fhRem <= 20 ? 'is-crit' : fhRem <= 50 ? 'is-warn' : '';
        const wkTone = wkRem === null ? '' : wkRem <= 20 ? 'is-crit' : wkRem <= 50 ? 'is-warn' : '';
        const fhReset = fhRem !== null && fhRem < 100 ? fmtResetIso(p.fiveHourResetTime) : '';
        const wkReset = wkRem !== null && wkRem < 100 ? fmtResetIso(p.weeklyResetTime) : '';

        const proj = p.projection || {};
        const trend = proj.paceTrend || 'steady';
        const trendLabel =
          trend === 'accelerating' ? s.paceAccel : trend === 'cooling' ? s.paceCool : trend === 'idle' ? s.paceIdle : s.paceSteady;
        const trendClass = trend === 'accelerating' ? 'is-accel' : trend === 'cooling' ? 'is-cool' : trend === 'steady' ? 'is-steady' : '';

        const isEnLoc = getLoc() === 'en';
        const depleteParts = [];
        if (typeof proj.estDeplete5hHours === 'number' && !proj.fiveHourSafeUntilReset) {
          depleteParts.push(`5h ${proj.estDeplete5hHours}h`);
        } else if (fhRem !== null && fhRem > 0 && proj.fiveHourSafeUntilReset) {
          depleteParts.push(isEnLoc ? '5h Safe' : '5h 安全');
        }
        if (typeof proj.estDepleteWeeklyDays === 'number' && !proj.weeklySafeUntilReset) {
          depleteParts.push(`${s.win7d} ${proj.estDepleteWeeklyDays}d`);
        } else if (wkRem !== null && wkRem > 0 && proj.weeklySafeUntilReset) {
          depleteParts.push(isEnLoc ? 'Wk Safe' : `${s.win7d}安全`);
        }
        const depleteStr = depleteParts.length ? depleteParts.join(' · ') : '—';
        const depleteTitle = isEnLoc
          ? `5h burn: ${proj.burnRate5hPerHour || 0}%/h (reset in ${proj.hoursTo5hReset || 0}h) · Weekly burn: ${proj.weeklyDailyRatePct || 0}%/d (reset in ${proj.daysToNextWeeklyReset || 0}d)`
          : `5h 燃速 ${proj.burnRate5hPerHour || 0}%/h（${proj.hoursTo5hReset || 0}h 后重置）· 周额日耗 ${proj.weeklyDailyRatePct || 0}%/天（${proj.daysToNextWeeklyReset || 0}d 后重置）`;

        const wkTokStr = proj.weekProjectedTokens > 0 ? '~' + fmtTok(proj.weekProjectedTokens) : '0';
        const wkCostStr = '$' + Math.round(Number(proj.weekProjectedCostUsd || 0));
        const moTokStr = proj.monthProjectedTokens > 0 ? '~' + fmtTok(proj.monthProjectedTokens) : '0';
        const moCostStr = '$' + Math.round(Number(proj.monthProjectedCostUsd || 0));
        const r5 = Number(p.fiveHourResets || 0);
        const rw = Number(p.weeklyResets || 0);
        const inf5 = Number(p.inferredFiveHourResets || 0);
        const infW = Number(p.inferredWeeklyResets || 0);
        const resetCountStr = `5h ×${r5} · ${s.win7d} ×${rw}`;
        const resetCountTitle = isEnLoc
          ? `5h resets: ${r5} (sampled ${p.sampledFiveHourResets || 0}, history ${inf5}) · Weekly resets: ${rw} (sampled ${p.sampledWeeklyResets || 0}, history ${infW})`
          : `5h 重置 ${r5} 次（采样 ${p.sampledFiveHourResets || 0} + 历史周期 ${inf5}）· 周额重置 ${rw} 次（采样 ${p.sampledWeeklyResets || 0} + 历史周期 ${infW}）`;
        const wkProjTitle = isEnLoc
          ? `Current 7-day rolling window projected total (reset in ${proj.daysToNextWeeklyReset ?? 0}d)`
          : `当前 7 天周窗口（距重置余 ${proj.daysToNextWeeklyReset ?? 0}d）预计总消耗`;
        const moProjTitle = isEnLoc
          ? `Calendar month cumulative + projected usage (${proj.remainingMonthDays ?? 0}d left in month)`
          : `自然月累计 + 距月末余 ${proj.remainingMonthDays ?? 0}d 预计新增`;

        return (
          '<div class="ag-pool-item">' +
          '<div class="ag-pool-hdr">' +
          '<span class="ag-pool-name"><span class="ag-pool-swatch" style="background:' + (poolSwatches[p.key] || 'var(--ag-zc-chart-3)') + '"></span>' + esc(p.label || p.key) + '</span>' +
          '<span class="ag-pace-badge ' + trendClass + '">' + esc(trendLabel) + '</span>' +
          '</div>' +
          '<div class="ag-pool-bars">' +
          '<div class="ag-pool-qrow"><span>' + esc(s.win5h) + '</span><span class="ag-acc-qtrack"><span class="ag-acc-qfill ' + fhTone + '" style="width:' + (fhRem ?? 0) + '%"></span></span><span>' + (fhRem === null ? '—' : fhRem + '%') + '</span><span class="ag-acc-qreset">' + esc(fhReset) + '</span></div>' +
          '<div class="ag-pool-qrow"><span>' + esc(s.win7d) + '</span><span class="ag-acc-qtrack"><span class="ag-acc-qfill ' + wkTone + '" style="width:' + (wkRem ?? 0) + '%"></span></span><span>' + (wkRem === null ? '—' : wkRem + '%') + '</span><span class="ag-acc-qreset">' + esc(wkReset) + '</span></div>' +
          '</div>' +
          '<div class="ag-pool-forecast-row">' +
          '<div class="ag-pf-cell" title="' + esc(wkProjTitle) + '"><span class="ag-pf-k">' + esc(s.weekProjLbl) + '</span><span class="ag-pf-v">' + esc(wkTokStr) + ' · ' + esc(wkCostStr) + '</span></div>' +
          '<div class="ag-pf-cell" title="' + esc(moProjTitle) + '"><span class="ag-pf-k">' + esc(s.monthProjLbl) + '</span><span class="ag-pf-v">' + esc(moTokStr) + ' · ' + esc(moCostStr) + '</span></div>' +
          '<div class="ag-pf-cell" title="' + esc(depleteTitle) + '"><span class="ag-pf-k">' + esc(s.projDepleteLbl) + '</span><span class="ag-pf-v">' + esc(depleteStr) + '</span></div>' +
          '<div class="ag-pf-cell" title="' + esc(resetCountTitle) + '"><span class="ag-pf-k">' + esc(s.resetsLbl) + '</span><span class="ag-pf-v">' + esc(resetCountStr) + '</span></div>' +
          '</div></div>'
        );
      })
      .join('');

    return (
      '<div class="ag-s-card"><div class="ag-s-row">' +
      '<div class="ag-s-section-head"><span class="ag-s-section-title">' + esc(s.poolQuotaTitle) + '</span></div>' +
      '<div class="ag-pool-list">' + items + '</div>' +
      '</div></div>'
    );
  }

  // ---------------------------------------------------------------------------
  // 1. ZCode-Inspired Usage Dashboard Renderer (Floating Popover)
  // ---------------------------------------------------------------------------
  function renderUnifiedDashboardBody(s, ana) {
    const masked = Boolean(ui.overview?.privacyMask);
    const curEmail = getActiveAccountEmail();
    const avail = Array.isArray(ana?.availableAccounts) ? ana.availableAccounts : [];
    const sum = ana?.summary || {};

    // Top filter row: Custom Codex Account Picker ("全部账号" first, then each account in order with ✓ on current active)
    const allAcctSet = new Set(avail.map((em) => String(em || '').trim().toLowerCase()).filter(Boolean));
    for (const a of Array.isArray(ui.overview?.accounts) ? ui.overview.accounts : []) {
      if (a?.email) allAcctSet.add(String(a.email).trim().toLowerCase());
    }
    if (curEmail) allAcctSet.add(curEmail);
    const orderedAccounts = [...allAcctSet].sort((a, b) => a.localeCompare(b));
    const effAcct = resolveEffectiveAccountFilter();
    const triggerLabel =
      ui.accountFilter === 'all'
        ? s.allAccounts
        : curEmail && effAcct === curEmail
        ? maskEmail(curEmail, masked) + ' (' + s.curAccountOpt + ')'
        : maskEmail(effAcct, masked);

    const iconUser = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.75;flex-shrink:0"><circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.8c.6-2.4 2.7-3.8 5.2-3.8s4.6 1.4 5.2 3.8"/></svg>';
    const iconChevron = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.65;flex-shrink:0"><path d="M4 6l4 4 4-4"/></svg>';

    const menuItemsHtml =
      '<button type="button" class="ag-acct-opt' + (ui.accountFilter === 'all' ? ' is-selected' : '') + '" data-acct-opt="all">' +
      '<span class="ag-acct-opt-left">' + esc(s.allAccounts) + '</span>' +
      (ui.accountFilter === 'all' ? '<span class="ag-acct-opt-right">✓</span>' : '') +
      '</button>' +
      orderedAccounts
        .map((em) => {
          const isCurSystem = Boolean(curEmail && em === curEmail);
          const isViewing = effAcct === em && ui.accountFilter !== 'all';
          const optVal = isCurSystem ? '__current__' : em;
          return (
            '<button type="button" class="ag-acct-opt' + (isViewing ? ' is-selected' : '') + '" data-acct-opt="' + esc(optVal) + '">' +
            '<span class="ag-acct-opt-left">' +
            (isCurSystem ? '<span class="ag-acc-dot is-active"></span>' : '<span class="ag-acc-dot" style="opacity:0.28"></span>') +
            '<span>' + esc(maskEmail(em, masked)) + '</span>' +
            '</span>' +
            (isCurSystem ? '<span class="ag-acct-opt-right" title="' + esc(s.curAccountOpt) + '">✓</span>' : isViewing ? '<span class="ag-acct-opt-right" style="color:var(--ag-zc-chart-1)">●</span>' : '') +
            '</button>'
          );
        })
        .join('');

    const acctPickerHtml =
      '<div class="ag-acct-picker">' +
      '<button type="button" class="ag-acct-trigger" data-acct-trigger="1" aria-expanded="' + (ui.acctMenuOpen ? 'true' : 'false') + '">' +
      iconUser +
      '<span class="ag-acct-trigger-label">' + esc(triggerLabel || s.curAccountOpt) + '</span>' +
      iconChevron +
      '</button>' +
      (ui.acctMenuOpen ? '<div class="ag-acct-menu browser-hole-opaque">' + menuItemsHtml + '</div>' : '') +
      '</div>';

    const rangeSegHtml =
      '<div class="ag-s-seg">' +
      [['today', s.rangeToday], ['week', s.rangeWeek], ['month', s.rangeMonth], ['year', s.rangeYear], ['all', s.rangeAll]]
        .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-ana-range="' + k + '" aria-pressed="' + (ui.range === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
        .join('') +
      '</div>';

    const topBarCard =
      '<div class="ag-s-card" style="overflow:visible"><div class="ag-s-row" style="padding:9px 12px">' +
      '<div class="ag-s-row-main">' +
      acctPickerHtml +
      rangeSegHtml +
      '</div></div></div>';

    if (!ana || !ana.ok) {
      return (
        topBarCard +
        '<div class="ag-s-card"><div class="ag-s-row"><div class="ag-s-row-desc" style="text-align:center;padding:24px 0">' +
        esc(ui.loadingAnalytics ? 'Loading…' : 'No analytics data yet') +
        '</div></div></div>'
      );
    }

    // Powertools 3-Card Area Sparkline KPI Strip (aligned with card-dashboard-light / dark)
    const spArr = Array.isArray(ana.sparkline) ? ana.sparkline : [];
    const buildSparkSvg = (vals, strokeColor, gid) => {
      if (!vals || vals.length < 2) return '';
      const maxV = Math.max(1, ...vals);
      const pts = vals.map((v, i) => {
        const x = ((i / (vals.length - 1)) * 120).toFixed(1);
        const y = (28 - (Math.max(0, v) / maxV) * 23).toFixed(1);
        return `${x},${y}`;
      });
      const areaPts = `0,30 ${pts.join(' ')} 120,30`;
      return (
        `<svg class="ag-kpi-spark" viewBox="0 0 120 30" preserveAspectRatio="none">` +
        `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.24"/>` +
        `<stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.01"/>` +
        `</linearGradient></defs>` +
        `<polygon fill="url(#${gid})" points="${areaPts}" />` +
        `<polyline fill="none" stroke="${strokeColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}" />` +
        `</svg>`
      );
    };
    const errCnt = Number(sum.errorCount || 0);
    const okCnt = Math.max(0, (sum.requests || 0) - errCnt);
    const avgCostPerReq = (sum.requests || 0) > 0 ? (sum.estCostUsd || 0) / sum.requests : 0;
    const iconReq = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 5H3.5l2.5-2.5M3.5 11h9l-2.5 2.5"/></svg>';
    const iconTok = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L2.5 5 8 8l5.5-3L8 2zM2.5 8.2L8 11.2l5.5-3M2.5 11.4L8 14.4l5.5-3"/></svg>';
    const iconCost = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="10" height="12" rx="1.8"/><path d="M5.5 5.5h5M5.5 8.5h5M5.5 11.5h3"/></svg>';

    const sparkCards =
      '<div class="ag-pt-kpi-grid">' +
      '<div class="ag-pt-kpi-card">' +
      '<div class="ag-pt-kpi-top"><span class="ag-pt-kpi-lbl">' + esc(getLoc() === 'en' ? 'Requests' : '请求次数') + '</span><span class="ag-pt-kpi-ico">' + iconReq + '</span></div>' +
      '<div class="ag-pt-kpi-val">' + esc(sum.requests || 0) + '</div>' +
      '<div class="ag-pt-kpi-sub"><span style="color:var(--ag-s-ok)">● ' + okCnt + ' 成功</span>' + (errCnt > 0 ? ' · <span style="color:var(--ag-s-err)">● ' + errCnt + ' 错误</span>' : '') + '</div>' +
      buildSparkSvg(spArr.map((x) => x.requests || 0), 'var(--ag-zc-chart-1)', 'ag-spk-req') +
      '</div>' +
      '<div class="ag-pt-kpi-card">' +
      '<div class="ag-pt-kpi-top"><span class="ag-pt-kpi-lbl">' + esc(s.kpiTokens) + '</span><span class="ag-pt-kpi-ico">' + iconTok + '</span></div>' +
      '<div class="ag-pt-kpi-val">' + esc(fmtTok(sum.totalTokens)) + '</div>' +
      '<div class="ag-pt-kpi-sub">命中 <b style="color:var(--ag-s-ok)">' + esc(sum.cacheHitPct || 0) + '%</b> · ' + esc(sum.avgTps || 0) + ' t/s</div>' +
      buildSparkSvg(spArr.map((x) => x.tokens || 0), 'var(--ag-zc-chart-2)', 'ag-spk-tok') +
      '</div>' +
      '<div class="ag-pt-kpi-card">' +
      '<div class="ag-pt-kpi-top"><span class="ag-pt-kpi-lbl">' + esc(s.kpiCost) + '</span><span class="ag-pt-kpi-ico">' + iconCost + '</span></div>' +
      '<div class="ag-pt-kpi-val">$' + esc((sum.estCostUsd || 0).toFixed(2)) + '</div>' +
      '<div class="ag-pt-kpi-sub">均价 $' + esc(avgCostPerReq.toFixed(2)) + ' · 省 $' + esc(Math.round(sum.cacheSavedUsd || 0)) + '</div>' +
      buildSparkSvg(spArr.map((x) => x.costUsd || 0), 'var(--ag-zc-chart-5)', 'ag-spk-cost') +
      '</div></div>';

    const stripCard = sparkCards;

    const poolQuotaCard = renderModelQuotaProjectionSection(s, ana);
    const heatmapCard = renderZCodeHeatmapSection(s, ana, {
      spanDays: 182,
      showSpanTabs: false
    });

    const palette = [
      'var(--ag-zc-chart-1)',
      'var(--ag-zc-chart-2)',
      'var(--ag-zc-chart-3)',
      'var(--ag-zc-chart-4)',
      'var(--ag-zc-chart-5)',
      'var(--ag-zc-chart-6)'
    ];
    const modRows = (ana.models || [])
      .slice(0, 7)
      .map((m, idx) => {
        const dotColor = palette[idx % palette.length];
        const sharePct = Math.min(100, Math.max(0, Number(m.sharePct || 0)));
        return (
          '<tr><td><div class="ag-mod-name-cell"><span class="ag-mod-dot" style="background:' + dotColor + '"></span><span style="truncate">' + esc(m.model) + '</span></div>' +
          '<div class="ag-mod-share-track"><div class="ag-mod-share-fill" style="width:' + Math.max(2, sharePct) + '%;background:' + dotColor + '"></div></div></td>' +
          '<td>' + esc(m.requests || 0) + '</td>' +
          '<td>' + esc(fmtTok(m.totalTokens)) + '</td>' +
          '<td>$' + esc((m.estCostUsd || 0).toFixed(2)) + '</td></tr>'
        );
      })
      .join('');

    const cmpAccounts = Array.isArray(ana.accountComparison) && ana.accountComparison.length > 0
      ? ana.accountComparison
      : (ana.accounts || []);
    const acctRows = cmpAccounts
      .map((a) => {
        const rem5h = typeof a.fiveHourRemainingPct === 'number' ? a.fiveHourRemainingPct + '%' : '—';
        return (
          '<tr><td><span class="ag-acc-dot' + (a.isCurrent ? ' is-active' : '') + '" style="margin-right:6px"></span>' +
          esc(maskEmail(a.email, masked)) + '</td>' +
          '<td>' + esc(fmtTok(a.totalTokens)) + '</td>' +
          '<td>$' + esc((a.estCostUsd || 0).toFixed(2)) + '</td>' +
          '<td>' + esc(rem5h) + '</td></tr>'
        );
      })
      .join('');

    const isEn = getLoc() === 'en';
    const modHead = isEn
      ? '<tr><th>Model</th><th>Reqs</th><th>Tokens</th><th>Cost</th></tr>'
      : '<tr><th>模型</th><th>请求</th><th>Tokens</th><th>费用</th></tr>';
    const acctHead = isEn
      ? '<tr><th>Account</th><th>Tokens</th><th>Cost</th><th>5h Left</th></tr>'
      : '<tr><th>账号</th><th>Tokens</th><th>费用</th><th>5h 剩余</th></tr>';

    const activeTab = ui.popTrendTab === 'accounts' ? 'accounts' : 'models';
    const detailHtml =
      activeTab === 'accounts'
        ? '<table class="ag-ana-table"><thead>' + acctHead + '</thead><tbody>' + (acctRows || '<tr><td colspan="4">—</td></tr>') + '</tbody></table>'
        : '<table class="ag-ana-table"><thead>' + modHead + '</thead><tbody>' + (modRows || '<tr><td colspan="4">—</td></tr>') + '</tbody></table>';
    const lowerHtml =
      '<div class="ag-s-card"><div class="ag-s-row">' +
      '<div class="ag-s-section-head"><span class="ag-s-section-title">' + esc(s.trendTitle) + '</span>' +
      '<div class="ag-s-seg">' +
      [['models', s.modelTableTitle], ['accounts', s.acctTableTitle]]
        .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-pop-tab="' + k + '" aria-pressed="' + (activeTab === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
        .join('') +
      '</div></div>' + detailHtml + '</div></div>';

    return topBarCard + stripCard + poolQuotaCard + heatmapCard + lowerHtml;
  }

  let lastFilteredReqs = [];
  let lastReqHelpers = null;

  function renderRequestsTabBody(s, ana) {
    const allReqs = Array.isArray(ana?.recentRequests) ? ana.recentRequests : [];
    const masked = Boolean(ui.overview?.privacyMask);
    const filtered = allReqs.filter((r) => {
      if (ui.reqStatus === 'success' && r.status !== 'success') return false;
      if (ui.reqStatus === 'error' && r.status !== 'error') return false;
      if (ui.reqStatus === 'drop' && !r.cacheAnomaly) return false;
      return true;
    });
    lastFilteredReqs = filtered;
    const dropCount = allReqs.filter((r) => r.cacheAnomaly).length;
    const now = new Date();
    const fmtTime = (ms) => {
      if (!ms) return '—';
      const d = new Date(ms);
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        return hhmm;
      }
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
    };
    const fmtFullTime = (ms) => {
      if (!ms) return '—';
      const d = new Date(ms);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    };
    const fmtDurMs = (ms) => {
      const v = Number(ms || 0);
      if (v <= 0) return '—';
      if (v < 1000) return v + 'ms';
      return (v / 1000).toFixed(2) + 's';
    };
    const isEn = getLoc() === 'en';
    const renderDetailRow = (r) => {
      const thinkTok = Number(r.thinkingTokens || 0);
      const outTok = Number(r.outputTokens || 0);
      const respTok = Math.max(0, outTok - thinkTok);
      const cwTok = Number(r.cacheWriteTokens || 0);
      const totTok = Number(r.totalTokens || (r.inputTokens || 0) + (r.cacheReadTokens || 0) + outTok);
      const diagHtml =
        r.status === 'error' && (r.errMsg || r.errCode)
          ? '<div class="ag-req-detail-diag is-err"><b>' +
            esc(isEn ? 'Error' : '错误详情') +
            (r.errCode ? ' #' + esc(r.errCode) : '') +
            ':</b> ' +
            esc(r.errMsg || 'Unknown error') +
            '</div>'
          : r.cacheAnomaly
          ? '<div class="ag-req-detail-diag is-warn"><b>' +
            esc(isEn ? 'Cache Anomaly' : '缓存异常') +
            ':</b> ' +
            esc(
              r.cacheAnomaly.kind === 'cleared'
                ? (isEn ? `Cache cleared (${r.cacheAnomaly.prevHit}% → 0%)` : `缓存清零（${r.cacheAnomaly.prevHit}% → 0%）`)
                : (isEn ? `Cache dropped (${r.cacheAnomaly.prevHit}% → ${r.cacheAnomaly.curHit}%)` : `缓存骤降（${r.cacheAnomaly.prevHit}% → ${r.cacheAnomaly.curHit}%）`)
            ) +
            '</div>'
          : '';
      return (
        '<tr class="ag-req-detail-row"><td colspan="8"><div class="ag-req-detail-card">' +
        '<div class="ag-req-detail-head">' +
        '<span class="ag-req-detail-model">' + esc(r.model) + (r.role ? ' <span class="ag-req-role-pill">' + esc(r.role) + '</span>' : '') + '</span>' +
        '<span class="ag-req-detail-ts">' + esc(fmtFullTime(r.ts)) + '</span>' +
        '</div>' +
        '<div class="ag-req-detail-grid">' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Session' : '会话 / 步序') + '</span><b title="' + esc(r.cid || '') + '">' + esc((r.cid || '—').slice(0, 12)) + ' #' + esc((r.genIdx ?? 0) + 1) + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Account' : '归属账号') + '</span><b>' + esc(maskEmail(r.accountEmail || '—', masked)) + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'New Input' : '新增输入') + '</span><b>' + esc(fmtTok(r.inputTokens || 0)) + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Cache Read' : '缓存复用') + '</span><b>' + esc(fmtTok(r.cacheReadTokens || 0)) + (r.cacheHitPct != null ? ' (' + esc(r.cacheHitPct) + '%)' : '') + (cwTok > 0 ? ' · 写 ' + esc(fmtTok(cwTok)) : '') + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Output' : '输出拆分') + '</span><b>' + esc(fmtTok(outTok)) + (thinkTok > 0 ? ' (' + esc(isEn ? 'think ' : '思考 ') + esc(fmtTok(thinkTok)) + ' / ' + esc(fmtTok(respTok)) + ')' : '') + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Total / Cost' : '总 Token / 费用') + '</span><b>' + esc(fmtTok(totTok)) + ' · $' + esc(Number(r.costUsd || 0).toFixed(4)) + (r.cacheSavedUsd > 0 ? ' (省 $' + esc(Number(r.cacheSavedUsd).toFixed(3)) + ')' : '') + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Timing' : '耗时详情') + '</span><b>TTFT ' + esc(fmtDurMs(r.ttftMs)) + ' · ' + esc(isEn ? 'Stream ' : '流式 ') + esc(fmtDurMs(r.streamMs)) + ' · ' + esc(isEn ? 'Total ' : '总计 ') + esc(fmtDurMs(r.totDurMs || r.durationMs)) + '</b></div>' +
        '<div class="ag-req-dkv"><span>' + esc(isEn ? 'Speed / Ctx' : '速度 / 窗口') + '</span><b>' + esc(r.tps > 0 ? r.tps + ' t/s' : '—') + (r.maxCtx > 0 ? ' · ' + esc(fmtTok(r.maxCtx)) : '') + '</b></div>' +
        '</div>' +
        diagHtml +
        '</div></td></tr>'
      );
    };
    const renderReqRowHtml = (r) => {
      const isSel = ui.selectedReqId === r.id;
      const isErr = r.status === 'error';
      const hasIssue = isErr || Boolean(r.cacheAnomaly);
      const statusTitle = isErr ? (isEn ? 'Error' : '错误') : r.cacheAnomaly ? (isEn ? 'Cache Drop' : '缓存骤降') : (isEn ? 'OK' : '成功');
      const hitStr = r.cacheHitPct != null ? r.cacheHitPct + '%' : '—';
      const hitHtml = r.cacheAnomaly
        ? '<span class="ag-req-drop-val">' + esc(hitStr) + ' ↓</span>'
        : esc(hitStr);
      const speedHtml = r.tps > 0
        ? esc(r.tps + 't/s')
        : isErr
        ? '<span class="ag-req-drop-val">' + esc(isEn ? '✕ Err' : '✕ 失败') + '</span>'
        : '—';
      const rowHtml =
        '<tr class="ag-req-row' + (isSel ? ' is-expanded' : '') + '" data-req-id="' + esc(r.id) + '" tabindex="0">' +
        '<td><span class="ag-req-time" title="' + esc(statusTitle) + '"><span class="ag-req-dot ' + (hasIssue ? 'is-err' : 'is-ok') + '"></span>' + esc(fmtTime(r.ts)) + '</span></td>' +
        '<td class="ag-req-model">' + esc(r.model) + '</td>' +
        '<td>' + speedHtml + '</td>' +
        '<td>' + esc(fmtTok(r.inputTokens)) + '</td>' +
        '<td>' + esc(fmtTok(r.cacheReadTokens)) + '</td>' +
        '<td>' + hitHtml + '</td>' +
        '<td>' + esc(fmtTok(r.outputTokens)) + '</td>' +
        '<td>$' + esc(Number(r.costUsd || 0).toFixed(2)) + '</td>' +
        '</tr>';
      return isSel ? rowHtml + renderDetailRow(r) : rowHtml;
    };
    lastReqHelpers = { renderReqRowHtml, isEn };

    const totalCount = Number(ana?.totalRequestsCount || allReqs.length);
    const countLabel =
      ui.reqStatus === 'all' && totalCount > allReqs.length
        ? (isEn ? `${allReqs.length} / ${totalCount}` : `最近 ${allReqs.length} / 共 ${totalCount} 条`)
        : (isEn ? `${filtered.length} items` : `共 ${filtered.length} 条`);
    const pageSize = Math.max(60, Number(ui.reqPageSize) || 80);
    const shown = filtered.slice(0, pageSize);
    const sentinelTxt =
      filtered.length > shown.length
        ? (isEn ? `Scroll to load more (${shown.length} / ${filtered.length})` : `下滑自动加载更多（已显示 ${shown.length} / ${filtered.length}）`)
        : filtered.length > 0
        ? (isEn ? `All ${filtered.length} items loaded` : `已加载全部 ${filtered.length} 条`)
        : '';
    const sentinelHtml = sentinelTxt ? '<div class="ag-req-sentinel" data-req-sentinel="1">' + esc(sentinelTxt) + '</div>' : '';

    return (
      '<div class="ag-s-card"><div class="ag-s-row">' +
      '<div class="ag-s-section-head">' +
      '<div class="ag-s-seg">' +
      [
        ['all', isEn ? 'All' : '全部'],
        ['success', isEn ? 'OK' : '成功'],
        ['error', isEn ? 'Error' : '错误'],
        ['drop', (isEn ? 'Cache Drop' : '缓存骤降') + (dropCount > 0 ? ' ' + dropCount : '')]
      ]
        .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-req-status="' + k + '" aria-pressed="' + (ui.reqStatus === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
        .join('') +
      '</div>' +
      '<span class="ag-req-count">' + esc(countLabel) + '</span>' +
      '</div>' +
      '<div style="overflow-x:auto"><table class="ag-ana-table ag-req-table"><thead><tr>' +
      '<th>时间</th><th>模型</th><th>速度</th><th>输入</th><th>缓存</th><th>命中</th><th>输出</th><th>费用</th>' +
      '</tr></thead><tbody data-req-tbody="1">' +
      (shown.map(renderReqRowHtml).join('') || '<tr><td colspan="8" style="text-align:center">—</td></tr>') +
      '</tbody></table></div>' +
      sentinelHtml +
      '</div></div>'
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Settings Modal Pane (#ag-accounts-pane) — Pure Account Management
  //    (No Heatmap, No Alias Input, Strict Grid Alignment)
  // ---------------------------------------------------------------------------
  function renderAccountsTab(s) {
    const ov = ui.overview;
    const masked = Boolean(ov?.privacyMask);
    const showClaude = isShowClaudeQuotaEnabled();
    const as = ov?.autoSwitch || { enabled: false, pool: 'gemini', window: 'fiveHour', thresholdPct: 5, autoRelaunch: true };
    const rawAccounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
    const allAccounts = rawAccounts.slice().sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));
    const busy = Boolean(ui.busyAction);

    const pendingSwitchBanner = ov?.pendingSwitch
      ? '<div class="ag-s-card" style="padding:10px 14px;font-size:12px;color:var(--ag-s-warn);border-color:rgba(217,119,6,0.35)">已切换本地凭据至 ' +
        esc(maskEmail(ov.pendingSwitch.targetEmail, masked)) +
        '，等待客户端重启生效。</div>'
      : '';

    const planOf = (a) => {
      const p = String(a?.planName || '').toLowerCase();
      if (p.includes('ultra')) return 'ultra';
      if (p.includes('plus')) return 'plus';
      if (p.includes('pro')) return 'pro';
      return 'free';
    };

    const renderAccMeterRow = (lbl, win) => {
      if (!win) return '';
      const pct = typeof win.remainingPct === 'number' ? Math.max(0, Math.min(100, win.remainingPct)) : null;
      const tone = pct === null ? '' : pct <= 20 ? 'crit' : pct <= 50 ? 'warn' : 'ok';
      const resetStr = pct !== null && pct < 100 && win.resetInSec > 0 ? fmtReset(win.resetInSec) : '';
      return (
        '<div class="ag-acc-meter-row">' +
        '<span class="ag-acc-meter-lbl">' + esc(lbl) + '</span>' +
        '<span class="ag-acc-meter-track"><i data-tone="' + tone + '" style="width:' + (pct ?? 0) + '%"></i></span>' +
        '<span class="ag-acc-meter-pct">' + (pct === null ? '—' : pct + '%') + '</span>' +
        '<span class="ag-acc-meter-reset">' + esc(resetStr) + '</span>' +
        '</div>'
      );
    };

    const planCounts = {
      all: allAccounts.length,
      ultra: allAccounts.filter((a) => planOf(a) === 'ultra').length,
      pro: allAccounts.filter((a) => planOf(a) === 'pro').length,
      free: allAccounts.filter((a) => planOf(a) === 'free').length
    };
    const searchQ = String(ui.acctSearchQuery || '').trim().toLowerCase();
    const accounts = allAccounts.filter((a) => {
      if (allAccounts.length > 5 && ui.acctPlanFilter !== 'all' && planOf(a) !== ui.acctPlanFilter) return false;
      if (searchQ && !String(a.email || '').toLowerCase().includes(searchQ) && !String(a.alias || '').toLowerCase().includes(searchQ)) {
        return false;
      }
      return true;
    });

    const pendingHintHtml = ov?.pendingNativeLogin
      ? '<div class="ag-s-card" style="padding:10px 14px;font-size:12px;color:var(--ag-s-warn);border-color:rgba(217,119,6,0.35)">' + esc(s.pendingNativeHint) + '</div>'
      : '';

    const filterRowHtml = allAccounts.length > 5
      ? '<div class="ag-acc-filter-row">' +
        '<input type="search" class="ag-acc-search-input" value="' + esc(ui.acctSearchQuery || '') + '" placeholder="' + esc(getLoc() === 'en' ? 'Search account…' : '搜索账号…') + '" />' +
        '<div class="ag-s-seg">' +
        [['all', '全部 ' + planCounts.all], ['ultra', 'Ultra ' + planCounts.ultra], ['pro', 'Pro ' + planCounts.pro], ['free', 'Free ' + planCounts.free]]
          .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-acct-plan="' + k + '" aria-pressed="' + (ui.acctPlanFilter === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
          .join('') +
        '</div></div>'
      : '';

    const cardsHtml = accounts.length
      ? accounts
          .map((a) => {
            const visibleGroups = filterVisibleQuotaGroups(a.lastQuota?.groups);
            const qHtml = visibleGroups.length
              ? '<div class="ag-acc-quotas' + (visibleGroups.length === 1 ? ' is-single' : '') + '">' +
                visibleGroups
                  .slice(0, 2)
                  .map(
                    (g) =>
                      '<div class="ag-acc-qgroup">' +
                      '<div class="ag-acc-qgtitle">' + esc(g.label || g.key) + '</div>' +
                      renderAccMeterRow(s.win5h, g.fiveHour) +
                      renderAccMeterRow(s.win7d, g.weekly) +
                      '</div>'
                  )
                  .join('') +
                '</div>'
              : '';

            const slot1Html = !a.isActive
              ? '<button type="button" class="ag-s-hdr-link is-primary" data-acc-act="switch" data-acc-id="' + esc(a.id) + '"' + (busy ? ' disabled' : '') + '>' + esc(s.switchBtn) + '</button>'
              : '<span class="ag-acc-slot-active">' + esc(s.activeBadge) + '</span>';

            return (
              '<div class="ag-s-row">' +
              '<div class="ag-acc-head-row">' +
              '<div class="ag-acc-ident">' +
              '<span class="ag-acc-dot' + (a.isActive ? ' is-active' : '') + '"></span>' +
              '<span class="ag-acc-email">' + esc(maskEmail(a.email, masked)) + '</span>' +
              (a.planName ? '<span class="ag-acc-pill">' + esc(a.planName) + '</span>' : '') +
              '</div>' +
              '<div class="ag-acc-actions-grid">' +
              slot1Html +
              '<button type="button" class="ag-s-hdr-link" data-acc-act="refresh_one" data-acc-id="' + esc(a.id) + '"' + (busy ? ' disabled' : '') + '>' + esc(s.refreshBtn) + '</button>' +
              '<button type="button" class="ag-s-hdr-link is-danger" data-acc-act="remove" data-acc-id="' + esc(a.id) + '">' + esc(s.removeBtn) + '</button>' +
              '</div>' +
              '</div>' +
              (a.quotaError ? '<div class="ag-s-row-desc" style="margin-top:4px;color:var(--ag-s-warn) !important">' + esc(a.quotaError) + '</div>' : '') +
              qHtml +
              '</div>'
            );
          })
          .join('')
      : !ov && ui.loadingAccounts
      ? '<div class="ag-s-row"><div class="ag-s-row-desc">' + esc(getLoc() === 'en' ? 'Loading…' : '正在读取…') + '</div></div>'
      : '<div class="ag-s-row"><div class="ag-s-row-desc">' + esc(s.noAccounts) + '</div></div>';

    return (
      '<div class="ag-s-sections">' +
      pendingSwitchBanner +
      pendingHintHtml +
      '<div>' +
      '<div class="ag-s-section-head"><span class="ag-s-section-title">' + esc(s.tabAccounts) + '</span>' +
      '<div class="ag-s-hdr-links">' +
      '<button type="button" class="ag-s-hdr-link is-primary" data-acc-act="capture"' + (busy ? ' disabled' : '') + '>' + esc(s.captureBtn) + '</button>' +
      '<button type="button" class="ag-s-hdr-link" data-acc-act="oauth_add"' + (busy ? ' disabled' : '') + '>' + esc(s.oauthBtn) + '</button>' +
      '<button type="button" class="ag-s-hdr-link" data-acc-act="native_add"' + (busy ? ' disabled' : '') + '>' + esc(s.nativeAddBtn) + '</button>' +
      '<button type="button" class="ag-s-hdr-link" data-acc-act="refresh_all"' + (busy ? ' disabled' : '') + '>' + esc(s.refreshAllBtn) + '</button>' +
      '</div></div>' +
      filterRowHtml +
      '<div class="ag-s-card">' + cardsHtml + '</div>' +
      '</div>' +
      '<div>' +
      '<div class="ag-s-section-head"><span class="ag-s-section-title">' + esc(s.autoSwitch) + '</span></div>' +
      '<div class="ag-s-card">' +
      '<div class="ag-s-row"><div class="ag-s-row-main"><span class="ag-s-row-label">' + esc(s.autoSwitch) + '</span><input type="checkbox" class="ag-s-switch" data-as-field="enabled"' + (as.enabled ? ' checked' : '') + ' /></div></div>' +
      (as.enabled
        ? '<div class="ag-s-row"><div class="ag-s-row-main"><span class="ag-s-row-label">' + esc(s.pool) + ' / ' + esc(s.window) + ' / ' + esc(s.threshold) + '</span>' +
          '<div class="ag-s-hdr-links">' +
          '<select class="ag-s-select" data-as-field="pool"><option value="gemini"' + (as.pool === 'gemini' ? ' selected' : '') + '>Gemini</option><option value="claude-gpt"' + (as.pool === 'claude-gpt' ? ' selected' : '') + '>Claude / GPT</option></select>' +
          '<select class="ag-s-select" data-as-field="window"><option value="fiveHour"' + (as.window === 'fiveHour' ? ' selected' : '') + '>' + esc(s.win5h) + '</option><option value="weekly"' + (as.window === 'weekly' ? ' selected' : '') + '>' + esc(s.win7d) + '</option></select>' +
          '<input type="number" class="ag-s-input" style="width:56px" min="0" max="50" value="' + esc(as.thresholdPct ?? 5) + '" data-as-field="thresholdPct" />%' +
          '</div></div></div>'
        : '') +
      '<div class="ag-s-row"><div class="ag-s-row-main"><span class="ag-s-row-label">' + esc(s.autoRelaunch) + '</span><input type="checkbox" class="ag-s-switch" data-as-field="autoRelaunch"' + (as.autoRelaunch !== false ? ' checked' : '') + ' /></div></div>' +
      '<div class="ag-s-row"><div class="ag-s-row-main"><span class="ag-s-row-label">' + esc(s.showClaudeLbl) + '</span><input type="checkbox" class="ag-s-switch" data-acc-show-claude="1"' + (showClaude ? ' checked' : '') + ' /></div></div>' +
      '<div class="ag-s-row"><div class="ag-s-row-main"><span class="ag-s-row-label">' + esc(s.privacyMask) + '</span><input type="checkbox" class="ag-s-switch" data-acc-privacy="1"' + (masked ? ' checked' : '') + ' /></div></div>' +
      '</div></div></div>'
    );
  }

  function computePaneSig() {
    const ov = ui.overview;
    return JSON.stringify([
      getLoc(),
      ui.busyAction,
      ui.loadingAccounts,
      isShowClaudeQuotaEnabled(),
      ui.banner?.text || '',
      ui.banner?.error || false,
      ov?.activeId || '',
      ov?.pendingNativeLogin || false,
      ov?.privacyMask || false,
      JSON.stringify(ov?.autoSwitch || {}),
      (ov?.accounts || []).map((a) => `${a.id}:${a.disabled}:${a.credHash}:${a.updatedAt}:${a.quotaError || ''}`).join(',')
    ]);
  }

  function renderPane(force = false) {
    const s = getStr();
    const pane = document.getElementById('ag-accounts-pane');
    if (!pane || !accountsTabActive) return;

    const sig = computePaneSig();
    if (!force && sig === lastPaneSig && pane.innerHTML !== '') return;
    lastPaneSig = sig;

    const bannerHtml = ui.banner
      ? '<div class="ag-s-card" style="padding:9px 14px;font-size:12px;margin-bottom:14px;color:' +
        (ui.banner.error ? 'var(--ag-s-err)' : 'var(--ag-s-ok)') + '">' + esc(ui.banner.text) + '</div>'
      : '';

    pane.innerHTML = bannerHtml + renderAccountsTab(s);
  }

  // ---------------------------------------------------------------------------
  // 3. Top-Right Session Usage Trigger & Floating Popover
  // ---------------------------------------------------------------------------
  function cleanupLegacyAuxArtifacts() {
    try {
      document.getElementById('ag-usage-aux-resizer')?.remove();
      document.querySelectorAll('[data-ag-aux-host-hidden="true"]').forEach((node) => {
        const orig = node.getAttribute?.('data-ag-aux-orig-display');
        if (node.style) node.style.display = orig || '';
        node.removeAttribute?.('data-ag-aux-orig-display');
        node.removeAttribute?.('data-ag-aux-host-hidden');
      });
      document.querySelectorAll('[data-side-panel-focus-scope="true"], [data-aux-pane-focus-scope="true"]').forEach((el) => {
        if (el.style && el.style.width && el.style.flexBasis) {
          el.style.width = '';
          el.style.minWidth = '';
          el.style.flexBasis = '';
        }
      });
    } catch {}
  }

  function ensurePopoverMount(pop) {
    if (!pop) return;
    if (!pop.classList.contains('browser-hole-opaque')) {
      pop.classList.add('browser-hole-opaque');
    }
    if (pop.parentElement !== document.body && document.body) {
      document.body.appendChild(pop);
    }
    pop.removeAttribute('data-dock');
    pop.removeAttribute('data-aux-view');
    pop.style.width = '';
    const resizer = document.getElementById('ag-usage-aux-resizer');
    if (resizer) resizer.remove();
  }

  let topbarWarmRetryCount = 0;
  function ensureTopbarMetricsWarm() {
    if (topbarMetricsFetching || disposed) return;
    if (topbarMetricsCache && Date.now() - topbarMetricsCache.at < 25000) return;
    if (typeof window.__agUsageAnalytics !== 'function') {
      if (topbarWarmRetryCount < 6) {
        topbarWarmRetryCount++;
        setTimeout(() => ensureTopbarMetricsWarm(), 400);
      }
      return;
    }
    topbarWarmRetryCount = 0;
    topbarMetricsFetching = true;
    void callAnalytics({
      range: 'month',
      account: resolveEffectiveAccountFilter(),
      heatmapDays: 30,
      force: false
    }).then((res) => {
      topbarMetricsFetching = false;
      if (res && res.ok && res.summary) {
        topbarMetricsCache = {
          todayTokens: res.summary.todayTokens || 0,
          todayCostUsd: res.summary.todayCostUsd || 0,
          monthTokens: res.summary.monthTokens || 0,
          monthCostUsd: res.summary.monthCostUsd || 0,
          at: Date.now()
        };
        refreshTopbarBadge();
      }
    });
  }

  function getTopbarDisplayMode() {
    const prefs = window.__ag_ui_prefs && typeof window.__ag_ui_prefs === 'object' ? window.__ag_ui_prefs : null;
    let lsVal = '';
    try {
      lsVal = localStorage.getItem('ag_topbar_usage_metric') || '';
    } catch {}
    const raw = (prefs && prefs.topbarUsageMetric) || boot.userConfig?.topbarUsageMetric || boot.topbarUsageMetric || lsVal || 'quota';
    return VALID_TOPBAR_MODES.includes(raw) ? raw : 'quota';
  }

  function refreshTopbarBadge() {
    const btn = document.getElementById('ag-topbar-usage-btn');
    if (!btn) return;
    const mode = getTopbarDisplayMode();
    const pq = getLivePrimaryQuota();
    const dot = btn.querySelector('.ag-tb-dot');
    const txt = btn.querySelector('.ag-tb-txt');
    const liveStats = window.__ag_last_metrics?.stats || null;
    const isGenerating = Boolean(liveStats?.generatingPending || liveStats?.pendingRetrying);

    const pickLevelClass = (val, thresholds) => {
      for (let i = 0; i < thresholds.length; i++) {
        if (val < thresholds[i]) return 'lv-' + (i + 1);
      }
      return 'lv-' + (thresholds.length + 1);
    };

    let nextTxt = '用量';
    let showDot = true;
    let toneCls = 'lv-1';
    let hasData = true;
    let nextTitle = '用量与额度看板';

    if (mode === 'icon') {
      showDot = false;
      hasData = false;
      nextTxt = '';
    } else if (mode === 'sessionTokens') {
      const sessTok = Number(liveStats?.sessionTotalTokens || 0);
      const ctxPct = Number(liveStats?.ctxPct || 0);
      const sessCost = Number(liveStats?.sessionCostUsd || 0);
      if (liveStats && sessTok > 0) {
        nextTxt = fmtTok(sessTok);
        toneCls = pickLevelClass(sessTok, [15e6, 40e6, 90e6, 180e6, 300e6, 500e6, 800e6]);
        nextTitle = `当前会话累计 ${fmtTok(sessTok)} · 上下文 ${ctxPct}% · 费用 $${sessCost.toFixed(2)}`;
      } else {
        nextTxt = '—';
        toneCls = 'is-idle';
        hasData = false;
        nextTitle = '当前会话暂无消耗数据';
      }
    } else if (mode === 'todayTokens' || mode === 'monthTokens' || mode === 'monthCost') {
      const sum = topbarMetricsCache || ui.analytics?.summary || null;
      if (!sum) ensureTopbarMetricsWarm();
      if (!sum) {
        nextTxt = '—';
        toneCls = 'is-idle';
        hasData = false;
      } else if (mode === 'todayTokens') {
        const v = Number(sum.todayTokens || 0);
        nextTxt = fmtTok(v);
        toneCls = pickLevelClass(v, [30e6, 80e6, 160e6, 300e6, 500e6, 800e6, 1.2e9]);
        nextTitle = `今日 Token 消耗: ${fmtTok(v)}`;
      } else if (mode === 'monthTokens') {
        const v = Number(sum.monthTokens || 0);
        nextTxt = fmtTok(v);
        toneCls = pickLevelClass(v, [150e6, 400e6, 800e6, 1.5e9, 2.5e9, 4.0e9, 6.0e9]);
        nextTitle = `本月 Token 消耗: ${fmtTok(v)}`;
      } else {
        const v = Number(sum.monthCostUsd || 0);
        nextTxt = '$' + v.toFixed(1);
        toneCls = pickLevelClass(v, [20, 60, 120, 220, 380, 600, 1000]);
        nextTitle = `本月 API 参考费用: $${v.toFixed(2)}`;
      }
    } else {
      nextTxt = pq && typeof pq.pct === 'number' ? pq.pct + '%' : '用量';
      if (pq && typeof pq.pct === 'number') {
        const rem = pq.pct;
        toneCls = rem >= 85 ? 'lv-1' : rem >= 70 ? 'lv-2' : rem >= 55 ? 'lv-3' : rem >= 40 ? 'lv-4' : rem >= 25 ? 'lv-5' : rem >= 12 ? 'lv-6' : 'lv-7';
        nextTitle = `${pq.label} 5h: ${pq.pct}%`;
      } else {
        toneCls = 'is-idle';
        hasData = false;
        nextTitle = '用量与额度看板';
      }
    }

    const pulse = showDot && hasData;
    const nextDot = ['ag-tb-dot', toneCls, pulse ? 'is-pulse' : '', pulse && isGenerating ? 'is-live' : ''].filter(Boolean).join(' ');
    const nextTxtCls = ['ag-tb-txt', toneCls].filter(Boolean).join(' ');

    if (txt) {
      if (txt.textContent !== nextTxt) txt.textContent = nextTxt;
      if (txt.className !== nextTxtCls) txt.className = nextTxtCls;
      txt.hidden = !nextTxt;
    }
    if (dot) {
      dot.hidden = !showDot;
      if (dot.className !== nextDot) dot.className = nextDot;
    }
    if (btn.title !== nextTitle) btn.title = nextTitle;
  }
  window.__ag_refresh_topbar_usage = () => {
    refreshTopbarBadge();
    if (ui.popoverOpen) renderUsagePopover();
  };
  window.__ag_set_demo_mode = function setDemoMode(demoCfg) {
    if (demoCfg && typeof demoCfg === 'object') {
      window.__ag_demo_mode = demoCfg;
      if (demoCfg.overview) ui.overview = demoCfg.overview;
      if (demoCfg.analytics) ui.analytics = demoCfg.analytics;
      if (demoCfg.popMainTab) ui.popMainTab = demoCfg.popMainTab;
      if (demoCfg.selectedReqId !== undefined) ui.selectedReqId = demoCfg.selectedReqId;
      refreshTopbarBadge();
      renderPane();
      if (ui.popoverOpen) renderUsagePopover();
    } else {
      window.__ag_demo_mode = null;
      ui.selectedReqId = '';
      ui.popMainTab = 'overview';
      topbarMetricsCache = null;
      void refreshOverview();
      void refreshAnalytics(false);
      refreshTopbarBadge();
    }
  };

  function positionPopover(btn, pop) {
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;

    const vw = window.innerWidth || 1280;
    const popW = Math.min(568, vw - 24);
    const top = Math.max(8, Math.round(r.bottom + 6));
    let left = Math.round(r.right - popW);

    const auxOpen = document.querySelector('[data-side-panel-open="true"], [data-aux-pane-open="true"]');
    if (auxOpen) {
      const ar = auxOpen.getBoundingClientRect();
      if (ar && ar.width > 120 && ar.left > 320 && left + popW > ar.left - 8) {
        left = Math.round(ar.left - popW - 8);
      }
    }
    left = Math.max(12, Math.min(vw - popW - 12, left));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.style.right = 'auto';
  }

  function computePopSig() {
    const ov = ui.overview;
    const ana = ui.analytics;
    return JSON.stringify([
      getLoc(),
      ui.popoverOpen,
      ui.popTrendTab,
      ui.popMainTab,
      ui.reqStatus,
      ui.selectedReqId,
      ui.acctPlanFilter,
      ui.acctQuotaWin,
      ui.range,
      ui.accountFilter,
      ui.acctMenuOpen,
      resolveEffectiveAccountFilter(),
      ui.heatDisplayMode,
      ui.heatMetric,
      ui.heatSpanDays,
      ui.selectedHeatKey,
      ui.loadingAnalytics,
      getQuotaSig(),
      ov?.activeId || '',
      ov?.activeSystemEmail || '',
      ov?.privacyMask || false,
      isShowClaudeQuotaEnabled(),
      (ov?.accounts || []).length,
      ana?.generatedAt || 0,
      ana?.summary?.totalTokens || 0
    ]);
  }

  function fitSingleLineNodes(root, selector, minPx = 8.5) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el) continue;
      el.style.fontSize = '';
      const cw = el.clientWidth;
      const sw = el.scrollWidth;
      if (cw > 0 && sw > cw + 1) {
        const curPx = parseFloat(getComputedStyle(el).fontSize) || 10.5;
        const nextPx = Math.max(minPx, Number((curPx * (cw / sw) - 0.2).toFixed(2)));
        el.style.fontSize = nextPx + 'px';
      }
    }
  }

  function renderUsagePopover(force = false) {
    const pop = document.getElementById('ag-usage-popover');
    if (!pop) return;
    if (!ui.popoverOpen) {
      lastPopSig = '';
      pop.removeAttribute('data-visible');
      ensurePopoverMount(pop);
      return;
    }

    ensurePopoverMount(pop);

    const sig = computePopSig();
    if (!force && sig === lastPopSig && pop.innerHTML !== '') {
      positionPopover(document.getElementById('ag-topbar-usage-btn'), pop);
      return;
    }
    lastPopSig = sig;

    const s = getStr();
    const iconRefresh = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.67M13.5 2.5v2.8h-2.8"/></svg>';
    const iconAccounts = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.2" cy="5.2" r="2.4"/><path d="M1.8 13.5c.4-2.2 2.2-3.5 4.4-3.5s4 1.3 4.4 3.5"/><path d="M11.8 4.2a2 2 0 0 1 0 3.8M13.5 13.2c.3-1.4-.5-2.6-1.8-3.1"/></svg>';

    const mainNavHtml =
      '<div class="ag-s-seg ag-pop-main-nav">' +
      [
        ['overview', getLoc() === 'en' ? 'Overview' : '概览'],
        ['requests', getLoc() === 'en' ? 'Requests' : '请求明细']
      ]
        .map(([k, lbl]) => '<button type="button" class="ag-s-seg-btn" data-pop-main-tab="' + k + '" aria-pressed="' + ((ui.popMainTab === 'requests' ? 'requests' : 'overview') === k ? 'true' : 'false') + '">' + esc(lbl) + '</button>')
        .join('') +
      '</div>';

    // Close button intentionally removed per user preference (click outside / Esc / topbar toggle closes popover)
    const hdrHtml =
      '<div class="ag-up-hdr">' +
      '<div style="display:inline-flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">' +
      '<span class="ag-up-title">' + esc(s.popTitle) + '</span>' +
      mainNavHtml +
      '</div>' +
      '<div class="ag-up-actions">' +
      '<button type="button" class="ag-up-icon-btn" data-pop-refresh="1" title="' + esc(s.refreshBtn) + '">' + iconRefresh + '</button>' +
      '<button type="button" class="ag-up-icon-btn" data-pop-accounts="1" title="' + esc(s.manageAccounts) + '">' + iconAccounts + '</button>' +
      '</div></div>';

    const prevBodyScrollTop = pop.querySelector('.ag-up-body')?.scrollTop || 0;
    const innerHtml =
      ui.popMainTab === 'requests'
        ? renderRequestsTabBody(s, ui.analytics)
        : renderUnifiedDashboardBody(s, ui.analytics);
    pop.innerHTML = hdrHtml + '<div class="ag-up-body"><div class="ag-up-inner">' + innerHtml + '</div></div>';
    const nextBody = pop.querySelector('.ag-up-body');
    if (nextBody) {
      if (prevBodyScrollTop > 0) nextBody.scrollTop = prevBodyScrollTop;
      if (nextBody.dataset.reqScrollBound !== '1') {
        nextBody.dataset.reqScrollBound = '1';
        nextBody.addEventListener('scroll', () => {
          if (ui.popMainTab !== 'requests' || !lastReqHelpers) return;
          if (nextBody.scrollTop + nextBody.clientHeight < nextBody.scrollHeight - 160) return;
          if (ui.reqPageSize >= lastFilteredReqs.length) return;
          const nextBatch = lastFilteredReqs.slice(ui.reqPageSize, ui.reqPageSize + 80);
          if (!nextBatch.length) return;
          ui.reqPageSize += nextBatch.length;
          const tbody = nextBody.querySelector('tbody[data-req-tbody="1"]');
          if (tbody) {
            tbody.insertAdjacentHTML('beforeend', nextBatch.map(lastReqHelpers.renderReqRowHtml).join(''));
          }
          const sentinel = nextBody.querySelector('[data-req-sentinel="1"]');
          if (sentinel) {
            const total = lastFilteredReqs.length;
            const shownLen = Math.min(ui.reqPageSize, total);
            sentinel.textContent =
              total > shownLen
                ? lastReqHelpers.isEn
                  ? `Scroll to load more (${shownLen} / ${total})`
                  : `下滑自动加载更多（已显示 ${shownLen} / ${total}）`
                : lastReqHelpers.isEn
                ? `All ${total} items loaded`
                : `已加载全部 ${total} 条`;
          }
        });
      }
    }

    pop.setAttribute('data-visible', '1');
    positionPopover(document.getElementById('ag-topbar-usage-btn'), pop);
    fitSingleLineNodes(pop, '.ag-pt-kpi-sub', 8.5);
  }

  function setPopoverOpen(forceOpen) {
    const next = typeof forceOpen === 'boolean' ? forceOpen : !ui.popoverOpen;
    ui.popoverOpen = next;
    if (!next) ui.acctMenuOpen = false;
    if (popAutoRefreshTimer) {
      clearInterval(popAutoRefreshTimer);
      popAutoRefreshTimer = null;
    }
    const btn = document.getElementById('ag-topbar-usage-btn');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    renderUsagePopover(true);
    if (next) {
      if (!ui.overview) {
        void callAccounts('get_overview').then((res) => {
          if (res?.ok) {
            ui.overview = res;
            void refreshAnalytics(false, { silent: Boolean(ui.analytics) });
          }
        });
      }
      void refreshAnalytics(false, { silent: Boolean(ui.analytics) });
      popAutoRefreshTimer = setInterval(() => {
        if (!ui.popoverOpen || disposed) {
          clearInterval(popAutoRefreshTimer);
          popAutoRefreshTimer = null;
          return;
        }
        void refreshAnalytics(false, { silent: true });
      }, 5000);
    }
  }
  window.__ag_toggle_usage_popover = setPopoverOpen;

  function ensureTopbarWidget() {
    if (disposed) return;
    const anchorBtn =
      document.querySelector('button[data-testid="titlebar-more-actions"]') ||
      document.querySelector('button[data-testid="toggle-overview-panel"]');
    const container = anchorBtn ? anchorBtn.parentElement : null;
    if (anchorBtn && container) {
      let btn = document.getElementById('ag-topbar-usage-btn');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'ag-topbar-usage-btn';
        btn.type = 'button';
        btn.setAttribute('data-testid', 'ag-topbar-usage-btn');
        btn.setAttribute('aria-expanded', ui.popoverOpen ? 'true' : 'false');
        btn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
          '<rect x="2" y="2" width="5" height="5" rx="1.2" opacity="0.45"></rect>' +
          '<rect x="9" y="2" width="5" height="5" rx="1.2" opacity="0.9"></rect>' +
          '<rect x="2" y="9" width="5" height="5" rx="1.2" opacity="0.7"></rect>' +
          '<rect x="9" y="9" width="5" height="5" rx="1.2" opacity="1"></rect>' +
          '</svg>' +
          '<span class="ag-tb-dot"></span>' +
          '<span class="ag-tb-txt">用量</span>';
      }
      if (btn.parentElement !== container || btn.nextElementSibling !== anchorBtn) {
        container.insertBefore(btn, anchorBtn);
      }
      if (btn !== boundTopbarBtn) {
        boundTopbarBtn = btn;
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setPopoverOpen();
        });
      }
      refreshTopbarBadge();
    }

    let pop = document.getElementById('ag-usage-popover');
    if (!pop && document.body) {
      pop = document.createElement('div');
      pop.id = 'ag-usage-popover';
      pop.className = 'browser-hole-opaque';
      document.body.appendChild(pop);
    }
    if (pop && pop !== boundPopover) {
      boundPopover = pop;
      pop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const popMainTabBtn = ev.target?.closest?.('[data-pop-main-tab]');
        if (popMainTabBtn) {
          ui.acctMenuOpen = false;
          const nextTab = popMainTabBtn.getAttribute('data-pop-main-tab');
          ui.popMainTab = nextTab === 'requests' ? 'requests' : 'overview';
          renderUsagePopover();
          return;
        }
        const reqStBtn = ev.target?.closest?.('[data-req-status]');
        if (reqStBtn) {
          ui.reqStatus = reqStBtn.getAttribute('data-req-status') || 'all';
          ui.reqPageSize = 80;
          ui.selectedReqId = '';
          renderUsagePopover();
          return;
        }
        const reqRow = ev.target?.closest?.('[data-req-id]');
        if (reqRow) {
          const rid = reqRow.getAttribute('data-req-id') || '';
          ui.selectedReqId = ui.selectedReqId === rid ? '' : rid;
          renderUsagePopover();
          return;
        }
        const acctTrig = ev.target?.closest?.('[data-acct-trigger]');
        if (acctTrig) {
          ui.acctMenuOpen = !ui.acctMenuOpen;
          renderUsagePopover();
          return;
        }
        const acctOpt = ev.target?.closest?.('[data-acct-opt]');
        if (acctOpt) {
          ui.accountFilter = acctOpt.getAttribute('data-acct-opt') || '__current__';
          ui.reqPageSize = 100;
          ui.acctMenuOpen = false;
          ui.selectedHeatKey = '';
          void refreshAnalytics(false);
          return;
        }
        if (ui.acctMenuOpen && !ev.target?.closest?.('.ag-acct-picker')) {
          ui.acctMenuOpen = false;
          renderUsagePopover();
        }
        if (ev.target?.closest?.('[data-pop-accounts]')) {
          ui.acctMenuOpen = false;
          setPopoverOpen(false);
          openAccountsInSettings();
          return;
        }
        const rangeBtn = ev.target?.closest?.('[data-ana-range]');
        if (rangeBtn) {
          ui.range = rangeBtn.getAttribute('data-ana-range') || 'month';
          ui.reqPageSize = 100;
          saveUsagePopPrefs();
          void refreshAnalytics(false);
          return;
        }
        const hsBtn = ev.target?.closest?.('[data-heat-span]');
        if (hsBtn) {
          ui.heatSpanDays = Number(hsBtn.getAttribute('data-heat-span')) || 182;
          ui.selectedHeatKey = '';
          renderUsagePopover();
          return;
        }
        const hModeBtn = ev.target?.closest?.('[data-heat-mode]');
        if (hModeBtn) {
          ui.heatDisplayMode = hModeBtn.getAttribute('data-heat-mode') || 'daily';
          ui.selectedHeatKey = '';
          saveUsagePopPrefs();
          renderUsagePopover();
          return;
        }
        const hmBtn = ev.target?.closest?.('[data-heat-metric]');
        if (hmBtn) {
          ui.heatMetric = hmBtn.getAttribute('data-heat-metric') || 'tokens';
          saveUsagePopPrefs();
          renderUsagePopover();
          return;
        }
        const ptBtn = ev.target?.closest?.('[data-pop-tab]');
        if (ptBtn) {
          const nextPt = ptBtn.getAttribute('data-pop-tab');
          ui.popTrendTab = nextPt === 'accounts' ? 'accounts' : 'models';
          renderUsagePopover();
          return;
        }
        const cellBtn = ev.target?.closest?.('[data-heat-date]');
        if (cellBtn) {
          const dt = cellBtn.getAttribute('data-heat-date') || '';
          ui.selectedHeatKey = ui.selectedHeatKey === dt ? '' : dt;
          renderUsagePopover();
          return;
        }
        if (ev.target?.closest?.('[data-pop-refresh]')) {
          void refreshAnalytics(true);
          void callAccounts('refresh_quota', { accountId: 'all' }).then((res) => {
            if (res?.overview) {
              ui.overview = res.overview;
              renderUsagePopover();
            }
          });
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Settings Modal Synchronization & Account Actions
  // ---------------------------------------------------------------------------
  function triggerAutoQuotaRefresh(minIntervalMs = 45000) {
    void callAccounts('refresh_quota', { accountId: 'active', minIntervalMs }).then((res) => {
      if (res?.ok && res.overview) {
        ui.overview = res.overview;
        renderPane();
        if (ui.popoverOpen) renderUsagePopover();
      }
    });
  }

  function mountAccountsPane(force = false) {
    const pane = document.getElementById('ag-accounts-pane');
    if (!pane) return false;
    if (pane !== boundPane) {
      boundPane = pane;
      bindPaneEvents(pane);
    }
    if (accountsTabActive) {
      renderPane(force || pane.innerHTML === '');
    }
    return true;
  }

  function onAccountsTabActive(active, opts = {}) {
    accountsTabActive = Boolean(active);
    window.__ag_accounts_tab_open = accountsTabActive;
    if (acctAutoRefreshTimer) {
      clearInterval(acctAutoRefreshTimer);
      acctAutoRefreshTimer = null;
    }
    if (accountsTabActive) {
      mountAccountsPane(Boolean(opts.forceMount));
      void refreshOverview();
      triggerAutoQuotaRefresh(45000);
      acctAutoRefreshTimer = setInterval(() => {
        if (!accountsTabActive || disposed) {
          clearInterval(acctAutoRefreshTimer);
          acctAutoRefreshTimer = null;
          return;
        }
        triggerAutoQuotaRefresh(45000);
      }, 45000);
    }
  }
  window.__ag_on_accounts_tab_active = onAccountsTabActive;

  function openAccountsInSettings() {
    if (typeof window.__ag_open_settings_tab === 'function') {
      window.__ag_open_settings_tab('accounts');
      return;
    }
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (settingsBtn) settingsBtn.click();
    setTimeout(() => onAccountsTabActive(true, { forceMount: true }), 180);
  }

  function setAccountsOpen(open) {
    if (open) {
      openAccountsInSettings();
    } else {
      onAccountsTabActive(false);
    }
  }
  window.__ag_set_accounts_open = setAccountsOpen;

  function bindPaneEvents(pane) {
    pane.addEventListener('click', async (ev) => {
      const planBtn = ev.target?.closest?.('[data-acct-plan]');
      if (planBtn) {
        ui.acctPlanFilter = planBtn.getAttribute('data-acct-plan') || 'all';
        renderPane(true);
        return;
      }
      const winBtn = ev.target?.closest?.('[data-acct-win]');
      if (winBtn) {
        ui.acctQuotaWin = winBtn.getAttribute('data-acct-win') === 'weekly' ? 'weekly' : '5h';
        renderPane(true);
        return;
      }
      const actBtn = ev.target?.closest?.('[data-acc-act]');
      if (!actBtn || ui.busyAction) return;
      const act = actBtn.getAttribute('data-acc-act');
      const id = actBtn.getAttribute('data-acc-id') || '';

      const s = getStr();
      ui.busyAction = act;
      ui.banner =
        act === 'capture'
          ? { error: false, text: s.busyCapture }
          : act === 'oauth_add'
          ? { error: false, text: s.busyOauth }
          : act === 'native_add'
          ? { error: false, text: s.busyNativeAdd }
          : act === 'refresh_all' || act === 'refresh_one'
          ? { error: false, text: s.busyRefresh }
          : act === 'switch'
          ? { error: false, text: s.busySwitch }
          : null;
      renderPane();

      const wantRelaunch = ui.overview?.autoSwitch?.autoRelaunch !== false;
      let res = null;
      if (act === 'capture') res = await callAccounts('capture_current');
      else if (act === 'oauth_add') res = await callAccounts('start_oauth_add');
      else if (act === 'native_add') res = await callAccounts('prepare_native_add', { relaunch: wantRelaunch });
      else if (act === 'refresh_all') res = await callAccounts('refresh_quota', { accountId: 'all' });
      else if (act === 'refresh_one') res = await callAccounts('refresh_quota', { accountId: id });
      else if (act === 'switch') res = await callAccounts('switch_account', { accountId: id, relaunch: wantRelaunch });
      else if (act === 'remove') {
        res = await callAccounts('remove_account', { accountId: id });
      }

      ui.busyAction = '';
      if (res && res.ok) {
        if (res.overview) ui.overview = res.overview;
        if ((act === 'capture' || act === 'oauth_add') && res.account?.email) {
          ui.banner = { error: false, text: `${s.okCaptured}: ${maskEmail(res.account.email, Boolean(ui.overview?.privacyMask))}` };
        } else if (act === 'switch') {
          if (!wantRelaunch) {
            ui.banner = { error: false, text: '已切换目标账号凭据，请手动重启 Antigravity 使新账号生效。' };
          } else if (res.manualRestartRequired) {
            ui.banner = { error: true, text: '已切好凭据，但自动重启未成功（' + (res.relaunchError || '请手动重启 Antigravity') + '），请手动重启 Antigravity 后生效。' };
          } else {
            ui.banner = { error: false, text: '已切换目标账号凭据，正在平滑重启 Antigravity 使其生效…' };
          }
        } else if (act === 'native_add') {
          ui.banner = { error: false, text: s.pendingNativeHint };
        } else {
          ui.banner = null;
        }
      } else if (res && res.error) {
        ui.banner = { error: true, text: res.error };
      } else {
        ui.banner = null;
      }
      renderPane();
      if (ui.popoverOpen) renderUsagePopover();
    });

    pane.addEventListener('input', (ev) => {
      const inp = ev.target?.closest?.('.ag-acc-search-input');
      if (!inp) return;
      const selStart = inp.selectionStart ?? inp.value.length;
      ui.acctSearchQuery = inp.value || '';
      renderPane(true);
      const nextInp = pane.querySelector('.ag-acc-search-input');
      if (nextInp) {
        try {
          nextInp.focus();
          nextInp.setSelectionRange(selStart, selStart);
        } catch {}
      }
    });

    pane.addEventListener('change', async (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.matches('[data-acc-show-claude]')) {
        const nextVal = Boolean(t.checked);
        window.__ag_ui_prefs = Object.assign({}, window.__ag_ui_prefs || {}, { showClaudeQuota: nextVal });
        if (typeof window.__agUpdateSettings === 'function') {
          try {
            window.__agUpdateSettings(JSON.stringify({ reqId: 'sc_' + Date.now(), patch: { showClaudeQuota: nextVal } }));
          } catch {}
        }
        renderPane(true);
        syncOverviewExtensions();
        if (ui.popoverOpen) renderUsagePopover(true);
        return;
      }
      if (t.matches('[data-acc-privacy]')) {
        const res = await callAccounts('set_privacy_mask', { enabled: Boolean(t.checked) });
        if (res?.overview) ui.overview = res.overview;
        renderPane();
        if (ui.popoverOpen) renderUsagePopover();
        return;
      }
      if (t.matches('[data-as-field]')) {
        const field = t.getAttribute('data-as-field');
        const val = t.type === 'checkbox' ? Boolean(t.checked) : t.type === 'number' ? Number(t.value) : t.value;
        const res = await callAccounts('update_auto_switch', { config: { [field]: val } });
        if (res?.overview) ui.overview = res.overview;
        renderPane();
      }
    });
  }

  function isProtectedRightChild(node) {
    if (!node || node.nodeType !== 1) return true;
    if (node.id === 'ag-settings-pane' || node.id === 'ag-accounts-pane' || node.tagName === 'STYLE' || node.tagName === 'BUTTON') return true;
    const tid = String(node.getAttribute?.('data-testid') || '');
    const aria = String(node.getAttribute?.('aria-label') || '');
    if (/close/i.test(tid) || /close|关闭|關閉/i.test(aria)) return true;
    return false;
  }

  function fmtClockSec(ms) {
    if (!ms || ms < 0) return '';
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtDurShort(ms) {
    if (ms == null || ms < 0) return '';
    if (ms < 1000) return `${Math.max(100, Math.round(ms / 100) * 100)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function resolveOverviewScrollMount(overviewEl) {
    if (!overviewEl) return null;
    const ch = Array.from(overviewEl.children || []);
    const scrollable = ch.find((c) => /overflow-y-auto|flex-grow/.test(String(c.className || '')));
    return scrollable || overviewEl;
  }

  function syncOverviewExtensions() {
    // Purge legacy misplaced card on overview-panel-host that clipped at bottom
    const legacy = document.getElementById('ag-overview-quota-card');
    if (legacy) legacy.remove();

    const overview = document.querySelector('[data-testid="overview-panel"]');
    const mountHost = resolveOverviewScrollMount(overview);
    let box = document.getElementById('ag-overview-sections');
    if (!mountHost || boot.modules?.metrics === false) {
      if (box) box.remove();
      return;
    }

    const prefs = window.__ag_ui_prefs && typeof window.__ag_ui_prefs === 'object' ? window.__ag_ui_prefs : {};
    const showProgress = (prefs.overviewProgress !== undefined ? prefs.overviewProgress : boot.userConfig?.overviewProgress) !== false;
    const showQuota = (prefs.overviewQuota !== undefined ? prefs.overviewQuota : boot.userConfig?.overviewQuota) !== false;
    const prog = showProgress ? (window.__ag_last_metrics?.stats?.overviewProgress || null) : null;
    const qGroups = showQuota ? filterVisibleQuotaGroups(window.__ag_quota_state?.groups) : [];

    if (!prog && qGroups.length === 0) {
      if (box) box.remove();
      return;
    }

    if (!box) {
      box = document.createElement('div');
      box.id = 'ag-overview-sections';
      box.addEventListener('click', (ev) => {
        if (ev.target?.closest?.('[data-ag-ov-toggle="progress"]')) {
          ui.ovProgressCollapsed = !ui.ovProgressCollapsed;
          syncOverviewExtensions();
          return;
        }
        if (ev.target?.closest?.('[data-ag-ov-toggle="quota"]')) {
          ui.overviewQuotaCollapsed = !ui.overviewQuotaCollapsed;
          syncOverviewExtensions();
          return;
        }
        if (ev.target?.closest?.('[data-ag-ov-open-accounts]')) {
          openAccountsInSettings();
        }
      });
      mountHost.appendChild(box);
    } else if (box.parentElement !== mountHost) {
      mountHost.appendChild(box);
    }

    const nowMs = Date.now();
    const liveGroups = qGroups.map((g) => {
      const fh = resolveLiveQuotaWin(g.fiveHour, nowMs);
      const wk = resolveLiveQuotaWin(g.weekly, nowMs);
      const fhPct = fh?.remainingPct ?? 100;
      const wkPct = wk?.remainingPct ?? 100;
      const resetSec = fhPct < 100 && fh?.resetInSec > 0 ? fh.resetInSec : (wkPct < 100 && wk?.resetInSec > 0 ? wk.resetInSec : 0);
      const resetTxt = resetSec > 0 ? `${fmtReset(resetSec)} 后重置` : '';
      return { key: g.key, label: g.label, fh, wk, fhPct, wkPct, resetTxt };
    });

    const sig = JSON.stringify([
      ui.ovProgressCollapsed,
      ui.overviewQuotaCollapsed,
      isShowClaudeQuotaEnabled(),
      prog ? [prog.conversationId, prog.status, prog.phase, prog.phaseDetail, prog.toolCount, prog.elapsedMs, (prog.recentActivity || []).map((a) => `${a.id}:${a.status}:${a.durationMs}`)] : null,
      liveGroups.map((g) => [g.key, g.fhPct, g.wkPct, g.resetTxt])
    ]);
    if (box.getAttribute('data-sig') === sig) return;
    box.setAttribute('data-sig', sig);

    let progressHtml = '';
    if (prog) {
      const isLive = prog.status === 'running';
      const phaseTone = prog.phase === 'retrying' ? 'warning' : prog.phase === 'error' ? 'critical' : isLive ? 'active' : '';
      const elapsedTxt = fmtClockSec(prog.elapsedMs);
      const headBadge = ui.ovProgressCollapsed
        ? (isLive ? '执行中' : prog.status === 'error' ? '错误' : elapsedTxt ? `已完成 ${elapsedTxt}` : '已完成')
        : (prog.toolCount > 0 ? String(prog.toolCount) : '');
      const headline =
        prog.phase === 'retrying'
          ? `正在重试${prog.retryCount > 0 ? `（第 ${prog.retryCount} 次）` : ''}`
          : prog.phase === 'error'
          ? '执行出现异常'
          : isLive && prog.phase === 'tool' && prog.phaseDetail
          ? `正在执行：${prog.phaseDetail}`
          : isLive
          ? '思考与生成中…'
          : '当前轮已完成';
      const trailHtml = (prog.recentActivity || []).length
        ? '<div class="ag-pt-trail">' +
          prog.recentActivity
            .map((a) => {
              const dur = a.status === 'running' ? '执行中' : fmtDurShort(a.durationMs);
              return (
                '<div class="ag-pt-trail-node" data-status="' + esc(a.status) + '" title="' + esc(a.detail || a.label) + '">' +
                '<span class="ag-pt-trail-dot-wrap"><i></i></span>' +
                '<span class="ag-pt-trail-label">' + esc(a.label) + '</span>' +
                (dur ? '<span class="ag-pt-trail-dur">' + esc(dur) + '</span>' : '') +
                '</div>'
              );
            })
            .join('') +
          '</div>'
        : '';
      const tasksHtml = (prog.tasks || []).length
        ? '<div class="ag-pt-task-mini">' +
          prog.tasks
            .slice(0, 6)
            .map((t) => '<div class="ag-pt-task-row" data-status="' + esc(t.status) + '"><span>' + (t.status === 'complete' ? '✓' : t.status === 'running' ? '◐' : '○') + '</span><span>' + esc(t.title) + '</span></div>')
            .join('') +
          '</div>'
        : '';

      const orbSvg =
        '<div class="ag-pt-orb' + (isLive ? ' is-live' : '') + '" data-tone="' + esc(phaseTone || 'idle') + '">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="' +
        (isLive ? '38 24' : '60 0') +
        '"/></svg></div>';

      progressHtml =
        '<section class="ag-pt-ov-sec" id="ag-ov-progress-sec">' +
        '<button type="button" class="ag-pt-ov-toggle" data-ag-ov-toggle="progress" aria-expanded="' + (!ui.ovProgressCollapsed) + '">' +
        '<span class="ag-pt-ov-title">任务进度</span>' +
        (headBadge ? '<span class="ag-pt-ov-badge" data-tone="' + esc(phaseTone) + '">' + esc(headBadge) + '</span>' : '') +
        '<span class="ag-pt-ov-chev">›</span>' +
        '</button>' +
        (ui.ovProgressCollapsed
          ? ''
          : '<div class="ag-pt-ov-body">' +
            '<div class="ag-pt-prog-hdr">' + orbSvg + '<div class="ag-pt-prog-head-txt"><div class="ag-pt-prog-title" data-tone="' + esc(phaseTone) + '">' + esc(headline) + '</div></div></div>' +
            tasksHtml +
            trailHtml +
            '<div class="ag-pt-prog-foot"><span>工具调用 ' + esc(prog.toolCount || 0) + '</span>' +
            (elapsedTxt ? '<span>用时 ' + esc(elapsedTxt) + '</span>' : '') +
            '</div></div>') +
        '</section>';
    }

    let quotaHtml = '';
    if (liveGroups.length > 0) {
      const minPct = Math.min(...liveGroups.map((g) => Math.min(g.fhPct, g.wkPct)));
      const qTone = minPct <= 20 ? 'critical' : minPct <= 50 ? 'warning' : '';
      const qBadge = ui.overviewQuotaCollapsed ? `${minPct}%` : '';
      const renderOvLine = (lbl, win) => {
        const pct = typeof win?.remainingPct === 'number' ? Math.max(0, Math.min(100, win.remainingPct)) : 100;
        const tone = pct <= 20 ? 'critical' : pct <= 50 ? 'warning' : 'ok';
        return (
          '<div class="ag-ov-qline" data-tone="' + tone + '">' +
          '<span class="ag-ov-qlbl">' + esc(lbl) + '</span>' +
          '<span class="ag-ov-qtrack"><i style="width:' + pct + '%"></i></span>' +
          '<span class="ag-ov-qpct">' + pct + '%</span>' +
          '</div>'
        );
      };
      quotaHtml =
        '<section class="ag-pt-ov-sec" id="ag-ov-quota-sec">' +
        '<button type="button" class="ag-pt-ov-toggle" data-ag-ov-toggle="quota" aria-expanded="' + (!ui.overviewQuotaCollapsed) + '">' +
        '<span class="ag-pt-ov-title">当前额度</span>' +
        (qBadge ? '<span class="ag-pt-ov-badge" data-tone="' + esc(qTone) + '">' + esc(qBadge) + '</span>' : '') +
        '<span class="ag-pt-ov-chev">›</span>' +
        '</button>' +
        (ui.overviewQuotaCollapsed
          ? ''
          : '<div class="ag-pt-ov-qbody">' +
            liveGroups
              .map((g) => {
                const labelShort = /claude|gpt/i.test(g.label || g.key) ? 'Claude / GPT' : /gemini/i.test(g.label || g.key) ? 'Gemini' : (g.label || g.key);
                return (
                  '<button type="button" class="ag-ov-pool" data-ag-ov-open-accounts="1">' +
                  '<div class="ag-ov-pool-hd">' +
                  '<span class="ag-ov-pool-name">' + esc(labelShort) + '</span>' +
                  (g.resetTxt ? '<span class="ag-ov-pool-reset">' + esc(g.resetTxt) + '</span>' : '') +
                  '</div>' +
                  renderOvLine('5h 限额', g.fh) +
                  renderOvLine('周限额', g.wk) +
                  '</button>'
                );
              })
              .join('') +
            '</div>') +
        '</section>';
    }

    box.innerHTML = progressHtml + quotaHtml;
  }
  window.__ag_sync_overview_extensions = syncOverviewExtensions;

  function syncSettingsDialog() {
    if (disposed) return;
    ensureTopbarWidget();
    syncOverviewExtensions();
    if (accountsTabActive) {
      mountAccountsPane(false);
    }
  }
  window.__ag_sync_accounts_dialog = syncSettingsDialog;

  function onGlobalClick(ev) {
    if (!ui.popoverOpen) return;
    const pop = document.getElementById('ag-usage-popover');
    const btn = document.getElementById('ag-topbar-usage-btn');
    if (
      pop?.contains(ev.target) ||
      btn?.contains(ev.target) ||
      ev.target?.closest?.('.ag-tt-btn-heatmap')
    ) {
      return;
    }
    setPopoverOpen(false);
  }
  function onGlobalKeyDown(ev) {
    if (ev.key === 'Escape' && ui.popoverOpen) {
      setPopoverOpen(false);
    }
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', onGlobalClick, false);
    document.addEventListener('keydown', onGlobalKeyDown, true);
  }

  function isOwnUiNode(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(
      target.closest('#ag-accounts-pane, #ag-usage-popover, #ag-topbar-usage-btn, #ag-overview-sections')
    );
  }

  function scheduleSync(records) {
    if (disposed || syncTimer) return;
    if (Array.isArray(records) && records.length > 0 && records.every((r) => isOwnUiNode(r.target))) {
      return;
    }
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncSettingsDialog();
    }, 60);
  }

  cleanupLegacyAuxArtifacts();
  document.getElementById('ag-accounts-nav-wrap')?.remove();
  try {
    document.querySelectorAll('[data-ag-accounts-open]').forEach((el) => el.removeAttribute('data-ag-accounts-open'));
  } catch {}
  try {
    observer = new MutationObserver((records) => scheduleSync(records));
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  } catch {}
  syncSettingsDialog();
  const initTopbarMode = getTopbarDisplayMode();
  if (initTopbarMode === 'todayTokens' || initTopbarMode === 'monthTokens' || initTopbarMode === 'monthCost') {
    ensureTopbarMetricsWarm();
  }
  if (typeof window.__agAccountsAction === 'function' && !ui.overview && !ui.loadingAccounts) {
    void refreshOverview();
  }
  liveQuotaTickTimer = setInterval(() => {
    if (disposed) return;
    const mode = getTopbarDisplayMode();
    if (mode === 'todayTokens' || mode === 'monthTokens' || mode === 'monthCost') {
      ensureTopbarMetricsWarm();
    }
    refreshTopbarBadge();
    syncOverviewExtensions();
  }, 15000);

  window.__ag_accounts_cleanup = () => {
    disposed = true;
    if (syncTimer) clearTimeout(syncTimer);
    if (acctAutoRefreshTimer) {
      clearInterval(acctAutoRefreshTimer);
      acctAutoRefreshTimer = null;
    }
    if (popAutoRefreshTimer) {
      clearInterval(popAutoRefreshTimer);
      popAutoRefreshTimer = null;
    }
    if (liveQuotaTickTimer) {
      clearInterval(liveQuotaTickTimer);
      liveQuotaTickTimer = null;
    }
    if (observer) observer.disconnect();
    cleanupLegacyAuxArtifacts();
    if (typeof document.removeEventListener === 'function') {
      document.removeEventListener('click', onGlobalClick, false);
      document.removeEventListener('keydown', onGlobalKeyDown, true);
    }
    document.getElementById('ag-accounts-nav-wrap')?.remove();
    try {
      document.querySelectorAll('[data-ag-accounts-open]').forEach((el) => el.removeAttribute('data-ag-accounts-open'));
    } catch {}
    try { delete window.__ag_on_accounts_tab_active; } catch {}
    document.getElementById('ag-topbar-usage-btn')?.remove();
    document.getElementById('ag-usage-aux-resizer')?.remove();
    document.getElementById('ag-usage-popover')?.remove();
    document.getElementById('ag-overview-sections')?.remove();
    document.getElementById('ag-overview-quota-card')?.remove();
  };
})();
