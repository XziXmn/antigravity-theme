/**
 * Part 78: Per-Conversation Flow Mode Picker (mounted beside Antigravity's permission selector)
 * Allows switching between default / writing / engineering / full per conversation (including new drafts),
 * shows live proxy/outcome status indicator, and offers quick per-session seat override with hot-word check.
 */
  function cleanupFlowModePickerDom() {
    try {
      for (const id of ['ag-flow-mode-menu', 'ag-flow-mode-trigger-main', 'ag-flow-mode-trigger-side']) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
      document.querySelectorAll('.ag-flow-mode-trigger').forEach((el) => el.remove());
    } catch {}
  }

  function mountFlowModePicker() {
    if (IS_SWARM_PLUGIN_FRAME || !ENABLED || !MODULES.flow) {
      cleanupFlowModePickerDom();
      return;
    }
    if (typeof document === 'undefined' || !document.body) return;

    (function initFlowModePicker() {
      const FLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const PERM_TEXT_RE = /^(?:Turbo|Auto|Default|Strict|Ask|全自动|智能判断|默认|严格|全自動|智慧判斷|預設|嚴格)$/i;
      let disposed = false;
      let reqSeq = 0;
      const pendingReqs = new Map();
      let openPaneKey = '';
      let seatEditorOpen = false;
      let hotWarnText = '';
      let scanTimer = null;
      let mo = null;

      const paneData = {
        main: { cid: '', prevCid: '', mode: boot.flow?.defaultMode || 'default', seatOverride: '', runtime: null, compaction: null, isDraft: true },
        side: { cid: '', prevCid: '', mode: boot.flow?.defaultMode || 'default', seatOverride: '', runtime: null, compaction: null, isDraft: true }
      };
      const prevFlowCache = window.__ag_flow_status_state && typeof window.__ag_flow_status_state === 'object' ? window.__ag_flow_status_state : null;
      let proxyInfo = prevFlowCache?.proxy ? Object.assign({}, prevFlowCache.proxy) : { running: false, port: boot.flow?.port || 18100, error: '' };
      let asarInfo = prevFlowCache?.asar ? Object.assign({}, prevFlowCache.asar) : { found: false, patched: false, status: 'original' };
      let compactConfig = prevFlowCache?.compactConfig
        ? Object.assign({}, prevFlowCache.compactConfig)
        : {
            enabled: Boolean(boot.flow?.compactEnabled),
            thresholdPct: Number(boot.flow?.compactThresholdPct || 70),
            keepTailTokens: Number(boot.flow?.compactKeepTailTokens || 20000)
          };
      let lastSuccessfulSyncAt = Number(prevFlowCache?.updatedAt || 0);

      function publishFlowStatusCache() {
        try {
          window.__ag_flow_status_state = {
            proxy: Object.assign({}, proxyInfo),
            asar: Object.assign({}, asarInfo),
            compactConfig: Object.assign({}, compactConfig),
            panes: {
              main: Object.assign({}, paneData.main),
              side: Object.assign({}, paneData.side)
            },
            updatedAt: Date.now()
          };
          if (typeof window.__ag_refresh_telemetry_flow === 'function') {
            window.__ag_refresh_telemetry_flow();
          }
        } catch {}
      }

      publishFlowStatusCache();

      function getLocale() {
        const loc = I18N_LOCALE || 'zh-CN';
        return loc === 'zh-TW' || loc === 'en' ? loc : 'zh-CN';
      }

      function getCopy() {
        const loc = getLocale();
        if (loc === 'en') {
          return {
            scopeSession: 'Chat Mode',
            scopeDraft: 'New Chat',
            proxyOn: 'Relay',
            proxyOff: 'Off',
            asarUnpatched: 'Direct',
            seatToggle: 'Chat Note',
            seatPlaceholder: 'Optional instruction for this chat only...',
            save: 'Apply',
            clear: 'Clear',
            moreSettings: 'Settings ->',
            lastLabel: 'Last: ',
            lastNone: 'Idle',
            hotPrefix: 'Sensitive: ',
            modes: [
              { id: 'default', short: 'Default', title: 'Default', desc: 'Direct passthrough' },
              { id: 'writing', short: 'Writing', title: 'Writing', desc: 'Auto-continue & refusal rewrite' },
              { id: 'engineering', short: 'Eng', title: 'Engineering', desc: 'History scrub & softened retry' },
              { id: 'full', short: 'Full', title: 'Full', desc: 'Continue + rewrite + fallback' }
            ]
          };
        }
        if (loc === 'zh-TW') {
          return {
            scopeSession: '對話模式',
            scopeDraft: '新對話',
            proxyOn: '轉發',
            proxyOff: '未啟',
            asarUnpatched: '未接管',
            seatToggle: '對話指令',
            seatPlaceholder: '選填：僅對目前對話生效的補充提示詞…',
            save: '套用',
            clear: '清除',
            moreSettings: '設定 →',
            lastLabel: '上輪：',
            lastNone: '待命',
            hotPrefix: '敏感詞：',
            modes: [
              { id: 'default', short: '預設', title: '預設模式', desc: '直接連線，不做處理' },
              { id: 'writing', short: '寫作', title: '寫作模式', desc: '自動續寫、拒絕改寫與對白保護' },
              { id: 'engineering', short: '工程', title: '工程模式', desc: '歷史淨化與措辭軟化重試' },
              { id: 'full', short: '全面', title: '全面模式', desc: '續寫 + 改寫 + 備用模型' }
            ]
          };
        }
        return {
          scopeSession: '会话模式',
          scopeDraft: '新会话',
          proxyOn: '转发',
          proxyOff: '未启',
          asarUnpatched: '未接管',
          seatToggle: '会话指令',
          seatPlaceholder: '选填：仅对当前会话生效的补充提示词…',
          save: '应用',
          clear: '清空',
          moreSettings: '设置 →',
          lastLabel: '上轮：',
          lastNone: '待命',
          hotPrefix: '敏感词：',
          modes: [
            { id: 'default', short: '默认', title: '默认模式', desc: '直接连接，不做处理' },
            { id: 'writing', short: '写作', title: '写作模式', desc: '自动续写、拒绝改写与对白保护' },
            { id: 'engineering', short: '工程', title: '工程模式', desc: '历史净化与措辞软化重试' },
            { id: 'full', short: '全面', title: '全面模式', desc: '续写 + 改写 + 备用模型' }
          ]
        };
      }

      function callFlowBinding(bindingName, payload, timeoutMs = 5000) {
        return new Promise((resolve) => {
          const fn = window[bindingName];
          if (typeof fn !== 'function') {
            resolve({ ok: false, error: 'binding unavailable' });
            return;
          }
          const reqId = 'fl_' + Date.now().toString(36) + '_' + ++reqSeq;
          const timer = setTimeout(() => {
            pendingReqs.delete(reqId);
            resolve({ ok: false, error: 'timeout' });
          }, timeoutMs);
          pendingReqs.set(reqId, (res) => {
            clearTimeout(timer);
            resolve(res || { ok: false });
          });
          try {
            fn(JSON.stringify(Object.assign({ reqId }, payload || {})));
          } catch {
            clearTimeout(timer);
            pendingReqs.delete(reqId);
            resolve({ ok: false });
          }
        });
      }

      const handleBindingResponse = function (reqId, payload) {
        const cb = pendingReqs.get(reqId);
        if (cb) {
          pendingReqs.delete(reqId);
          try {
            cb(payload);
          } catch {}
        }
      };
      window.__ag_on_flow_response = handleBindingResponse;
      window.__ag_on_flow_compact_response = handleBindingResponse;

      function callFlowCompactAction(action, cascadeId) {
        return callFlowBinding('__agFlowCompactAction', { action, cascadeId }, 65000);
      }

      let lastPaneRefreshAt = { main: 0, side: 0 };
      window.__ag_refresh_flow_state_for_pane = function (pkRaw) {
        const pk = pkRaw === 'side' ? 'side' : 'main';
        const now = Date.now();
        if (now - (lastPaneRefreshAt[pk] || 0) < 1500) return;
        lastPaneRefreshAt[pk] = now;
        const st = paneData[pk];
        void callFlowBinding('__agFlowGetState', {
          cascadeId: st.cid || '__draft__:' + pk,
          paneKey: pk
        }).then((res) => applyFlowStateResponse(pk, res));
      };

      window.__ag_on_flow_event = function (ev) {
        if (disposed || !ev || typeof ev !== 'object') return;
        let shouldRefreshCompact = false;
        let compactFxDispatched = false;
        const isCompactEv =
          ev.type === 'compact-start' ||
          ev.type === 'compact' ||
          ev.type === 'compaction' ||
          ev.type === 'compact-hijack';
        for (const pk of ['main', 'side']) {
          const st = paneData[pk];
          const matchCid =
            (ev.cascadeId && st.cid && ev.cascadeId === st.cid) ||
            (ev.cascadeId && st.isDraft && ev.cascadeId === '__draft__:' + pk);
          if (!matchCid) continue;
          if (ev.mode) st.mode = ev.mode;
          if (typeof ev.seatOverride === 'string') st.seatOverride = ev.seatOverride;
          if (ev.runtime) st.runtime = ev.runtime;
          if (ev.compaction && typeof ev.compaction === 'object') st.compaction = ev.compaction;
          if (ev.type === 'outcome') {
            st.runtime = Object.assign({}, st.runtime || {}, {
              lastVerdict: ev.verdict || 'pass',
              lastDetail: ev.detail || '',
              ms: ev.ms || 0
            });
          }
          if (ev.type === 'compact-start') {
            st.compaction = Object.assign({}, st.compaction || {}, { inFlight: true });
          } else if (ev.type === 'compact' || ev.type === 'compaction') {
            if (ev.status && typeof ev.status === 'object') {
              st.compaction = ev.status;
            } else {
              st.compaction = Object.assign({}, st.compaction || {}, { inFlight: false });
            }
            shouldRefreshCompact = pk;
          }
          if (isCompactEv && typeof window.__ag_on_flow_compact_fx === 'function') {
            window.__ag_on_flow_compact_fx(ev, pk);
            compactFxDispatched = true;
          }
          updateTriggerVisual(pk);
          if (openPaneKey === pk) renderMenuContent(pk);
        }
        if (isCompactEv && !compactFxDispatched && typeof window.__ag_on_flow_compact_fx === 'function') {
          window.__ag_on_flow_compact_fx(ev, 'main');
        }
        if (
          (ev.type === 'recovery-stage' || ev.type === 'outcome') &&
          typeof window.__ag_on_flow_recovery_event === 'function'
        ) {
          window.__ag_on_flow_recovery_event(ev);
        }
        publishFlowStatusCache();
        if (shouldRefreshCompact && typeof window.__ag_refresh_flow_state_for_pane === 'function') {
          window.__ag_refresh_flow_state_for_pane(shouldRefreshCompact);
        }
      };

      function getMainCid() {
        try {
          const p = String(window.location?.pathname || '');
          const m = p.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-zA-Z_-]{8,})/i);
          if (m && m[1]) return m[1];
          const view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
          const vcid = view ? String(view.getAttribute('data-cascade-id') || '').trim() : '';
          if (FLOW_UUID_RE.test(vcid)) return vcid;
          if (!document.querySelector('[data-testid="home-greeting"], [data-testid="home-splash-content"]')) {
            const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
            const scid = sel ? String(sel.getAttribute('data-cascade-id') || '').trim() : '';
            if (scid) return scid;
          }
        } catch {}
        return '';
      }

      function getSideCid(sideContent) {
        try {
          if (!sideContent) return '';
          const conv = sideContent.querySelector('[data-testid="side-question-tab-conversation"][data-cascade-id]');
          const cid = conv ? String(conv.getAttribute('data-cascade-id') || '').trim() : '';
          if (FLOW_UUID_RE.test(cid)) return cid;
        } catch {}
        return '';
      }

      function discoverPanes() {
        const out = [];
        try {
          const boxes = document.querySelectorAll('[id="' + SELECTORS.inputBoxId + '"]');
          let mainSeen = false;
          let sideSeen = false;
          for (let i = 0; i < boxes.length; i += 1) {
            const box = boxes[i];
            const sideContent = box.closest ? box.closest('[data-testid="side-question-tab-content"]') : null;
            const inSide = Boolean(sideContent || (box.closest && box.closest('[data-testid="side-question-tab-composer"]')));
            if (inSide) {
              if (sideSeen) continue;
              sideSeen = true;
              out.push({ key: 'side', inputBox: box, cid: getSideCid(sideContent) });
            } else {
              if (mainSeen) continue;
              mainSeen = true;
              out.push({ key: 'main', inputBox: box, cid: getMainCid() });
            }
          }
        } catch {}
        return out;
      }

      function findToolbarAnchor(inputBox) {
        if (!inputBox || !inputBox.querySelector) return null;
        const modelTrigger = inputBox.querySelector('[data-testid="model-selector-trigger"]');
        const footer =
          (modelTrigger && modelTrigger.closest && modelTrigger.closest('.agy-composer-footer, [data-agent-composer-root]')) ||
          inputBox.querySelector('.agy-composer-footer') ||
          inputBox;

        // 1. Direct match on Antigravity's native permission selector (right side beside Send button)
        const explicitPerm = footer.querySelector(
          '[data-testid="permissions-selector-trigger"], [data-testid*="permission"], [data-ag-orig-aria-label^="Agent permissions"], [data-ag-orig-aria-label^="Permission mode"], [aria-label^="Permission mode"], [aria-label^="权限模式"], [aria-label^="權限模式"]'
        );
        if (explicitPerm && !explicitPerm.classList.contains('ag-flow-mode-trigger')) {
          return { anchor: explicitPerm, position: 'beforebegin' };
        }

        // 2. Text fallback across footer buttons (search right-to-left so rightGroup permission pill wins)
        const btns = Array.from(footer.querySelectorAll('button, [role="button"]'));
        for (let i = btns.length - 1; i >= 0; i -= 1) {
          const b = btns[i];
          if (b === modelTrigger || b.classList.contains('ag-flow-mode-trigger')) continue;
          const txt = String(b.innerText || b.textContent || '').trim();
          if (PERM_TEXT_RE.test(txt)) {
            return { anchor: b, position: 'beforebegin' };
          }
        }

        // 3. Fallback: prepend inside the right toolbar group if present
        if (footer && footer.children && footer.children.length >= 2) {
          const rightGroup = footer.children[footer.children.length - 1];
          if (rightGroup && rightGroup.firstElementChild && !rightGroup.contains(modelTrigger)) {
            return { anchor: rightGroup.firstElementChild, position: 'beforebegin' };
          }
        }

        if (modelTrigger && modelTrigger.parentElement) {
          return { anchor: modelTrigger, position: 'afterend' };
        }
        return null;
      }

      function getModeIconSvg(modeId, size = 14) {
        const s = String(size || 14);
        if (modeId === 'writing') {
          return (
            '<svg class="ag-flow-icon" width="' +
            s +
            '" height="' +
            s +
            '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M11.8 2.2a1.7 1.7 0 0 1 2.4 2.4L6.1 12.7l-3.1.8.8-3.1 8-8.2z"/>' +
            '<path d="M10.2 3.8l2 2"/>' +
            '</svg>'
          );
        }
        if (modeId === 'engineering') {
          return (
            '<svg class="ag-flow-icon" width="' +
            s +
            '" height="' +
            s +
            '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="2" y="2.8" width="12" height="10.4" rx="2"/>' +
            '<path d="M5 6.4l2 1.8-2 1.8M8.5 10h2.5"/>' +
            '</svg>'
          );
        }
        if (modeId === 'full') {
          return (
            '<svg class="ag-flow-icon" width="' +
            s +
            '" height="' +
            s +
            '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M8 1.9l5 2v3.9c0 3.1-2.1 5.3-5 6.3-2.9-1-5-3.2-5-6.3V3.9l5-2z"/>' +
            '<path d="M5.9 8.1l1.5 1.5 2.9-3"/>' +
            '</svg>'
          );
        }
        return (
          '<svg class="ag-flow-icon" width="' +
          s +
          '" height="' +
          s +
          '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="5.6"/>' +
          '<path d="M10.4 5.6l-1.5 3.3-3.3 1.5 1.5-3.3 3.3-1.5z"/>' +
          '</svg>'
        );
      }

      const CHECK_ICON_SVG =
        '<svg class="ag-flow-item-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-6.8"/></svg>';
      const NOTE_ICON_SVG =
        '<svg class="ag-flow-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 3.2h9.6a1 1 0 0 1 1 1v7.6a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1z"/><path d="M5.2 6.2h5.6M5.2 9.4h3.6"/></svg>';

      function getModeMeta(modeId) {
        const copy = getCopy();
        return copy.modes.find((m) => m.id === modeId) || copy.modes[0];
      }

      function updateTriggerVisual(pk) {
        const btn = document.getElementById('ag-flow-mode-trigger-' + pk);
        if (!btn) return;
        const st = paneData[pk];
        const copy = getCopy();
        const meta = getModeMeta(st.mode);
        const iconWrap = btn.querySelector('.ag-flow-icon-wrap');
        const lbl = btn.querySelector('.ag-flow-label');
        if (iconWrap && iconWrap.getAttribute('data-mode') !== st.mode) {
          iconWrap.setAttribute('data-mode', st.mode);
          iconWrap.innerHTML = getModeIconSvg(st.mode, 14);
        }
        const needsRelay = st.mode !== 'default' || Boolean(compactConfig.enabled);
        const unpatched = needsRelay && (!proxyInfo.running || (asarInfo.found && !asarInfo.patched));
        if (lbl) lbl.textContent = unpatched ? meta.short + ' · ' + copy.asarUnpatched : meta.short;
        btn.setAttribute('data-ag-flow-active', st.mode !== 'default' ? '1' : '0');
        if (unpatched) {
          btn.setAttribute('data-ag-flow-unpatched', '1');
          btn.title =
            getLocale() === 'en'
              ? 'Flow relay not intercepting (app.asar unpatched or proxy off). Enable Traffic Redirect in Settings.'
              : 'Flow 未接管（app.asar 未改道或代理未启动，客户端更新后需重新在「设置 → 代理与接管」开启接管）';
        } else {
          btn.removeAttribute('data-ag-flow-unpatched');
          btn.removeAttribute('title');
        }
        btn.setAttribute('aria-expanded', openPaneKey === pk ? 'true' : 'false');
      }

      function ensureMenuEl() {
        let menu = document.getElementById('ag-flow-mode-menu');
        if (!menu) {
          menu = document.createElement('div');
          menu.id = 'ag-flow-mode-menu';
          menu.setAttribute('data-agi18n-ignore', 'true');
          menu.setAttribute('role', 'menu');
          document.body.appendChild(menu);
        }
        return menu;
      }

      function closeMenu() {
        const prev = openPaneKey;
        openPaneKey = '';
        seatEditorOpen = false;
        hotWarnText = '';
        const menu = document.getElementById('ag-flow-mode-menu');
        if (menu) menu.removeAttribute('data-open');
        if (prev) updateTriggerVisual(prev);
      }

      function positionMenu(triggerEl, menuEl) {
        if (!triggerEl || !menuEl) return;
        try {
          const r = triggerEl.getBoundingClientRect();
          const mw = menuEl.offsetWidth || 292;
          const mh = menuEl.offsetHeight || 220;
          const vw = window.innerWidth || 1280;
          const left = Math.max(8, Math.min(Math.round(r.right - mw), vw - mw - 8));
          let top = Math.round(r.top - mh - 8);
          if (top < 8) top = Math.round(r.bottom + 8);
          menuEl.style.left = left + 'px';
          menuEl.style.top = top + 'px';
        } catch {}
      }

      function renderMenuContent(pk) {
        const menu = ensureMenuEl();
        const copy = getCopy();
        const st = paneData[pk];
        menu.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'ag-flow-menu-head';
        const scopeSpan = document.createElement('span');
        scopeSpan.textContent = st.isDraft ? copy.scopeDraft : copy.scopeSession;
        head.appendChild(scopeSpan);
        if (!proxyInfo.running || (asarInfo.found && !asarInfo.patched)) {
          const warnBadge = document.createElement('span');
          warnBadge.className = 'ag-flow-menu-badge-warn';
          warnBadge.textContent = !proxyInfo.running ? copy.proxyOff : copy.asarUnpatched;
          head.appendChild(warnBadge);
        }
        menu.appendChild(head);

        for (const m of copy.modes) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ag-flow-menu-item';
          item.setAttribute('role', 'menuitemradio');
          item.setAttribute('aria-checked', st.mode === m.id ? 'true' : 'false');

          const iconCol = document.createElement('span');
          iconCol.className = 'ag-flow-item-icon';
          iconCol.innerHTML = getModeIconSvg(m.id, 16);

          const body = document.createElement('div');
          body.className = 'ag-flow-item-body';
          const t = document.createElement('div');
          t.className = 'ag-flow-item-title';
          t.textContent = m.title;
          const d = document.createElement('div');
          d.className = 'ag-flow-item-desc';
          d.textContent = m.desc;
          body.appendChild(t);
          body.appendChild(d);

          const chk = document.createElement('span');
          chk.className = 'ag-flow-item-check-wrap';
          chk.innerHTML = st.mode === m.id ? CHECK_ICON_SVG : '';

          item.appendChild(iconCol);
          item.appendChild(body);
          item.appendChild(chk);
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            st.mode = m.id;
            updateTriggerVisual(pk);
            publishFlowStatusCache();
            const targetCid = st.cid || '__draft__:' + pk;
            void callFlowBinding('__agFlowSetSessionMode', {
              cascadeId: targetCid,
              paneKey: pk,
              mode: m.id
            }).then((res) => {
              if (res && res.ok) applyFlowStateResponse(pk, res);
            });
            closeMenu();
          });
          menu.appendChild(item);
        }

        const sep = document.createElement('div');
        sep.className = 'ag-flow-menu-sep';
        menu.appendChild(sep);

        if (seatEditorOpen) {
          const box = document.createElement('div');
          box.className = 'ag-flow-seat-box';
          const ta = document.createElement('textarea');
          ta.value = st.seatOverride || '';
          ta.placeholder = copy.seatPlaceholder;
          const warn = document.createElement('div');
          warn.className = 'ag-flow-hot-warn';
          warn.textContent = hotWarnText;

          let scanDeb = null;
          ta.addEventListener('input', () => {
            if (scanDeb) clearTimeout(scanDeb);
            scanDeb = setTimeout(() => {
              void callFlowBinding('__agFlowScanHotWords', { text: ta.value }).then((r) => {
                if (r && r.ok && Array.isArray(r.hot) && r.hot.length > 0) {
                  hotWarnText = copy.hotPrefix + r.hot.join(', ');
                } else {
                  hotWarnText = '';
                }
                warn.textContent = hotWarnText;
              });
            }, 220);
          });

          const actions = document.createElement('div');
          actions.className = 'ag-flow-seat-actions';
          const btnClear = document.createElement('button');
          btnClear.type = 'button';
          btnClear.className = 'ag-flow-btn-sm';
          btnClear.textContent = copy.clear;
          btnClear.addEventListener('click', (e) => {
            e.stopPropagation();
            ta.value = '';
            hotWarnText = '';
            warn.textContent = '';
            st.seatOverride = '';
            void callFlowBinding('__agFlowSetSessionMode', {
              cascadeId: st.cid || '__draft__:' + pk,
              paneKey: pk,
              mode: st.mode,
              seatOverride: ''
            });
          });
          const btnSave = document.createElement('button');
          btnSave.type = 'button';
          btnSave.className = 'ag-flow-btn-sm is-primary';
          btnSave.textContent = copy.save;
          btnSave.addEventListener('click', (e) => {
            e.stopPropagation();
            st.seatOverride = ta.value;
            void callFlowBinding('__agFlowSetSessionMode', {
              cascadeId: st.cid || '__draft__:' + pk,
              paneKey: pk,
              mode: st.mode,
              seatOverride: ta.value
            }).then(() => {
              seatEditorOpen = false;
              renderMenuContent(pk);
            });
          });
          actions.appendChild(btnClear);
          actions.appendChild(btnSave);
          box.appendChild(ta);
          box.appendChild(warn);
          box.appendChild(actions);
          menu.appendChild(box);
        }

        const footer = document.createElement('div');
        footer.className = 'ag-flow-footer-links';
        const btnSeat = document.createElement('button');
        btnSeat.type = 'button';
        btnSeat.className = 'ag-flow-link-btn';
        btnSeat.innerHTML =
          NOTE_ICON_SVG +
          '<span>' +
          copy.seatToggle +
          (st.seatOverride ? ' •' : '') +
          '</span>';
        btnSeat.addEventListener('click', (e) => {
          e.stopPropagation();
          seatEditorOpen = !seatEditorOpen;
          renderMenuContent(pk);
          const trg = document.getElementById('ag-flow-mode-trigger-' + pk);
          if (trg) positionMenu(trg, menu);
        });
        footer.appendChild(btnSeat);
        menu.appendChild(footer);
      }

      function applyFlowStateResponse(pk, res) {
        if (!res || !res.ok) return;
        lastSuccessfulSyncAt = Date.now();
        if (res.proxy) proxyInfo = res.proxy;
        if (res.asar) asarInfo = res.asar;
        if (res.compactConfig && typeof res.compactConfig === 'object') {
          compactConfig = Object.assign({}, compactConfig, res.compactConfig);
        }
        const st = paneData[pk];
        if (res.session) {
          st.mode = res.session.mode || st.mode;
          st.seatOverride = res.session.seatOverride || '';
          st.runtime = res.session.runtime || st.runtime;
        }
        if (res.compaction && typeof res.compaction === 'object') {
          st.compaction = res.compaction;
          if (st.cid && typeof window.__ag_sync_flow_compact_status === 'function') {
            window.__ag_sync_flow_compact_status(st.cid, res.compaction, pk);
          }
        }
        updateTriggerVisual(pk);
        publishFlowStatusCache();
        if (openPaneKey === pk) renderMenuContent(pk);
      }

      function syncPaneTrigger(pane) {
        const { key: pk, inputBox, cid } = pane;
        const st = paneData[pk];
        const transitionedFromDraft = Boolean(!st.prevCid && cid);
        const cidChanged = st.cid !== cid;
        st.prevCid = st.cid;
        st.cid = cid;
        st.isDraft = !cid;

        const target = findToolbarAnchor(inputBox);
        if (!target || !target.anchor || !target.anchor.parentElement) return;
        const { anchor, position } = target;

        const btnId = 'ag-flow-mode-trigger-' + pk;
        let btn = document.getElementById(btnId);
        if (!btn) {
          btn = document.createElement('button');
          btn.id = btnId;
          btn.type = 'button';
          btn.className =
            'ag-flow-mode-trigger flex cursor-pointer items-center h-7 gap-1 rounded-full pl-1.5 pr-2 text-sm text-secondary-foreground select-none outline-none hover:bg-secondary transition-colors shrink-0 whitespace-nowrap';
          btn.setAttribute('data-agi18n-ignore', 'true');
          btn.setAttribute('aria-haspopup', 'menu');
          btn.setAttribute('aria-expanded', 'false');
          btn.innerHTML = '<span class="ag-flow-icon-wrap" data-mode=""></span><span class="ag-flow-label"></span>';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (openPaneKey === pk) {
              closeMenu();
              return;
            }
            openPaneKey = pk;
            seatEditorOpen = false;
            const menu = ensureMenuEl();
            renderMenuContent(pk);
            menu.setAttribute('data-open', '1');
            positionMenu(btn, menu);
            updateTriggerVisual(pk);
            void callFlowBinding('__agFlowGetState', {
              cascadeId: st.cid || '__draft__:' + pk,
              paneKey: pk
            }).then((res) => applyFlowStateResponse(pk, res));
          });
        }

        const alreadyPlaced =
          position === 'beforebegin'
            ? btn.nextElementSibling === anchor
            : btn.previousElementSibling === anchor;
        if (!alreadyPlaced) {
          anchor.insertAdjacentElement(position, btn);
        }
        updateTriggerVisual(pk);

        if (cidChanged || transitionedFromDraft || !btn.getAttribute('data-ag-flow-synced')) {
          btn.setAttribute('data-ag-flow-synced', '1');
          void callFlowBinding('__agFlowGetState', {
            cascadeId: cid || '__draft__:' + pk,
            paneKey: pk,
            claimDraft: transitionedFromDraft
          }).then((res) => applyFlowStateResponse(pk, res));
        }
      }

      function scanAllPanes() {
        if (disposed) return;
        const panes = discoverPanes();
        for (let i = 0; i < panes.length; i += 1) {
          syncPaneTrigger(panes[i]);
        }
      }

      const onDocClick = (e) => {
        if (!openPaneKey) return;
        const menu = document.getElementById('ag-flow-mode-menu');
        const trg = document.getElementById('ag-flow-mode-trigger-' + openPaneKey);
        if (menu && menu.contains(e.target)) return;
        if (trg && trg.contains(e.target)) return;
        closeMenu();
      };
      const onKeyDown = (e) => {
        if (e.key === 'Escape' && openPaneKey) closeMenu();
      };

      function isSlidingCompactHijackActive() {
        return Boolean(compactConfig.enabled && proxyInfo.running && asarInfo.patched);
      }

      function readEditorSlashText(editorEl) {
        if (!editorEl) return '';
        const raw =
          typeof editorEl.value === 'string'
            ? editorEl.value
            : editorEl.innerText || editorEl.textContent || '';
        return String(raw).replace(/[\u200B-\u200D\uFEFF\r]/g, '').trim();
      }

      function isSlashCompactCommand(text) {
        return /^\/compact(?:\s|$)/i.test(String(text || '').trim());
      }

      function stripIconText(el) {
        if (!el) return '';
        try {
          const parts = [];
          const stack = [el];
          while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (node.nodeType === 3) {
              if (node.nodeValue) parts.push(node.nodeValue);
              continue;
            }
            if (node.nodeType !== 1) continue;
            const tag = node.tagName ? node.tagName.toUpperCase() : '';
            if (tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT') continue;
            if (node.getAttribute && (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('data-symbol-name'))) {
              continue;
            }
            const children = node.childNodes;
            if (children && children.length) {
              for (let i = children.length - 1; i >= 0; i -= 1) {
                stack.push(children[i]);
              }
            }
          }
          return parts.join('').replace(/[\u200B-\u200D\uFEFF\r]/g, '').trim();
        } catch {
          return '';
        }
      }

      function readSlashScopeNameFromProps(obj) {
        if (!obj || typeof obj !== 'object') return '';
        const candidate =
          (obj.item && obj.item.scopeItem) ||
          (obj.option && obj.option.item && obj.option.item.scopeItem) ||
          (obj.scopeItem) ||
          null;
        if (candidate && candidate.case === 'slashCommand') {
          return String(candidate.value?.info?.name || '').trim();
        }
        return '';
      }

      function extractSlashCommandNameFromReact(el) {
        if (!el) return '';
        try {
          const candidates = [el];
          if (el.firstElementChild) candidates.push(el.firstElementChild);
          const bdiParent = el.closest ? el.closest('bdi') : null;
          if (bdiParent && bdiParent !== el && candidates.length < 3) candidates.push(bdiParent);

          for (let i = 0; i < candidates.length && i < 3; i += 1) {
            const node = candidates[i];
            if (!node) continue;
            const keys = Object.keys(node);
            for (let k = 0; k < keys.length; k += 1) {
              const key = keys[k];
              if (key.startsWith('__reactProps$')) {
                const name = readSlashScopeNameFromProps(node[key]);
                if (name) return name;
              } else if (key.startsWith('__reactFiber$')) {
                let fiber = node[key];
                for (let depth = 0; fiber && depth < 8; depth += 1) {
                  const name = readSlashScopeNameFromProps(fiber.memoizedProps);
                  if (name) return name;
                  fiber = fiber.return;
                }
              }
            }
          }
        } catch {}
        return '';
      }

      function isCompactSlashChipEl(el) {
        if (!el) return false;
        try {
          const ownTip = el.getAttribute ? String(el.getAttribute('data-tooltip-id') || '') : '';
          if (/^slashCommand:\/?compact$/i.test(ownTip)) return true;
          const descTip = el.querySelector ? el.querySelector('[data-tooltip-id]') : null;
          if (descTip && /^slashCommand:\/?compact$/i.test(String(descTip.getAttribute('data-tooltip-id') || ''))) {
            return true;
          }
          const reactName = extractSlashCommandNameFromReact(el);
          if (/^\/?compact$/i.test(reactName)) return true;
          const isChipNode =
            (el.tagName && el.tagName.toUpperCase() === 'BDI') ||
            (el.getAttribute && el.getAttribute('data-lexical-decorator') === 'true');
          if (isChipNode && /^\/?compact$/i.test(stripIconText(el))) return true;
        } catch {}
        return false;
      }

      function isEditorSlashCompactCommand(editorEl) {
        if (!editorEl) return false;
        if (isSlashCompactCommand(readEditorSlashText(editorEl))) return true;
        try {
          const chips = editorEl.querySelectorAll('bdi, [data-lexical-decorator="true"], [data-tooltip-id^="slashCommand:"]');
          for (let i = 0; i < chips.length; i += 1) {
            const chip = chips[i];
            if (!isCompactSlashChipEl(chip)) continue;
            let hasLeadingText = false;
            try {
              const range = document.createRange();
              range.setStart(editorEl, 0);
              range.setEndBefore(chip);
              const before = range.toString().replace(/[\u200B-\u200D\uFEFF\s]/g, '');
              if (before.length > 0) hasLeadingText = true;
            } catch {
              if (!/^\/?compact(?:\s|$)/i.test(stripIconText(editorEl))) hasLeadingText = true;
            }
            if (!hasLeadingText) return true;
          }
        } catch {}
        return false;
      }

      function isCompactSlashMenuItem(el) {
        if (!el) return false;
        try {
          const reactName = extractSlashCommandNameFromReact(el);
          if (/^\/?compact$/i.test(reactName)) return true;
          const firstLine =
            stripIconText(el)
              .split(/\n+/)
              .map((s) => s.trim())
              .find(Boolean) || '';
          if (/^\/?compact(?:\s|$)/i.test(firstLine)) return true;
        } catch {}
        return false;
      }

      function isSlashCompactMenuSelected(editorEl) {
        try {
          const activeId = editorEl && editorEl.getAttribute ? String(editorEl.getAttribute('aria-activedescendant') || '').trim() : '';
          if (activeId) {
            const activeEl = document.getElementById(activeId);
            if (activeEl && isCompactSlashMenuItem(activeEl)) return true;
          }
          const sel = document.querySelectorAll(
            '#typeahead-menu [aria-selected="true"], #typeahead-menu .selected, [role="listbox"] [aria-selected="true"], [role="listbox"] .selected, [role="menu"] [aria-selected="true"], [role="option"][data-selected="true"], [role="option"][data-highlighted], [cmdk-item][aria-selected="true"]'
          );
          for (let i = 0; i < sel.length; i += 1) {
            if (isCompactSlashMenuItem(sel[i])) return true;
          }
        } catch {}
        return false;
      }

      function clearLexicalEditorOnce(editorEl) {
        if (!editorEl) return;
        try {
          editorEl.focus();
          if (typeof editorEl.value === 'string') {
            editorEl.value = '';
            editorEl.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
          document.execCommand('selectAll', false);
          document.execCommand('delete', false);
          if (readEditorSlashText(editorEl) || isEditorSlashCompactCommand(editorEl)) {
            const sel = window.getSelection && window.getSelection();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(editorEl);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            editorEl.dispatchEvent(
              new InputEvent('beforeinput', {
                inputType: 'deleteContentBackward',
                bubbles: true,
                cancelable: true
              })
            );
          }
        } catch {}
      }

      function clearLexicalEditor(editorEl) {
        if (!editorEl) return;
        clearLexicalEditorOnce(editorEl);
        setTimeout(() => {
          if (disposed || !editorEl.isConnected) return;
          if (isEditorSlashCompactCommand(editorEl) || editorEl.querySelector?.('bdi, [data-tooltip-id^="slashCommand:"]')) {
            clearLexicalEditorOnce(editorEl);
          }
        }, 40);
      }

      function findPaneContaining(node) {
        if (!node) return null;
        const panes = discoverPanes();
        for (let i = 0; i < panes.length; i += 1) {
          if (panes[i].inputBox && panes[i].inputBox.contains(node)) return panes[i];
        }
        return null;
      }

      let lastSlashCompactAt = 0;
      function triggerSlidingCompactFromSlash(pane, editorEl) {
        const now = Date.now();
        if (now - lastSlashCompactAt < 600) return;
        lastSlashCompactAt = now;
        clearLexicalEditor(editorEl);
        const pk = pane && pane.key === 'side' ? 'side' : 'main';
        const cid = (pane && pane.cid) || (paneData[pk] && paneData[pk].cid) || '';
        if (!cid) {
          if (typeof window.__ag_on_flow_compact_fx === 'function') {
            window.__ag_on_flow_compact_fx(
              { type: 'compact', cascadeId: '__draft__:' + pk, reason: 'manual', ok: false, error: 'no_session_snapshot' },
              pk
            );
          }
          return;
        }
        if (typeof window.__ag_on_flow_compact_fx === 'function') {
          window.__ag_on_flow_compact_fx({ type: 'compact-start', cascadeId: cid, reason: 'manual' }, pk);
        }
        void callFlowCompactAction('compact', cid).then((res) => {
          const err = String((res && res.error) || '');
          if (err === 'compaction_in_flight') return;
          if (typeof window.__ag_on_flow_compact_fx === 'function') {
            if (!res || res.ok === false) {
              window.__ag_on_flow_compact_fx(
                {
                  type: 'compact',
                  cascadeId: cid,
                  reason: 'manual',
                  ok: false,
                  error: err || 'compact_failed',
                  status: res && res.status ? res.status : undefined
                },
                pk
              );
            } else {
              window.__ag_on_flow_compact_fx(
                { type: 'compact', cascadeId: cid, reason: 'manual', ok: true, status: res.status || res },
                pk
              );
            }
          }
          if (typeof window.__ag_refresh_flow_state_for_pane === 'function') {
            window.__ag_refresh_flow_state_for_pane(pk);
          }
        });
      }

      let suppressPointerUntil = 0;
      let suppressPointerTargetKind = '';

      const onSlashKeyDown = (e) => {
        if (disposed || !isSlidingCompactHijackActive()) return;
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        let pane = findPaneContaining(e.target);
        if (!pane || !pane.inputBox) {
          pane = findPaneContaining(document.activeElement);
        }
        if (!pane || !pane.inputBox) return;
        let editor = e.target && e.target.closest ? e.target.closest('[contenteditable="true"], [data-lexical-editor="true"], textarea') : null;
        if (!editor || !pane.inputBox.contains(editor)) {
          editor = pane.inputBox.querySelector('[contenteditable="true"], [data-lexical-editor="true"], textarea');
        }
        if (!editor || !pane.inputBox.contains(editor)) return;
        const txt = readEditorSlashText(editor);
        if (isEditorSlashCompactCommand(editor) || (txt.startsWith('/') && isSlashCompactMenuSelected(editor))) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          triggerSlidingCompactFromSlash(pane, editor);
        }
      };

      const onSlashPointer = (e) => {
        if (disposed || !isSlidingCompactHijackActive()) return;
        const pane = findPaneContaining(e.target);
        if (pane && pane.inputBox) {
          const btn = e.target && e.target.closest ? e.target.closest('button') : null;
          if (!btn || !pane.inputBox.contains(btn)) return;
          if (btn.classList.contains('ag-flow-mode-trigger')) return;
          const tid = String(btn.getAttribute('data-testid') || '');
          if (
            tid === 'input-cancel-button' ||
            tid === 'voice-start-button' ||
            tid === 'model-selector-trigger' ||
            tid === 'permissions-selector-trigger'
          ) {
            return;
          }
          const aria = String(btn.getAttribute('aria-label') || '');
          const isSendBtn =
            tid === 'send-button' ||
            btn.classList.contains('agy-send-button') ||
            btn.getAttribute('type') === 'submit' ||
            /send|submit|发送|傳送/i.test(tid + ' ' + aria);
          if (!isSendBtn) return;
          if (Date.now() < suppressPointerUntil && suppressPointerTargetKind === 'send') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
          }
          const editor = pane.inputBox.querySelector('[contenteditable="true"], [data-lexical-editor="true"], textarea');
          if (isEditorSlashCompactCommand(editor)) {
            suppressPointerUntil = Date.now() + 450;
            suppressPointerTargetKind = 'send';
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            triggerSlidingCompactFromSlash(pane, editor);
          }
          return;
        }
        const item =
          e.target && e.target.closest
            ? e.target.closest('#typeahead-menu li, #typeahead-menu [role="option"], [role="option"], [role="menuitem"], [cmdk-item], li, button')
            : null;
        if (!item) return;
        if (Date.now() < suppressPointerUntil && suppressPointerTargetKind === 'menu') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
        if (!isCompactSlashMenuItem(item)) return;
        const panes = discoverPanes();
        let activePane = null;
        let activeEditor = null;
        for (let i = 0; i < panes.length; i += 1) {
          const ed = panes[i].inputBox && panes[i].inputBox.querySelector('[contenteditable="true"], [data-lexical-editor="true"], textarea');
          const edTxt = readEditorSlashText(ed);
          if (edTxt.startsWith('/') || isEditorSlashCompactCommand(ed)) {
            activePane = panes[i];
            activeEditor = ed;
            break;
          }
        }
        if (activePane && activeEditor) {
          suppressPointerUntil = Date.now() + 450;
          suppressPointerTargetKind = 'menu';
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          triggerSlidingCompactFromSlash(activePane, activeEditor);
        }
      };

      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keydown', onSlashKeyDown, true);
      window.addEventListener('pointerdown', onSlashPointer, true);
      window.addEventListener('mousedown', onSlashPointer, true);
      window.addEventListener('click', onSlashPointer, true);

      scanAllPanes();
      scanTimer = setInterval(scanAllPanes, 1500);
      const statusPollTimer = setInterval(() => {
        if (disposed) return;
        const stale = Date.now() - lastSuccessfulSyncAt >= 20000;
        if (!proxyInfo.running || !asarInfo.patched || stale) {
          const st = paneData.main;
          void callFlowBinding('__agFlowGetState', {
            cascadeId: st.cid || '__draft__:main',
            paneKey: 'main'
          }).then((res) => applyFlowStateResponse('main', res));
        }
      }, 5000);
      if (typeof MutationObserver === 'function') {
        let moScheduled = false;
        mo = new MutationObserver(() => {
          if (moScheduled || disposed) return;
          moScheduled = true;
          setTimeout(() => {
            moScheduled = false;
            scanAllPanes();
          }, 180);
        });
        try {
          mo.observe(document.body, { childList: true, subtree: true });
        } catch {}
      }

      if (Array.isArray(window.__ag_cleanup_fns)) {
        window.__ag_cleanup_fns.push(() => {
          disposed = true;
          if (scanTimer) clearInterval(scanTimer);
          if (statusPollTimer) clearInterval(statusPollTimer);
          if (mo) {
            try {
              mo.disconnect();
            } catch {}
          }
          document.removeEventListener('click', onDocClick, true);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('keydown', onSlashKeyDown, true);
          window.removeEventListener('pointerdown', onSlashPointer, true);
          window.removeEventListener('mousedown', onSlashPointer, true);
          window.removeEventListener('click', onSlashPointer, true);
          try { delete window.__ag_refresh_flow_state_for_pane; } catch {}
          try { delete window.__ag_on_flow_compact_response; } catch {}
          cleanupFlowModePickerDom();
        });
      }
    })();
  }
