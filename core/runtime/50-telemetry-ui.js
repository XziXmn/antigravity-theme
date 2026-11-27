/**
 * Part 50: Telemetry Pill, Hover Bento Tooltip, Per-Turn Badges & Live 4-State Probe Loop
 * Supports both the main conversation pane and the right-hand Side Question (旁路提问) pane.
 */
  // Remove any stale DOM nodes and observers from a prior bundle version so fresh listeners attach cleanly
  try {
    for (const staleId of ['ag-live-metrics-pill', 'ag-side-metrics-pill', 'ag-live-metrics-tooltip', 'ag-turn-metrics-tooltip', 'ag-composer-quota-halo']) {
      const staleEl = document.getElementById(staleId);
      if (staleEl) staleEl.remove();
    }
    document.querySelectorAll('.ag-live-metrics-pill, .ag-composer-compact-rim, .ag-compact-swap-line, #ag-composer-quota-halo, svg[id*="quota-halo"]').forEach((el) => el.remove());
    document.querySelectorAll('[data-ag-row-mode]').forEach((el) => el.removeAttribute('data-ag-row-mode'));
    document.querySelectorAll('[data-ag-turn-row]').forEach((el) => el.removeAttribute('data-ag-turn-row'));
    document.querySelectorAll('[data-ag-compact-fx]').forEach((el) => el.removeAttribute('data-ag-compact-fx'));
    document.querySelectorAll('[data-ag-compact-phase]').forEach((el) => el.removeAttribute('data-ag-compact-phase'));
    if (window.__ag_pane_states && typeof window.__ag_pane_states === 'object') {
      for (const k of Object.keys(window.__ag_pane_states)) {
        const ps = window.__ag_pane_states[k];
        if (ps && ps.roRaf && typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(ps.roRaf); } catch (e) {}
        }
        if (ps && ps.ro) {
          try { ps.ro.disconnect(); } catch (e) {}
        }
      }
    }
    if (window.__ag_turn_metrics_observer) {
      try { window.__ag_turn_metrics_observer.disconnect(); } catch (e) {}
      window.__ag_turn_metrics_observer = null;
    }
  } catch (e) {}

  const AG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const metricsByCid = (window.__ag_metrics_by_cid = {});
  const paneStates = (window.__ag_pane_states = {});

  function getOrCreatePaneState(key) {
    if (!paneStates[key]) {
      paneStates[key] = {
        cid: '',
        unconnStartMs: 0,
        pendingKind: 'idle',
        waitStartMs: 0,
        lastSteps: 0,
        lastGens: 0,
        lastStreamLen: 0,
        rowMode: '',
        layoutSig: '',
        ro: null,
        roObserved: null,
        roRaf: 0,
        lastSnap: null
      };
    }
    return paneStates[key];
  }

  function storeMetricsPayload(cid, payload) {
    if (!cid || !payload) return;
    if (Object.prototype.hasOwnProperty.call(metricsByCid, cid)) {
      delete metricsByCid[cid];
    }
    metricsByCid[cid] = payload;
    const keys = Object.keys(metricsByCid);
    if (keys.length > 12) {
      delete metricsByCid[keys[0]];
    }
    if (typeof window.__ag_sync_overview_extensions === 'function') {
      try { window.__ag_sync_overview_extensions(); } catch {}
    }
  }

  function extractCascadeId() {
    try {
      const pathStr = String(window.location && window.location.pathname ? window.location.pathname : '');
      const mRoute = pathStr.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-zA-Z_-]{8,})/i);
      if (mRoute && mRoute[1]) return mRoute[1];
      const mainView = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
      const viewCid = mainView ? String(mainView.getAttribute('data-cascade-id') || '').trim() : '';
      if (AG_UUID_RE.test(viewCid)) return viewCid;
      if (!document.querySelector('[data-testid="home-greeting"], [data-testid="home-splash-content"]')) {
        const selRow = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
        const selCid = selRow ? selRow.getAttribute('data-cascade-id') || '' : '';
        if (selCid) return selCid;
      }
    } catch (e) {}
    return '';
  }

  function extractSideCascadeId(sideContent) {
    try {
      if (!sideContent) return '';
      const convEl = sideContent.querySelector('[data-testid="side-question-tab-conversation"][data-cascade-id]');
      const attrCid = convEl ? String(convEl.getAttribute('data-cascade-id') || '').trim() : '';
      if (AG_UUID_RE.test(attrCid)) return attrCid;
    } catch (e) {}
    return '';
  }

  function discoverConversationPanes() {
    const panes = [];
    try {
      const boxes = document.querySelectorAll('[id="' + SELECTORS.inputBoxId + '"]');
      let mainFound = false;
      let sideFound = false;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        const sideContent = box.closest ? box.closest('[data-testid="side-question-tab-content"]') : null;
        const inSide = Boolean(
          sideContent || (box.closest && box.closest('[data-testid="side-question-tab-composer"]'))
        );
        if (inSide) {
          if (sideFound) continue;
          sideFound = true;
          panes.push({
            key: 'side',
            pillId: 'ag-side-metrics-pill',
            inputBox: box,
            container: sideContent || box.parentElement || document,
            cid: extractSideCascadeId(sideContent)
          });
        } else {
          if (mainFound) continue;
          mainFound = true;
          panes.push({
            key: 'main',
            pillId: 'ag-live-metrics-pill',
            inputBox: box,
            container: (box.closest && box.closest('[data-testid="conversation-view"]')) || document,
            cid: extractCascadeId()
          });
        }
      }
    } catch (e) {}
    return panes;
  }

  function getPaneByKey(paneKey) {
    const panes = discoverConversationPanes();
    for (let i = 0; i < panes.length; i++) {
      if (panes[i].key === paneKey) return panes[i];
    }
    return null;
  }

  function getWatchedCascadeIds() {
    const out = [];
    const add = (id) => {
      const s = String(id || '').trim();
      if (AG_UUID_RE.test(s) && !out.includes(s)) out.push(s);
    };
    add(extractCascadeId());
    try {
      document.querySelectorAll('[data-testid="side-question-tab-content"]').forEach((sc) => {
        add(extractSideCascadeId(sc));
      });
    } catch (e) {}
    return out;
  }

  window.__ag_get_watched_cascade_ids = getWatchedCascadeIds;

  function isMetricsRouteActive(pane) {
    if (!MODULES.metrics) return false;
    if (!pane) return false;
    if (pane.cid) return true;
    return Boolean(pane.inputBox);
  }

  function positionMetricsTooltip(pill, tt, inputBox) {
    if (!pill || !tt) return;
    try {
      const rect = pill.getBoundingClientRect();
      const textEl = pill.querySelector('.ag-live-metrics-text');
      const textRect = textEl ? textEl.getBoundingClientRect() : null;
      const anchorRect = textRect && textRect.width > 0 && textRect.height > 0 ? textRect : rect;
      const box = inputBox || pill.closest('[id="' + SELECTORS.inputBoxId + '"]') || document.getElementById(SELECTORS.inputBoxId);
      const boxRect = box ? box.getBoundingClientRect() : null;
      const anchorTop = rect.height > 0 ? rect.top : boxRect ? boxRect.top : 0;
      const anchorLeft =
        anchorRect && anchorRect.width > 0
          ? anchorRect.left + anchorRect.width / 2
          : boxRect
          ? boxRect.left + boxRect.width / 2
          : 0;
      const ttW = tt.offsetWidth || tt.getBoundingClientRect().width || 332;
      const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const left = Math.max(12, Math.min(Math.round(anchorLeft - ttW / 2), vw - ttW - 12));
      const bottomPx = Math.max(12, Math.round(vh - anchorTop + 10));
      const wrap = tt.querySelector('.ag-tt-wrap');
      if (wrap) {
        wrap.style.maxHeight = Math.max(180, Math.round(anchorTop - 24)) + 'px';
        wrap.style.overflowY = 'auto';
      }
      tt.style.top = 'auto';
      tt.style.bottom = bottomPx + 'px';
      tt.style.left = left + 'px';
    } catch (e) {}
  }

  function syncTooltipFlowOverlay(tt, paneKey) {
    if (!tt) return;
    const wrap = tt.querySelector('.ag-tt-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.ag-tt-flow-bar').forEach((el) => el.remove());
    const slot = wrap.querySelector('.ag-tt-flow-chip-slot');
    if (slot) {
      if (!MODULES.flow) {
        slot.innerHTML = '';
      } else {
        const cache = window.__ag_flow_status_state;
        const pk = paneKey === 'side' ? 'side' : 'main';
        const paneSt = (cache && cache.panes && cache.panes[pk]) || {
          mode: (boot.flow && boot.flow.defaultMode) || 'default',
          runtime: null
        };
        const proxy = (cache && cache.proxy) || { running: false, port: (boot.flow && boot.flow.port) || 18100 };
        const asar = (cache && cache.asar) || { found: false, patched: false };

        const loc = I18N_LOCALE || 'zh-CN';
        const isEn = loc === 'en';
        const isTw = loc === 'zh-TW';
        const modeMap = isEn
          ? { default: 'Default', writing: 'Writing', engineering: 'Eng', full: 'Full' }
          : isTw
          ? { default: '預設', writing: '寫作', engineering: '工程', full: '全面' }
          : { default: '默认', writing: '写作', engineering: '工程', full: '全面' };
        const modeLabel = modeMap[paneSt.mode] || modeMap.default;
        const tipText =
          modeLabel +
          ' · ' +
          (proxy.running
            ? (asar.patched ? (isEn ? 'Relay Active :' : '接管 :') : isEn ? 'Direct :' : '仅转发 :') + proxy.port
            : isEn ? 'Relay Off' : '未启动');
        const isActive = proxy.running && asar.patched;
        const sig = modeLabel + '|' + isActive + '|' + tipText;
        if (slot.getAttribute('data-ag-flow-sig') !== sig) {
          slot.setAttribute('data-ag-flow-sig', sig);
          slot.innerHTML =
            '<span class="ag-tt-flow-chip' +
            (isActive ? ' is-on' : '') +
            '" title="' +
            escapeStatusHtml(tipText) +
            '">' +
            '<i class="ag-tt-flow-chip-dot"></i>' +
            escapeStatusHtml(modeLabel) +
            '</span>';
        }
      }
    }

    const compEl = wrap.querySelector('.ag-tt-comp-status');
    if (compEl) {
      const nCount = Number(compEl.getAttribute('data-native-count') || 0);
      const nPending = compEl.getAttribute('data-native-pending') === '1';
      const nRunning = compEl.getAttribute('data-native-running') === '1';
      const nKb = Number(compEl.getAttribute('data-native-kb') || 0);

      const cache = window.__ag_flow_status_state || {};
      const pk = paneKey === 'side' ? 'side' : 'main';
      const proxy = cache.proxy || { running: false };
      const asar = cache.asar || { patched: false };
      const prefsFlow = (window.__ag_ui_prefs && window.__ag_ui_prefs.flow) || {};
      const baseCfg = cache.compactConfig || {};
      const bootFlow = boot.flow || {};
      const compactEnabled = Boolean(
        prefsFlow.compactEnabled !== undefined
          ? prefsFlow.compactEnabled
          : baseCfg.enabled !== undefined
          ? baseCfg.enabled
          : bootFlow.compactEnabled
      );
      const threshPct = Number(prefsFlow.compactThresholdPct || baseCfg.thresholdPct || bootFlow.compactThresholdPct || 70);
      const tailTokens = Number(prefsFlow.compactKeepTailTokens || baseCfg.keepTailTokens || bootFlow.compactKeepTailTokens || 20000);
      const tailK = Math.round(tailTokens / 1000) + 'k';
      const compSt = (cache.panes && cache.panes[pk] && cache.panes[pk].compaction) || {};

      const loc = I18N_LOCALE || 'zh-CN';
      const isEn = loc === 'en';
      const isTw = loc === 'zh-TW';

      const hdrTxt = isEn ? 'Compaction' : isTw ? '壓縮狀態' : '压缩状态';
      const nativeLbl = isEn ? 'Native' : isTw ? '原生壓縮' : '原生压缩';
      const slideLbl = isEn ? 'Sliding' : isTw ? '滑動壓縮' : '滑动压缩';

      const isHijacked = compactEnabled && proxy.running && asar.patched;
      const isPendingHijack = compactEnabled && (!proxy.running || !asar.patched);
      const modePillCls = isHijacked ? 'is-hijacked' : isPendingHijack ? 'is-pending' : 'is-native';
      const modePillTxt = isHijacked
        ? (isEn ? 'Hijacked' : '已接管')
        : isPendingHijack
        ? (isEn ? 'Pending' : '待接管')
        : (isEn ? 'Native' : '原生');

      const nativeTone = nRunning ? 'is-active' : nPending || nCount > 0 ? 'is-ready' : 'is-idle';
      const nativeVal = nRunning
        ? (isEn ? 'Compacting…' : isTw ? '壓縮中…' : '压缩中…')
        : nPending
        ? (isEn ? 'Just compacted' : isTw ? '剛完成壓縮' : '刚完成压缩') + (nKb > 0 ? ` · ${nKb} KB` : '')
        : nCount > 0
        ? (isEn ? `${nCount}× triggered` : isTw ? `已觸發 ${nCount} 次` : `已触发 ${nCount} 次`)
        : (isEn ? '0× · Idle' : isTw ? '0 次 · 未觸發' : '0 次 · 未触发');

      let slideTone = 'is-idle';
      let slideVal = isEn ? 'Off' : isTw ? '未開啟' : '未开启';
      if (compactEnabled) {
        const cnt = Math.max(0, Number(compSt.count || 0));
        if (compSt.inFlight) {
          slideTone = 'is-active';
          slideVal = isEn
            ? `Compacting #${cnt + 1}`
            : isTw
            ? `壓縮中 · 第 ${cnt + 1} 次`
            : `压缩中 · 第 ${cnt + 1} 次`;
        } else if (!proxy.running || !asar.patched) {
          slideTone = 'is-warn';
          slideVal = isEn ? '0× · Needs Redirect' : isTw ? '0 次 · 需開啟接管' : '0 次 · 需开启接管';
        } else if (compSt.active || cnt > 0) {
          slideTone = 'is-ready';
          const effCnt = Math.max(1, cnt);
          slideVal = isEn
            ? `${effCnt}× triggered`
            : isTw
            ? `已觸發 ${effCnt} 次`
            : `已触发 ${effCnt} 次`;
        } else {
          slideTone = 'is-ready';
          slideVal = isEn
            ? `0× · ${threshPct}% / ${tailK}`
            : isTw
            ? `0 次 · 閾值 ${threshPct}%`
            : `0 次 · 阈值 ${threshPct}%`;
        }
      }

      const compSig = [hdrTxt, modePillCls, modePillTxt, nativeTone, nativeVal, slideTone, slideVal].join('|');
      if (compEl.getAttribute('data-ag-comp-sig') !== compSig) {
        compEl.setAttribute('data-ag-comp-sig', compSig);
        compEl.innerHTML =
          '<div class="ag-tt-comp-hdr"><span class="ag-tt-sub-hdr" style="margin-bottom:0">' +
          escapeStatusHtml(hdrTxt) +
          '</span><span class="ag-tt-comp-mode-pill ' +
          modePillCls +
          '">' +
          escapeStatusHtml(modePillTxt) +
          '</span></div>' +
          '<div class="ag-tt-comp-row"><span class="ag-tt-comp-lbl"><i class="ag-tt-comp-dot ' +
          nativeTone +
          '"></i>' +
          escapeStatusHtml(nativeLbl) +
          '</span><span class="ag-tt-comp-val">' +
          escapeStatusHtml(nativeVal) +
          '</span></div>' +
          '<div class="ag-tt-comp-row"><span class="ag-tt-comp-lbl"><i class="ag-tt-comp-dot ' +
          slideTone +
          '"></i>' +
          escapeStatusHtml(slideLbl) +
          '</span><span class="ag-tt-comp-val">' +
          escapeStatusHtml(slideVal) +
          '</span></div>';
      }
    }
  }

  window.__ag_refresh_telemetry_flow = function () {
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt) return;
    syncTooltipCacheObs(tt);
    syncTooltipQuotaOverlay(tt);
    syncTooltipFlowOverlay(tt, window.__ag_tt_owner_pane || 'main');
  };

  function formatQuotaResetDuration(sec, loc) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
    if (sec < 60) return loc === 'en' ? '<1m' : '<1分';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd' + (h > 0 ? h + 'h' : '');
    if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '');
    return m + 'm';
  }

  function requestQuotaStatus(force = false, minGapMs = 3000) {
    if (typeof window.__agGetQuotaStatus !== 'function') return;
    const now = Date.now();
    const last = window.__ag_quota_state;
    if (window.__ag_quota_loading) return;
    if (last && last.fetchedAt && now - last.fetchedAt < minGapMs) return;
    window.__ag_quota_loading = true;
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt) {
      tt.querySelectorAll('.ag-tt-quota-refresh').forEach((btn) => btn.classList.add('is-loading'));
    }
    try {
      window.__agGetQuotaStatus(JSON.stringify({ reqId: 'q-' + now, force: Boolean(force) }));
    } catch {
      window.__ag_quota_loading = false;
    }
  }

  function resolveLiveQuotaWindow(win, nowMs) {
    if (!win || typeof win !== 'object') return null;
    const pct = typeof win.remainingPct === 'number' ? Math.max(0, Math.min(100, win.remainingPct)) : null;
    let resetInSec =
      typeof win.resetInSec === 'number' && Number.isFinite(win.resetInSec) ? Math.max(0, win.resetInSec) : null;
    const resetMs = win.resetTime ? Date.parse(win.resetTime) : NaN;
    if (Number.isFinite(resetMs)) {
      const liveSec = Math.round((resetMs - nowMs) / 1000);
      if (liveSec <= 0) {
        return { pct: 100, resetInSec: 0, expired: true };
      }
      resetInSec = liveSec;
    }
    return { pct, resetInSec, expired: false };
  }

  function syncTooltipCacheObs(tt) {
    if (!tt) return;
    const el = tt.querySelector('.ag-tt-cache-obs-val');
    if (!el) return;
    const ts = Number(el.getAttribute('data-last-req-ts') || 0);
    const model = el.getAttribute('data-model') || '';
    if (!ts || !/gemini|claude/i.test(model)) {
      el.textContent = '—';
      return;
    }
    const remMs = 300000 - (Date.now() - ts);
    if (remMs <= 0) {
      el.textContent = I18N_LOCALE === 'en' ? 'Expired' : '已过 5m';
      return;
    }
    const sec = Math.ceil(remMs / 1000);
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    el.textContent = `≈ ${m}:${s}`;
  }

  function syncTooltipQuotaOverlay(tt) {
    if (!tt) return;
    const wrap = tt.querySelector('.ag-tt-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.ag-tt-quota-box, .ag-tt-quota-l1').forEach((el) => el.remove());

    const q = window.__ag_quota_state;
    const nowMs = Date.now();
    const groups = q && Array.isArray(q.groups) ? q.groups : [];
    let hasExpiredWindow = false;
    for (const g of groups) {
      const l5 = resolveLiveQuotaWindow(g.fiveHour, nowMs);
      const lw = resolveLiveQuotaWindow(g.weekly, nowMs);
      if ((l5 && l5.expired) || (lw && lw.expired)) {
        hasExpiredWindow = true;
        break;
      }
    }
    if (hasExpiredWindow && q && q.fetchedAt && nowMs - q.fetchedAt >= 15000) {
      requestQuotaStatus(true, 15000);
    }
  }

  window.__ag_on_quota_status = function (_reqId, payload) {
    window.__ag_quota_loading = false;
    if (payload && typeof payload === 'object' && Array.isArray(payload.buckets)) {
      window.__ag_quota_state = payload;
    }
    if (typeof window.__ag_refresh_topbar_usage === 'function') {
      try { window.__ag_refresh_topbar_usage(); } catch {}
    }
    if (typeof window.__ag_sync_overview_extensions === 'function') {
      try { window.__ag_sync_overview_extensions(); } catch {}
    }
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt) return;
    syncTooltipQuotaOverlay(tt);
    if (tt.getAttribute('data-visible') === '1') {
      const ownerKey = window.__ag_tt_owner_pane || 'main';
      const ownerPane = getPaneByKey(ownerKey);
      const pill = document.getElementById(ownerKey === 'side' ? 'ag-side-metrics-pill' : 'ag-live-metrics-pill');
      if (pill) positionMetricsTooltip(pill, tt, ownerPane ? ownerPane.inputBox : null);
    }
  };

  function syncTooltipLiveOverlay(tt, snap, ownerPill, ownerBox) {
    if (!tt || !snap) return;
    const chipEl = tt.querySelector('.ag-tt-live-chip');
    if (chipEl) {
      if (chipEl.textContent !== snap.chipText) chipEl.textContent = snap.chipText;
      const targetChipClass = 'ag-tt-live-chip' + (snap.chipClass ? ' ' + snap.chipClass : '');
      if (chipEl.className !== targetChipClass) chipEl.className = targetChipClass;
    }
    const noteEl = tt.querySelector('.ag-tt-wait-note');
    if (noteEl) {
      const targetNoteClass = 'ag-tt-wait-note' + (snap.noteClass ? ' ' + snap.noteClass : '');
      if (noteEl.className !== targetNoteClass) noteEl.className = targetNoteClass;
      if (noteEl.getAttribute('data-ag-note-html') !== snap.noteHtml) {
        noteEl.setAttribute('data-ag-note-html', snap.noteHtml);
        noteEl.innerHTML = snap.noteHtml;
        if (ownerPill && tt.getAttribute('data-visible') === '1') {
          positionMetricsTooltip(ownerPill, tt, ownerBox);
        }
      }
    }
    syncTooltipCacheObs(tt);
    syncTooltipQuotaOverlay(tt);
    syncTooltipFlowOverlay(tt, window.__ag_tt_owner_pane || 'main');
  }

  function ensureMetricsTooltipEl() {
    let tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt && document.body) {
      tt = document.createElement('div');
      tt.id = 'ag-live-metrics-tooltip';
      document.body.appendChild(tt);
      tt.addEventListener('mouseenter', () => {
        if (window.__ag_tt_hide_timer) {
          clearTimeout(window.__ag_tt_hide_timer);
          window.__ag_tt_hide_timer = null;
        }
      });
      tt.addEventListener('mouseleave', () => {
        if (window.__ag_tt_pinned) return;
        if (window.__ag_tt_hide_timer) clearTimeout(window.__ag_tt_hide_timer);
        window.__ag_tt_hide_timer = setTimeout(() => {
          const curTt = document.getElementById('ag-live-metrics-tooltip');
          if (curTt && !window.__ag_tt_pinned) {
            curTt.removeAttribute('data-visible');
            window.__ag_tt_hover_opened_at = 0;
          }
        }, 180);
      });
      tt.addEventListener('click', (e) => {
        if (window.__ag_tt_hide_timer) {
          clearTimeout(window.__ag_tt_hide_timer);
          window.__ag_tt_hide_timer = null;
        }
        const qBtn = e.target && e.target.closest ? e.target.closest('.ag-tt-quota-refresh') : null;
        if (qBtn) {
          e.preventDefault();
          e.stopPropagation();
          requestQuotaStatus(true);
          return;
        }
        const btn = e.target && e.target.closest ? e.target.closest('.ag-tt-btn-toggle') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const expanded = tt.getAttribute('data-expanded') === '1';
        if (expanded) {
          tt.removeAttribute('data-expanded');
        } else {
          tt.setAttribute('data-expanded', '1');
          requestQuotaStatus(true);
        }
        const ownerKey = window.__ag_tt_owner_pane || 'main';
        const ownerPane = getPaneByKey(ownerKey);
        const pill = document.getElementById(ownerKey === 'side' ? 'ag-side-metrics-pill' : 'ag-live-metrics-pill');
        if (pill) positionMetricsTooltip(pill, tt, ownerPane ? ownerPane.inputBox : null);
      });
    }
    return tt;
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
        const curPx = parseFloat(getComputedStyle(el).fontSize) || 10;
        const nextPx = Math.max(minPx, Number((curPx * (cw / sw) - 0.2).toFixed(2)));
        el.style.fontSize = nextPx + 'px';
      }
    }
  }

  function hydrateTooltipForPane(paneKey) {
    const tt = ensureMetricsTooltipEl();
    if (!tt) return null;
    const pane = getPaneByKey(paneKey);
    const cid = pane ? pane.cid : paneKey === 'main' ? extractCascadeId() : '';
    const m = cid ? metricsByCid[cid] : null;
    if (!m || !m.tooltipHtml) return null;
    window.__ag_tt_owner_pane = paneKey;
    tt.setAttribute('data-ag-owner-pane', paneKey);
    if (tt.getAttribute('data-ag-raw-tt') !== m.tooltipHtml) {
      tt.setAttribute('data-ag-raw-tt', m.tooltipHtml);
      tt.innerHTML = m.tooltipHtml;
    }
    const ps = paneStates[paneKey];
    if (ps && ps.lastSnap) {
      const pill = document.getElementById(pane ? pane.pillId : 'ag-live-metrics-pill');
      syncTooltipLiveOverlay(tt, ps.lastSnap, pill, pane ? pane.inputBox : null);
    } else {
      syncTooltipCacheObs(tt);
      syncTooltipQuotaOverlay(tt);
      syncTooltipFlowOverlay(tt, paneKey);
    }
    requestQuotaStatus(false);
    fitSingleLineNodes(tt, '.ag-tt-kpi-sub', 8.5);
    return { tt, pane };
  }

  function isMetricsPillEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === 'ag-live-metrics-pill' || el.id === 'ag-side-metrics-pill') return true;
    return Boolean(el.classList && el.classList.contains('ag-live-metrics-pill'));
  }

  function getNonPillChildren(el) {
    const out = [];
    if (!el || !el.children) return out;
    for (let i = 0; i < el.children.length; i++) {
      const ch = el.children[i];
      if (!isMetricsPillEl(ch)) out.push(ch);
    }
    return out;
  }

  function isHorizontalFlexContainer(el) {
    if (!el || typeof window.getComputedStyle !== 'function') return true;
    try {
      const cs = window.getComputedStyle(el);
      const disp = cs && cs.display ? String(cs.display) : '';
      const dir = cs && cs.flexDirection ? String(cs.flexDirection) : '';
      return disp.includes('flex') && dir.startsWith('row');
    } catch (e) {
      return true;
    }
  }

  function isVerticalFlowContainer(el) {
    if (!el || typeof window.getComputedStyle !== 'function') return true;
    try {
      const cs = window.getComputedStyle(el);
      const disp = cs && cs.display ? String(cs.display) : '';
      const dir = cs && cs.flexDirection ? String(cs.flexDirection) : '';
      if (disp.includes('flex')) return dir.startsWith('column');
      return disp !== 'inline' && disp !== 'inline-block' && !disp.includes('inline-grid');
    } catch (e) {
      return true;
    }
  }

  function clearStaleRowModes(inputBox, activeRow, activePill) {
    if (!inputBox || !inputBox.querySelectorAll) return;
    try {
      inputBox.querySelectorAll('[data-ag-row-mode]').forEach((el) => {
        if (el !== activeRow && el !== activePill) {
          el.removeAttribute('data-ag-row-mode');
        }
      });
    } catch (e) {}
  }

  function findInputToolbarContext(inputBox) {
    if (!inputBox) return null;
    const modelTrigger = inputBox.querySelector('[data-testid="model-selector-trigger"]');
    if (!modelTrigger) return null;

    const extractPair = (candidate) => {
      if (!candidate || candidate === inputBox || !inputBox.contains(candidate) || isMetricsPillEl(candidate)) {
        return null;
      }
      const kids = getNonPillChildren(candidate);
      if (kids.length < 2) return null;
      const leftGroup = kids[0];
      const rightGroup = kids[kids.length - 1];
      if (!leftGroup || !rightGroup || leftGroup === rightGroup) return null;
      if (!leftGroup.contains(modelTrigger)) return null;
      return { row: candidate, leftGroup, rightGroup };
    };

    // Prefer Antigravity's canonical composer footer row so inner dropdown/tooltip siblings
    // mounted around model-selector-trigger can never hijack row detection.
    if (modelTrigger.closest) {
      const explicitRow = modelTrigger.closest('.agy-composer-footer, [data-agent-composer-root]');
      const explicitCtx = extractPair(explicitRow);
      if (explicitCtx) return explicitCtx;
    }

    // Structural fallback: pick the outermost full-width horizontal row inside inputBox
    // whose parent flows vertically (so bottom-mode stacking never lands inside a flex-row).
    const boxWidth = inputBox.getBoundingClientRect ? Math.round(inputBox.getBoundingClientRect().width || 0) : 0;
    let best = null;
    let row = modelTrigger.parentElement;
    for (let i = 0; i < 12 && row && row !== inputBox; i++, row = row.parentElement) {
      const ctx = extractPair(row);
      if (!ctx) continue;
      if (!isHorizontalFlexContainer(row)) continue;
      if (row.parentElement && !isVerticalFlowContainer(row.parentElement)) continue;
      if (boxWidth > 0 && row.getBoundingClientRect) {
        const rw = Math.round(row.getBoundingClientRect().width || 0);
        if (rw > 0 && rw < boxWidth * 0.7) continue;
      }
      best = ctx;
    }
    return best;
  }

  function ensureMetricsPillForPane(pane, forceLayout = false, resetHysteresis = false) {
    if (!pane || !pane.inputBox) return null;
    const { key: paneKey, pillId, inputBox, cid } = pane;
    const ctx = findInputToolbarContext(inputBox);
    if (!ctx) return null;
    const { row, leftGroup, rightGroup } = ctx;
    const ps = getOrCreatePaneState(paneKey);

    let pill = document.getElementById(pillId);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = pillId;
      pill.className = 'ag-live-metrics-pill';
      pill.setAttribute('data-ag-pane', paneKey);
      const textSpanId = paneKey === 'main' ? ' id="ag-live-metrics-text"' : '';
      pill.innerHTML = '<span' + textSpanId + ' class="ag-live-metrics-text"><span class="ag-ctx-pending-dot ag-dot-idle"></span></span>';
      const cachedM = cid ? metricsByCid[cid] : null;
      if (cachedM && cachedM.inlineHtml) {
        const textEl = pill.querySelector('.ag-live-metrics-text');
        if (textEl) {
          textEl.setAttribute('data-ag-raw-html', cachedM.inlineHtml);
          textEl.innerHTML = cachedM.inlineHtml;
        }
      }

      pill.addEventListener('mouseenter', () => {
        if (window.__ag_tt_hide_timer) {
          clearTimeout(window.__ag_tt_hide_timer);
          window.__ag_tt_hide_timer = null;
        }
        if (window.__ag_tt_pinned && window.__ag_tt_owner_pane && window.__ag_tt_owner_pane !== paneKey) {
          return;
        }
        if (window.__ag_tt_show_timer) clearTimeout(window.__ag_tt_show_timer);
        window.__ag_tt_show_timer = setTimeout(() => {
          const res = hydrateTooltipForPane(paneKey);
          if (!res || !res.tt || !res.tt.innerHTML.trim()) return;
          if (res.tt.getAttribute('data-visible') !== '1') {
            window.__ag_tt_hover_opened_at = Date.now();
          }
          positionMetricsTooltip(pill, res.tt, res.pane ? res.pane.inputBox : inputBox);
          res.tt.setAttribute('data-visible', '1');
          requestQuotaStatus(true);
          if (typeof window.__ag_refresh_flow_state_for_pane === 'function') {
            window.__ag_refresh_flow_state_for_pane(paneKey);
          }
        }, 85);
      });

      pill.addEventListener('mouseleave', () => {
        if (window.__ag_tt_show_timer) {
          clearTimeout(window.__ag_tt_show_timer);
          window.__ag_tt_show_timer = null;
        }
        if (window.__ag_tt_pinned) return;
        if (window.__ag_tt_hide_timer) clearTimeout(window.__ag_tt_hide_timer);
        window.__ag_tt_hide_timer = setTimeout(() => {
          const tt = document.getElementById('ag-live-metrics-tooltip');
          if (tt && !window.__ag_tt_pinned) {
            tt.removeAttribute('data-visible');
            window.__ag_tt_hover_opened_at = 0;
          }
        }, 180);
      });

      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.__ag_tt_show_timer) {
          clearTimeout(window.__ag_tt_show_timer);
          window.__ag_tt_show_timer = null;
        }
        if (window.__ag_tt_hide_timer) {
          clearTimeout(window.__ag_tt_hide_timer);
          window.__ag_tt_hide_timer = null;
        }
        const prevOwner = window.__ag_tt_owner_pane || '';
        const res = hydrateTooltipForPane(paneKey);
        if (!res || !res.tt || !res.tt.innerHTML.trim()) return;
        const tt = res.tt;
        const isVisible = tt.getAttribute('data-visible') === '1';
        const isExpanded = tt.getAttribute('data-expanded') === '1';
        const switchedOwner = prevOwner && prevOwner !== paneKey;

        if (!isVisible || !window.__ag_tt_pinned || switchedOwner) {
          // 1st click (or switching from the other pane): open & pin L1 summary panel
          tt.removeAttribute('data-expanded');
          tt.setAttribute('data-visible', '1');
          window.__ag_tt_pinned = true;
          window.__ag_tt_hover_opened_at = 0;
          requestQuotaStatus(true);
        } else if (!isExpanded) {
          // 2nd click: expand L2 detail breakdown
          tt.setAttribute('data-expanded', '1');
          tt.setAttribute('data-visible', '1');
          window.__ag_tt_pinned = true;
          requestQuotaStatus(true);
        } else {
          // 3rd click: close panel
          tt.removeAttribute('data-expanded');
          tt.removeAttribute('data-visible');
          window.__ag_tt_pinned = false;
          window.__ag_tt_hover_opened_at = 0;
        }
        if (tt.getAttribute('data-visible') === '1') {
          positionMetricsTooltip(pill, tt, res.pane ? res.pane.inputBox : inputBox);
          if (typeof window.__ag_refresh_flow_state_for_pane === 'function') {
            window.__ag_refresh_flow_state_for_pane(paneKey);
          }
        }
      });
    }

    const boxRect = inputBox.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowWidth = Math.round(rowRect.width || boxRect.width || 0);
    if (resetHysteresis) ps.rowMode = '';
    const prevMode = ps.rowMode || '';

    let leftUsed = 0;
    for (let i = 0; i < leftGroup.children.length; i++) {
      const ch = leftGroup.children[i];
      if (ch === pill || isMetricsPillEl(ch)) continue;
      leftUsed += Math.ceil(ch.getBoundingClientRect().width || 0);
    }
    const rightUsed = Math.ceil(rightGroup.getBoundingClientRect().width || 0);
    const freeWidth = rowWidth - leftUsed - rightUsed - 16;

    const swapEl = pill.hasAttribute('data-ag-compact-phase') ? pill.querySelector('.ag-compact-swap-line') : null;
    const textEl = pill.querySelector('.ag-live-metrics-text');
    const measuredTextWidth = swapEl
      ? Math.ceil(swapEl.scrollWidth || 0)
      : textEl
      ? Math.ceil(textEl.scrollWidth || 0)
      : 0;
    const isDetailed =
      boot.telemetryLayout === 'detailed' ||
      Boolean(boot.userConfig && boot.userConfig.telemetryLayout === 'detailed');
    const neededWidth = measuredTextWidth > 24 ? measuredTextWidth + 24 : 204;
    const threshold = swapEl
      ? Math.max(120, neededWidth + 8)
      : prevMode === 'middle'
      ? Math.max(168, neededWidth)
      : Math.max(202, neededWidth + 24);
    const mode = !isDetailed && rowWidth > 0 && freeWidth >= threshold ? 'middle' : 'bottom';
    const sig = mode + ':' + Math.round(rowWidth / 8) + ':' + Math.round(neededWidth / 16);

    const isMountedCorrectly =
      pill.isConnected &&
      inputBox.contains(pill) &&
      row.getAttribute('data-ag-row-mode') === mode &&
      pill.getAttribute('data-ag-row-mode') === mode &&
      (mode === 'middle'
        ? pill.parentElement === leftGroup
        : Boolean(row.parentElement && pill.parentElement === row.parentElement && row.nextElementSibling === pill));

    if (forceLayout || !isMountedCorrectly || ps.rowMode !== mode || ps.layoutSig !== sig) {
      ps.rowMode = mode;
      ps.layoutSig = sig;
      clearStaleRowModes(inputBox, row, pill);
      row.setAttribute('data-ag-row-mode', mode);
      pill.setAttribute('data-ag-row-mode', mode);
      if (mode === 'middle') {
        if (pill.parentElement !== leftGroup) {
          leftGroup.appendChild(pill);
        }
      } else if (row.parentElement) {
        if (pill.parentElement !== row.parentElement || row.nextElementSibling !== pill) {
          row.parentElement.insertBefore(pill, row.nextSibling);
        }
      }
    }

    if (ps.roObserved !== inputBox && typeof ResizeObserver !== 'undefined') {
      if (ps.roRaf && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(ps.roRaf); } catch (e) {}
        ps.roRaf = 0;
      }
      if (ps.ro) {
        try { ps.ro.disconnect(); } catch (e) {}
      }
      ps.roObserved = inputBox;
      ps.ro = new ResizeObserver(() => {
        if (ps.roRaf) return;
        const runLayout = () => {
          ps.roRaf = 0;
          const curPane = getPaneByKey(paneKey);
          if (!curPane) return;
          ensureMetricsPillForPane(curPane, false, false);
          const tt = document.getElementById('ag-live-metrics-tooltip');
          const p = document.getElementById(pillId);
          if (tt && p && tt.getAttribute('data-visible') === '1' && (window.__ag_tt_owner_pane || 'main') === paneKey) {
            positionMetricsTooltip(p, tt, curPane.inputBox);
          }
        };
        if (typeof requestAnimationFrame === 'function') {
          ps.roRaf = requestAnimationFrame(runLayout);
        } else {
          runLayout();
        }
      });
      try { ps.ro.observe(inputBox); } catch (e) {}
    }

    return pill;
  }

  function pruneStalePills(activePanes) {
    const activeKeys = new Set(activePanes.map((p) => p.key));
    for (const [k, pid] of [['main', 'ag-live-metrics-pill'], ['side', 'ag-side-metrics-pill']]) {
      if (activeKeys.has(k)) continue;
      const stale = document.getElementById(pid);
      if (stale) stale.remove();
      const ps = paneStates[k];
      if (ps) {
        if (ps.roRaf && typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(ps.roRaf); } catch (e) {}
          ps.roRaf = 0;
        }
        if (ps.ro) {
          try { ps.ro.disconnect(); } catch (e) {}
          ps.ro = null;
          ps.roObserved = null;
        }
        ps.cid = '';
        ps.layoutSig = '';
        ps.rowMode = '';
      }
      if ((window.__ag_tt_owner_pane || '') === k) {
        window.__ag_tt_pinned = false;
        window.__ag_tt_hover_opened_at = 0;
        const tt = document.getElementById('ag-live-metrics-tooltip');
        if (tt) {
          tt.removeAttribute('data-visible');
          tt.removeAttribute('data-expanded');
        }
      }
    }
  }

  function ensureMetricsPill(forceLayout = false, resetHysteresis = false) {
    const panes = discoverConversationPanes();
    pruneStalePills(panes);
    let mainPill = null;
    for (let i = 0; i < panes.length; i++) {
      const pill = ensureMetricsPillForPane(panes[i], forceLayout, resetHysteresis);
      if (panes[i].key === 'main') mainPill = pill;
    }
    return mainPill;
  }

  const compactFxByCid = Object.create(null);

  function resolveCompactFxKey(cid, pk) {
    const clean = String(cid || '').trim();
    if (clean) return clean;
    return '__draft__:' + (pk === 'side' ? 'side' : 'main');
  }

  function clearCompactFxForKey(key) {
    if (!key) return;
    const cur = compactFxByCid[key];
    if (cur && cur.timerId) {
      clearTimeout(cur.timerId);
    }
    delete compactFxByCid[key];
  }

  function isCidCurrentlyVisible(cidKey) {
    try {
      const panes = discoverConversationPanes();
      for (let i = 0; i < panes.length; i += 1) {
        if (resolveCompactFxKey(panes[i].cid, panes[i].key) === cidKey) return true;
      }
    } catch {}
    return false;
  }

  function armCompactFxTimer(key, fx, ttlMs) {
    if (!fx || !key) return;
    if (fx.timerId) {
      clearTimeout(fx.timerId);
      fx.timerId = null;
    }
    fx.expiresAt = Date.now() + ttlMs;
    const timerId = setTimeout(() => {
      const cur = compactFxByCid[key];
      if (cur && cur.timerId === timerId) {
        delete compactFxByCid[key];
        try { applyPendingWaitVisuals(); } catch {}
      }
    }, ttlMs);
    fx.timerId = timerId;
  }

  function formatCompactTokensK(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v >= 1000) return Math.round(v / 1000) + 'k';
    return String(v);
  }

  function formatCompactFxText(phase, ev) {
    const loc = I18N_LOCALE || 'zh-CN';
    const isEn = loc === 'en';
    const isTw = loc === 'zh-TW';
    if (phase === 'running') {
      return isEn ? 'Compacting context…' : isTw ? '正在滑動壓縮上下文…' : '正在滑动压缩上下文…';
    }
    if (phase === 'hijack') {
      return isEn
        ? 'Native compaction hijacked · recent context kept'
        : isTw
        ? '已接管原生壓縮 · 保留近期上下文'
        : '已接管原生压缩 · 保留近期上下文';
    }
    if (phase === 'rollback') {
      const errCode = String((ev && ev.error) || '').trim();
      if (
        errCode === 'too_few_turns' ||
        errCode === 'head_too_small' ||
        errCode === 'no_safe_split_point' ||
        errCode === 'cannot_compact'
      ) {
        return isEn
          ? 'Context too short · skipped'
          : isTw
          ? '目前上下文較短 · 暫無需壓縮'
          : '当前上下文较短 · 暂无需压缩';
      }
      if (errCode === 'no_session_snapshot' || errCode === 'no_auth_headers') {
        return isEn
          ? 'Send a turn first to compact'
          : isTw
          ? '請先傳送一輪對話後再壓縮'
          : '请先发送一轮对话后再压缩';
      }
      if (/^COMPACT_HTTP_|COMPACT_INVALID_SUMMARY|COMPACT_UNEXPECTED_TOOL_CALL/i.test(errCode)) {
        return isEn
          ? 'Summary failed · original context kept'
          : isTw
          ? '摘要生成異常 · 已保留原上下文'
          : '摘要生成异常 · 已保留原上下文';
      }
      if (/timeout|ETIMEDOUT/i.test(errCode)) {
        return isEn
          ? 'Compaction timed out · context kept'
          : isTw
          ? '壓縮逾時 · 已保留原上下文'
          : '压缩超时 · 已保留原上下文';
      }
      return isEn
        ? 'Compaction skipped · original context kept'
        : isTw
        ? '滑動壓縮已安全回滾'
        : '滑动压缩已安全回滚';
    }
    const st = (ev && ev.status && typeof ev.status === 'object' ? ev.status : ev) || {};
    const before = Number(st.beforeTokensEst || 0);
    const after = Number(st.afterTokensEst || 0);
    const saved = Number(st.savedTokensEst || 0);
    if (before > 0 && saved > 0) {
      const bStr = formatCompactTokensK(before);
      const aStr = formatCompactTokensK(after);
      const sStr = formatCompactTokensK(saved);
      if (isEn) return `Compacted ${bStr}→${aStr} (-${sStr})`;
      if (isTw) return `已壓縮 ${bStr}→${aStr}（省${sStr}）`;
      return `已压缩 ${bStr}→${aStr}（省${sStr}）`;
    }
    return isEn ? 'Context compacted' : isTw ? '已完成滑動壓縮' : '已完成滑动压缩';
  }

  function resolveComposerCardEl(inputBox) {
    if (!inputBox || !inputBox.querySelector) return null;
    return (
      inputBox.querySelector('.surface-composer-card') ||
      inputBox.querySelector(':scope > div.bg-card') ||
      inputBox
    );
  }

  function syncCompactFxVisualForPane(pane, pill, now) {
    if (!pane) return;
    const pk = pane.key === 'side' ? 'side' : 'main';
    const cidKey = resolveCompactFxKey(pane.cid, pk);
    let fx = compactFxByCid[cidKey] || null;
    if (fx && fx.expiresAt && fx.expiresAt <= now) {
      clearCompactFxForKey(cidKey);
      fx = null;
    }
    if (fx && fx.deferredReveal) {
      fx.deferredReveal = false;
      armCompactFxTimer(cidKey, fx, fx.revealTtlMs || 4500);
    }

    const card = resolveComposerCardEl(pane.inputBox);
    if (card) {
      if (fx) {
        let rim = card.querySelector(':scope > .ag-composer-compact-rim');
        if (!rim) {
          rim = document.createElement('div');
          rim.className = 'ag-composer-compact-rim';
          rim.setAttribute('aria-hidden', 'true');
          card.insertBefore(rim, card.firstChild);
        }
        if (card.getAttribute('data-ag-compact-fx') !== fx.phase) {
          card.setAttribute('data-ag-compact-fx', fx.phase);
        }
      } else {
        if (card.hasAttribute('data-ag-compact-fx')) {
          card.removeAttribute('data-ag-compact-fx');
        }
      }
    }

    if (pill) {
      let layoutDirty = false;
      if (fx) {
        if (pill.getAttribute('data-ag-compact-phase') !== fx.phase) {
          pill.setAttribute('data-ag-compact-phase', fx.phase);
          layoutDirty = true;
        }
        let swapLine = pill.querySelector(':scope > .ag-compact-swap-line');
        if (!swapLine) {
          swapLine = document.createElement('span');
          swapLine.className = 'ag-compact-swap-line';
          swapLine.innerHTML = '<span class="ag-ctx-pending-dot"></span><span class="ag-compact-swap-text"></span>';
          pill.appendChild(swapLine);
          layoutDirty = true;
        }
        const swapDot = swapLine.querySelector('.ag-ctx-pending-dot');
        const swapTxt = swapLine.querySelector('.ag-compact-swap-text');
        if (swapDot) {
          const dotCls =
            'ag-ctx-pending-dot ' +
            (fx.phase === 'running'
              ? 'ag-dot-compact-running'
              : fx.phase === 'rollback'
              ? 'ag-dot-compact-warn'
              : 'ag-dot-compact-success');
          if (swapDot.className !== dotCls) swapDot.className = dotCls;
        }
        if (swapTxt) {
          const txtCls =
            'ag-compact-swap-text ' +
            (fx.phase === 'running'
              ? 'ag-compact-shimmer'
              : fx.phase === 'hijack'
              ? 'ag-compact-tone-hijack'
              : fx.phase === 'rollback'
              ? 'ag-compact-tone-rollback'
              : 'ag-compact-tone-success');
          if (swapTxt.className !== txtCls) swapTxt.className = txtCls;
          if (swapTxt.textContent !== fx.text) {
            swapTxt.textContent = fx.text;
            layoutDirty = true;
          }
        }
      } else if (pill.hasAttribute('data-ag-compact-phase')) {
        pill.removeAttribute('data-ag-compact-phase');
        layoutDirty = true;
      }
      if (layoutDirty) {
        ensureMetricsPillForPane(pane, false, false);
      }
    }
  }

  window.__ag_on_flow_compact_fx = function (ev, pkHint) {
    if (!ev || typeof ev !== 'object') return;
    const pk = pkHint === 'side' ? 'side' : 'main';
    const type = String(ev.type || '');
    let phase = '';
    let ttlMs = 0;

    if (type === 'compact-start') {
      phase = 'running';
      ttlMs = 90000;
    } else if (type === 'compact-hijack') {
      phase = 'hijack';
      ttlMs = 3600;
    } else if (type === 'compact' || type === 'compaction') {
      if (ev.ok === false) {
        if (ev.error === 'compaction_in_flight') return;
        phase = 'rollback';
        ttlMs = 3600;
      } else {
        phase = 'success';
        ttlMs = 4500;
      }
    }
    if (!phase) return;

    const key = resolveCompactFxKey(ev.cascadeId, pk);
    const text = formatCompactFxText(phase, ev);
    const now = Date.now();
    const prev = compactFxByCid[key];
    if (
      prev &&
      prev.phase === phase &&
      phase !== 'running' &&
      prev.text === text &&
      now - Number(prev.updatedAt || 0) < 1500
    ) {
      return;
    }

    clearCompactFxForKey(key);
    const fx = {
      cid: String(ev.cascadeId || '').trim(),
      phase,
      text,
      startedAt: phase === 'running' ? now : Number((prev && prev.startedAt) || now),
      updatedAt: now,
      deferredReveal: false,
      revealTtlMs: ttlMs,
      expiresAt: 0,
      timerId: null
    };
    compactFxByCid[key] = fx;

    if (phase === 'running' || isCidCurrentlyVisible(key)) {
      armCompactFxTimer(key, fx, ttlMs);
    } else {
      fx.deferredReveal = true;
      fx.revealTtlMs = ttlMs;
      armCompactFxTimer(key, fx, 180000);
    }
    try { applyPendingWaitVisuals(); } catch {}
  };

  window.__ag_sync_flow_compact_status = function (cid, compStatus, pkHint) {
    if (!cid || !compStatus || typeof compStatus !== 'object') return;
    const pk = pkHint === 'side' ? 'side' : 'main';
    const key = resolveCompactFxKey(cid, pk);
    const cur = compactFxByCid[key] || null;
    if (compStatus.inFlight === true) {
      if (!cur || cur.phase !== 'running') {
        window.__ag_on_flow_compact_fx({ type: 'compact-start', cascadeId: cid, reason: 'sync' }, pk);
      }
      return;
    }
    if (compStatus.inFlight === false && cur && cur.phase === 'running') {
      const startedAt = Number(cur.startedAt || 0);
      if (Number(compStatus.compactedAt || 0) >= startedAt - 2000) {
        window.__ag_on_flow_compact_fx({ type: 'compact', cascadeId: cid, ok: true, status: compStatus }, pk);
      } else if (compStatus.lastError && Number(compStatus.lastErrorAt || 0) >= startedAt - 2000) {
        window.__ag_on_flow_compact_fx(
          { type: 'compact', cascadeId: cid, ok: false, error: compStatus.lastError, status: compStatus },
          pk
        );
      } else if (Date.now() - startedAt > 2500) {
        clearCompactFxForKey(key);
        try { applyPendingWaitVisuals(); } catch {}
      }
    }
  };

  function applyPendingWaitVisualsForPane(pane, now) {
    const { key: paneKey, pillId, inputBox, container, cid: curCid } = pane;
    const ps = getOrCreatePaneState(paneKey);
    const m = curCid && metricsByCid[curCid] ? metricsByCid[curCid] : null;
    const st = m && m.status ? m.status : null;
    const live =
      typeof readLiveCascadeRuntimeState === 'function'
        ? readLiveCascadeRuntimeState(curCid, inputBox, container)
        : null;

    if (ps.cid !== curCid) {
      ps.cid = curCid;
      ps.unconnStartMs = 0;
      ps.waitStartMs = 0;
      ps.pendingKind = 'idle';
      ps.lastSteps = 0;
      ps.lastGens = 0;
      ps.lastStreamLen = 0;
    }

    const isUnconnNow = Boolean(
      curCid && live && live.matched && live.hasProvider && Number(live.aspStatus) === 0 && !live.hasTrajectory
    );
    if (isUnconnNow) {
      if (!ps.unconnStartMs) ps.unconnStartMs = now;
    } else {
      ps.unconnStartMs = 0;
    }
    const unconnSec = ps.unconnStartMs ? Math.max(0, Math.floor((now - ps.unconnStartMs) / 1000)) : 0;

    const stKind = st && st.pendingKind ? String(st.pendingKind) : 'idle';
    const stSteps = st && typeof st.totalSteps === 'number' ? st.totalSteps : 0;
    const stGens = st && typeof st.totalGenerations === 'number' ? st.totalGenerations : 0;
    const curStreamLen =
      typeof readActiveStreamProgressLen === 'function' ? readActiveStreamProgressLen(container) : 0;

    const activeProbe = Boolean(
      stKind !== 'idle' ||
        (live &&
          live.matched &&
          (live.stopBtnActive || (live.hasProvider && (Number(live.effRunStatus) === 2 || live.execCase === 'modelRequest'))))
    );

    if (activeProbe) {
      const progressed =
        stSteps > ps.lastSteps ||
        stGens > ps.lastGens ||
        curStreamLen > ps.lastStreamLen + 1;
      if (!ps.waitStartMs || ps.pendingKind !== stKind || progressed) {
        ps.waitStartMs = now;
      }
      ps.pendingKind = stKind;
      ps.lastSteps = Math.max(ps.lastSteps, stSteps);
      ps.lastGens = Math.max(ps.lastGens, stGens);
      ps.lastStreamLen = Math.max(ps.lastStreamLen, curStreamLen);
    } else {
      ps.waitStartMs = 0;
      ps.pendingKind = 'idle';
      if (ps.lastSteps > 0 || ps.lastGens > 0 || ps.lastStreamLen > 0) {
        requestQuotaStatus(true, 5000);
      }
      ps.lastSteps = stSteps;
      ps.lastGens = stGens;
      ps.lastStreamLen = curStreamLen;
    }

    const waitSec = ps.waitStartMs ? Math.max(0, Math.floor((now - ps.waitStartMs) / 1000)) : 0;
    const snap = computeStatusSnapshot({
      now,
      st,
      live,
      waitSec,
      unconnSec,
      lastHb: window.__ag_last_daemon_hb || 0,
      visibleSince: window.__ag_visible_since || 0,
      documentHidden: Boolean(document.hidden),
      navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      hasConversation: Boolean(curCid),
      curModel: typeof getSelectedModelLabel === 'function' ? getSelectedModelLabel(inputBox) : ''
    });
    ps.lastSnap = snap;

    const hasCompactFx = Boolean(compactFxByCid[resolveCompactFxKey(curCid, paneKey)]);
    const routeVisible =
      isMetricsRouteActive(pane) || snap.visualState === 'error' || snap.visualState === 'slow' || snap.isExecuting || hasCompactFx;

    let pill = document.getElementById(pillId);
    if (routeVisible && !pill) {
      pill = ensureMetricsPillForPane(pane, false, false);
    }

    if (pill) {
      const hasInlineData = Boolean(m && m.hasData && m.inlineHtml);
      const showPill = Boolean(hasInlineData || routeVisible);
      const nextDisplay = showPill ? 'inline-flex' : 'none';
      const displayChanged = pill.style.display !== nextDisplay;
      pill.style.display = nextDisplay;

      const textEl = pill.querySelector('.ag-live-metrics-text');
      let inlineTextChanged = false;
      if (textEl && hasInlineData) {
        if (textEl.getAttribute('data-ag-raw-html') !== m.inlineHtml) {
          textEl.setAttribute('data-ag-raw-html', m.inlineHtml);
          textEl.innerHTML = m.inlineHtml;
          inlineTextChanged = true;
        }
      } else if (textEl && !hasInlineData && showPill) {
        const fallbackLabel =
          snap.visualState === 'error'
            ? (snap.chipText || '连接异常')
            : snap.visualState === 'slow'
            ? (snap.chipText || '等待响应...')
            : snap.isExecuting
            ? (snap.chipText || '生成中...')
            : '就绪';
        const fallbackHtml =
          '<span class="ag-ctx-pending-dot ag-dot-idle"></span><span>' +
          escapeStatusHtml(fallbackLabel) +
          '</span>';
        if (textEl.getAttribute('data-ag-raw-html') !== fallbackHtml) {
          textEl.setAttribute('data-ag-raw-html', fallbackHtml);
          textEl.innerHTML = fallbackHtml;
          inlineTextChanged = true;
        }
      }
      if ((inlineTextChanged || displayChanged) && showPill) {
        ensureMetricsPillForPane(pane, false, false);
      }

      const dotEl = pill.querySelector('.ag-ctx-pending-dot');
      if (dotEl) {
        const targetClass =
          'ag-ctx-pending-dot ' +
          (snap.visualState === 'error'
            ? 'ag-dot-error'
            : snap.visualState === 'slow'
            ? 'ag-dot-slow'
            : snap.visualState === 'running'
            ? 'ag-dot-running'
            : 'ag-dot-idle');
        if (dotEl.className !== targetClass) {
          dotEl.className = targetClass;
        }
        if (dotEl.hasAttribute('title')) {
          dotEl.removeAttribute('title');
        }
        if (dotEl.getAttribute('aria-label') !== snap.dotTitle) {
          dotEl.setAttribute('aria-label', snap.dotTitle);
        }
      }
      if (pill.hasAttribute('title')) {
        pill.removeAttribute('title');
      }
      if (pill.getAttribute('aria-label') !== snap.dotTitle) {
        pill.setAttribute('aria-label', snap.dotTitle);
      }
    }

    syncCompactFxVisualForPane(pane, pill, now);

    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt && (window.__ag_tt_owner_pane || 'main') === paneKey) {
      syncTooltipLiveOverlay(tt, snap, pill, inputBox);
    }

    return snap;
  }

  function applyPendingWaitVisuals() {
    if (!MODULES.metrics) return null;
    const now = Date.now();
    const panes = discoverConversationPanes();
    pruneStalePills(panes);
    let mainSnap = null;
    for (let i = 0; i < panes.length; i++) {
      const snap = applyPendingWaitVisualsForPane(panes[i], now);
      if (panes[i].key === 'main') mainSnap = snap;
    }
    return mainSnap;
  }

  window.__ag_refresh_wait_ui = applyPendingWaitVisuals;

  function extractToolbarStepMeta(tb) {
    try {
      const domCidEl = tb.closest ? tb.closest('[data-cascade-id]') : null;
      const domCid = domCidEl ? String(domCidEl.getAttribute('data-cascade-id') || '').trim() : '';

      const fk = Object.keys(tb).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fk) return null;
      let f = tb[fk];
      let nrcProps = null;
      let iEcProps = null;
      let sliceProps = null;
      for (let i = 0; i < 20 && f; i++) {
        const p = f.memoizedProps;
        if (p) {
          if (!nrcProps && Array.isArray(p.steps) && 'showThumbsUpDown' in p) nrcProps = p;
          if (!iEcProps && p.cascadeId && Array.isArray(p.trajectorySteps) && typeof p.trajectoryLength === 'number') {
            iEcProps = p;
          }
          if (!sliceProps && p.trajectorySlice && Array.isArray(p.trajectorySlice.stepsInSlice)) {
            sliceProps = p;
          }
        }
        if (nrcProps && (iEcProps || sliceProps)) break;
        f = f.return;
      }
      if (!nrcProps) return null;

      const tSteps = iEcProps
        ? iEcProps.trajectorySteps
        : sliceProps && sliceProps.trajectorySlice
        ? sliceProps.trajectorySlice.stepsInSlice
        : [];
      const base = iEcProps
        ? iEcProps.trajectoryLength - tSteps.length
        : sliceProps && sliceProps.trajectorySlice && typeof sliceProps.trajectorySlice.totalStepsLength === 'number'
        ? sliceProps.trajectorySlice.totalStepsLength - tSteps.length
        : 0;

      let maxStep = -1;
      let maxMeta = -1;
      for (let i = 0; i < nrcProps.steps.length; i++) {
        const s = nrcProps.steps[i];
        if (!s) continue;
        const srcInfo = s.metadata && s.metadata.sourceTrajectoryStepInfo;
        let si = srcInfo && typeof srcInfo.stepIndex === 'number' ? srcInfo.stepIndex : -1;
        if (si < 0 && tSteps.length > 0) {
          const pos = tSteps.indexOf(s);
          if (pos >= 0) si = base + pos;
        }
        if (si > maxStep) maxStep = si;
        if (srcInfo && typeof srcInfo.metadataIndex === 'number' && srcInfo.metadataIndex > maxMeta) {
          maxMeta = srcInfo.metadataIndex;
        }
      }
      const fiberCid = iEcProps && iEcProps.cascadeId ? String(iEcProps.cascadeId).trim() : '';
      const resolvedCid = AG_UUID_RE.test(domCid) ? domCid : fiberCid;
      if (!resolvedCid && maxStep < 0 && maxMeta < 0) return null;
      return {
        cascadeId: resolvedCid,
        maxStep,
        maxMeta
      };
    } catch {
      return null;
    }
  }

  function matchTurnForToolbar(turns, meta) {
    if (!turns || turns.length === 0 || !meta) return null;
    if (meta.maxStep >= 0) {
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        if (meta.maxStep >= t.startStepIdx && (t.endStepIdx < 0 || meta.maxStep <= t.endStepIdx)) {
          return t;
        }
      }
    }
    if (meta.maxMeta >= 0) {
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        if (meta.maxMeta >= t.minGenIdx && meta.maxMeta <= t.maxGenIdx) {
          return t;
        }
      }
    }
    return null;
  }

  function formatTurnBadgeData(t) {
    const parts = [];
    if (t.model) parts.push('<span class="ag-turn-model">' + escapeStatusHtml(t.model) + '</span>');
    const promptTok = typeof t.promptTok === 'number' ? t.promptTok : t.inTok + t.cacheWrite + t.cacheRead;
    const promptStr = t.promptStr || '';
    if (promptTok > 0 && promptStr) {
      parts.push('<span>In ' + escapeStatusHtml(promptStr) + '</span>');
    }
    if (t.outTok > 0) parts.push('<span>Out ' + escapeStatusHtml(t.outStr) + '</span>');
    if (promptTok > 0 && t.cacheRate) {
      parts.push('<span>Cache ' + escapeStatusHtml(t.cacheRate) + '</span>');
    }
    if (t.tps > 0) parts.push('<span>' + t.tps + ' tok/s</span>');
    const html = parts.join('<span class="ag-sep"> · </span>');

    const rows = [];
    if (t.lastCtx > 0) {
      const ctxCls = t.ctxPct >= 90 ? 'ag-tmt-ctx-crit' : t.ctxPct >= 75 ? 'ag-tmt-ctx-warn' : '';
      const ctxVal =
        '<span class="ag-tmt-nowrap">' +
        escapeStatusHtml(t.lastCtx.toLocaleString('en-US')) +
        ' / ' +
        escapeStatusHtml(t.limitStr) +
        ' <span class="' +
        ctxCls +
        '">(' +
        escapeStatusHtml(String(t.ctxPct)) +
        '%)</span></span>';
      rows.push('<div class="ag-tmt-row"><span class="ag-tmt-lbl">当前上下文</span><span class="ag-tmt-val">' + ctxVal + '</span></div>');
    }
    if (t.outTok > 0) {
      const outVal =
        '<span class="ag-tmt-nowrap">' +
        escapeStatusHtml(t.outTok.toLocaleString('en-US')) +
        '</span> <span class="ag-tmt-nowrap ag-tmt-sub">(思考 ' +
        escapeStatusHtml(t.thinkTok.toLocaleString('en-US')) +
        ' + 正文/工具 ' +
        escapeStatusHtml(t.respTok.toLocaleString('en-US')) +
        ')</span>';
      rows.push('<div class="ag-tmt-row"><span class="ag-tmt-lbl">本轮输出</span><span class="ag-tmt-val">' + outVal + '</span></div>');
    }
    const promptSum = t.inTok + t.cacheWrite + t.cacheRead;
    if (promptSum > 0) {
      const inVal =
        '<span class="ag-tmt-nowrap">新增 ' +
        escapeStatusHtml(t.inTok.toLocaleString('en-US')) +
        '</span>' +
        (t.cacheWrite > 0
          ? ' <span class="ag-tmt-nowrap">+ 写缓存 ' + escapeStatusHtml(t.cacheWrite.toLocaleString('en-US')) + '</span>'
          : '') +
        ' <span class="ag-tmt-nowrap">+ 读缓存 ' +
        escapeStatusHtml(t.cacheRead.toLocaleString('en-US')) +
        '</span> <span class="ag-tmt-nowrap ag-tmt-sub">(命中率 ' +
        escapeStatusHtml(t.cacheRate) +
        ')</span>';
      rows.push('<div class="ag-tmt-row"><span class="ag-tmt-lbl">本轮累计输入</span><span class="ag-tmt-val">' + inVal + '</span></div>');
    }
    if (t.tps > 0 || t.totDur > 0) {
      const spdVal =
        (t.tps > 0
          ? '<span class="ag-tmt-nowrap">' +
            escapeStatusHtml(String(t.tps)) +
            ' tok/s <span class="ag-tmt-sub">(端到端 ' +
            escapeStatusHtml(String(t.e2eTps)) +
            ' tok/s)</span></span> · '
          : '') +
        '<span class="ag-tmt-nowrap">流式 ' +
        escapeStatusHtml(String(t.streamDur)) +
        's / 总计 ' +
        escapeStatusHtml(String(t.totDur)) +
        's</span>';
      rows.push('<div class="ag-tmt-row"><span class="ag-tmt-lbl">速度与耗时</span><span class="ag-tmt-val">' + spdVal + '</span></div>');
    }

    const hdrHtml = t.model
      ? '<div class="ag-tmt-hdr"><span class="ag-tmt-model">' +
        escapeStatusHtml(t.model) +
        '</span><span class="ag-tmt-chip">' +
        escapeStatusHtml(String(t.steps || 1)) +
        ' 步</span></div>'
      : '';
    const tooltipHtml = hdrHtml || rows.length > 0 ? hdrHtml + '<div class="ag-tmt-grid">' + rows.join('') + '</div>' : '';
    return { html, tooltipHtml };
  }

  let activeTurnBadgeEl = null;

  function clearTurnTooltipTimers() {
    if (window.__ag_turn_tt_show_timer) {
      clearTimeout(window.__ag_turn_tt_show_timer);
      window.__ag_turn_tt_show_timer = null;
    }
    if (window.__ag_turn_tt_hide_timer) {
      clearTimeout(window.__ag_turn_tt_hide_timer);
      window.__ag_turn_tt_hide_timer = null;
    }
  }

  function hideTurnMetricsTooltip(immediate = false) {
    if (window.__ag_turn_tt_show_timer) {
      clearTimeout(window.__ag_turn_tt_show_timer);
      window.__ag_turn_tt_show_timer = null;
    }
    const doHide = () => {
      window.__ag_turn_tt_hide_timer = null;
      activeTurnBadgeEl = null;
      const tt = document.getElementById('ag-turn-metrics-tooltip');
      if (tt) tt.removeAttribute('data-visible');
    };
    if (immediate) {
      if (window.__ag_turn_tt_hide_timer) {
        clearTimeout(window.__ag_turn_tt_hide_timer);
        window.__ag_turn_tt_hide_timer = null;
      }
      doHide();
      return;
    }
    if (window.__ag_turn_tt_hide_timer) clearTimeout(window.__ag_turn_tt_hide_timer);
    window.__ag_turn_tt_hide_timer = setTimeout(doHide, 110);
  }

  function ensureTurnMetricsTooltipEl() {
    let tt = document.getElementById('ag-turn-metrics-tooltip');
    if (!tt && document.body) {
      tt = document.createElement('div');
      tt.id = 'ag-turn-metrics-tooltip';
      document.body.appendChild(tt);
      tt.addEventListener('mouseenter', () => {
        if (window.__ag_turn_tt_hide_timer) {
          clearTimeout(window.__ag_turn_tt_hide_timer);
          window.__ag_turn_tt_hide_timer = null;
        }
      });
      tt.addEventListener('mouseleave', () => {
        hideTurnMetricsTooltip(false);
      });
    }
    return tt;
  }

  function positionTurnMetricsTooltip(badge, tt) {
    if (!badge || !tt) return;
    try {
      const rect = badge.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      tt.style.left = '12px';
      const ttRect = tt.getBoundingClientRect();
      const ttW = tt.offsetWidth || ttRect.width || 320;
      const ttH = tt.offsetHeight || ttRect.height || 130;

      const preferAbove = rect.top >= ttH + 16 || rect.top >= vh - rect.bottom;
      const left = Math.max(12, Math.min(Math.round(rect.left), vw - ttW - 12));
      if (preferAbove) {
        const top = Math.max(12, Math.round(rect.top - ttH - 8));
        tt.setAttribute('data-placement', 'above');
        tt.style.top = top + 'px';
      } else {
        const top = Math.min(vh - ttH - 12, Math.round(rect.bottom + 8));
        tt.setAttribute('data-placement', 'below');
        tt.style.top = Math.max(12, top) + 'px';
      }
      tt.style.left = left + 'px';
    } catch (e) {}
  }

  function scheduleShowTurnMetricsTooltip(badge) {
    if (!badge || !badge.__agTurnTtHtml) return;
    if (window.__ag_turn_tt_hide_timer) {
      clearTimeout(window.__ag_turn_tt_hide_timer);
      window.__ag_turn_tt_hide_timer = null;
    }
    if (activeTurnBadgeEl === badge) {
      const existingTt = document.getElementById('ag-turn-metrics-tooltip');
      if (existingTt && existingTt.getAttribute('data-visible') === '1') return;
    }
    if (window.__ag_turn_tt_show_timer) clearTimeout(window.__ag_turn_tt_show_timer);
    window.__ag_turn_tt_show_timer = setTimeout(() => {
      window.__ag_turn_tt_show_timer = null;
      if (!badge.isConnected || !badge.__agTurnTtHtml) return;
      const tt = ensureTurnMetricsTooltipEl();
      if (!tt) return;
      activeTurnBadgeEl = badge;
      if (tt.getAttribute('data-ag-turn-tt-raw') !== badge.__agTurnTtHtml) {
        tt.setAttribute('data-ag-turn-tt-raw', badge.__agTurnTtHtml);
        tt.innerHTML = badge.__agTurnTtHtml;
      }
      positionTurnMetricsTooltip(badge, tt);
      tt.setAttribute('data-visible', '1');
    }, 80);
  }

  function renderTurnMetrics(optionalPayload, optionalCid) {
    try {
      if (optionalPayload && typeof optionalPayload === 'object') {
        const pCid = optionalCid || optionalPayload.cid || optionalPayload.cascadeId || '';
        if (pCid) storeMetricsPayload(pCid, optionalPayload);
      }
      const toolbars = document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]');
      if (!toolbars || toolbars.length === 0) return;

      for (let i = 0; i < toolbars.length; i++) {
        const tb = toolbars[i];
        tb.querySelectorAll(':scope > button > .ag-turn-metrics').forEach((el) => el.remove());
        const directDivs = tb.querySelectorAll(':scope > div');
        const row = (directDivs.length > 0 ? directDivs[directDivs.length - 1] : null) || tb.lastElementChild;
        if (!row) continue;
        let badge = row.querySelector(':scope > .ag-turn-metrics');
        if (!MODULES.metrics) {
          if (badge) badge.remove();
          if (row.hasAttribute('data-ag-turn-row')) row.removeAttribute('data-ag-turn-row');
          continue;
        }
        if (row.getAttribute('data-ag-turn-row') !== '1') {
          row.setAttribute('data-ag-turn-row', '1');
        }
        const meta = extractToolbarStepMeta(tb);
        if (!meta) {
          if (badge) badge.remove();
          continue;
        }
        const tbCid = meta.cascadeId || '';
        const payload = tbCid ? metricsByCid[tbCid] : null;
        const turns =
          payload && payload.hasData && Array.isArray(payload.turns) && payload.turns.length > 0
            ? payload.turns
            : null;
        if (!turns) {
          if (badge) badge.remove();
          continue;
        }
        const turn = matchTurnForToolbar(turns, meta);
        if (!turn) {
          if (badge) badge.remove();
          continue;
        }
        const { html, tooltipHtml } = formatTurnBadgeData(turn);
        if (!html) {
          if (badge) badge.remove();
          continue;
        }
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'ag-turn-metrics';
          badge.setAttribute('data-ag-turn-metrics', '1');
          row.prepend(badge);
        } else if (row.firstElementChild !== badge) {
          row.prepend(badge);
        }
        if (badge.getAttribute('data-ag-turn-html') !== html) {
          badge.setAttribute('data-ag-turn-html', html);
          badge.innerHTML = html;
        }
        if (badge.hasAttribute('title')) badge.removeAttribute('title');
        badge.__agTurnTtHtml = tooltipHtml;
        if (activeTurnBadgeEl === badge) {
          const tt = document.getElementById('ag-turn-metrics-tooltip');
          if (tt && tt.getAttribute('data-visible') === '1' && tt.getAttribute('data-ag-turn-tt-raw') !== tooltipHtml) {
            tt.setAttribute('data-ag-turn-tt-raw', tooltipHtml);
            tt.innerHTML = tooltipHtml;
            positionTurnMetricsTooltip(badge, tt);
          }
        }
      }
    } catch (e) {}
  }

  function ensureTurnMetricsObserver() {
    if (!MODULES.metrics || !document.body || typeof MutationObserver === 'undefined') return;
    if (window.__ag_turn_metrics_observer) return;
    const scheduleSync = (withPaneCheck) => {
      if (withPaneCheck) window.__ag_turn_sync_needs_pane = true;
      if (window.__ag_turn_sync_raf) return;
      window.__ag_turn_sync_raf = requestAnimationFrame(() => {
        window.__ag_turn_sync_raf = null;
        const needPane = Boolean(window.__ag_turn_sync_needs_pane);
        window.__ag_turn_sync_needs_pane = false;
        if (needPane) {
          checkRouteAndMountMetrics();
        } else {
          renderTurnMetrics();
        }
      });
    };
    window.__ag_turn_metrics_observer = new MutationObserver((mutations) => {
      let hitToolbar = false;
      let hitPane = false;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'attributes') {
          if (m.attributeName === 'data-cascade-id') {
            hitPane = true;
            break;
          }
          continue;
        }
        const checkList = (nodes) => {
          if (!nodes || nodes.length === 0) return;
          for (let j = 0; j < nodes.length; j++) {
            const n = nodes[j];
            if (n.nodeType !== 1) continue;
            const tid = n.getAttribute ? n.getAttribute('data-testid') || '' : '';
            if (
              n.id === SELECTORS.inputBoxId ||
              tid === 'side-question-tab-content' ||
              tid === 'side-question-tab-composer' ||
              tid === 'side-question-tab-conversation' ||
              (n.querySelector &&
                n.querySelector('[data-testid="side-question-tab-content"], [id="' + SELECTORS.inputBoxId + '"]'))
            ) {
              hitPane = true;
              return;
            }
            if (
              tid === 'cascade-system-message-toolbar' ||
              (n.querySelector && n.querySelector('[data-testid="cascade-system-message-toolbar"]'))
            ) {
              hitToolbar = true;
            }
          }
        };
        checkList(m.addedNodes);
        if (!hitPane) checkList(m.removedNodes);
        if (hitPane) break;
      }
      if (hitPane) {
        scheduleSync(true);
      } else if (hitToolbar) {
        scheduleSync(false);
      }
    });
    try {
      window.__ag_turn_metrics_observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-cascade-id']
      });
    } catch (e) {}
  }

  window.__ag_render_metrics = function (payload) {
    window.__ag_last_daemon_hb = Date.now();
    if (window.__ag_demo_mode && window.__ag_demo_mode.lockTelemetry) return;
    if (!payload || typeof payload !== 'object') return;
    const payloadCid = String(payload.cid || payload.cascadeId || '').trim();
    const watched = getWatchedCascadeIds();
    if (!payloadCid || !watched.includes(payloadCid)) return;

    storeMetricsPayload(payloadCid, payload);
    const mainCid = extractCascadeId();
    if (payloadCid === mainCid) {
      window.__ag_last_metrics = payload;
      if (typeof window.__ag_refresh_topbar_usage === 'function') {
        try { window.__ag_refresh_topbar_usage(); } catch {}
      }
    }
    if (!MODULES.metrics) return;

    const panes = discoverConversationPanes();
    pruneStalePills(panes);
    for (let i = 0; i < panes.length; i++) {
      const pane = panes[i];
      if (pane.cid !== payloadCid) continue;
      const pill = ensureMetricsPillForPane(pane, false, false);
      if (pill && payload.inlineHtml) {
        const textEl = pill.querySelector('.ag-live-metrics-text');
        if (textEl && textEl.getAttribute('data-ag-raw-html') !== payload.inlineHtml) {
          textEl.setAttribute('data-ag-raw-html', payload.inlineHtml);
          textEl.innerHTML = payload.inlineHtml;
          ensureMetricsPillForPane(pane, false, false);
        }
      }
      if (payload.tooltipHtml && (window.__ag_tt_owner_pane || 'main') === pane.key) {
        const tt = ensureMetricsTooltipEl();
        if (tt && tt.getAttribute('data-ag-raw-tt') !== payload.tooltipHtml) {
          tt.setAttribute('data-ag-raw-tt', payload.tooltipHtml);
          tt.innerHTML = payload.tooltipHtml;
          fitSingleLineNodes(tt, '.ag-tt-kpi-sub', 8.5);
          if (pill && tt.getAttribute('data-visible') === '1') {
            positionMetricsTooltip(pill, tt, pane.inputBox);
          }
        }
      }
    }

    ensureTurnMetricsObserver();
    renderTurnMetrics();
    applyPendingWaitVisuals();
  };

  function checkRouteAndMountMetrics() {
    if (!MODULES.metrics) return;
    const mainCid = extractCascadeId();
    const panes = discoverConversationPanes();
    pruneStalePills(panes);

    const watchedIds = getWatchedCascadeIds();
    const watchedSig = watchedIds.join(',');
    window.__ag_watched_cascade_id = mainCid || '';
    if (window.__ag_last_watched_sig !== watchedSig) {
      window.__ag_last_watched_sig = watchedSig;
      if (typeof window.__agRequestMetrics === 'function') {
        try { window.__agRequestMetrics(watchedSig); } catch (e) {}
      }
    }

    for (let i = 0; i < panes.length; i++) {
      const pane = panes[i];
      const ps = getOrCreatePaneState(pane.key);
      if (ps.cid !== pane.cid) {
        ps.cid = pane.cid;
        ps.unconnStartMs = 0;
        ps.waitStartMs = 0;
        ps.pendingKind = 'idle';
        ps.lastSteps = 0;
        ps.lastGens = 0;
        ps.lastStreamLen = 0;
        if (pane.key === 'main') {
          window.__ag_last_metrics = pane.cid && metricsByCid[pane.cid] ? metricsByCid[pane.cid] : null;
          if (typeof window.__ag_refresh_topbar_usage === 'function') {
            try { window.__ag_refresh_topbar_usage(); } catch {}
          }
        }
        if ((window.__ag_tt_owner_pane || 'main') === pane.key) {
          window.__ag_tt_pinned = false;
          window.__ag_tt_hover_opened_at = 0;
          const tt = document.getElementById('ag-live-metrics-tooltip');
          if (tt) {
            tt.removeAttribute('data-visible');
            tt.removeAttribute('data-expanded');
            tt.removeAttribute('data-ag-raw-tt');
            tt.innerHTML = '';
          }
        }
        hideTurnMetricsTooltip(true);
        try {
          const scopeRoot = pane.container && pane.container.querySelectorAll ? pane.container : document;
          scopeRoot.querySelectorAll('.ag-turn-metrics').forEach((el) => el.remove());
        } catch (e) {}
        const pill = document.getElementById(pane.pillId);
        const textEl = pill && pill.querySelector('.ag-live-metrics-text');
        if (textEl) {
          const cachedM = pane.cid ? metricsByCid[pane.cid] : null;
          if (cachedM && cachedM.hasData && cachedM.inlineHtml) {
            textEl.setAttribute('data-ag-raw-html', cachedM.inlineHtml);
            textEl.innerHTML = cachedM.inlineHtml;
          } else {
            textEl.removeAttribute('data-ag-raw-html');
            textEl.innerHTML =
              '<span class="ag-ctx-pending-dot ag-dot-idle"></span><span>' +
              (pane.cid ? '读取中...' : '就绪') +
              '</span>';
          }
        }
      }
      ensureMetricsPillForPane(pane, false, false);
    }

    ensureTurnMetricsObserver();
    renderTurnMetrics();
    applyPendingWaitVisuals();
  }

  window.__ag_on_route_change = checkRouteAndMountMetrics;

  if (!window.__ag_history_hooked) {
    window.__ag_history_hooked = true;
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const res = origPush.apply(this, arguments);
      setTimeout(() => window.__ag_on_route_change && window.__ag_on_route_change(), 40);
      return res;
    };
    history.replaceState = function () {
      const res = origReplace.apply(this, arguments);
      setTimeout(() => window.__ag_on_route_change && window.__ag_on_route_change(), 40);
      return res;
    };
  }

  const _onPopState = () => setTimeout(() => checkRouteAndMountMetrics(), 40);
  const _onVisibility = () => {
    if (!document.hidden) {
      window.__ag_visible_since = Date.now();
      applyPendingWaitVisuals();
    }
  };
  const _onNetworkChange = () => applyPendingWaitVisuals();
  const _closeMetricsTooltip = () => {
    window.__ag_tt_pinned = false;
    window.__ag_tt_hover_opened_at = 0;
    hideTurnMetricsTooltip(true);
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt) {
      tt.removeAttribute('data-expanded');
      tt.removeAttribute('data-visible');
    }
  };
  const _onEscapeKey = (e) => {
    if (e && e.key === 'Escape') {
      _closeMetricsTooltip();
    }
  };
  const _onDocClick = (e) => {
    const t = e && e.target;
    if (!t || !t.closest) return;
    if (
      t.closest('.ag-live-metrics-pill') ||
      t.closest('#ag-live-metrics-pill') ||
      t.closest('#ag-live-metrics-tooltip') ||
      t.closest('#ag-turn-metrics-tooltip')
    ) {
      return;
    }
    _closeMetricsTooltip();
  };
  const _onTurnMouseOver = (e) => {
    if (!MODULES.metrics) return;
    const t = e && e.target;
    if (!t || !t.closest) return;
    const badge = t.closest('.ag-turn-metrics');
    if (!badge) return;
    scheduleShowTurnMetricsTooltip(badge);
  };
  const _onTurnMouseOut = (e) => {
    const t = e && e.target;
    if (!t || !t.closest) return;
    const badge = t.closest('.ag-turn-metrics');
    if (!badge) return;
    const rel = e.relatedTarget;
    if (rel && rel.closest && (rel.closest('.ag-turn-metrics') === badge || rel.closest('#ag-turn-metrics-tooltip'))) {
      return;
    }
    hideTurnMetricsTooltip(false);
  };
  const _onTurnScroll = () => {
    if (activeTurnBadgeEl || window.__ag_turn_tt_show_timer) {
      hideTurnMetricsTooltip(true);
    }
  };

  window.__ag_tt_pinned = false;
  window.__ag_tt_hover_opened_at = 0;
  window.__ag_tt_owner_pane = 'main';
  window.__ag_last_watched_sig = '';

  window.addEventListener('popstate', _onPopState);
  document.addEventListener('visibilitychange', _onVisibility);
  window.addEventListener('online', _onNetworkChange);
  window.addEventListener('offline', _onNetworkChange);
  window.addEventListener('keydown', _onEscapeKey, true);
  document.addEventListener('click', _onDocClick, true);
  document.addEventListener('mouseover', _onTurnMouseOver, true);
  document.addEventListener('mouseout', _onTurnMouseOut, true);
  window.addEventListener('scroll', _onTurnScroll, true);

  if (MODULES.metrics) {
    if (!window.__ag_visible_since) window.__ag_visible_since = Date.now();
    window.__ag_metrics_route_watcher = setInterval(() => {
      if (!document.hidden) checkRouteAndMountMetrics();
    }, 2000);
    window.__ag_live_probe_timer = setInterval(() => {
      if (!document.hidden) applyPendingWaitVisuals();
    }, 1000);
  } else {
    try {
      hideTurnMetricsTooltip(true);
      document.querySelectorAll('.ag-turn-metrics, .ag-live-metrics-pill').forEach((el) => el.remove());
      document.querySelectorAll('[data-ag-row-mode]').forEach((el) => el.removeAttribute('data-ag-row-mode'));
      for (const k of Object.keys(paneStates)) {
        const ps = paneStates[k];
        if (ps && ps.roRaf && typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(ps.roRaf); } catch (e) {}
          ps.roRaf = 0;
        }
        if (ps && ps.ro) {
          ps.ro.disconnect();
          ps.ro = null;
          ps.roObserved = null;
        }
      }
    } catch (e) {}
  }

  window.__ag_cleanup_fns.push(() => {
    window.removeEventListener('popstate', _onPopState);
    document.removeEventListener('visibilitychange', _onVisibility);
    window.removeEventListener('online', _onNetworkChange);
    window.removeEventListener('offline', _onNetworkChange);
    window.removeEventListener('keydown', _onEscapeKey, true);
    document.removeEventListener('click', _onDocClick, true);
    document.removeEventListener('mouseover', _onTurnMouseOver, true);
    document.removeEventListener('mouseout', _onTurnMouseOut, true);
    window.removeEventListener('scroll', _onTurnScroll, true);
    clearTurnTooltipTimers();
    activeTurnBadgeEl = null;
    window.__ag_tt_pinned = false;
    window.__ag_tt_hover_opened_at = 0;
    try {
      clearCompactFxForPane('main');
      clearCompactFxForPane('side');
      document.querySelectorAll('.ag-composer-compact-rim, .ag-compact-swap-line').forEach((el) => el.remove());
      document.querySelectorAll('[data-ag-compact-fx]').forEach((el) => el.removeAttribute('data-ag-compact-fx'));
      document.querySelectorAll('[data-ag-compact-phase]').forEach((el) => el.removeAttribute('data-ag-compact-phase'));
      document.querySelectorAll('[data-ag-row-mode]').forEach((el) => el.removeAttribute('data-ag-row-mode'));
    } catch (e) {}
    for (const k of Object.keys(paneStates)) {
      const ps = paneStates[k];
      if (ps && ps.roRaf && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(ps.roRaf); } catch (e) {}
        ps.roRaf = 0;
      }
      if (ps && ps.ro) {
        try { ps.ro.disconnect(); } catch (e) {}
        ps.ro = null;
        ps.roObserved = null;
      }
    }
    if (window.__ag_turn_metrics_observer) {
      try { window.__ag_turn_metrics_observer.disconnect(); } catch (e) {}
      window.__ag_turn_metrics_observer = null;
    }
    if (window.__ag_metrics_route_watcher) {
      clearInterval(window.__ag_metrics_route_watcher);
      window.__ag_metrics_route_watcher = null;
    }
    if (window.__ag_live_probe_timer) {
      clearInterval(window.__ag_live_probe_timer);
      window.__ag_live_probe_timer = null;
    }
    if (window.__ag_tt_show_timer) {
      clearTimeout(window.__ag_tt_show_timer);
      window.__ag_tt_show_timer = null;
    }
    if (window.__ag_tt_hide_timer) {
      clearTimeout(window.__ag_tt_hide_timer);
      window.__ag_tt_hide_timer = null;
    }
  });
