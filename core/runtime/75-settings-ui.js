/**
 * Part 75: Embedded Native Codex Settings Panel (inside Antigravity Settings Modal)
 * Mounts a native-style "Codex 主题" tab into [data-testid="settings-sidebar"],
 * persists changes to user/config.json via CDP bindings with ~200ms hot-reload,
 * and provides a 2-level popover cascading model picker populated from `agy models`.
 */
  const AG_SETTINGS_FALLBACK_FAMILIES = [
    {
      key: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      recommended: true,
      defaultEffort: 'Low',
      efforts: [
        { label: 'Low', id: 'gemini-3.8-flash-low' },
        { label: 'Medium', id: 'gemini-3.8-flash-medium' },
        { label: 'High', id: 'gemini-3.8-flash-high' }
      ]
    },
    {
      key: 'gemini-4-neon',
      name: 'Gemini 4 Neon',
      recommended: false,
      defaultEffort: 'Medium',
      efforts: [
        { label: 'Low', id: 'gemini-4-neon-low' },
        { label: 'Medium', id: 'gemini-4-neon-medium' },
        { label: 'High', id: 'gemini-4-neon-high' },
        { label: 'Extra High', id: 'gemini-4-neon-xhigh' }
      ]
    },
    {
      key: 'gemini-4-carbon',
      name: 'Gemini 4 Carbon',
      recommended: false,
      defaultEffort: 'Medium',
      efforts: [
        { label: 'Low', id: 'gemini-4-carbon-low' },
        { label: 'Medium', id: 'gemini-4-carbon-medium' },
        { label: 'High', id: 'gemini-4-carbon-high' }
      ]
    },
    {
      key: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      recommended: false,
      defaultEffort: 'Medium',
      efforts: [
        { label: 'Low', id: 'gemini-4-argon-low' },
        { label: 'Medium', id: 'gemini-4-argon-medium' },
        { label: 'High', id: 'gemini-4-argon-high' }
      ]
    },
    {
      key: 'gemini-4-hydrogen',
      name: 'Gemini 4 Hydrogen',
      recommended: false,
      defaultEffort: 'Medium',
      efforts: [
        { label: 'Low', id: 'gemini-4-hydrogen-low' },
        { label: 'Medium', id: 'gemini-4-hydrogen-medium' },
        { label: 'High', id: 'gemini-4-hydrogen-high' },
        { label: 'Extra High', id: 'gemini-4-hydrogen-xhigh' }
      ]
    },
    {
      key: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      recommended: false,
      defaultEffort: 'Medium',
      efforts: [
        { label: 'Low', id: 'claude-opus-5-5-low' },
        { label: 'Medium', id: 'claude-opus-5-5-medium' },
        { label: 'High', id: 'claude-opus-5-5-high' }
      ]
    },
    {
      key: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      recommended: false,
      defaultEffort: 'Medium',
      efforts: [
        { label: 'Low', id: 'claude-sonnet-5-5-low' },
        { label: 'Medium', id: 'claude-sonnet-5-5-medium' },
        { label: 'High', id: 'claude-sonnet-5-5-high' }
      ]
    },
    {
      key: 'gpt-oss-120b',
      name: 'GPT-OSS 120B (Medium)',
      recommended: false,
      singleId: 'gpt-oss-120b-medium',
      efforts: []
    }
  ];

  function cleanupCodexSettingsDom() {
    try {
      for (const id of [
        'ag-settings-nav-divider',
        'ag-settings-nav-wrap',
        'ag-settings-pane',
        'ag-settings-model-menu',
        'ag-settings-effort-menu'
      ]) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
      document.querySelectorAll('[data-ag-codex-settings-open]').forEach((el) => {
        el.removeAttribute('data-ag-codex-settings-open');
      });
      document.querySelectorAll('[data-ag-settings-split-row]').forEach((el) => {
        el.removeAttribute('data-ag-settings-split-row');
      });
      document.querySelectorAll('[data-ag-settings-right-pane]').forEach((el) => {
        el.removeAttribute('data-ag-settings-right-pane');
      });
    } catch {}
  }

  function mountCodexSettingsUi() {
    if (IS_SWARM_PLUGIN_FRAME || !ENABLED) {
      cleanupCodexSettingsDom();
      return;
    }
    if (typeof document === 'undefined' || !document.body) return;

    (function initCodexSettingsUi() {
      const VALID_HOST_RE = /^[a-zA-Z0-9_@][a-zA-Z0-9._:@-]{0,127}$/;
      const SUPPORTS_POPOVER =
        typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
      const SUPPORTS_FOCUSGROUP =
        typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;
      const SUPPORTS_IMPLICIT_ANCHOR =
        SUPPORTS_POPOVER &&
        typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        CSS.supports('position-area: block-end') &&
        typeof ToggleEvent !== 'undefined' &&
        'source' in ToggleEvent.prototype;

      let disposed = false;
      let reqSeq = 0;
      const pendingReqs = new Map();
      const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const manualRemovers = [];
      function listen(target, type, handler, capture = false) {
        if (!target || typeof target.addEventListener !== 'function') return;
        if (abortCtrl && abortCtrl.signal) {
          try {
            target.addEventListener(type, handler, { capture: Boolean(capture), signal: abortCtrl.signal });
            return;
          } catch {}
        }
        target.addEventListener(type, handler, capture);
        manualRemovers.push(() => {
          try {
            target.removeEventListener(type, handler, capture);
          } catch {}
        });
      }
      let scanTimer = null;
      let statusPollTimer = null;
      let saveBadgeTimer = null;
      let hoverSwitchTimer = null;
      let lastSubAnchorBtn = null;
      let hoveredFamilyKey = '';
      let activeModelPickerTarget = 'promptSuggestionModel';
      let activeModelPickerTriggerId = 'ag-s-model-trigger';
      let addingHost = false;
      let invalidHost = false;
      let refreshingModels = false;
      let refreshingAll = false;
      let activeDlg = null;
      let activeSidebar = null;
      let boundSidebarClick = null;
      let boundNavBtn = null;
      let boundPane = null;
      const SECTION_TAB_KEYS = ['appearance', 'accounts', 'prompts', 'flow', 'advanced'];
      let activeSectionTab =
        typeof window.__ag_settings_section_tab === 'string' && SECTION_TAB_KEYS.includes(window.__ag_settings_section_tab)
          ? window.__ag_settings_section_tab
          : 'appearance';
      function setActiveSectionTab(tab) {
        activeSectionTab = SECTION_TAB_KEYS.includes(tab) ? tab : 'appearance';
        window.__ag_settings_section_tab = activeSectionTab;
      }
      const PROMPT_TAB_KEYS = ['global', 'default', 'writing', 'engineering', 'full'];
      let activePromptTab =
        typeof window.__ag_settings_prompt_tab === 'string' && PROMPT_TAB_KEYS.includes(window.__ag_settings_prompt_tab)
          ? window.__ag_settings_prompt_tab
          : 'global';
      const promptDrafts =
        window.__ag_settings_prompt_drafts && typeof window.__ag_settings_prompt_drafts === 'object'
          ? window.__ag_settings_prompt_drafts
          : {};
      window.__ag_settings_prompt_drafts = promptDrafts;
      function setActivePromptTab(tab) {
        activePromptTab = PROMPT_TAB_KEYS.includes(tab) ? tab : 'global';
        window.__ag_settings_prompt_tab = activePromptTab;
      }
      function getSavedPromptForTab(tab) {
        if (tab === 'global') return (uiState.config.customSystemPrompt && uiState.config.customSystemPrompt.text) || '';
        const fl = uiState.config.flow || {};
        if (tab === 'default') return fl.defaultSeat || '';
        if (tab === 'writing') return fl.writingSeat || '';
        if (tab === 'engineering') return fl.engineeringSeat || '';
        if (tab === 'full') return fl.fullSeat || '';
        return '';
      }
      function getDraftForTab(tab) {
        return typeof promptDrafts[tab] === 'string' ? promptDrafts[tab] : getSavedPromptForTab(tab);
      }
      function setDraftForTab(tab, val) {
        if (typeof val === 'string') {
          promptDrafts[tab] = val;
        } else {
          delete promptDrafts[tab];
        }
      }
      function commitPromptForTab(tab, text) {
        const clean = String(text || '');
        setDraftForTab(tab, clean);
        if (tab === 'global') {
          commitPatch({ customSystemPrompt: { text: clean } });
          return;
        }
        const keyMap = {
          default: 'defaultSeat',
          writing: 'writingSeat',
          engineering: 'engineeringSeat',
          full: 'fullSeat'
        };
        const field = keyMap[tab];
        if (field) commitPatch({ flow: { [field]: clean } });
      }

      const bootUserCfg = boot.userConfig && typeof boot.userConfig === 'object' ? boot.userConfig : {};
      const bootPromptCfg =
        bootUserCfg.customSystemPrompt && typeof bootUserCfg.customSystemPrompt === 'object'
          ? bootUserCfg.customSystemPrompt
          : boot.customSystemPrompt && typeof boot.customSystemPrompt === 'object'
          ? boot.customSystemPrompt
          : {};
      const bootHookAllowCfg =
        bootUserCfg.hookAutoAllow && typeof bootUserCfg.hookAutoAllow === 'object'
          ? bootUserCfg.hookAutoAllow
          : boot.hookAutoAllow && typeof boot.hookAutoAllow === 'object'
          ? boot.hookAutoAllow
          : {};
      const bootFlowCfg =
        bootUserCfg.flow && typeof bootUserCfg.flow === 'object'
          ? bootUserCfg.flow
          : boot.flow && typeof boot.flow === 'object'
          ? boot.flow
          : {};
      const DEFAULT_FLOW_UI = {
        port: 18100,
        defaultMode: 'default',
        modelPattern: 'gemini',
        maxContinuations: 3,
        refusalRewrite: true,
        outputChannelHardening: false,
        judgeEnabled: false,
        judgeModel: 'gemini-3.8-flash-low',
        softenEnabled: true,
        remapEnabled: false,
        remapTargetModel: 'gpt-oss-120b-medium',
        systemPromptStrategy: 'keep',
        defaultSeat: '',
        writingSeat: '',
        engineeringSeat: '',
        fullSeat: '',
        compactEnabled: false,
        compactThresholdPct: 70,
        compactKeepTailTokens: 20000,
        compactModel: ''
      };
      const DEFAULT_AUTO_TITLE_UI = { enabled: false, turnInterval: 4, minIntervalMin: 5 };
      const DEFAULT_SUBAGENT_ROUTING_UI = { enabled: false, allowedModels: [] };
      const bootAutoTitleCfg =
        bootUserCfg.autoTitle && typeof bootUserCfg.autoTitle === 'object'
          ? bootUserCfg.autoTitle
          : boot.autoTitle && typeof boot.autoTitle === 'object'
          ? boot.autoTitle
          : {};
      const bootSubRoutingCfg =
        bootUserCfg.subagentRouting && typeof bootUserCfg.subagentRouting === 'object'
          ? bootUserCfg.subagentRouting
          : boot.subagentRouting && typeof boot.subagentRouting === 'object'
          ? boot.subagentRouting
          : {};
      let flowAsarMsg = '';
      let autoTitleStatusMsg = '';
      let autoTitleBusy = false;

      const VALID_TOPBAR_METRICS = ['quota', 'sessionTokens', 'todayTokens', 'monthTokens', 'monthCost', 'icon'];
      function readStoredTopbarMetric() {
        try {
          const v = localStorage.getItem('ag_topbar_usage_metric');
          return VALID_TOPBAR_METRICS.includes(v) ? v : '';
        } catch {
          return '';
        }
      }
      function syncUiPrefsToRuntime(cfgObj, { refreshTopbar = false } = {}) {
        if (!cfgObj || typeof cfgObj !== 'object') return;
        const metric = VALID_TOPBAR_METRICS.includes(cfgObj.topbarUsageMetric)
          ? cfgObj.topbarUsageMetric
          : readStoredTopbarMetric() || 'quota';
        window.__ag_ui_prefs = Object.assign({}, window.__ag_ui_prefs || {}, {
          compactTypography: cfgObj.compactTypography !== false,
          topbarUsageMetric: metric,
          overviewQuota: cfgObj.overviewQuota !== false,
          overviewProgress: cfgObj.overviewProgress !== false,
          showClaudeQuota: Boolean(cfgObj.showClaudeQuota),
          flow: cfgObj.flow
        });
        boot.userConfig = Object.assign({}, boot.userConfig || {}, window.__ag_ui_prefs);
        try {
          localStorage.setItem('ag_topbar_usage_metric', metric);
        } catch {}
        if (refreshTopbar && typeof window.__ag_refresh_topbar_usage === 'function') {
          try { window.__ag_refresh_topbar_usage(); } catch {}
        }
      }

      const uiState = {
        config: {
          i18nLocale: bootUserCfg.i18nLocale || boot.i18nLocale || (MODULES.i18n ? 'zh-CN' : 'en'),
          syncAiOutputLang: Boolean(bootUserCfg.syncAiOutputLang ?? boot.syncAiOutputLang),
          customSystemPrompt: {
            enabled: Boolean(bootPromptCfg.enabled),
            mode: bootPromptCfg.mode || 'flow-proxy',
            text: typeof bootPromptCfg.text === 'string' ? bootPromptCfg.text : '',
            everyInvocation: Boolean(bootPromptCfg.everyInvocation)
          },
          hookAutoAllow: {
            enabled: Boolean(bootHookAllowCfg.enabled),
            mode: bootHookAllowCfg.mode || 'files'
          },
          flow: Object.assign({}, DEFAULT_FLOW_UI, bootFlowCfg),
          autoTitle: Object.assign({}, DEFAULT_AUTO_TITLE_UI, bootAutoTitleCfg),
          subagentRouting: {
            enabled: Boolean(bootSubRoutingCfg.enabled),
            allowedModels: Array.isArray(bootSubRoutingCfg.allowedModels)
              ? bootSubRoutingCfg.allowedModels.map((m) => Object.assign({}, m))
              : []
          },
          telemetryLayout: bootUserCfg.telemetryLayout || boot.telemetryLayout || 'compact',
          telemetryCacheMode: bootUserCfg.telemetryCacheMode || boot.telemetryCacheMode || 'session',
          compactTypography: bootUserCfg.compactTypography !== false && boot.compactTypography !== false,
          topbarUsageMetric: bootUserCfg.topbarUsageMetric || boot.topbarUsageMetric || readStoredTopbarMetric() || 'quota',
          overviewQuota: bootUserCfg.overviewQuota !== false && boot.overviewQuota !== false,
          overviewProgress: bootUserCfg.overviewProgress !== false && boot.overviewProgress !== false,
          showClaudeQuota: Boolean(bootUserCfg.showClaudeQuota ?? boot.showClaudeQuota),
          promptSuggestionModel: bootUserCfg.promptSuggestionModel || 'gemini-3.8-flash-low',
          sshHosts: Array.isArray(bootUserCfg.sshHosts) ? bootUserCfg.sshHosts.slice() : [],
          modules: Object.assign({}, MODULES, bootUserCfg.modules || {})
        },
        flowStatus: null,
        agyStatus: (window.__ag_settings_agy_cache && Object.assign({}, window.__ag_settings_agy_cache)) || {
          available: true,
          running: false,
          starting: false,
          ready: false,
          warmed: false,
          activeModel: ''
        },
        families:
          Array.isArray(window.__ag_settings_models_cache) && window.__ag_settings_models_cache.length > 0
            ? window.__ag_settings_models_cache
            : AG_SETTINGS_FALLBACK_FAMILIES,
        update: (window.__ag_settings_update_cache && Object.assign({}, window.__ag_settings_update_cache)) || {
          phase: 'idle',
          status: 'idle',
          currentVersion: '',
          latestVersion: '',
          updateAvailable: false,
          canSyncMain: false,
          changedCount: 0,
          targetRef: 'main',
          error: ''
        }
      };
      syncUiPrefsToRuntime(uiState.config, { refreshTopbar: false });

      function getShortVersionTag() {
        const m = String(PATCH_VERSION || '').match(/^(\d+\.\d+(?:\.\d+)?)/);
        return m ? 'v' + m[1] : 'v1.2';
      }

      function getActiveLocale() {
        if (!uiState.config.modules.i18n) return 'en';
        const loc = uiState.config.i18nLocale || 'zh-CN';
        return loc === 'zh-TW' || loc === 'zh-SG' || loc === 'en' ? loc : 'zh-CN';
      }

      function getStrings() {
        const loc = getActiveLocale();
        if (loc === 'zh-TW') {
          return {
            navTitle: '增強設定',
            pageTitle: '增強設定',
            manualRefreshLabel: '重新整理設定',
            savedBadge: '已同步',
            refreshedBadge: '已重新整理',
            githubLabel: 'GitHub',
            feedbackLabel: '回報問題',
            tabAppearance: '外觀與狀態',
            tabAccounts: '帳號管理',
            tabPrompts: '提示詞與權限',
            tabFlow: '代理與恢復',
            tabAdvanced: '擴充與更新',
            secCore: '外觀與語言',
            secFlowProxy: '本機代理',
            secFlowStrategy: '輸出恢復',
            modTheme: 'Codex 晝夜主題',
            modThemeDesc: '跟隨 IDE 淺/深色外觀',
            compactTypoLbl: '緊湊對話排版',
            compactTypoDesc: '收緊行高與工具間距',
            bubbleTintLbl: '使用者訊息氣泡著色',
            bubbleTintDesc: '為發出訊息添加低飽和底色',
            overviewQuotaLbl: '右側概覽顯示額度',
            overviewQuotaDesc: '在右側概覽底部顯示額度',
            showClaudeQuotaLbl: '顯示 Claude / GPT 額度',
            showClaudeQuotaDesc: '預設僅顯示 Gemini 額度',
            overviewProgressLbl: '右側概覽顯示任務進度',
            overviewProgressDesc: '顯示步驟與即時用時',
            modI18n: '中文介面本地化',
            modI18nDesc: '關閉即還原英文介面',
            localeLbl: '介面語言',
            localeDesc: '即時切換，無需重啟',
            locZhCn: '简体中文',
            locZhSg: '简中·英术',
            locZhTw: '繁體中文',
            locEn: 'English',
            syncAiLangLbl: '同步 AI 回覆語言',
            syncAiLangDesc: '讓代理思考與回覆跟隨介面語言',
            secPromptHooks: '系統提示詞與權限',
            modFlow: '對話模式與本機轉發',
            modFlowDesc: '輸入框旁顯示模式選單並啟用本機轉發',
            flowDefaultModeLbl: '預設模式',
            flowDefaultModeDesc: '新對話預設套用此模式',
            flowModeDefault: '預設',
            flowModeWriting: '寫作',
            flowModeEng: '工程',
            flowModeFull: '全面',
            flowMaxContLbl: '最大續寫',
            flowMaxContDesc: '中斷時自動續寫次數（0 為停用）',
            flowRewriteLbl: '拒絕改寫',
            flowRewriteDesc: '被拒時以同一模型重試輸出',
            flowHardeningLbl: '正文落盤',
            flowHardeningDesc: '寫作模式下正文經寫檔儲存',
            flowJudgeLbl: '裁判判定',
            flowJudgeDesc: '以輕量模型判斷是否中斷',
            flowSoftenLbl: '措辭軟化',
            flowSoftenDesc: '重試時自動軟化敏感措辭',
            flowRemapLbl: '備用模型',
            flowRemapDesc: '全面模式連續失敗時切換模型',
            flowAsarLbl: '流量接管',
            flowAsarEnable: '開啟接管',
            flowAsarDisable: '取消接管',
            flowProxyOnline: '運作中',
            flowProxyOffline: '未啟動',
            flowAsarPatched: '已接管',
            flowAsarOriginal: '未接管',
            flowAsarMissing: '未找到 app.asar',
            secFlowCompact: 'Codex 智慧壓縮接管',
            flowCompactLbl: '啟用 Codex 虛擬滑動壓縮',
            flowCompactDesc: '原生觸發前折疊舊歷史並保留近期原文（推薦預設：70% · 20k）',
            flowCompactThreshLbl: '自動觸發門檻',
            flowCompactThreshDesc: '上下文達到此比例時預先壓縮',
            flowCompactTailLbl: '保留近期原文尾部',
            flowCompactTailDesc: '壓縮後保留最新對話的 Token 上限',
            flowCompactNeedAsar: '需先開啟上方「流量接管」與「本機轉發」。',
            modCustomPrompt: '系統級自訂提示詞',
            modCustomPromptDesc: '支援全域與分模式提示詞',
            promptModeLbl: '注入方式',
            promptModeDescProxy: '直注系統指令，不留對話歷史殘留',
            promptModeDescHook: '透過原生 Hook 注入，內建指紋去重',
            promptModePreInv: 'Hook 注入',
            promptModeProxy: '代理注入',
            promptTimingLbl: '注入時機',
            promptTimingDescSession: '每個會話僅注入一次，不膨脹上下文',
            promptTimingDescEvery: '每輪發包末尾附加提醒，防長對話遺忘',
            promptTimingSession: '按會話注入',
            promptTimingEvery: '每輪重複',
            promptProxyWarnNeedFlow: '請先於「代理與恢復」開啟本機轉發與流量接管',
            promptProxyWarnNeedAsar: '流量尚未接管，請至「代理與恢復」點選「開啟接管」',
            promptScopeLbl: '生效範圍',
            promptTabGlobal: '全域',
            promptTabDefault: '預設',
            promptTabWriting: '寫作',
            promptTabEng: '工程',
            promptTabFull: '全面',
            promptPlaceholderMode: '輸入僅對「{tab}」生效的提示詞（留空則僅用全域）…',
            promptPresetLbl: '範本：',
            presetSystemRole: '系統專家',
            presetAntiHalluc: '嚴謹防幻覺',
            presetConcise: '簡潔極客',
            presetContract: '契約開發',
            promptPlaceholder: '輸入全域系統提示詞（最多 20,000 字元）…',
            promptClearBtn: '清空',
            promptSaveBtn: '儲存',
            promptUnsaved: '未儲存',
            promptSavedTip: 'Ctrl/Cmd + Enter 儲存',
            modAutoAllow: '工具自動放行',
            modAutoAllowDesc: '透過 Hook 自動核准指定工具操作',
            autoAllowModeLbl: '放行範圍',
            autoAllowModeDesc: '「含安全指令」會攔截高危破壞性指令',
            autoAllowFiles: '僅檔案讀寫',
            autoAllowSafeCmd: '含安全指令',
            autoAllowAll: '全部放行',
            autoAllowAllWarn: '注意：全部放行將略過所有終端指令確認，請謹慎開啟。',
            secSubagentRouting: '子代理模型分配',
            modSubagentRouting: '按能力自動分配子代理模型',
            modSubagentRoutingDesc: '主會話依任務難度從白名單中分派模型（支援第三方模型 ID）',
            subagentEmpty: '尚未新增允許用於子代理的模型，請從下方選擇或手動輸入（如 deepseek-4.1）',
            subagentPickBtn: '+ 從可用模型選擇',
            subagentCustomPh: '輸入模型 ID（如 deepseek-4.1）',
            subagentAddBtn: '新增',
            tierAuto: '自動檔位',
            tierFast: '輕量',
            tierBalanced: '均衡',
            tierStrong: '高階',
            tierToggleTip: '點選切換能力檔位',
            modAutoTitle: '按進度自動更新標題',
            modAutoTitleDesc: '每隔數輪依最新對話進展熱更新會話標題',
            autoTitleTurnsLbl: '觸發輪數',
            autoTitleTurnsUnit: '輪',
            autoTitleCoolLbl: '冷卻間隔',
            autoTitleCoolUnit: '分',
            autoTitleNowBtn: '立即更新標題',
            autoTitleUpdating: '更新中…',
            presets: {
              systemRole:
                '## 系統級角色與執行原則\n- 你是一位資深全端系統架構師，所有技術判斷以實際讀取到的程式碼與執行結果為唯一依據。\n- 先分析根因再動手修改，避免表面修補與無關重構。\n- 每次改動後自動執行對應驗證（語法檢查／測試／建置），僅回報實際驗證通過的結果。\n- 回覆簡明直接，先給結論與關鍵改動，程式碼識別字與命令保持英文原樣。',
              antiHalluc:
                '## 嚴謹工程與防幻覺規範\n- 修改任何程式碼前必須先讀取並核對實際檔案，嚴禁臆測未驗證的 API、路徑或設定項。\n- 所有改動完成後必須執行對應的語法檢查或單元測試，並只回報實際執行觀察到的結果。\n- 若遇資訊不足或高風險破壞性操作，先說明影響並向使用者確認。',
              concise:
                '## 高效精簡回覆規範\n- 先給結論與可執行方案，避免客套與冗長鋪陳。\n- 優先最小化精準修改，不順手重構無關程式碼。\n- 關鍵檔案與行號附上明確定位。',
              contract:
                '## 契約式開發規範\n- 動手修改前先列出受影響檔案清單與變更目標。\n- 嚴格遵守現有專案架構、命名風格與零多餘依賴原則。\n- 交付時簡明總結改動點、驗證指令與結果。'
            },
            modMetrics: '即時狀態與用量統計',
            modMetricsDesc: '底部狀態列、明細浮窗與每輪尾部統計',
            secOptional: '可選增強',
            modSuggest: '輸入框下一句預測',
            modSuggestDescPre: '按 ',
            modSuggestDescMid: ' 或 ',
            modSuggestDescPost: ' 補全下一句（需本機 ',
            modSuggestDescEnd: '）',
            agyIdle: '未啟動',
            agyWarming: '預熱中…',
            agyReady: '就緒',
            agyMissing: '未偵測到 agy',
            suggestModelLbl: '預測模型',
            suggestModelDescPre: '來源 ',
            suggestModelDescPost: '，推薦 Gemini 3.8 Flash Low',
            refreshModelsTitle: '重新取得 agy models',
            menuModelsHdr: '模型',
            recommendedBadge: '推薦',
            modSsh: 'SSH 遠端統計',
            modSshDesc: '遠端唯讀擷取數值統計，不複製資料庫',
            sshHostsLbl: '允許主機',
            addHostBtn: '+ 新增主機',
            addHostPlaceholder: '例如 node032',
            addHostOk: '新增',
            secTelemetry: '狀態列與統計',
            layoutLbl: '狀態列密度',
            layoutDesc: '精簡嵌於工具列內；詳細展開為獨立列',
            layoutCompact: '精簡',
            layoutDetailed: '詳細',
            cacheLbl: '快取口徑',
            cacheDesc: '顯示工作階段累計或單步命中率',
            cacheSession: '工作階段累計',
            cacheStep: '單步',
            topbarMetricLbl: '頂欄用量顯示',
            topbarMetricDesc: '自訂右上角熱力圖按鈕顯示指標',
            topbarOptQuota: '5h 額度',
            topbarOptSessionTok: '目前會話',
            topbarOptTodayTok: '今日 Token',
            topbarOptMonthTok: '本月 Token',
            topbarOptMonthCost: '本月費用',
            topbarOptIcon: '僅圖示',
            secUpdate: '版本與更新',
            updTitle: '外掛版本',
            updDescIdle: '從 GitHub 檢查更新，保留個人設定',
            updDescChecking: '正在檢查最新版本…',
            updDescUpToDate: '已是最新版本',
            updDescAhead: '本機版本領先遠端',
            updDescAvailable: '發現新版本，可熱更新生效',
            updDescMainDiff: '遠端 main 分支有更新',
            updDescUpdating: '正在下載並驗證更新…',
            updDescApplied: '已更新，正在熱重載…',
            updPillChecking: '檢查中…',
            updPillLatest: '已是最新',
            updPillAhead: '本機領先',
            updPillAvailablePrefix: '新版本 ',
            updPillMainDiff: 'main 有差異',
            updPillUpdating: '更新中…',
            updPillApplied: '更新完成',
            updPillErr: '檢查失敗',
            updBtnCheck: '檢查更新',
            updBtnChecking: '檢查中…',
            updBtnApply: '立即更新',
            updBtnSyncMain: '同步 main',
            updBtnUpdating: '更新中…'
          };
        }
        if (loc === 'zh-CN' || loc === 'zh-SG') {
          return {
            navTitle: '增强设置',
            pageTitle: '增强设置',
            manualRefreshLabel: '刷新配置',
            savedBadge: '已同步',
            refreshedBadge: '已刷新',
            githubLabel: 'GitHub',
            feedbackLabel: '反馈',
            tabAppearance: '外观与状态',
            tabAccounts: '账号管理',
            tabPrompts: '提示词与权限',
            tabFlow: '代理与恢复',
            tabAdvanced: '扩展与更新',
            secCore: '外观与语言',
            secFlowProxy: '本地代理',
            secFlowStrategy: '输出恢复',
            modTheme: 'Codex 昼夜主题',
            modThemeDesc: '跟随 IDE 浅/深色外观',
            compactTypoLbl: '紧凑对话排版',
            compactTypoDesc: '收紧行高与工具间距',
            bubbleTintLbl: '用户消息气泡着色',
            bubbleTintDesc: '为发送消息添加低饱和底色',
            overviewQuotaLbl: '右侧概览显示额度',
            overviewQuotaDesc: '在右侧概览底部显示额度',
            showClaudeQuotaLbl: '显示 Claude / GPT 额度',
            showClaudeQuotaDesc: '默认仅显示 Gemini 额度',
            overviewProgressLbl: '右侧概览显示任务进度',
            overviewProgressDesc: '显示步骤与实时用时',
            modI18n: '中文界面汉化',
            modI18nDesc: '关闭即恢复英文界面',
            localeLbl: '界面语言',
            localeDesc: '实时切换，无需重启',
            locZhCn: '简体中文',
            locZhSg: '简中·英术',
            locZhTw: '繁體中文',
            locEn: 'English',
            syncAiLangLbl: '同步 AI 回复语言',
            syncAiLangDesc: '让智能体思考与回复跟随界面语言',
            secPromptHooks: '系统提示词与权限',
            modFlow: '会话模式与本地转发',
            modFlowDesc: '输入框旁显示模式菜单并启用本地转发',
            flowDefaultModeLbl: '默认模式',
            flowDefaultModeDesc: '新会话默认套用此模式',
            flowModeDefault: '默认',
            flowModeWriting: '写作',
            flowModeEng: '工程',
            flowModeFull: '全面',
            flowMaxContLbl: '最大续写',
            flowMaxContDesc: '中断时自动续写次数（0 为停用）',
            flowRewriteLbl: '拒绝改写',
            flowRewriteDesc: '被拒时以同一模型重试输出',
            flowHardeningLbl: '正文落盘',
            flowHardeningDesc: '写作模式下正文经写文件保存',
            flowJudgeLbl: '裁判判定',
            flowJudgeDesc: '以轻量模型判断是否中断',
            flowSoftenLbl: '措辞软化',
            flowSoftenDesc: '重试时自动软化敏感措辞',
            flowRemapLbl: '备用模型',
            flowRemapDesc: '全面模式连续失败时切换模型',
            flowAsarLbl: '流量接管',
            flowAsarEnable: '开启接管',
            flowAsarDisable: '取消接管',
            flowProxyOnline: '运行中',
            flowProxyOffline: '未启动',
            flowAsarPatched: '已接管',
            flowAsarOriginal: '未接管',
            flowAsarMissing: '未找到 app.asar',
            secFlowCompact: 'Codex 智能压缩接管',
            flowCompactLbl: '启用 Codex 智能滑动压缩',
            flowCompactDesc: '在原生压缩前折叠旧历史并保留近期原文（推荐默认：70% · 20k）',
            flowCompactThreshLbl: '自动触发阈值',
            flowCompactThreshDesc: '上下文达到该比例时后台预压缩',
            flowCompactTailLbl: '保留最近原文尾部',
            flowCompactTailDesc: '压缩后保留最新对话的 Token 上限',
            flowCompactNeedAsar: '需先开启上方「流量接管」与「本地转发」。',
            modCustomPrompt: '系统级自定义提示词',
            modCustomPromptDesc: '支持全局与分模式提示词',
            promptModeLbl: '注入方式',
            promptModeDescProxy: '发包时注入高权重系统指令，不污染对话历史',
            promptModeDescHook: '通过原生 Hook 注入，内置指纹去重',
            promptModePreInv: 'Hook 注入',
            promptModeProxy: '代理注入',
            promptTimingLbl: '注入时机',
            promptTimingDescSession: '每个会话仅注入一次，不膨胀上下文',
            promptTimingDescEvery: '每轮发包末尾附带强提醒，防长对话遗忘',
            promptTimingSession: '按会话注入',
            promptTimingEvery: '每轮重复',
            promptProxyWarnNeedFlow: '请先在「代理与恢复」开启本地转发与流量接管',
            promptProxyWarnNeedAsar: '流量尚未接管，请到「代理与恢复」点击「开启接管」',
            promptScopeLbl: '生效范围',
            promptTabGlobal: '全局',
            promptTabDefault: '默认',
            promptTabWriting: '写作',
            promptTabEng: '工程',
            promptTabFull: '全面',
            promptPlaceholderMode: '输入仅对「{tab}」生效的提示词（留空则仅用全局）…',
            promptPresetLbl: '模板：',
            presetSystemRole: '系统专家',
            presetAntiHalluc: '严谨防幻觉',
            presetConcise: '简洁极客',
            presetContract: '契约开发',
            promptPlaceholder: '输入全局系统提示词（最多 20,000 字符）…',
            promptClearBtn: '清空',
            promptSaveBtn: '保存',
            promptUnsaved: '未保存',
            promptSavedTip: 'Ctrl/Cmd + Enter 保存',
            modAutoAllow: '工具自动放行',
            modAutoAllowDesc: '通过 Hook 自动放行指定工具操作',
            autoAllowModeLbl: '放行范围',
            autoAllowModeDesc: '「含安全命令」会拦截高危破坏性命令',
            autoAllowFiles: '仅文件读写',
            autoAllowSafeCmd: '含安全命令',
            autoAllowAll: '全部放行',
            autoAllowAllWarn: '注意：全部放行将跳过所有终端命令审批，请谨慎开启。',
            secSubagentRouting: '子代理模型分配',
            modSubagentRouting: '按能力自动分配子代理模型',
            modSubagentRoutingDesc: '主会话按任务复杂度从白名单中分配模型（支持自定义第三方模型 ID）',
            subagentEmpty: '尚未添加允许用于子代理的模型，请从下方选择或手动输入（如 deepseek-4.1）',
            subagentPickBtn: '+ 从可用模型选择',
            subagentCustomPh: '自定义模型 ID（如 deepseek-4.1）',
            subagentAddBtn: '添加',
            tierAuto: '自动档位',
            tierFast: '轻量',
            tierBalanced: '均衡',
            tierStrong: '高阶',
            tierToggleTip: '点击切换能力档位',
            modAutoTitle: '按进度自动更新标题',
            modAutoTitleDesc: '每隔数轮按最新对话进展自动刷新会话标题',
            autoTitleTurnsLbl: '触发轮数',
            autoTitleTurnsUnit: '轮',
            autoTitleCoolLbl: '冷却间隔',
            autoTitleCoolUnit: '分',
            autoTitleNowBtn: '立即更新标题',
            autoTitleUpdating: '更新中…',
            presets: {
              systemRole:
                '## 系统级角色与执行原则\n- 你是一位资深全栈系统架构师，所有技术判断以实际读取到的代码和命令输出为唯一依据。\n- 先定位根因再动手修改，不做表面修补与无关重构。\n- 每次改动后自动执行对应的语法检查或测试验证，仅汇报实际观测到的结果。\n- 回复简洁直接，先给结论与关键修改点，代码标识符与命令保持英文原样。',
              antiHalluc:
                '## 严谨工程与防幻觉规范\n- 修改任何代码前必须先读取并核对实际文件，严禁臆测未验证的 API、路径或配置项。\n- 所有改动完成后必须执行对应的语法检查或单元测试，仅汇报实际执行观察到的结果。\n- 若遇信息不足或高风险破坏性操作，先说明影响并向用户确认。',
              concise:
                '## 高效精简回复规范\n- 先给结论与可执行方案，避免客套与冗长铺陈。\n- 优先最小化精准修改，不顺手重构无关代码。\n- 关键文件与行号附上明确位置。',
              contract:
                '## 契约式开发规范\n- 动手修改前先列出受影响文件清单与变更目标。\n- 严格遵守现有项目架构、命名风格与最小依赖原则。\n- 交付时简明总结改动点、验证命令与结果。'
            },
            modMetrics: '实时状态与用量统计',
            modMetricsDesc: '底部状态栏、明细浮窗与每轮尾部统计',
            secOptional: '可选增强',
            modSuggest: '输入框下一句预测',
            modSuggestDescPre: '按 ',
            modSuggestDescMid: ' 或 ',
            modSuggestDescPost: ' 补全下一句（需本机 ',
            modSuggestDescEnd: '）',
            agyIdle: '未启动',
            agyWarming: '预热中…',
            agyReady: '就绪',
            agyMissing: '未检测到 agy',
            suggestModelLbl: '预测模型',
            suggestModelDescPre: '来源 ',
            suggestModelDescPost: '，推荐 Gemini 3.8 Flash Low',
            refreshModelsTitle: '重新拉取 agy models',
            menuModelsHdr: '模型',
            recommendedBadge: '推荐',
            modSsh: 'SSH 远端统计',
            modSshDesc: '远端只读提取数值统计，不拷贝数据库',
            sshHostsLbl: '允许主机',
            addHostBtn: '+ 添加主机',
            addHostPlaceholder: '如 node032',
            addHostOk: '添加',
            secTelemetry: '状态栏与统计',
            layoutLbl: '状态栏密度',
            layoutDesc: '紧凑嵌在工具栏内；详细展开为独立行',
            layoutCompact: '紧凑',
            layoutDetailed: '详细',
            cacheLbl: '缓存口径',
            cacheDesc: '展示会话累计或单步命中率',
            cacheSession: '会话累计',
            cacheStep: '单步',
            topbarMetricLbl: '顶栏用量显示',
            topbarMetricDesc: '自定义右上角热力图按钮显示的指标',
            topbarOptQuota: '5h 额度',
            topbarOptSessionTok: '当前会话',
            topbarOptTodayTok: '今日 Token',
            topbarOptMonthTok: '本月 Token',
            topbarOptMonthCost: '本月费用',
            topbarOptIcon: '仅图标',
            secUpdate: '版本与更新',
            updTitle: '插件版本',
            updDescIdle: '从 GitHub 检查更新，保留个人配置',
            updDescChecking: '正在检查最新版本…',
            updDescUpToDate: '已是最新版本',
            updDescAhead: '本地版本领先远端',
            updDescAvailable: '发现新版本，可热更新生效',
            updDescMainDiff: '远端 main 分支有更新',
            updDescUpdating: '正在下载并校验更新…',
            updDescApplied: '已更新，正在热重载…',
            updPillChecking: '检查中…',
            updPillLatest: '已是最新',
            updPillAhead: '本地领先',
            updPillAvailablePrefix: '新版本 ',
            updPillMainDiff: 'main 有差异',
            updPillUpdating: '更新中…',
            updPillApplied: '更新完成',
            updPillErr: '检查失败',
            updBtnCheck: '检查更新',
            updBtnChecking: '检查中…',
            updBtnApply: '立即更新',
            updBtnSyncMain: '同步 main',
            updBtnUpdating: '更新中…'
          };
        }
        return {
          navTitle: 'Enhancements',
          pageTitle: 'Enhancements',
          manualRefreshLabel: 'Reload config',
          savedBadge: 'Synced',
          refreshedBadge: 'Refreshed',
          githubLabel: 'GitHub',
          feedbackLabel: 'Issues',
          tabAppearance: 'Appearance',
          tabAccounts: 'Accounts',
          tabPrompts: 'Prompts',
          tabFlow: 'Relay',
          tabAdvanced: 'Add-ons',
          secCore: 'Appearance & Language',
          secFlowProxy: 'Local Relay',
          secFlowStrategy: 'Output Recovery',
          modTheme: 'Codex Light & Dark Theme',
          modThemeDesc: 'Follows IDE light/dark appearance automatically',
          compactTypoLbl: 'Compact Typography',
          compactTypoDesc: 'Tighten line-height to 1.4 & tool row padding',
          bubbleTintLbl: 'User Message Bubble Tint',
          bubbleTintDesc: 'Apply subtle low-saturation tint to user messages',
          overviewQuotaLbl: 'Show Quota in Overview',
          overviewQuotaDesc: 'Display quota bars in right overview',
          showClaudeQuotaLbl: 'Show Claude / GPT Quota',
          showClaudeQuotaDesc: 'Only Gemini quota is shown by default',
          overviewProgressLbl: 'Show Task Progress in Overview',
          overviewProgressDesc: 'Display phase steps & elapsed clock',
          modI18n: 'Chinese UI Localization',
          modI18nDesc: 'Disable to restore English immediately',
          localeLbl: 'Display Language',
          localeDesc: 'Switch live without restarting',
          locZhCn: '简体中文',
          locZhSg: '简中·英术',
          locZhTw: '繁體中文',
          locEn: 'English',
          syncAiLangLbl: 'Sync AI Reply Language',
          syncAiLangDesc: 'Keep agent thinking and replies in UI language',
          secPromptHooks: 'System Prompt & Permissions',
          modFlow: 'Chat Mode & Local Relay',
          modFlowDesc: 'Adds per-chat mode picker and local relay',
          flowDefaultModeLbl: 'Default Mode',
          flowDefaultModeDesc: 'Applied to new conversations',
          flowModeDefault: 'Default',
          flowModeWriting: 'Writing',
          flowModeEng: 'Engineering',
          flowModeFull: 'Full',
          flowMaxContLbl: 'Max Continuations',
          flowMaxContDesc: 'Auto-continue cut-off replies (0 = off)',
          flowRewriteLbl: 'Refusal Rewrite',
          flowRewriteDesc: 'Retry cleanly with the same model on refusal',
          flowHardeningLbl: 'File Output',
          flowHardeningDesc: 'Save writing drafts to files',
          flowJudgeLbl: 'Ending Judge',
          flowJudgeDesc: 'Check incomplete endings via fast model',
          flowSoftenLbl: 'Soften Retry',
          flowSoftenDesc: 'Soften wording and trim history on retry',
          flowRemapLbl: 'Fallback Model',
          flowRemapDesc: 'Switch model in Full mode if still blocked',
          flowAsarLbl: 'Traffic Redirect',
          flowAsarEnable: 'Enable Redirect',
          flowAsarDisable: 'Restore Default',
          flowProxyOnline: 'Running',
          flowProxyOffline: 'Stopped',
          flowAsarPatched: 'Active',
          flowAsarOriginal: 'Off',
          flowAsarMissing: 'app.asar missing',
          secFlowCompact: 'Codex Compaction Hijack',
          flowCompactLbl: 'Enable Codex Virtual Sliding Compaction',
          flowCompactDesc: 'Preempt native checkpoints while keeping recent tail verbatim (Recommended: 70% · 20k)',
          flowCompactThreshLbl: 'Auto Trigger Threshold',
          flowCompactThreshDesc: 'Pre-compact in background when prompt context ratio reaches this percentage',
          flowCompactTailLbl: 'Verbatim Tail Budget',
          flowCompactTailDesc: 'Maximum recent tokens kept verbatim without splitting tool call/response pairs',
          flowCompactNeedAsar: 'Note: Enable Traffic Redirect and Local Relay above for compaction hijack to take effect.',
          modCustomPrompt: 'System-Level Custom Prompt',
          modCustomPromptDesc: 'Global & per-mode prompts (inherited by subagents)',
          promptModeLbl: 'Injection Method',
          promptModeDescProxy: 'Injected on outbound requests with zero history bloat',
          promptModeDescHook: 'Injected via native Hook with fingerprint dedup',
          promptModePreInv: 'Hook',
          promptModeProxy: 'Proxy',
          promptTimingLbl: 'Injection Frequency',
          promptTimingDescSession: 'Once per session, zero context growth',
          promptTimingDescEvery: 'Reinforced on every turn tail without saving to history',
          promptTimingSession: 'Per Session',
          promptTimingEvery: 'Every Turn',
          promptProxyWarnNeedFlow: 'Enable Local Relay & Traffic Redirect in Relay tab first',
          promptProxyWarnNeedAsar: 'Redirect inactive — click Enable Redirect in Relay tab',
          promptScopeLbl: 'Scope',
          promptTabGlobal: 'Global',
          promptTabDefault: 'Default',
          promptTabWriting: 'Writing',
          promptTabEng: 'Eng',
          promptTabFull: 'Full',
          promptPlaceholderMode: 'Prompt for "{tab}" mode only (blank uses Global)…',
          promptPresetLbl: 'Presets:',
          presetSystemRole: 'Architect',
          presetAntiHalluc: 'Strict Verify',
          presetConcise: 'Concise',
          presetContract: 'Contract',
          promptPlaceholder: 'Enter global system prompt (max 20,000 chars)…',
          promptClearBtn: 'Clear',
          promptSaveBtn: 'Save',
          promptUnsaved: 'Unsaved',
          promptSavedTip: 'Ctrl/Cmd + Enter to save',
          modAutoAllow: 'Auto-Allow Tools',
          modAutoAllowDesc: 'Approve selected tools automatically via Hook',
          autoAllowModeLbl: 'Scope',
          autoAllowModeDesc: 'Safe Commands guards against destructive shell commands',
          autoAllowFiles: 'Files Only',
          autoAllowSafeCmd: 'Safe Commands',
          autoAllowAll: 'Allow All',
          autoAllowAllWarn: 'Warning: Allow All skips confirmation for every run_command call.',
          secSubagentRouting: 'Subagent Model Routing',
          modSubagentRouting: 'Auto-Assign Subagent Models',
          modSubagentRoutingDesc: 'Let the main agent pick subagent models by difficulty from your whitelist (supports custom IDs)',
          subagentEmpty: 'No allowed subagent models yet. Pick from available models or enter a custom ID (e.g. deepseek-4.1).',
          subagentPickBtn: '+ Pick Model',
          subagentCustomPh: 'Custom model ID (e.g. deepseek-4.1)',
          subagentAddBtn: 'Add',
          tierAuto: 'Auto tier',
          tierFast: 'Fast',
          tierBalanced: 'Balanced',
          tierStrong: 'Strong',
          tierToggleTip: 'Click to cycle capability tier',
          modAutoTitle: 'Auto-Update Conversation Title',
          modAutoTitleDesc: 'Refresh conversation title periodically as task progress evolves',
          autoTitleTurnsLbl: 'Every N Turns',
          autoTitleTurnsUnit: 'turns',
          autoTitleCoolLbl: 'Cooldown',
          autoTitleCoolUnit: 'min',
          autoTitleNowBtn: 'Refresh Now',
          autoTitleUpdating: 'Updating…',
          presets: {
            systemRole:
              '## System-Level Persona & Operating Rules\n- Act as a principal systems engineer; ground every claim in inspected source files and real command output.\n- Diagnose root causes before editing; avoid band-aids and unrelated refactors.\n- Run relevant checks/tests after edits and report only observed results.\n- Lead with concise conclusions and exact file/line references.',
            antiHalluc:
              '## Verification & Anti-Hallucination\n- Read actual source files before editing; never guess unverified APIs, paths, or flags.\n- Run relevant checks/tests after edits and report only observed results.\n- Ask for confirmation before destructive operations.',
            concise:
              '## Concise Engineering Style\n- Lead with conclusions and actionable changes; skip filler.\n- Make minimal, targeted edits without unrelated refactors.',
            contract:
              '## Contract-Driven Workflow\n- Outline affected files and intent before making broad edits.\n- Follow existing codebase conventions and summarize verified changes clearly.'
          },
          modMetrics: 'Live Status & Telemetry',
          modMetricsDesc: 'Bottom status bar, detail popover, and turn footer stats',
          secOptional: 'Optional Add-ons',
          modSuggest: 'Prompt Suggestions',
          modSuggestDescPre: 'Press ',
          modSuggestDescMid: ' or ',
          modSuggestDescPost: ' to accept (requires ',
          modSuggestDescEnd: ')',
          agyIdle: 'Stopped',
          agyWarming: 'Warming…',
          agyReady: 'Ready',
          agyMissing: 'agy missing',
          suggestModelLbl: 'Model',
          suggestModelDescPre: 'From ',
          suggestModelDescPost: '; Gemini 3.8 Flash Low recommended',
          refreshModelsTitle: 'Refresh agy models',
          menuModelsHdr: 'Models',
          recommendedBadge: 'Rec',
          modSsh: 'SSH Remote Stats',
          modSshDesc: 'Read-only remote metrics without copying .db files',
          sshHostsLbl: 'Allowed Hosts',
          addHostBtn: '+ Add host',
          addHostPlaceholder: 'e.g. node032',
          addHostOk: 'Add',
          secTelemetry: 'Status Bar & Telemetry',
          layoutLbl: 'Bar Density',
          layoutDesc: 'Compact inline or Detailed dedicated row',
          layoutCompact: 'Compact',
          layoutDetailed: 'Detailed',
          cacheLbl: 'Cache Scope',
          cacheDesc: 'Cumulative session or last-step hit rate',
          cacheSession: 'Session',
          cacheStep: 'Step',
          topbarMetricLbl: 'Topbar Usage Badge',
          topbarMetricDesc: 'Choose what the top-right heatmap button displays',
          topbarOptQuota: '5h Quota',
          topbarOptSessionTok: 'Session',
          topbarOptTodayTok: 'Today Tok',
          topbarOptMonthTok: 'Month Tok',
          topbarOptMonthCost: 'Month Cost',
          topbarOptIcon: 'Icon Only',
          secUpdate: 'Updates',
          updTitle: 'Plugin Version',
          updDescIdle: 'Check GitHub for updates; user config is preserved',
          updDescChecking: 'Checking latest release…',
          updDescUpToDate: 'Up to date',
          updDescAhead: 'Local build is ahead',
          updDescAvailable: 'Update available; applies live without restart',
          updDescMainDiff: 'Remote main branch has updates',
          updDescUpdating: 'Downloading and verifying…',
          updDescApplied: 'Updated; reloading window…',
          updPillChecking: 'Checking…',
          updPillLatest: 'Up to date',
          updPillAhead: 'Local ahead',
          updPillAvailablePrefix: 'New ',
          updPillMainDiff: 'main differs',
          updPillUpdating: 'Updating…',
          updPillApplied: 'Updated',
          updPillErr: 'Failed',
          updBtnCheck: 'Check',
          updBtnChecking: 'Checking…',
          updBtnApply: 'Update Now',
          updBtnSyncMain: 'Sync main',
          updBtnUpdating: 'Updating…'
        };
      }

      function escHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function findSelectedModelInfo(modelId) {
        const families = uiState.families || AG_SETTINGS_FALLBACK_FAMILIES;
        for (let i = 0; i < families.length; i++) {
          const fam = families[i];
          if (fam.singleId === modelId) {
            return { family: fam, effortLabel: '' };
          }
          if (Array.isArray(fam.efforts)) {
            for (let j = 0; j < fam.efforts.length; j++) {
              if (fam.efforts[j].id === modelId) {
                return { family: fam, effortLabel: fam.efforts[j].label };
              }
            }
          }
        }
        return {
          family: { key: '', name: modelId || 'Gemini 3.8 Flash', efforts: [] },
          effortLabel: ''
        };
      }

      function callDaemonBinding(bindingName, payloadObj, timeoutMs = 15000) {
        return new Promise((resolve) => {
          const fn = window[bindingName];
          if (typeof fn !== 'function') return resolve(null);
          reqSeq += 1;
          const reqId = `cfg-${Date.now()}-${reqSeq}`;
          const timer = setTimeout(() => {
            pendingReqs.delete(reqId);
            resolve(null);
          }, timeoutMs);
          pendingReqs.set(reqId, (res) => {
            clearTimeout(timer);
            resolve(res);
          });
          try {
            fn(JSON.stringify(Object.assign({ reqId }, payloadObj || {})));
          } catch {
            clearTimeout(timer);
            pendingReqs.delete(reqId);
            resolve(null);
          }
        });
      }

      window.__ag_on_settings_state = (reqId, payload) => {
        if (disposed) return;
        const cb = pendingReqs.get(reqId);
        if (cb) {
          pendingReqs.delete(reqId);
          cb(payload);
        }
      };

      function applyRemoteState(res, flashSaved) {
        if (!res || !res.ok) return;
        if (res.config) {
          const nextSp =
            res.config.customSystemPrompt && typeof res.config.customSystemPrompt === 'object'
              ? {
                  enabled: Boolean(res.config.customSystemPrompt.enabled),
                  mode: res.config.customSystemPrompt.mode || 'flow-proxy',
                  text: typeof res.config.customSystemPrompt.text === 'string' ? res.config.customSystemPrompt.text : '',
                  everyInvocation: Boolean(res.config.customSystemPrompt.everyInvocation)
                }
              : uiState.config.customSystemPrompt;
          const nextAa =
            res.config.hookAutoAllow && typeof res.config.hookAutoAllow === 'object'
              ? {
                  enabled: Boolean(res.config.hookAutoAllow.enabled),
                  mode: res.config.hookAutoAllow.mode || 'files'
                }
              : uiState.config.hookAutoAllow;
          const nextFlow =
            res.config.flow && typeof res.config.flow === 'object'
              ? Object.assign({}, DEFAULT_FLOW_UI, uiState.config.flow || {}, res.config.flow)
              : uiState.config.flow;
          const nextAutoTitle =
            res.config.autoTitle && typeof res.config.autoTitle === 'object'
              ? Object.assign({}, DEFAULT_AUTO_TITLE_UI, uiState.config.autoTitle || {}, res.config.autoTitle)
              : uiState.config.autoTitle;
          const nextSubRouting =
            res.config.subagentRouting && typeof res.config.subagentRouting === 'object'
              ? {
                  enabled: Boolean(res.config.subagentRouting.enabled),
                  allowedModels: Array.isArray(res.config.subagentRouting.allowedModels)
                    ? res.config.subagentRouting.allowedModels.map((m) => Object.assign({}, m))
                    : []
                }
              : uiState.config.subagentRouting;
          uiState.config = {
            i18nLocale: res.config.i18nLocale || uiState.config.i18nLocale || 'zh-CN',
            syncAiOutputLang:
              typeof res.config.syncAiOutputLang === 'boolean'
                ? res.config.syncAiOutputLang
                : Boolean(uiState.config.syncAiOutputLang),
            customSystemPrompt: nextSp,
            hookAutoAllow: nextAa,
            flow: nextFlow,
            autoTitle: nextAutoTitle,
            subagentRouting: nextSubRouting,
            telemetryLayout: res.config.telemetryLayout || uiState.config.telemetryLayout,
            telemetryCacheMode: res.config.telemetryCacheMode || uiState.config.telemetryCacheMode,
            compactTypography:
              typeof res.config.compactTypography === 'boolean' ? res.config.compactTypography : uiState.config.compactTypography,
            topbarUsageMetric: res.config.topbarUsageMetric || uiState.config.topbarUsageMetric || 'quota',
            overviewQuota:
              typeof res.config.overviewQuota === 'boolean' ? res.config.overviewQuota : uiState.config.overviewQuota,
            overviewProgress:
              typeof res.config.overviewProgress === 'boolean' ? res.config.overviewProgress : uiState.config.overviewProgress,
            showClaudeQuota:
              typeof res.config.showClaudeQuota === 'boolean' ? res.config.showClaudeQuota : Boolean(uiState.config.showClaudeQuota),
            promptSuggestionModel: res.config.promptSuggestionModel || uiState.config.promptSuggestionModel,
            sshHosts: Array.isArray(res.config.sshHosts) ? res.config.sshHosts.slice() : uiState.config.sshHosts,
            modules: Object.assign({}, uiState.config.modules, res.config.modules || {})
          };
          if (typeof promptDrafts.global !== 'string') {
            setDraftForTab('global', nextSp.text);
          }
          syncUiPrefsToRuntime(uiState.config, { refreshTopbar: true });
        }
        if (res.flowStatus && typeof res.flowStatus === 'object') {
          uiState.flowStatus = res.flowStatus;
        }
        if (res.agyStatus) {
          uiState.agyStatus = Object.assign({}, res.agyStatus);
          window.__ag_settings_agy_cache = Object.assign({}, res.agyStatus);
        }
        if (res.modelsInfo && Array.isArray(res.modelsInfo.families) && res.modelsInfo.families.length > 0) {
          uiState.families = res.modelsInfo.families;
          window.__ag_settings_models_cache = res.modelsInfo.families;
        }
        if (flashSaved) {
          window.__ag_settings_saved_label = flashSaved === 'refreshed' ? 'refreshed' : 'saved';
          window.__ag_settings_saved_until = Date.now() + 1800;
        }
        renderPane();
        syncStatusPoller();
      }

      async function fetchSettingsState({ includeModels = false, refreshModels = false, forceReload = false } = {}) {
        if (forceReload) {
          refreshingAll = true;
          window.__ag_settings_saved_label = 'refreshed';
          window.__ag_settings_saved_until = Date.now() + 2400;
          const paneEl = document.getElementById('ag-settings-pane');
          if (paneEl) window.__ag_settings_scroll_top = paneEl.scrollTop;
          updateRefreshSpin();
        }
        if (refreshModels) {
          refreshingModels = true;
          updateRefreshSpin();
        }
        const res = await callDaemonBinding('__agGetSettingsState', { includeModels, refreshModels, forceReload });
        if (forceReload) {
          refreshingAll = false;
          updateRefreshSpin();
        }
        if (refreshModels) {
          refreshingModels = false;
          updateRefreshSpin();
        }
        if (!disposed && res) {
          applyRemoteState(res, forceReload ? 'refreshed' : false);
        }
      }

      async function checkPluginUpdate() {
        if (uiState.update.phase === 'checking' || uiState.update.phase === 'updating') return;
        uiState.update = Object.assign({}, uiState.update, { phase: 'checking', error: '' });
        window.__ag_settings_update_cache = Object.assign({}, uiState.update);
        renderPane();

        const res = await callDaemonBinding('__agCheckPluginUpdate', {}, 20000);
        if (disposed) return;
        if (!res || !res.ok) {
          uiState.update = Object.assign({}, uiState.update, {
            phase: 'done',
            status: 'error',
            updateAvailable: false,
            canSyncMain: false,
            error: (res && res.error) || 'Network error'
          });
        } else {
          uiState.update = {
            phase: 'done',
            status: res.status || 'up_to_date',
            currentVersion: res.currentVersion || '',
            latestVersion: res.latestVersion || '',
            updateAvailable: Boolean(res.updateAvailable),
            canSyncMain: Boolean(res.canSyncMain),
            changedCount: Number(res.changedCount || 0),
            targetRef: res.targetRef || 'main',
            error: ''
          };
        }
        window.__ag_settings_update_cache = Object.assign({}, uiState.update);
        renderPane();
      }

      async function applyPluginUpdateAction() {
        if (uiState.update.phase === 'updating' || uiState.update.phase === 'checking') return;
        const ref = uiState.update.targetRef || 'main';
        uiState.update = Object.assign({}, uiState.update, { phase: 'updating', error: '' });
        window.__ag_settings_update_cache = Object.assign({}, uiState.update);
        const paneEl = document.getElementById('ag-settings-pane');
        if (paneEl) window.__ag_settings_scroll_top = paneEl.scrollTop;
        renderPane();

        const res = await callDaemonBinding('__agApplyPluginUpdate', { ref }, 60000);
        if (disposed) return;
        if (!res || !res.ok) {
          uiState.update = Object.assign({}, uiState.update, {
            phase: 'done',
            status: 'error',
            error: (res && res.error) || 'Update failed'
          });
        } else {
          uiState.update = {
            phase: 'applied',
            status: 'applied',
            currentVersion: res.version || uiState.update.latestVersion,
            latestVersion: res.version || uiState.update.latestVersion,
            updateAvailable: false,
            canSyncMain: false,
            changedCount: 0,
            targetRef: 'main',
            error: ''
          };
          window.__ag_settings_saved_label = 'refreshed';
          window.__ag_settings_saved_until = Date.now() + 3000;
        }
        window.__ag_settings_update_cache = Object.assign({}, uiState.update);
        renderPane();
      }

      async function commitPatch(patch) {
        // Optimistic local state update for snappy UX
        if (patch.modules) {
          Object.assign(uiState.config.modules, patch.modules);
          if (patch.modules.i18n === true && uiState.config.i18nLocale === 'en') {
            uiState.config.i18nLocale = 'zh-CN';
          }
          if (patch.modules.promptSuggestions === false) {
            uiState.agyStatus = Object.assign({}, uiState.agyStatus, { running: false, ready: false, warmed: false });
          } else if (patch.modules.promptSuggestions === true && uiState.agyStatus.available) {
            uiState.agyStatus = Object.assign({}, uiState.agyStatus, { running: true, warmed: false });
          }
        }
        if (typeof patch.i18nLocale === 'string') {
          uiState.config.i18nLocale = patch.i18nLocale;
          uiState.config.modules.i18n = patch.i18nLocale !== 'en';
        }
        if (typeof patch.syncAiOutputLang === 'boolean') {
          uiState.config.syncAiOutputLang = patch.syncAiOutputLang;
        }
        if (patch.customSystemPrompt && typeof patch.customSystemPrompt === 'object') {
          uiState.config.customSystemPrompt = Object.assign({}, uiState.config.customSystemPrompt, patch.customSystemPrompt);
          if (typeof patch.customSystemPrompt.text === 'string') {
            setDraftForTab('global', patch.customSystemPrompt.text);
          }
        }
        if (patch.hookAutoAllow && typeof patch.hookAutoAllow === 'object') {
          uiState.config.hookAutoAllow = Object.assign({}, uiState.config.hookAutoAllow, patch.hookAutoAllow);
        }
        if (patch.flow && typeof patch.flow === 'object') {
          uiState.config.flow = Object.assign({}, DEFAULT_FLOW_UI, uiState.config.flow || {}, patch.flow);
        }
        if (patch.autoTitle && typeof patch.autoTitle === 'object') {
          uiState.config.autoTitle = Object.assign({}, DEFAULT_AUTO_TITLE_UI, uiState.config.autoTitle || {}, patch.autoTitle);
        }
        if (patch.subagentRouting && typeof patch.subagentRouting === 'object') {
          const curSr = uiState.config.subagentRouting || { enabled: false, allowedModels: [] };
          uiState.config.subagentRouting = {
            enabled:
              typeof patch.subagentRouting.enabled === 'boolean' ? patch.subagentRouting.enabled : Boolean(curSr.enabled),
            allowedModels: Array.isArray(patch.subagentRouting.allowedModels)
              ? patch.subagentRouting.allowedModels.map((m) => Object.assign({}, m))
              : (curSr.allowedModels || []).slice()
          };
        }
        if (patch.telemetryLayout) uiState.config.telemetryLayout = patch.telemetryLayout;
        if (patch.telemetryCacheMode) uiState.config.telemetryCacheMode = patch.telemetryCacheMode;
        if (typeof patch.compactTypography === 'boolean') uiState.config.compactTypography = patch.compactTypography;
        if (typeof patch.topbarUsageMetric === 'string') uiState.config.topbarUsageMetric = patch.topbarUsageMetric;
        if (typeof patch.overviewQuota === 'boolean') uiState.config.overviewQuota = patch.overviewQuota;
        if (typeof patch.overviewProgress === 'boolean') uiState.config.overviewProgress = patch.overviewProgress;
        if (typeof patch.showClaudeQuota === 'boolean') uiState.config.showClaudeQuota = patch.showClaudeQuota;
        syncUiPrefsToRuntime(uiState.config, { refreshTopbar: true });
        if (typeof window.__ag_sync_overview_extensions === 'function') {
          try { window.__ag_sync_overview_extensions(); } catch {}
        }
        if (typeof window.__ag_sync_preset_fn === 'function') {
          try { window.__ag_sync_preset_fn(); } catch {}
        }
        if (typeof window.__ag_sync_overview_extensions === 'function') {
          try { window.__ag_sync_overview_extensions(); } catch {}
        }
        if (patch.promptSuggestionModel) {
          uiState.config.promptSuggestionModel = patch.promptSuggestionModel;
          if (uiState.config.modules.promptSuggestions && uiState.agyStatus.available) {
            uiState.agyStatus = Object.assign({}, uiState.agyStatus, { warmed: false, running: true });
          }
        }
        if (Array.isArray(patch.sshHosts)) {
          uiState.config.sshHosts = patch.sshHosts.slice();
        }
        window.__ag_settings_saved_label = 'saved';
        window.__ag_settings_saved_until = Date.now() + 1800;
        const paneEl = document.getElementById('ag-settings-pane');
        if (paneEl) window.__ag_settings_scroll_top = paneEl.scrollTop;
        renderPane();
        syncStatusPoller();

        const res = await callDaemonBinding('__agUpdateSettings', { patch });
        if (!disposed && res) {
          applyRemoteState(res, true);
        }
      }

      function syncStatusPoller() {
        if (statusPollTimer) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
        }
        const needPoll =
          Boolean(window.__ag_settings_tab_open) &&
          Boolean(activeDlg && activeDlg.isConnected) &&
          Boolean(uiState.config.modules.promptSuggestions) &&
          uiState.agyStatus.available !== false &&
          !uiState.agyStatus.warmed;
        if (!needPoll) return;
        statusPollTimer = setInterval(() => {
          if (disposed || !window.__ag_settings_tab_open || !activeDlg || !activeDlg.isConnected) {
            syncStatusPoller();
            return;
          }
          fetchSettingsState({ includeModels: false, refreshModels: false });
        }, 1500);
      }

      const VALID_CUSTOM_MODEL_RE = /^[a-zA-Z0-9._:/-]{2,80}$/;

      function inferSubagentTierLocal(modelId) {
        const low = String(modelId || '').toLowerCase();
        if (/flash|lite|mini|haiku|small|fast|low$/.test(low)) return 'fast';
        if (/opus|xhigh|max|pro|r1|reasoner|4\.1|high$/.test(low)) return 'strong';
        return 'balanced';
      }

      function addSubagentAllowedModel(rawId, tierOverride) {
        const id = String(rawId || '').trim();
        if (!id || id.startsWith('-') || !VALID_CUSTOM_MODEL_RE.test(id)) return false;
        const curSr = uiState.config.subagentRouting || { enabled: false, allowedModels: [] };
        const list = Array.isArray(curSr.allowedModels) ? curSr.allowedModels.map((m) => Object.assign({}, m)) : [];
        if (list.some((m) => String(m.id || '').toLowerCase() === id.toLowerCase())) {
          return true;
        }
        const tier =
          tierOverride === 'fast' || tierOverride === 'balanced' || tierOverride === 'strong'
            ? tierOverride
            : inferSubagentTierLocal(id);
        list.push({ id, tier, note: '' });
        commitPatch({ subagentRouting: { allowedModels: list } });
        return true;
      }

      function getPickerModelId(targetKey) {
        if (targetKey === 'subagentRouting.add') {
          return '';
        }
        if (targetKey === 'flow.judgeModel') {
          return (uiState.config.flow && uiState.config.flow.judgeModel) || DEFAULT_FLOW_UI.judgeModel;
        }
        if (targetKey === 'flow.remapTargetModel') {
          return (uiState.config.flow && uiState.config.flow.remapTargetModel) || DEFAULT_FLOW_UI.remapTargetModel;
        }
        return uiState.config.promptSuggestionModel || 'gemini-3.8-flash-low';
      }

      function commitPickerModelId(targetKey, modelId) {
        if (!modelId) return;
        if (targetKey === 'subagentRouting.add') {
          addSubagentAllowedModel(modelId, '');
          return;
        }
        if (targetKey === 'flow.judgeModel') {
          commitPatch({ flow: { judgeModel: modelId } });
          return;
        }
        if (targetKey === 'flow.remapTargetModel') {
          commitPatch({ flow: { remapTargetModel: modelId } });
          return;
        }
        commitPatch({ promptSuggestionModel: modelId });
      }

      function updateRefreshSpin() {
        document.querySelectorAll('.ag-s-refresh-models-icon').forEach((icon) => {
          icon.classList.toggle('ag-s-spin', Boolean(refreshingModels));
        });
        const hdrIcon = document.getElementById('ag-s-manual-refresh-icon');
        if (hdrIcon) hdrIcon.classList.toggle('ag-s-spin', Boolean(refreshingAll));
      }

      function hideModelMenus({ restoreFocus = false, fromPointer = false } = {}) {
        // Reset cached submenu anchor whenever menus hide
        lastSubAnchorBtn = null;
        if (hoverSwitchTimer) {
          clearTimeout(hoverSwitchTimer);
          hoverSwitchTimer = null;
        }
        const sub = document.getElementById('ag-settings-effort-menu');
        const root = document.getElementById('ag-settings-model-menu');
        const trigger = activeModelPickerTriggerId ? document.getElementById(activeModelPickerTriggerId) : null;
        if (sub) {
          if (SUPPORTS_POPOVER) {
            try {
              if (sub.matches(':popover-open')) sub.hidePopover();
            } catch {}
          } else {
            sub.hidden = true;
          }
        }
        if (root) {
          if (SUPPORTS_POPOVER) {
            try {
              if (root.matches(':popover-open')) root.hidePopover();
            } catch {}
          } else {
            root.hidden = true;
          }
        }
        document.querySelectorAll('[data-model-picker-target]').forEach((el) => {
          el.setAttribute('aria-expanded', 'false');
        });
        if (trigger && restoreFocus) {
          try {
            trigger.focus({ focusVisible: !fromPointer });
          } catch {
            try { trigger.focus(); } catch {}
          }
        }
      }

      function isPopoverOpen(el) {
        if (!el) return false;
        if (SUPPORTS_POPOVER) {
          try {
            return el.matches(':popover-open');
          } catch {
            return false;
          }
        }
        return !el.hidden;
      }

      function positionFixedOverlay(overlayEl, anchorEl, placement) {
        if (!overlayEl || !anchorEl) return;
        overlayEl.setAttribute('data-js-pos', '1');
        const ar = anchorEl.getBoundingClientRect();
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const ow = overlayEl.offsetWidth || (placement === 'submenu' ? 172 : 272);
        const oh = overlayEl.offsetHeight || 220;
        let left;
        let top;
        if (placement === 'submenu') {
          const parentBox = (anchorEl.closest && anchorEl.closest('#ag-settings-model-menu')) || anchorEl;
          const pr = parentBox.getBoundingClientRect();
          left = pr.right + 6;
          if (left + ow > vw - 12) {
            left = pr.left - ow - 6;
          }
          if (left < 12) {
            left = Math.max(12, vw - ow - 12);
          }
          top = ar.top - 6;
          if (top + oh > vh - 12) top = vh - oh - 12;
          if (top < 12) top = 12;
        } else {
          left = ar.right - ow;
          if (left < 12) left = Math.max(12, ar.left);
          if (left + ow > vw - 12) left = Math.max(12, vw - ow - 12);
          top = ar.bottom + 6;
          if (top + oh > vh - 12 && ar.top - oh - 6 >= 12) {
            top = ar.top - oh - 6;
          } else if (top + oh > vh - 12) {
            top = Math.max(12, vh - oh - 12);
          }
        }
        overlayEl.style.left = Math.round(left) + 'px';
        overlayEl.style.top = Math.round(top) + 'px';
      }

      function openEffortSubmenu(fam, anchorBtn, { focusFirst = false } = {}) {
        const sub = document.getElementById('ag-settings-effort-menu');
        if (!sub) return;
        if (!fam || !Array.isArray(fam.efforts) || fam.efforts.length === 0) {
          lastSubAnchorBtn = null;
          if (isPopoverOpen(sub)) {
            if (SUPPORTS_POPOVER) {
              try { sub.hidePopover(); } catch {}
            } else {
              sub.hidden = true;
            }
          }
          return;
        }

        const listEl = sub.querySelector('.ag-s-menu-list');
        if (listEl) {
          const curId = getPickerModelId(activeModelPickerTarget);
          listEl.innerHTML = fam.efforts
            .map((ef) => {
              const isSel = ef.id === curId;
              return (
                '<button type="button" class="ag-s-menu-row" role="menuitemradio" aria-checked="' +
                (isSel ? 'true' : 'false') +
                '" data-pick-effort="' +
                escHtml(ef.id) +
                '">' +
                '<span>' +
                escHtml(ef.label) +
                '</span>' +
                (isSel
                  ? '<svg class="ag-s-menu-row-check" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>'
                  : '') +
                '</button>'
              );
            })
            .join('');
        }

        if (SUPPORTS_POPOVER) {
          try {
            if (SUPPORTS_IMPLICIT_ANCHOR) {
              const alreadyOpen = isPopoverOpen(sub);
              if (!alreadyOpen || lastSubAnchorBtn !== anchorBtn) {
                if (alreadyOpen) {
                  try { sub.hidePopover(); } catch {}
                }
                sub.removeAttribute('data-js-pos');
                sub.style.left = '';
                sub.style.top = '';
                sub.showPopover({ source: anchorBtn });
                lastSubAnchorBtn = anchorBtn;
              }
            } else {
              if (!isPopoverOpen(sub)) sub.showPopover();
              positionFixedOverlay(sub, anchorBtn, 'submenu');
              lastSubAnchorBtn = anchorBtn;
            }
          } catch {
            try {
              if (!isPopoverOpen(sub)) sub.showPopover();
              positionFixedOverlay(sub, anchorBtn, 'submenu');
              lastSubAnchorBtn = anchorBtn;
            } catch {}
          }
        } else {
          sub.hidden = false;
          positionFixedOverlay(sub, anchorBtn, 'submenu');
          lastSubAnchorBtn = anchorBtn;
        }

        if (focusFirst && listEl) {
          const firstBtn = listEl.querySelector('button[aria-checked="true"]') || listEl.querySelector('button');
          if (firstBtn) firstBtn.focus();
        }
      }

      function renderModelMenuItems() {
        const root = document.getElementById('ag-settings-model-menu');
        if (!root) return;
        const s = getStrings();
        const hdr = root.querySelector('.ag-s-menu-hdr');
        if (hdr) hdr.textContent = s.menuModelsHdr;

        const listEl = root.querySelector('.ag-s-menu-list');
        if (!listEl) return;
        const curModelId = getPickerModelId(activeModelPickerTarget);
        const selInfo = findSelectedModelInfo(curModelId);
        const showRecBadge = activeModelPickerTarget !== 'flow.remapTargetModel';
        const families = uiState.families || AG_SETTINGS_FALLBACK_FAMILIES;

        listEl.innerHTML = families
          .map((fam) => {
            const isSelectedFam = selInfo.family.key === fam.key;
            const isHovered = hoveredFamilyKey === fam.key;
            const hasSub = Array.isArray(fam.efforts) && fam.efforts.length > 0;
            const displayEffort = isSelectedFam ? selInfo.effortLabel : fam.defaultEffort || '';
            const roleAttr = hasSub
              ? SUPPORTS_FOCUSGROUP
                ? ''
                : ' role="menuitem"'
              : ' role="menuitemradio" aria-checked="' + (isSelectedFam ? 'true' : 'false') + '"';

            return (
              '<button type="button" class="ag-s-menu-row"' +
              roleAttr +
              (hasSub ? ' aria-haspopup="menu" aria-expanded="' + (isHovered ? 'true' : 'false') + '"' : '') +
              ' data-fam-key="' +
              escHtml(fam.key) +
              '" data-selected="' +
              (isSelectedFam ? 'true' : 'false') +
              '" data-hovered="' +
              (isHovered ? 'true' : 'false') +
              '">' +
              '<span class="ag-s-menu-row-left">' +
              '<span class="ag-s-menu-row-name">' +
              escHtml(fam.name) +
              '</span>' +
              (displayEffort ? '<span class="ag-s-menu-row-effort">' + escHtml(displayEffort) + '</span>' : '') +
              (showRecBadge && fam.recommended ? '<span class="ag-s-menu-badge">' + escHtml(s.recommendedBadge) + '</span>' : '') +
              '</span>' +
              '<span class="ag-s-menu-row-right" aria-hidden="true">' +
              (hasSub
                ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'
                : isSelectedFam
                ? '<svg class="ag-s-menu-row-check" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>'
                : '') +
              '</span>' +
              '</button>'
            );
          })
          .join('');
      }

      function ensureModelPopovers() {
        let root = document.getElementById('ag-settings-model-menu');
        if (root) return root;

        root = document.createElement('div');
        root.id = 'ag-settings-model-menu';
        if (SUPPORTS_POPOVER) {
          root.setAttribute('popover', 'auto');
        } else {
          root.hidden = true;
        }

        const fg = document.createElement('div');
        fg.setAttribute('focusgroup', 'menu nomemory');
        if (!SUPPORTS_FOCUSGROUP) fg.setAttribute('role', 'menu');
        fg.setAttribute('aria-labelledby', 'ag-s-model-trigger');

        const hdr = document.createElement('div');
        hdr.className = 'ag-s-menu-hdr';
        const list = document.createElement('div');
        list.className = 'ag-s-menu-list';

        const sub = document.createElement('div');
        sub.id = 'ag-settings-effort-menu';
        if (SUPPORTS_POPOVER) {
          sub.setAttribute('popover', 'auto');
        } else {
          sub.hidden = true;
        }
        const subFg = document.createElement('div');
        subFg.setAttribute('focusgroup', 'menu nomemory');
        if (!SUPPORTS_FOCUSGROUP) subFg.setAttribute('role', 'menu');
        subFg.setAttribute('aria-label', 'Thinking effort');
        subFg.innerHTML =
          '<div class="ag-s-menu-hdr">' +
          '<span>Thinking effort</span>' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.8h.01" stroke-linecap="round"/>' +
          '</svg>' +
          '</div>' +
          '<div class="ag-s-menu-list"></div>';
        sub.appendChild(subFg);

        fg.appendChild(hdr);
        fg.appendChild(list);
        fg.appendChild(sub);
        root.appendChild(fg);
        document.body.appendChild(root);

        root.addEventListener('toggle', (ev) => {
          const trigger = activeModelPickerTriggerId ? document.getElementById(activeModelPickerTriggerId) : null;
          const open = ev.newState === 'open';
          if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (!open && isPopoverOpen(sub)) {
            try { sub.hidePopover(); } catch {}
          }
        });

        // Hover Level 1 row -> preview Level 2 effort submenu (short grace delay when submenu is open to aid diagonal travel)
        sub.addEventListener('mouseenter', () => {
          if (hoverSwitchTimer) {
            clearTimeout(hoverSwitchTimer);
            hoverSwitchTimer = null;
          }
        });
        list.addEventListener('mouseover', (ev) => {
          const row = ev.target && ev.target.closest ? ev.target.closest('[data-fam-key]') : null;
          if (!row) return;
          const key = row.getAttribute('data-fam-key');
          if (!key) return;
          if (hoverSwitchTimer) {
            clearTimeout(hoverSwitchTimer);
            hoverSwitchTimer = null;
          }
          const applyHoverRow = () => {
            if (disposed || !isPopoverOpen(root)) return;
            if (key !== hoveredFamilyKey) {
              hoveredFamilyKey = key;
              list.querySelectorAll('[data-fam-key]').forEach((b) => {
                const isH = b.getAttribute('data-fam-key') === key;
                b.setAttribute('data-hovered', isH ? 'true' : 'false');
                if (b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', isH ? 'true' : 'false');
              });
            }
            if (document.activeElement && document.activeElement !== row && list.contains(document.activeElement)) {
              try {
                row.focus({ focusVisible: false });
              } catch {
                try { row.focus(); } catch {}
              }
            }
            const fam = (uiState.families || AG_SETTINGS_FALLBACK_FAMILIES).find((f) => f.key === key);
            openEffortSubmenu(fam, row, { focusFirst: false });
          };
          if (key !== hoveredFamilyKey && isPopoverOpen(sub) && ev.isTrusted) {
            hoverSwitchTimer = setTimeout(() => {
              hoverSwitchTimer = null;
              applyHoverRow();
            }, 60);
          } else {
            applyHoverRow();
          }
        });

        // Click Level 1 row
        list.addEventListener('click', (ev) => {
          const row = ev.target && ev.target.closest ? ev.target.closest('[data-fam-key]') : null;
          if (!row) return;
          const key = row.getAttribute('data-fam-key');
          const fam = (uiState.families || AG_SETTINGS_FALLBACK_FAMILIES).find((f) => f.key === key);
          if (!fam) return;
          if (fam.singleId) {
            const targetKey = activeModelPickerTarget;
            hideModelMenus({ restoreFocus: true, fromPointer: ev.detail !== 0 });
            commitPickerModelId(targetKey, fam.singleId);
          } else {
            hoveredFamilyKey = key;
            openEffortSubmenu(fam, row, { focusFirst: ev.detail === 0 });
          }
        });

        // Click Level 2 effort item
        sub.addEventListener('click', (ev) => {
          const btn = ev.target && ev.target.closest ? ev.target.closest('[data-pick-effort]') : null;
          if (!btn) return;
          const id = btn.getAttribute('data-pick-effort');
          if (!id) return;
          const targetKey = activeModelPickerTarget;
          hideModelMenus({ restoreFocus: true, fromPointer: ev.detail !== 0 });
          commitPickerModelId(targetKey, id);
        });

        // Keyboard navigation across Level 1 & Level 2
        const handleMenuKeydown = (menuEl, isSub) => (ev) => {
          const items = Array.from(menuEl.querySelectorAll('.ag-s-menu-list > button'));
          if (items.length === 0) return;
          const idx = items.indexOf(document.activeElement);
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
            ev.preventDefault();
            ev.stopPropagation();
            const nextIdx =
              ev.key === 'Home'
                ? 0
                : ev.key === 'End'
                ? items.length - 1
                : idx < 0
                ? 0
                : (idx + (ev.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            const nextBtn = items[nextIdx];
            nextBtn.focus();
            if (!isSub) {
              const key = nextBtn.getAttribute('data-fam-key');
              hoveredFamilyKey = key || '';
              const fam = (uiState.families || AG_SETTINGS_FALLBACK_FAMILIES).find((f) => f.key === key);
              openEffortSubmenu(fam, nextBtn, { focusFirst: false });
            }
          } else if (!isSub && ev.key === 'ArrowRight' && idx >= 0) {
            const key = items[idx].getAttribute('data-fam-key');
            const fam = (uiState.families || AG_SETTINGS_FALLBACK_FAMILIES).find((f) => f.key === key);
            if (fam && fam.efforts && fam.efforts.length > 0) {
              ev.preventDefault();
              ev.stopPropagation();
              openEffortSubmenu(fam, items[idx], { focusFirst: true });
            }
          } else if (isSub && (ev.key === 'ArrowLeft' || ev.key === 'Escape')) {
            ev.preventDefault();
            ev.stopPropagation();
            if (SUPPORTS_POPOVER) {
              try { sub.hidePopover(); } catch {}
            } else {
              sub.hidden = true;
            }
            const parentRow = list.querySelector('[data-fam-key="' + hoveredFamilyKey + '"]');
            if (parentRow) parentRow.focus();
          } else if (!isSub && ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            hideModelMenus({ restoreFocus: true, fromPointer: false });
          } else if (ev.key === 'Tab') {
            hideModelMenus({ restoreFocus: false });
          }
        };

        list.addEventListener('keydown', handleMenuKeydown(root, false));
        sub.addEventListener('keydown', handleMenuKeydown(sub, true));

        return root;
      }

      function toggleModelMenu(triggerBtn, fromKeyboard) {
        const root = ensureModelPopovers();
        const nextTarget =
          (triggerBtn && triggerBtn.getAttribute && triggerBtn.getAttribute('data-model-picker-target')) ||
          'promptSuggestionModel';
        const nextTriggerId = (triggerBtn && triggerBtn.id) || 'ag-s-model-trigger';
        const sameTrigger = isPopoverOpen(root) && activeModelPickerTriggerId === nextTriggerId;
        if (sameTrigger) {
          hideModelMenus({ restoreFocus: fromKeyboard, fromPointer: !fromKeyboard });
          return;
        }
        if (isPopoverOpen(root)) {
          hideModelMenus({ restoreFocus: false });
        }
        activeModelPickerTarget = nextTarget;
        activeModelPickerTriggerId = nextTriggerId;
        const fg = root.firstElementChild;
        if (fg && nextTriggerId) fg.setAttribute('aria-labelledby', nextTriggerId);

        const selInfo = findSelectedModelInfo(getPickerModelId(activeModelPickerTarget));
        hoveredFamilyKey = selInfo.family.key || (uiState.families[0] && uiState.families[0].key) || '';
        renderModelMenuItems();

        if (SUPPORTS_POPOVER) {
          try {
            if (SUPPORTS_IMPLICIT_ANCHOR) {
              root.removeAttribute('data-js-pos');
              root.style.left = '';
              root.style.top = '';
              root.showPopover({ source: triggerBtn });
            } else {
              root.showPopover();
              positionFixedOverlay(root, triggerBtn, 'root');
            }
          } catch {
            try {
              root.showPopover();
              positionFixedOverlay(root, triggerBtn, 'root');
            } catch {}
          }
        } else {
          root.hidden = false;
          positionFixedOverlay(root, triggerBtn, 'root');
        }
        triggerBtn.setAttribute('aria-expanded', 'true');

        // Preview submenu for currently selected family on open
        const selectedRow = root.querySelector('[data-fam-key="' + hoveredFamilyKey + '"]');
        const selectedFam = (uiState.families || AG_SETTINGS_FALLBACK_FAMILIES).find((f) => f.key === hoveredFamilyKey);
        if (selectedRow && selectedFam && selectedFam.efforts && selectedFam.efforts.length > 0) {
          openEffortSubmenu(selectedFam, selectedRow, { focusFirst: false });
        }
        if (fromKeyboard) {
          const focusTarget = selectedRow || root.querySelector('.ag-s-menu-list > button');
          if (focusTarget) focusTarget.focus();
        }
      }

      function bindAddingHostInput() {
        if (!addingHost) return;
        const inp = document.getElementById('ag-s-host-input');
        if (!inp || inp.__ag_bound_host_input) return;
        inp.__ag_bound_host_input = true;
        inp.focus();
        listen(inp, 'keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submitNewHost(inp.value);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            addingHost = false;
            invalidHost = false;
            renderPane();
          }
        });
      }

      function buildUpdateCardHtml(s) {
        const u = uiState.update || {};
        const verStr = u.currentVersion ? 'v' + String(u.currentVersion).replace(/^v/i, '') : getShortVersionTag();
        const isBusy = u.phase === 'checking' || u.phase === 'updating';
        let pillHtml = '';
        let descText = s.updDescIdle;
        if (u.phase === 'checking') {
          pillHtml = '<span class="ag-s-upd-pill" data-tone="idle">' + escHtml(s.updPillChecking) + '</span>';
          descText = s.updDescChecking;
        } else if (u.phase === 'updating') {
          pillHtml = '<span class="ag-s-upd-pill" data-tone="warn">' + escHtml(s.updPillUpdating) + '</span>';
          descText = s.updDescUpdating;
        } else if (u.status === 'applied') {
          pillHtml = '<span class="ag-s-upd-pill" data-tone="ok">' + escHtml(s.updPillApplied) + '</span>';
          descText = s.updDescApplied;
        } else if (u.status === 'up_to_date') {
          pillHtml = '<span class="ag-s-upd-pill" data-tone="ok">' + escHtml(s.updPillLatest) + '</span>';
          descText = s.updDescUpToDate;
        } else if (u.status === 'ahead') {
          pillHtml = '<span class="ag-s-upd-pill" data-tone="ok">' + escHtml(s.updPillAhead) + '</span>';
          descText = s.updDescAhead;
        } else if (u.status === 'update_available') {
          const latestTag = u.latestVersion ? 'v' + String(u.latestVersion).replace(/^v/i, '') : '';
          pillHtml =
            '<span class="ag-s-upd-pill" data-tone="warn">' +
            escHtml(s.updPillAvailablePrefix + latestTag) +
            '</span>';
          descText = s.updDescAvailable;
        } else if (u.status === 'main_diff') {
          const diffSuffix = u.changedCount > 0 ? ' (' + u.changedCount + ')' : '';
          pillHtml =
            '<span class="ag-s-upd-pill" data-tone="warn">' +
            escHtml(s.updPillMainDiff + diffSuffix) +
            '</span>';
          descText = s.updDescMainDiff;
        } else if (u.status === 'error') {
          pillHtml = '<span class="ag-s-upd-pill" data-tone="err">' + escHtml(s.updPillErr) + '</span>';
          descText = u.error ? String(u.error).slice(0, 140) : s.updPillErr;
        }

        const showApply = u.status === 'update_available' || u.status === 'main_diff' || u.phase === 'updating';
        const applyLabel =
          u.phase === 'updating'
            ? s.updBtnUpdating
            : u.status === 'update_available'
            ? s.updBtnApply
            : s.updBtnSyncMain;

        return (
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info">' +
          '<div class="ag-s-row-label-wrap">' +
          '<span class="ag-s-row-label" style="cursor:default">' +
          escHtml(s.updTitle) +
          '</span>' +
          '<span class="ag-s-upd-pill">' +
          escHtml(verStr) +
          '</span>' +
          pillHtml +
          '</div>' +
          '<div class="ag-s-row-desc">' +
          escHtml(descText) +
          '</div>' +
          '</div>' +
          '<div class="ag-s-upd-actions">' +
          '<button type="button" id="ag-s-check-update" class="ag-s-btn-secondary"' +
          (isBusy ? ' disabled' : '') +
          '>' +
          escHtml(u.phase === 'checking' ? s.updBtnChecking : s.updBtnCheck) +
          '</button>' +
          (showApply
            ? '<button type="button" id="ag-s-apply-update" class="' +
              (u.status === 'update_available' || u.phase === 'updating' ? 'ag-s-btn-primary' : 'ag-s-btn-secondary') +
              '"' +
              (isBusy ? ' disabled' : '') +
              '>' +
              escHtml(applyLabel) +
              '</button>'
            : '') +
          '</div>' +
          '</div></div>'
        );
      }

      function syncSaveBadge(savedActive, savedLabel) {
        const b = document.getElementById('ag-s-hot-badge');
        if (b) {
          if (b.textContent !== savedLabel) b.textContent = savedLabel;
          b.hidden = !savedActive;
        }
        if (saveBadgeTimer) {
          clearTimeout(saveBadgeTimer);
          saveBadgeTimer = null;
        }
        if (savedActive) {
          const remain = Math.max(100, window.__ag_settings_saved_until - Date.now());
          saveBadgeTimer = setTimeout(() => {
            saveBadgeTimer = null;
            const badgeEl = document.getElementById('ag-s-hot-badge');
            if (badgeEl) badgeEl.hidden = true;
          }, remain);
        }
      }

      function renderPane({ forceRebuild = false } = {}) {
        const navBtn = document.getElementById('ag-settings-nav-btn');
        const s = getStrings();
        if (navBtn) {
          const lbl = navBtn.querySelector('.ag-s-nav-label');
          if (lbl && lbl.textContent !== s.navTitle) lbl.textContent = s.navTitle;
          const ver = navBtn.querySelector('.ag-s-nav-ver');
          const verText = getShortVersionTag();
          if (ver && ver.textContent !== verText) ver.textContent = verText;
        }

        const pane = document.getElementById('ag-settings-pane');
        if (!pane) return;

        const cfg = uiState.config;
        const mods = cfg.modules || {};
        const metricsOn = mods.metrics !== false;
        const psOn = Boolean(mods.promptSuggestions);
        const sshOn = Boolean(mods.sshRemote);
        const sp = cfg.customSystemPrompt || { enabled: false, mode: 'flow-proxy', text: '', everyInvocation: false };
        const effectiveSpMode = sp.mode || 'flow-proxy';
        const aa = cfg.hookAutoAllow || { enabled: false, mode: 'files' };
        const fl = Object.assign({}, DEFAULT_FLOW_UI, cfg.flow || {});
        const at = Object.assign({}, DEFAULT_AUTO_TITLE_UI, cfg.autoTitle || {});
        const sr = cfg.subagentRouting && typeof cfg.subagentRouting === 'object' ? cfg.subagentRouting : DEFAULT_SUBAGENT_ROUTING_UI;
        const subModels = Array.isArray(sr.allowedModels) ? sr.allowedModels : [];
        const tierLabelMap = { fast: s.tierFast, balanced: s.tierBalanced, strong: s.tierStrong };
        const subModelsHtml = subModels.length
          ? subModels
              .map((m, idx) => {
                const t = m.tier === 'fast' || m.tier === 'strong' ? m.tier : 'balanced';
                return (
                  '<div class="ag-s-submodel-item">' +
                  '<span class="ag-s-submodel-id" title="' +
                  escHtml(m.id) +
                  '">' +
                  escHtml(m.id) +
                  '</span>' +
                  '<span class="ag-s-submodel-right">' +
                  '<button type="button" class="ag-s-tier-pill" data-cycle-submodel-tier="' +
                  idx +
                  '" data-tier="' +
                  t +
                  '" title="' +
                  escHtml(s.tierToggleTip) +
                  '">' +
                  escHtml(tierLabelMap[t] || t) +
                  '</button>' +
                  '<button type="button" class="ag-s-chip-rm" data-rm-submodel="' +
                  idx +
                  '" aria-label="Remove ' +
                  escHtml(m.id) +
                  '">×</button>' +
                  '</span>' +
                  '</div>'
                );
              })
              .join('')
          : '<div class="ag-s-submodel-empty">' + escHtml(s.subagentEmpty) + '</div>';
        const flowOn = Boolean(mods.flow);
        const flProxy = uiState.flowStatus && uiState.flowStatus.proxy ? uiState.flowStatus.proxy : { running: false, port: fl.port || 18100 };
        const flAsar = uiState.flowStatus && uiState.flowStatus.asar ? uiState.flowStatus.asar : { found: false, patched: false, status: 'missing' };
        const flowStatusLine =
          (flProxy.running ? s.flowProxyOnline + ' :' + flProxy.port : s.flowProxyOffline) +
          ' · ' +
          (flAsar.patched ? s.flowAsarPatched : flAsar.found ? s.flowAsarOriginal : s.flowAsarMissing) +
          (flowAsarMsg ? ' · ' + flowAsarMsg : '');
        const asarToggleLabel = flAsar.patched ? s.flowAsarDisable : s.flowAsarEnable;
        const asarToggleAction = flAsar.patched ? 'rollback' : 'apply';
        const asarToggleCls = flAsar.patched ? 'ag-s-btn-secondary' : 'ag-s-btn-primary';
        const asarToggleDisabled = !flAsar.found;
        const curSection = SECTION_TAB_KEYS.includes(activeSectionTab) ? activeSectionTab : 'appearance';
        const curTab = PROMPT_TAB_KEYS.includes(activePromptTab) ? activePromptTab : 'global';
        const isGlobalTab = curTab === 'global';
        const tabLabelMap = {
          global: s.promptTabGlobal,
          default: s.promptTabDefault,
          writing: s.promptTabWriting,
          engineering: s.promptTabEng,
          full: s.promptTabFull
        };
        const savedVal = getSavedPromptForTab(curTab);
        const draftVal = getDraftForTab(curTab);
        const isDirty = draftVal !== savedVal;
        const isProxySpMode = effectiveSpMode === 'flow-proxy';
        const promptModeDescText = isProxySpMode ? s.promptModeDescProxy : s.promptModeDescHook;
        const promptTimingDescText = sp.everyInvocation ? s.promptTimingDescEvery : s.promptTimingDescSession;
        const promptProxyWarnText = isProxySpMode
          ? !flowOn
            ? s.promptProxyWarnNeedFlow
            : !flAsar.patched
            ? s.promptProxyWarnNeedAsar
            : ''
          : '';
        const promptPlaceholderText = isGlobalTab
          ? s.promptPlaceholder
          : s.promptPlaceholderMode.replace('{tab}', tabLabelMap[curTab] || curTab);
        const selInfo = findSelectedModelInfo(cfg.promptSuggestionModel);
        const judgeSelInfo = findSelectedModelInfo(fl.judgeModel);
        const remapSelInfo = findSelectedModelInfo(fl.remapTargetModel);
        const savedActive = Boolean(window.__ag_settings_saved_until && Date.now() < window.__ag_settings_saved_until);
        const activeLoc = getActiveLocale();

        let workerStatus = 'idle';
        let workerLabel = s.agyIdle;
        if (psOn) {
          if (uiState.agyStatus.available === false) {
            workerStatus = 'missing';
            workerLabel = s.agyMissing;
          } else if (uiState.agyStatus.warmed) {
            workerStatus = 'ready';
            workerLabel = s.agyReady;
          } else {
            workerStatus = 'warming';
            workerLabel = s.agyWarming;
          }
        }

        const chipsHtml =
          (cfg.sshHosts || [])
            .map(
              (h, idx) =>
                '<span class="ag-s-chip">' +
                '<span>' +
                escHtml(h) +
                '</span>' +
                '<button type="button" class="ag-s-chip-rm" data-rm-host="' +
                idx +
                '" aria-label="Remove ' +
                escHtml(h) +
                '">×</button>' +
                '</span>'
            )
            .join('') +
          (addingHost
            ? '<span class="ag-s-host-form">' +
              '<input type="text" id="ag-s-host-input" class="ag-s-host-input" placeholder="' +
              escHtml(s.addHostPlaceholder) +
              '" data-invalid="' +
              (invalidHost ? '1' : '0') +
              '" autocomplete="off" spellcheck="false" />' +
              '<button type="button" id="ag-s-host-ok" class="ag-s-host-ok">' +
              escHtml(s.addHostOk) +
              '</button>' +
              '</span>'
            : '<button type="button" id="ag-s-add-host" class="ag-s-add-chip-btn">' +
              escHtml(s.addHostBtn) +
              '</button>');

        const savedLabel = window.__ag_settings_saved_label === 'refreshed' ? s.refreshedBadge : s.savedBadge;
        const updateCardHtml = buildUpdateCardHtml(s);

        // Fast zero-flicker in-place state sync when pane is already mounted in the same locale
        const renderedLocale = pane.getAttribute ? pane.getAttribute('data-ag-rendered-locale') : '';
        if (
          !forceRebuild &&
          renderedLocale === activeLoc &&
          pane.querySelector &&
          pane.querySelector('#ag-s-sw-theme') &&
          pane.querySelector('#ag-s-nav-tabs') &&
          pane.querySelector('#ag-s-update-card')
        ) {
          pane.querySelectorAll('.ag-s-nav-tab[data-section-tab]').forEach((btn) => {
            const k = btn.getAttribute('data-section-tab') || '';
            const nextStr = k === curSection ? 'true' : 'false';
            if (btn.getAttribute('aria-selected') !== nextStr) btn.setAttribute('aria-selected', nextStr);
          });
          pane.querySelectorAll('.ag-s-tab-panel[data-settings-panel]').forEach((panel) => {
            const k = panel.getAttribute('data-settings-panel') || '';
            const hide = k !== curSection;
            if (Boolean(panel.hidden) !== hide) panel.hidden = hide;
          });
          if (typeof window.__ag_on_accounts_tab_active === 'function') {
            try {
              window.__ag_on_accounts_tab_active(Boolean(window.__ag_settings_tab_open && curSection === 'accounts'), {
                forceMount: curSection === 'accounts'
              });
            } catch {}
          }

          const syncSwitch = (id, checked) => {
            const el = document.getElementById(id);
            if (el && Boolean(el.checked) !== Boolean(checked)) {
              el.checked = Boolean(checked);
            }
          };
          syncSwitch('ag-s-sw-theme', mods.theme !== false);
          syncSwitch('ag-s-sw-ai-lang', Boolean(cfg.syncAiOutputLang));
          syncSwitch('ag-s-sw-metrics', metricsOn);
          syncSwitch('ag-s-sw-suggest', psOn);
          syncSwitch('ag-s-sw-ssh', sshOn);
          syncSwitch('ag-s-sw-custom-prompt', Boolean(sp.enabled));
          syncSwitch('ag-s-sw-auto-allow', Boolean(aa.enabled));
          syncSwitch('ag-s-sw-subagent-routing', Boolean(sr.enabled));
          syncSwitch('ag-s-sw-auto-title', Boolean(at.enabled));
          syncSwitch('ag-s-sw-flow', flowOn);
          syncSwitch('ag-s-sw-flow-rewrite', Boolean(fl.refusalRewrite));
          syncSwitch('ag-s-sw-flow-hardening', Boolean(fl.outputChannelHardening));
          syncSwitch('ag-s-sw-flow-judge', Boolean(fl.judgeEnabled));
          syncSwitch('ag-s-sw-flow-soften', Boolean(fl.softenEnabled));
          syncSwitch('ag-s-sw-flow-remap', Boolean(fl.remapEnabled));
          syncSwitch('ag-s-sw-flow-compact', Boolean(fl.compactEnabled));
          syncSwitch('ag-s-sw-ovquota', cfg.overviewQuota !== false);
          syncSwitch('ag-s-sw-show-claude', Boolean(cfg.showClaudeQuota));
          syncSwitch('ag-s-sw-ovprogress', cfg.overviewProgress !== false);

          pane.querySelectorAll('.ag-s-seg-btn[data-seg]').forEach((btn) => {
            const field = btn.getAttribute('data-seg');
            const val = btn.getAttribute('data-val');
            let active = false;
            if (field === 'i18nLocale') active = activeLoc === val;
            else if (field === 'telemetryLayout') {
              active = val === 'detailed' ? cfg.telemetryLayout === 'detailed' : cfg.telemetryLayout !== 'detailed';
            } else if (field === 'telemetryCacheMode') {
              active = val === 'step' ? cfg.telemetryCacheMode === 'step' : cfg.telemetryCacheMode !== 'step';
            } else {
              active = cfg[field] === val;
            }
            const nextStr = active ? 'true' : 'false';
            if (btn.getAttribute('aria-pressed') !== nextStr) btn.setAttribute('aria-pressed', nextStr);
          });

          pane.querySelectorAll('.ag-s-seg-btn[data-nested-seg]').forEach((btn) => {
            const spec = btn.getAttribute('data-nested-seg') || '';
            const val = btn.getAttribute('data-val');
            const parts = spec.split('.');
            let curVal = parts.length === 2 ? (cfg[parts[0]] || {})[parts[1]] : undefined;
            if (spec === 'customSystemPrompt.mode') {
              curVal = isProxySpMode ? 'flow-proxy' : 'pre-invocation';
            } else if (spec === 'customSystemPrompt.everyInvocation') {
              curVal = sp.everyInvocation ? 'true' : 'false';
            }
            const nextStr = String(curVal) === String(val) ? 'true' : 'false';
            if (btn.getAttribute('aria-pressed') !== nextStr) btn.setAttribute('aria-pressed', nextStr);
          });

          const setHidden = (id, hide) => {
            const el = document.getElementById(id);
            if (el && Boolean(el.hidden) !== Boolean(hide)) el.hidden = Boolean(hide);
          };
          setHidden('ag-s-sub-ai-lang', activeLoc === 'en');
          setHidden('ag-s-sub-metrics-layout', !metricsOn);
          setHidden('ag-s-sub-metrics-cache', !metricsOn);
          setHidden('ag-s-sub-suggest', !psOn);
          setHidden('ag-s-sub-ssh', !sshOn);
          setHidden('ag-s-sub-custom-prompt', !sp.enabled);
          setHidden('ag-s-prompt-proxy-warn', !promptProxyWarnText);
          setHidden('ag-s-sub-auto-allow', !aa.enabled);
          setHidden('ag-s-warn-auto-allow-all', aa.mode !== 'all');
          setHidden('ag-s-sub-subagent-routing', !sr.enabled);
          setHidden('ag-s-sub-auto-title', !at.enabled);
          setHidden('ag-s-sub-flow-head', !flowOn);
          setHidden('ag-s-flow-strategy-wrap', !flowOn);
          setHidden('ag-s-sub-flow-compact', !Boolean(fl.compactEnabled));
          setHidden('ag-s-compact-asar-warn', !Boolean(fl.compactEnabled && !flAsar.patched));

          const subListEl = document.getElementById('ag-s-subagent-list');
          if (subListEl && subListEl.__ag_html !== subModelsHtml) {
            subListEl.innerHTML = subModelsHtml;
            subListEl.__ag_html = subModelsHtml;
          }
          const atNowBtn = document.getElementById('ag-s-auto-title-now');
          if (atNowBtn) {
            atNowBtn.disabled = autoTitleBusy;
            const nextAtLbl = autoTitleBusy ? s.autoTitleUpdating : s.autoTitleNowBtn;
            if (atNowBtn.textContent !== nextAtLbl) atNowBtn.textContent = nextAtLbl;
          }
          const atStatusEl = document.getElementById('ag-s-auto-title-status');
          if (atStatusEl) {
            atStatusEl.textContent = autoTitleStatusMsg || '';
            atStatusEl.hidden = !autoTitleStatusMsg;
          }

          const modeDescEl = document.getElementById('ag-s-prompt-mode-desc');
          if (modeDescEl && modeDescEl.textContent !== promptModeDescText) {
            modeDescEl.textContent = promptModeDescText;
          }
          const timingDescEl = document.getElementById('ag-s-prompt-timing-desc');
          if (timingDescEl && timingDescEl.textContent !== promptTimingDescText) {
            timingDescEl.textContent = promptTimingDescText;
          }
          const proxyWarnEl = document.getElementById('ag-s-prompt-proxy-warn');
          if (proxyWarnEl && proxyWarnEl.textContent !== promptProxyWarnText) {
            proxyWarnEl.textContent = promptProxyWarnText;
          }

          pane.querySelectorAll('.ag-s-seg-btn[data-prompt-tab]').forEach((btn) => {
            const tk = btn.getAttribute('data-prompt-tab') || '';
            const nextStr = tk === curTab ? 'true' : 'false';
            if (btn.getAttribute('aria-pressed') !== nextStr) btn.setAttribute('aria-pressed', nextStr);
            const dot = btn.querySelector('.ag-s-tab-dot');
            if (dot) dot.hidden = !String(getSavedPromptForTab(tk) || '').trim();
          });
          const flowStEl = document.getElementById('ag-s-flow-status-line');
          if (flowStEl && flowStEl.textContent !== flowStatusLine) flowStEl.textContent = flowStatusLine;
          const asarToggleBtn = document.getElementById('ag-s-flow-asar-toggle');
          if (asarToggleBtn) {
            if (asarToggleBtn.textContent !== asarToggleLabel) asarToggleBtn.textContent = asarToggleLabel;
            if (asarToggleBtn.className !== asarToggleCls) asarToggleBtn.className = asarToggleCls;
            if (asarToggleBtn.getAttribute('data-asar-action') !== asarToggleAction) {
              asarToggleBtn.setAttribute('data-asar-action', asarToggleAction);
            }
            asarToggleBtn.disabled = asarToggleDisabled;
          }

          const workerPill = document.getElementById('ag-s-worker-pill');
          if (workerPill && workerPill.getAttribute('data-status') !== workerStatus) {
            workerPill.setAttribute('data-status', workerStatus);
          }
          const workerLblEl = document.getElementById('ag-s-worker-label');
          if (workerLblEl && workerLblEl.textContent !== workerLabel) {
            workerLblEl.textContent = workerLabel;
          }

          const syncModelLabel = (nameId, effId, info) => {
            const nEl = document.getElementById(nameId);
            if (nEl && nEl.textContent !== info.family.name) {
              nEl.textContent = info.family.name;
            }
            const eEl = document.getElementById(effId);
            if (eEl) {
              const effText = info.effortLabel || '';
              if (eEl.textContent !== effText) eEl.textContent = effText;
              eEl.hidden = !effText;
            }
          };
          syncModelLabel('ag-s-model-name', 'ag-s-model-effort', selInfo);
          syncModelLabel('ag-s-flow-judge-name', 'ag-s-flow-judge-effort', judgeSelInfo);
          syncModelLabel('ag-s-flow-remap-name', 'ag-s-flow-remap-effort', remapSelInfo);

          const ta = document.getElementById('ag-s-prompt-textarea');
          if (ta) {
            if (ta.getAttribute('placeholder') !== promptPlaceholderText) {
              ta.setAttribute('placeholder', promptPlaceholderText);
            }
            if ((ta.getAttribute('data-ag-tab') !== curTab || document.activeElement !== ta) && ta.value !== draftVal) {
              ta.value = draftVal;
            }
            ta.setAttribute('data-ag-tab', curTab);
          }
          const metaEl = document.getElementById('ag-s-prompt-meta');
          const nextMeta = draftVal.length + ' / 20000 · ' + (isDirty ? s.promptUnsaved : s.promptSavedTip);
          if (metaEl && metaEl.textContent !== nextMeta) metaEl.textContent = nextMeta;
          const saveBtn = document.getElementById('ag-s-prompt-save');
          if (saveBtn) saveBtn.disabled = !isDirty;

          const chipsEl = document.getElementById('ag-s-ssh-chips');
          if (chipsEl && chipsEl.__ag_html !== chipsHtml) {
            chipsEl.innerHTML = chipsHtml;
            chipsEl.__ag_html = chipsHtml;
            bindAddingHostInput();
          }

          const updEl = document.getElementById('ag-s-update-card');
          if (updEl && updEl.__ag_html !== updateCardHtml) {
            updEl.innerHTML = updateCardHtml;
            updEl.__ag_html = updateCardHtml;
          }

          updateRefreshSpin();
          syncSaveBadge(savedActive, savedLabel);
          if (isPopoverOpen(document.getElementById('ag-settings-model-menu'))) {
            renderModelMenuItems();
          }
          return;
        }

        const prevScroll = pane.scrollTop || window.__ag_settings_scroll_top || 0;

        const sectionNavTabsHtml =
          '<div id="ag-s-nav-tabs" class="ag-s-nav-tabs" role="tablist">' +
          '<button type="button" class="ag-s-nav-tab" role="tab" data-section-tab="appearance" aria-selected="' +
          (curSection === 'appearance' ? 'true' : 'false') +
          '">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11M8 8h5.5"/></svg>' +
          '<span>' + escHtml(s.tabAppearance) + '</span></button>' +
          '<button type="button" class="ag-s-nav-tab" role="tab" data-section-tab="accounts" aria-selected="' +
          (curSection === 'accounts' ? 'true' : 'false') +
          '">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.2" cy="5.2" r="2.4"/><path d="M1.8 13.5c.4-2.2 2.2-3.5 4.4-3.5s4 1.3 4.4 3.5"/><path d="M11.8 4.2a2 2 0 0 1 0 3.8M13.5 13.2c.3-1.4-.5-2.6-1.8-3.1"/></svg>' +
          '<span>' + escHtml(s.tabAccounts) + '</span></button>' +
          '<button type="button" class="ag-s-nav-tab" role="tab" data-section-tab="prompts" aria-selected="' +
          (curSection === 'prompts' ? 'true' : 'false') +
          '">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 3.5h9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M5.5 6.5h5M5.5 9.5h3.5"/></svg>' +
          '<span>' + escHtml(s.tabPrompts) + '</span></button>' +
          '<button type="button" class="ag-s-nav-tab" role="tab" data-section-tab="flow" aria-selected="' +
          (curSection === 'flow' ? 'true' : 'false') +
          '">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2L13 4.2v3.6c0 3.1-2.1 5.1-5 6-2.9-.9-5-2.9-5-6V4.2L8 2.2z"/><path d="M5.8 8.2l1.5 1.5 3-3.1"/></svg>' +
          '<span>' + escHtml(s.tabFlow) + '</span></button>' +
          '<button type="button" class="ag-s-nav-tab" role="tab" data-section-tab="advanced" aria-selected="' +
          (curSection === 'advanced' ? 'true' : 'false') +
          '">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>' +
          '<span>' + escHtml(s.tabAdvanced) + '</span></button>' +
          '</div>';

        pane.innerHTML =
          '<div class="ag-s-header">' +
          '<div class="ag-s-title-row">' +
          '<div class="ag-s-title-left">' +
          '<h2 class="ag-s-title">' +
          escHtml(s.pageTitle) +
          '</h2>' +
          '<button type="button" id="ag-s-manual-refresh" class="ag-s-hdr-refresh" aria-label="' +
          escHtml(s.manualRefreshLabel) +
          '">' +
          '<svg id="ag-s-manual-refresh-icon" class="' +
          (refreshingAll ? 'ag-s-spin' : '') +
          '" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.67M13.5 2.5v2.8h-2.8"/></svg>' +
          '</button>' +
          '<span id="ag-s-hot-badge" class="ag-s-hot-badge"' +
          (savedActive ? '' : ' hidden') +
          '>' +
          escHtml(savedLabel) +
          '</span>' +
          '</div>' +
          '<div class="ag-s-hdr-links">' +
          '<a id="ag-s-link-github" class="ag-s-hdr-link" href="https://github.com/XziXmn/antigravity-theme" target="_blank" rel="noopener noreferrer" data-ext-link="github">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>' +
          '<span>' +
          escHtml(s.githubLabel) +
          '</span>' +
          '</a>' +
          '<a id="ag-s-link-feedback" class="ag-s-hdr-link" href="https://github.com/XziXmn/antigravity-theme/issues" target="_blank" rel="noopener noreferrer" data-ext-link="feedback">' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 5.2v3.2M8 10.8h.01"/></svg>' +
          '<span>' +
          escHtml(s.feedbackLabel) +
          '</span>' +
          '</a>' +
          '</div>' +
          '</div>' +
          '</div>' +
          sectionNavTabsHtml +
          '<div class="ag-s-sections">' +
          // ==================== TAB 1: Appearance & Status ====================
          '<div class="ag-s-tab-panel" data-settings-panel="appearance"' +
          (curSection === 'appearance' ? '' : ' hidden') +
          '>' +
          '<div>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secCore) +
          '</span></div>' +
          '<div class="ag-s-card">' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-theme">' +
          escHtml(s.modTheme) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modThemeDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-theme" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="theme" aria-label="' +
          escHtml(s.modTheme) +
          '" ' +
          (mods.theme !== false ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div class="ag-s-subrow">' +
          '<div class="ag-s-row-info"><label class="ag-s-sub-label" for="ag-s-sw-compact" style="cursor:pointer">' +
          escHtml(s.compactTypoLbl) +
          '</label><div class="ag-s-sub-desc">' +
          escHtml(s.compactTypoDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-compact" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-flag="compactTypography" ' +
          (cfg.compactTypography !== false ? 'checked' : '') +
          ' /></div>' +
          '<div class="ag-s-subrow">' +
          '<div class="ag-s-row-info"><label class="ag-s-sub-label" for="ag-s-sw-ovquota" style="cursor:pointer">' +
          escHtml(s.overviewQuotaLbl) +
          '</label><div class="ag-s-sub-desc">' +
          escHtml(s.overviewQuotaDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-ovquota" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-flag="overviewQuota" ' +
          (cfg.overviewQuota !== false ? 'checked' : '') +
          ' /></div>' +
          '<div class="ag-s-subrow">' +
          '<div class="ag-s-row-info"><label class="ag-s-sub-label" for="ag-s-sw-show-claude" style="cursor:pointer">' +
          escHtml(s.showClaudeQuotaLbl) +
          '</label><div class="ag-s-sub-desc">' +
          escHtml(s.showClaudeQuotaDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-show-claude" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-flag="showClaudeQuota" ' +
          (cfg.showClaudeQuota ? 'checked' : '') +
          ' /></div>' +
          '<div class="ag-s-subrow">' +
          '<div class="ag-s-row-info"><label class="ag-s-sub-label" for="ag-s-sw-ovprogress" style="cursor:pointer">' +
          escHtml(s.overviewProgressLbl) +
          '</label><div class="ag-s-sub-desc">' +
          escHtml(s.overviewProgressDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-ovprogress" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-flag="overviewProgress" ' +
          (cfg.overviewProgress !== false ? 'checked' : '') +
          ' /></div>' +
          '</div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><div class="ag-s-row-label">' +
          escHtml(s.localeLbl) +
          '</div><div class="ag-s-row-desc">' +
          escHtml(s.localeDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.localeLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-seg="i18nLocale" data-val="zh-CN" aria-pressed="' +
          (activeLoc === 'zh-CN' ? 'true' : 'false') +
          '">' +
          escHtml(s.locZhCn) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-seg="i18nLocale" data-val="zh-SG" aria-pressed="' +
          (activeLoc === 'zh-SG' ? 'true' : 'false') +
          '">' +
          escHtml(s.locZhSg) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-seg="i18nLocale" data-val="zh-TW" aria-pressed="' +
          (activeLoc === 'zh-TW' ? 'true' : 'false') +
          '">' +
          escHtml(s.locZhTw) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-seg="i18nLocale" data-val="en" aria-pressed="' +
          (activeLoc === 'en' ? 'true' : 'false') +
          '">' +
          escHtml(s.locEn) +
          '</button>' +
          '</div>' +
          '</div>' +
          '<div id="ag-s-sub-ai-lang" class="ag-s-subrow"' +
          (activeLoc !== 'en' ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-row-info"><label class="ag-s-sub-label" for="ag-s-sw-ai-lang" style="cursor:pointer">' +
          escHtml(s.syncAiLangLbl) +
          '</label><div class="ag-s-sub-desc">' +
          escHtml(s.syncAiLangDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-ai-lang" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-flag="syncAiOutputLang" aria-label="' +
          escHtml(s.syncAiLangLbl) +
          '" ' +
          (cfg.syncAiOutputLang ? 'checked' : '') +
          ' />' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // Status bar & Telemetry (merged cleanly into Appearance tab)
          '<div>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secTelemetry) +
          '</span></div>' +
          '<div class="ag-s-card">' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-metrics">' +
          escHtml(s.modMetrics) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modMetricsDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-metrics" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="metrics" aria-label="' +
          escHtml(s.modMetrics) +
          '" ' +
          (metricsOn ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-metrics-layout" class="ag-s-subrow"' +
          (metricsOn ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.layoutLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.layoutDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.layoutLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-seg="telemetryLayout" data-val="compact" aria-pressed="' +
          (cfg.telemetryLayout !== 'detailed' ? 'true' : 'false') +
          '">' +
          escHtml(s.layoutCompact) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-seg="telemetryLayout" data-val="detailed" aria-pressed="' +
          (cfg.telemetryLayout === 'detailed' ? 'true' : 'false') +
          '">' +
          escHtml(s.layoutDetailed) +
          '</button>' +
          '</div>' +
          '</div>' +
          '<div id="ag-s-sub-metrics-cache" class="ag-s-subrow"' +
          (metricsOn ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.cacheLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.cacheDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.cacheLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-seg="telemetryCacheMode" data-val="session" aria-pressed="' +
          (cfg.telemetryCacheMode !== 'step' ? 'true' : 'false') +
          '">' +
          escHtml(s.cacheSession) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-seg="telemetryCacheMode" data-val="step" aria-pressed="' +
          (cfg.telemetryCacheMode === 'step' ? 'true' : 'false') +
          '">' +
          escHtml(s.cacheStep) +
          '</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><div class="ag-s-row-label">' +
          escHtml(s.topbarMetricLbl) +
          '</div><div class="ag-s-row-desc">' +
          escHtml(s.topbarMetricDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.topbarMetricLbl) +
          '">' +
          [
            ['quota', s.topbarOptQuota],
            ['sessionTokens', s.topbarOptSessionTok],
            ['todayTokens', s.topbarOptTodayTok],
            ['monthTokens', s.topbarOptMonthTok],
            ['monthCost', s.topbarOptMonthCost],
            ['icon', s.topbarOptIcon]
          ]
            .map(
              ([val, lbl]) =>
                '<button type="button" class="ag-s-seg-btn" data-seg="topbarUsageMetric" data-val="' +
                val +
                '" aria-pressed="' +
                ((cfg.topbarUsageMetric || 'quota') === val ? 'true' : 'false') +
                '">' +
                escHtml(lbl) +
                '</button>'
            )
            .join('') +
          '</div>' +
          '</div></div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // ==================== TAB 2: Accounts ====================
          '<div class="ag-s-tab-panel" data-settings-panel="accounts"' +
          (curSection === 'accounts' ? '' : ' hidden') +
          '>' +
          '<div id="ag-accounts-pane" class="ag-s-accounts-host"></div>' +
          '</div>' +
          // ==================== TAB 3: Prompts & Hooks ====================
          '<div class="ag-s-tab-panel" data-settings-panel="prompts"' +
          (curSection === 'prompts' ? '' : ' hidden') +
          '>' +
          '<div>' +
          '<div class="ag-s-section-head">' +
          '<span class="ag-s-section-title">' +
          escHtml(s.secPromptHooks) +
          '</span>' +
          '</div>' +
          '<div class="ag-s-card">' +
          // Custom System Prompt
          '<div class="ag-s-row">' +
          '<div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-custom-prompt">' +
          escHtml(s.modCustomPrompt) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modCustomPromptDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-custom-prompt" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="customSystemPrompt.enabled" aria-label="' +
          escHtml(s.modCustomPrompt) +
          '" ' +
          (sp.enabled ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-custom-prompt" class="ag-s-subrow-stack"' +
          (sp.enabled ? '' : ' hidden') +
          '>' +
          // Always visible across all scope tabs: Injection Method (Proxy / Hook)
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.promptModeLbl) +
          '</div><div id="ag-s-prompt-mode-desc" class="ag-s-sub-desc">' +
          escHtml(promptModeDescText) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.promptModeLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.mode" data-val="flow-proxy" aria-pressed="' +
          (isProxySpMode ? 'true' : 'false') +
          '">' +
          escHtml(s.promptModeProxy) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.mode" data-val="pre-invocation" aria-pressed="' +
          (!isProxySpMode ? 'true' : 'false') +
          '">' +
          escHtml(s.promptModePreInv) +
          '</button>' +
          '</div>' +
          '</div>' +
          // Always visible across all scope tabs: Injection Timing (Per Session / Every Turn)
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.promptTimingLbl) +
          '</div><div id="ag-s-prompt-timing-desc" class="ag-s-sub-desc">' +
          escHtml(promptTimingDescText) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.promptTimingLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.everyInvocation" data-val="false" aria-pressed="' +
          (!sp.everyInvocation ? 'true' : 'false') +
          '">' +
          escHtml(s.promptTimingSession) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.everyInvocation" data-val="true" aria-pressed="' +
          (sp.everyInvocation ? 'true' : 'false') +
          '">' +
          escHtml(s.promptTimingEvery) +
          '</button>' +
          '</div>' +
          '</div>' +
          '<div id="ag-s-prompt-proxy-warn" class="ag-s-warn-note"' +
          (promptProxyWarnText ? '' : ' hidden') +
          '>' +
          escHtml(promptProxyWarnText) +
          '</div>' +
          // Scope tabs
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.promptScopeLbl) +
          '</div></div>' +
          '<div class="ag-s-seg" role="tablist" aria-label="' +
          escHtml(s.promptScopeLbl) +
          '">' +
          PROMPT_TAB_KEYS.map((tk) => {
            const hasContent = Boolean(String(getSavedPromptForTab(tk) || '').trim());
            return (
              '<button type="button" class="ag-s-seg-btn" role="tab" data-prompt-tab="' +
              tk +
              '" aria-pressed="' +
              (curTab === tk ? 'true' : 'false') +
              '">' +
              escHtml(tabLabelMap[tk] || tk) +
              '<span class="ag-s-tab-dot"' +
              (hasContent ? '' : ' hidden') +
              '></span>' +
              '</button>'
            );
          }).join('') +
          '</div>' +
          '</div>' +
          '<div id="ag-s-prompt-preset-bar" class="ag-s-preset-bar">' +
          '<span class="ag-s-preset-lbl">' +
          escHtml(s.promptPresetLbl) +
          '</span>' +
          '<button type="button" class="ag-s-preset-btn" data-prompt-preset="systemRole">' +
          escHtml(s.presetSystemRole) +
          '</button>' +
          '<button type="button" class="ag-s-preset-btn" data-prompt-preset="antiHalluc">' +
          escHtml(s.presetAntiHalluc) +
          '</button>' +
          '<button type="button" class="ag-s-preset-btn" data-prompt-preset="concise">' +
          escHtml(s.presetConcise) +
          '</button>' +
          '<button type="button" class="ag-s-preset-btn" data-prompt-preset="contract">' +
          escHtml(s.presetContract) +
          '</button>' +
          '</div>' +
          '<textarea id="ag-s-prompt-textarea" class="ag-s-textarea" data-ag-tab="' +
          curTab +
          '" placeholder="' +
          escHtml(promptPlaceholderText) +
          '" maxlength="20000">' +
          escHtml(draftVal) +
          '</textarea>' +
          '<div class="ag-s-prompt-foot">' +
          '<span id="ag-s-prompt-meta" class="ag-s-prompt-meta">' +
          escHtml(draftVal.length + ' / 20000 · ' + (isDirty ? s.promptUnsaved : s.promptSavedTip)) +
          '</span>' +
          '<div class="ag-s-prompt-actions">' +
          '<button type="button" id="ag-s-prompt-clear" class="ag-s-btn-secondary">' +
          escHtml(s.promptClearBtn) +
          '</button>' +
          '<button type="button" id="ag-s-prompt-save" class="ag-s-btn-primary"' +
          (isDirty ? '' : ' disabled') +
          '>' +
          escHtml(s.promptSaveBtn) +
          '</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // PreToolUse Auto-Allow Hook
          '<div class="ag-s-row">' +
          '<div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-auto-allow">' +
          escHtml(s.modAutoAllow) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modAutoAllowDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-auto-allow" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="hookAutoAllow.enabled" aria-label="' +
          escHtml(s.modAutoAllow) +
          '" ' +
          (aa.enabled ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-auto-allow" class="ag-s-subrow-stack"' +
          (aa.enabled ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.autoAllowModeLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.autoAllowModeDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.autoAllowModeLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="hookAutoAllow.mode" data-val="files" aria-pressed="' +
          (aa.mode === 'files' ? 'true' : 'false') +
          '">' +
          escHtml(s.autoAllowFiles) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="hookAutoAllow.mode" data-val="safe-cmd" aria-pressed="' +
          (aa.mode === 'safe-cmd' ? 'true' : 'false') +
          '">' +
          escHtml(s.autoAllowSafeCmd) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="hookAutoAllow.mode" data-val="all" aria-pressed="' +
          (aa.mode === 'all' ? 'true' : 'false') +
          '">' +
          escHtml(s.autoAllowAll) +
          '</button>' +
          '</div>' +
          '</div>' +
          '<div id="ag-s-warn-auto-allow-all" class="ag-s-warn-note"' +
          (aa.mode === 'all' ? '' : ' hidden') +
          '>' +
          escHtml(s.autoAllowAllWarn) +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // ==================== TAB 3: Relay & Recovery ====================
          '<div class="ag-s-tab-panel" data-settings-panel="flow"' +
          (curSection === 'flow' ? '' : ' hidden') +
          '>' +
          '<div>' +
          '<div class="ag-s-section-head">' +
          '<span class="ag-s-section-title">' +
          escHtml(s.secFlowProxy) +
          '</span>' +
          '</div>' +
          '<div class="ag-s-card">' +
          '<div class="ag-s-row">' +
          '<div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow">' +
          escHtml(s.modFlow) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modFlowDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-flow" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="flow" aria-label="' +
          escHtml(s.modFlow) +
          '" ' +
          (flowOn ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-flow-head" class="ag-s-subrow-stack"' +
          (flowOn ? '' : ' hidden') +
          '>' +
          // Merged single toggle button for Traffic Redirect
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.flowAsarLbl) +
          '</div><div id="ag-s-flow-status-line" class="ag-s-sub-desc">' +
          escHtml(flowStatusLine) +
          '</div></div>' +
          '<button type="button" id="ag-s-flow-asar-toggle" class="' +
          asarToggleCls +
          '" data-asar-action="' +
          asarToggleAction +
          '"' +
          (asarToggleDisabled ? ' disabled' : '') +
          '>' +
          escHtml(asarToggleLabel) +
          '</button>' +
          '</div>' +
          // Default Mode
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.flowDefaultModeLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.flowDefaultModeDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group">' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.defaultMode" data-val="default" aria-pressed="' + (fl.defaultMode === 'default' ? 'true' : 'false') + '">' + escHtml(s.flowModeDefault) + '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.defaultMode" data-val="writing" aria-pressed="' + (fl.defaultMode === 'writing' ? 'true' : 'false') + '">' + escHtml(s.flowModeWriting) + '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.defaultMode" data-val="engineering" aria-pressed="' + (fl.defaultMode === 'engineering' ? 'true' : 'false') + '">' + escHtml(s.flowModeEng) + '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.defaultMode" data-val="full" aria-pressed="' + (fl.defaultMode === 'full' ? 'true' : 'false') + '">' + escHtml(s.flowModeFull) + '</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // Recovery strategies card (cleanly separated, modelPattern removed)
          '<div id="ag-s-flow-strategy-wrap"' +
          (flowOn ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secFlowStrategy) +
          '</span></div>' +
          '<div class="ag-s-card">' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><div class="ag-s-row-label" style="cursor:default">' +
          escHtml(s.flowMaxContLbl) +
          '</div><div class="ag-s-row-desc">' +
          escHtml(s.flowMaxContDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group">' +
          ['0', '2', '3', '5', '8']
            .map(
              (v) =>
                '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.maxContinuations" data-val="' +
                v +
                '" aria-pressed="' +
                (String(fl.maxContinuations) === v ? 'true' : 'false') +
                '">' +
                v +
                '</button>'
            )
            .join('') +
          '</div>' +
          '</div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main"><div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow-rewrite">' + escHtml(s.flowRewriteLbl) + '</label><div class="ag-s-row-desc">' + escHtml(s.flowRewriteDesc) + '</div></div><input id="ag-s-sw-flow-rewrite" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="flow.refusalRewrite" ' + (fl.refusalRewrite ? 'checked' : '') + ' /></div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main"><div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow-hardening">' + escHtml(s.flowHardeningLbl) + '</label><div class="ag-s-row-desc">' + escHtml(s.flowHardeningDesc) + '</div></div><input id="ag-s-sw-flow-hardening" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="flow.outputChannelHardening" ' + (fl.outputChannelHardening ? 'checked' : '') + ' /></div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main"><div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow-soften">' + escHtml(s.flowSoftenLbl) + '</label><div class="ag-s-row-desc">' + escHtml(s.flowSoftenDesc) + '</div></div><input id="ag-s-sw-flow-soften" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="flow.softenEnabled" ' + (fl.softenEnabled ? 'checked' : '') + ' /></div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main"><div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow-judge">' + escHtml(s.flowJudgeLbl) + '</label><div class="ag-s-row-desc">' + escHtml(s.flowJudgeDesc) + '</div></div><div class="ag-s-picker-controls">' +
          '<button type="button" id="ag-s-flow-judge-trigger" class="ag-s-pill-trigger" data-model-picker-target="flow.judgeModel" aria-haspopup="menu" aria-expanded="false">' +
          '<span class="ag-s-trigger-text"><span id="ag-s-flow-judge-name">' + escHtml(judgeSelInfo.family.name) + '</span><span id="ag-s-flow-judge-effort" class="ag-s-trigger-effort"' + (judgeSelInfo.effortLabel ? '' : ' hidden') + '>' + escHtml(judgeSelInfo.effortLabel || '') + '</span></span>' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="opacity:0.6;flex-shrink:0"><path d="M4 6l4 4 4-4"/></svg>' +
          '</button>' +
          '<button type="button" class="ag-s-icon-btn" data-refresh-models="1" aria-label="' + escHtml(s.refreshModelsTitle) + '">' +
          '<svg class="ag-s-refresh-models-icon ' + (refreshingModels ? 'ag-s-spin' : '') + '" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.67M13.5 2.5v2.8h-2.8"/></svg>' +
          '</button>' +
          '<input id="ag-s-sw-flow-judge" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="flow.judgeEnabled" ' + (fl.judgeEnabled ? 'checked' : '') + ' />' +
          '</div></div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main"><div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow-remap">' + escHtml(s.flowRemapLbl) + '</label><div class="ag-s-row-desc">' + escHtml(s.flowRemapDesc) + '</div></div><div class="ag-s-picker-controls">' +
          '<button type="button" id="ag-s-flow-remap-trigger" class="ag-s-pill-trigger" data-model-picker-target="flow.remapTargetModel" aria-haspopup="menu" aria-expanded="false">' +
          '<span class="ag-s-trigger-text"><span id="ag-s-flow-remap-name">' + escHtml(remapSelInfo.family.name) + '</span><span id="ag-s-flow-remap-effort" class="ag-s-trigger-effort"' + (remapSelInfo.effortLabel ? '' : ' hidden') + '>' + escHtml(remapSelInfo.effortLabel || '') + '</span></span>' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="opacity:0.6;flex-shrink:0"><path d="M4 6l4 4 4-4"/></svg>' +
          '</button>' +
          '<input id="ag-s-sw-flow-remap" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="flow.remapEnabled" ' + (fl.remapEnabled ? 'checked' : '') + ' />' +
          '</div></div></div>' +
          '</div>' +
          '</div>' +
          '<div>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secFlowCompact) +
          '</span></div>' +
          '<div class="ag-s-card">' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-flow-compact">' +
          escHtml(s.flowCompactLbl) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.flowCompactDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-flow-compact" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="flow.compactEnabled" ' +
          (fl.compactEnabled ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-flow-compact" class="ag-s-subrow-stack"' +
          (fl.compactEnabled ? '' : ' hidden') +
          '>' +
          '<div id="ag-s-compact-asar-warn" class="ag-s-warn-note"' +
          (flAsar.patched ? ' hidden' : '') +
          '>' +
          escHtml(s.flowCompactNeedAsar) +
          '</div>' +
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.flowCompactThreshLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.flowCompactThreshDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group">' +
          [60, 70, 80]
            .map(
              (pct) =>
                '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.compactThresholdPct" data-val="' +
                pct +
                '" aria-pressed="' +
                (Number(fl.compactThresholdPct || 70) === pct ? 'true' : 'false') +
                '">' +
                (pct === 70 ? pct + '% (' + escHtml(s.recommendedBadge) + ')' : pct + '%') +
                '</button>'
            )
            .join('') +
          '</div>' +
          '</div>' +
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.flowCompactTailLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.flowCompactTailDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group">' +
          [
            [10000, '10k'],
            [20000, '20k'],
            [40000, '40k']
          ]
            .map(
              ([val, lbl]) =>
                '<button type="button" class="ag-s-seg-btn" data-nested-seg="flow.compactKeepTailTokens" data-val="' +
                val +
                '" aria-pressed="' +
                (Number(fl.compactKeepTailTokens || 20000) === val ? 'true' : 'false') +
                '">' +
                (val === 20000 ? escHtml(lbl + ' (' + s.recommendedBadge + ')') : escHtml(lbl)) +
                '</button>'
            )
            .join('') +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // ==================== TAB 4: Add-ons & Updates ====================
          '<div class="ag-s-tab-panel" data-settings-panel="advanced"' +
          (curSection === 'advanced' ? '' : ' hidden') +
          '>' +
          '<div>' +
          '<div class="ag-s-section-head">' +
          '<span class="ag-s-section-title">' +
          escHtml(s.secOptional) +
          '</span>' +
          '</div>' +
          '<div class="ag-s-card">' +
          // Prompt Suggestions
          '<div class="ag-s-row">' +
          '<div class="ag-s-row-main">' +
          '<div class="ag-s-row-info">' +
          '<div class="ag-s-row-label-wrap">' +
          '<label class="ag-s-row-label" for="ag-s-sw-suggest">' +
          escHtml(s.modSuggest) +
          '</label>' +
          '<span id="ag-s-worker-pill" class="ag-s-worker-pill" data-status="' +
          workerStatus +
          '">' +
          '<span class="ag-s-worker-dot"></span>' +
          '<span id="ag-s-worker-label">' +
          escHtml(workerLabel) +
          '</span>' +
          '</span>' +
          '</div>' +
          '<div class="ag-s-row-desc">' +
          escHtml(s.modSuggestDescPre) +
          '<span class="ag-s-mono">Tab</span>' +
          escHtml(s.modSuggestDescMid) +
          '<span class="ag-s-mono">→</span>' +
          escHtml(s.modSuggestDescPost) +
          '<span class="ag-s-mono">agy</span>' +
          escHtml(s.modSuggestDescEnd) +
          '</div>' +
          '</div>' +
          '<input id="ag-s-sw-suggest" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="promptSuggestions" aria-label="' +
          escHtml(s.modSuggest) +
          '" ' +
          (psOn ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-suggest" class="ag-s-subrow"' +
          (psOn ? '' : ' hidden') +
          '>' +
          '<div>' +
          '<div class="ag-s-sub-label">' +
          escHtml(s.suggestModelLbl) +
          '</div>' +
          '<div class="ag-s-sub-desc">' +
          escHtml(s.suggestModelDescPre) +
          '<span class="ag-s-mono">agy models</span>' +
          escHtml(s.suggestModelDescPost) +
          '</div>' +
          '</div>' +
          '<div class="ag-s-picker-controls">' +
          '<button type="button" id="ag-s-model-trigger" class="ag-s-pill-trigger" data-model-picker-target="promptSuggestionModel" aria-haspopup="menu" aria-expanded="false">' +
          '<span class="ag-s-trigger-text">' +
          '<span id="ag-s-model-name">' +
          escHtml(selInfo.family.name) +
          '</span>' +
          '<span id="ag-s-model-effort" class="ag-s-trigger-effort"' +
          (selInfo.effortLabel ? '' : ' hidden') +
          '>' +
          escHtml(selInfo.effortLabel || '') +
          '</span>' +
          '</span>' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="opacity:0.6;flex-shrink:0"><path d="M4 6l4 4 4-4"/></svg>' +
          '</button>' +
          '<button type="button" id="ag-s-refresh-models" class="ag-s-icon-btn" data-refresh-models="1" aria-label="' +
          escHtml(s.refreshModelsTitle) +
          '">' +
          '<svg id="ag-s-refresh-icon" class="ag-s-refresh-models-icon ' +
          (refreshingModels ? 'ag-s-spin' : '') +
          '" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.67M13.5 2.5v2.8h-2.8"/></svg>' +
          '</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // Progress-Based Auto Conversation Title
          '<div class="ag-s-row">' +
          '<div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-auto-title">' +
          escHtml(s.modAutoTitle) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modAutoTitleDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-auto-title" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="autoTitle.enabled" aria-label="' +
          escHtml(s.modAutoTitle) +
          '" ' +
          (at.enabled ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-auto-title" class="ag-s-subrow-stack"' +
          (at.enabled ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-sub-head">' +
          '<span class="ag-s-sub-label">' +
          escHtml(s.autoTitleTurnsLbl) +
          '</span>' +
          '<div class="ag-s-seg" role="group">' +
          [2, 4, 6, 10]
            .map(
              (n) =>
                '<button type="button" class="ag-s-seg-btn" data-nested-seg="autoTitle.turnInterval" data-val="' +
                n +
                '" aria-pressed="' +
                (Number(at.turnInterval) === n ? 'true' : 'false') +
                '">' +
                n +
                ' ' +
                escHtml(s.autoTitleTurnsUnit) +
                '</button>'
            )
            .join('') +
          '</div>' +
          '</div>' +
          '<div class="ag-s-sub-head">' +
          '<span class="ag-s-sub-label">' +
          escHtml(s.autoTitleCoolLbl) +
          '</span>' +
          '<div class="ag-s-seg" role="group">' +
          [2, 5, 10, 15]
            .map(
              (m) =>
                '<button type="button" class="ag-s-seg-btn" data-nested-seg="autoTitle.minIntervalMin" data-val="' +
                m +
                '" aria-pressed="' +
                (Number(at.minIntervalMin) === m ? 'true' : 'false') +
                '">' +
                m +
                ' ' +
                escHtml(s.autoTitleCoolUnit) +
                '</button>'
            )
            .join('') +
          '</div>' +
          '</div>' +
          '<div class="ag-s-sub-head">' +
          '<span id="ag-s-auto-title-status" class="ag-s-sub-desc"' +
          (autoTitleStatusMsg ? '' : ' hidden') +
          '>' +
          escHtml(autoTitleStatusMsg) +
          '</span>' +
          '<button type="button" id="ag-s-auto-title-now" class="ag-s-btn-secondary"' +
          (autoTitleBusy ? ' disabled' : '') +
          '>' +
          escHtml(autoTitleBusy ? s.autoTitleUpdating : s.autoTitleNowBtn) +
          '</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // SSH Remote
          '<div class="ag-s-row">' +
          '<div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-ssh">' +
          escHtml(s.modSsh) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modSshDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-ssh" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="sshRemote" aria-label="' +
          escHtml(s.modSsh) +
          '" ' +
          (sshOn ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div id="ag-s-sub-ssh" class="ag-s-subrow"' +
          (sshOn ? '' : ' hidden') +
          '>' +
          '<span class="ag-s-sub-label">' +
          escHtml(s.sshHostsLbl) +
          '</span>' +
          '<div id="ag-s-ssh-chips" class="ag-s-chips">' +
          chipsHtml +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          // Version & Updates
          '<div>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secUpdate) +
          '</span></div>' +
          '<div id="ag-s-update-card" class="ag-s-card">' +
          updateCardHtml +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>';

        if (pane.setAttribute) pane.setAttribute('data-ag-rendered-locale', activeLoc);
        if (typeof window.__ag_on_accounts_tab_active === 'function') {
          try {
            window.__ag_on_accounts_tab_active(Boolean(window.__ag_settings_tab_open && curSection === 'accounts'), {
              forceMount: curSection === 'accounts'
            });
          } catch {}
        }
        const chipsMounted = document.getElementById('ag-s-ssh-chips');
        if (chipsMounted) chipsMounted.__ag_html = chipsHtml;
        const subListMounted = document.getElementById('ag-s-subagent-list');
        if (subListMounted) subListMounted.__ag_html = subModelsHtml;
        const updMounted = document.getElementById('ag-s-update-card');
        if (updMounted) updMounted.__ag_html = updateCardHtml;

        if (prevScroll > 0) pane.scrollTop = prevScroll;

        bindAddingHostInput();
        syncSaveBadge(savedActive, savedLabel);

        if (isPopoverOpen(document.getElementById('ag-settings-model-menu'))) {
          renderModelMenuItems();
        }
      }

      function submitNewHost(rawVal) {
        const host = String(rawVal || '').trim();
        if (!host) {
          addingHost = false;
          invalidHost = false;
          renderPane();
          return;
        }
        if (host.startsWith('-') || !VALID_HOST_RE.test(host)) {
          invalidHost = true;
          const inp = document.getElementById('ag-s-host-input');
          if (inp) {
            inp.setAttribute('data-invalid', '1');
            inp.focus();
          }
          return;
        }
        addingHost = false;
        invalidHost = false;
        const nextHosts = (uiState.config.sshHosts || []).slice();
        if (!nextHosts.includes(host)) nextHosts.push(host);
        commitPatch({ sshHosts: nextHosts });
      }

      function setCodexTabOpen(open) {
        window.__ag_settings_tab_open = Boolean(open);
        if (activeDlg) {
          if (open) {
            activeDlg.setAttribute('data-ag-codex-settings-open', '1');
          } else {
            activeDlg.removeAttribute('data-ag-codex-settings-open');
          }
        }
        if (open) {
          renderPane();
          fetchSettingsState({
            includeModels: !window.__ag_settings_models_cache,
            refreshModels: false
          });
          syncStatusPoller();
        } else {
          if (typeof window.__ag_on_accounts_tab_active === 'function') {
            try { window.__ag_on_accounts_tab_active(false); } catch {}
          }
          hideModelMenus({ restoreFocus: false });
          syncStatusPoller();
        }
      }
      window.__ag_set_codex_settings_open = setCodexTabOpen;
      window.__ag_open_settings_tab = (tabKey) => {
        const nextTab = SECTION_TAB_KEYS.includes(tabKey) ? tabKey : 'appearance';
        setActiveSectionTab(nextTab);
        const activate = () => {
          tryMountInSettingsModal();
          setCodexTabOpen(true);
        };
        if (document.querySelector('[data-testid="settings-sidebar"]')) {
          activate();
        } else {
          const settingsBtn = document.querySelector('[data-testid="settings-button"]');
          if (settingsBtn) settingsBtn.click();
          setTimeout(activate, 180);
        }
      };

      function bindPaneEvents(pane) {
        listen(pane, 'change', (ev) => {
          const sw = ev.target && ev.target.closest ? ev.target.closest('input.ag-s-switch[data-bind-mod]') : null;
          if (sw) {
            const mod = sw.getAttribute('data-bind-mod');
            if (!mod) return;
            const checked = Boolean(sw.checked);
            if ((mod === 'promptSuggestions' || mod === 'flow') && !checked) {
              hideModelMenus({ restoreFocus: false });
            }
            commitPatch({ modules: { [mod]: checked } });
            return;
          }
          const flagSw = ev.target && ev.target.closest ? ev.target.closest('input.ag-s-switch[data-bind-flag]') : null;
          if (flagSw) {
            const flagKey = flagSw.getAttribute('data-bind-flag');
            if (flagKey) {
              commitPatch({ [flagKey]: Boolean(flagSw.checked) });
            }
            return;
          }
          const nestedSw = ev.target && ev.target.closest ? ev.target.closest('input.ag-s-switch[data-bind-nested]') : null;
          if (nestedSw) {
            const spec = nestedSw.getAttribute('data-bind-nested') || '';
            const parts = spec.split('.');
            if (parts.length === 2) {
              commitPatch({ [parts[0]]: { [parts[1]]: Boolean(nestedSw.checked) } });
            }
            return;
          }
        });

        listen(pane, 'input', (ev) => {
          const ta = ev.target && ev.target.id === 'ag-s-prompt-textarea' ? ev.target : null;
          if (!ta) return;
          const tab = activePromptTab;
          setDraftForTab(tab, ta.value);
          const saved = getSavedPromptForTab(tab);
          const dirty = ta.value !== saved;
          const s = getStrings();
          const metaEl = document.getElementById('ag-s-prompt-meta');
          if (metaEl) {
            metaEl.textContent = ta.value.length + ' / 20000 · ' + (dirty ? s.promptUnsaved : s.promptSavedTip);
          }
          const saveBtn = document.getElementById('ag-s-prompt-save');
          if (saveBtn) saveBtn.disabled = !dirty;
        });

        listen(pane, 'click', (ev) => {
          const secTabBtn = ev.target && ev.target.closest ? ev.target.closest('.ag-s-nav-tab[data-section-tab]') : null;
          if (secTabBtn) {
            const nextSec = secTabBtn.getAttribute('data-section-tab') || 'appearance';
            if (nextSec !== activeSectionTab) {
              hideModelMenus({ restoreFocus: false });
              setActiveSectionTab(nextSec);
              pane.scrollTop = 0;
              window.__ag_settings_scroll_top = 0;
              renderPane();
            }
            return;
          }

          const manualRef = ev.target && ev.target.closest ? ev.target.closest('#ag-s-manual-refresh') : null;
          if (manualRef) {
            ev.preventDefault();
            ev.stopPropagation();
            fetchSettingsState({ includeModels: true, refreshModels: true, forceReload: true });
            return;
          }

          const checkUpd = ev.target && ev.target.closest ? ev.target.closest('#ag-s-check-update') : null;
          if (checkUpd) {
            ev.preventDefault();
            ev.stopPropagation();
            checkPluginUpdate();
            return;
          }

          const applyUpd = ev.target && ev.target.closest ? ev.target.closest('#ag-s-apply-update') : null;
          if (applyUpd) {
            ev.preventDefault();
            ev.stopPropagation();
            applyPluginUpdateAction();
            return;
          }

          const extLink = ev.target && ev.target.closest ? ev.target.closest('a[data-ext-link]') : null;
          if (extLink) {
            const key = extLink.getAttribute('data-ext-link');
            if (key && typeof window.__agOpenExternalUrl === 'function') {
              ev.preventDefault();
              ev.stopPropagation();
              try {
                window.__agOpenExternalUrl(JSON.stringify({ key }));
              } catch {}
            }
            return;
          }

          const trigger = ev.target && ev.target.closest ? ev.target.closest('[data-model-picker-target]') : null;
          if (trigger) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleModelMenu(trigger, ev.detail === 0);
            return;
          }

          const refBtn = ev.target && ev.target.closest ? ev.target.closest('[data-refresh-models]') : null;
          if (refBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            fetchSettingsState({ includeModels: true, refreshModels: true });
            return;
          }

          const seg = ev.target && ev.target.closest ? ev.target.closest('.ag-s-seg-btn[data-seg]') : null;
          if (seg) {
            const field = seg.getAttribute('data-seg');
            const val = seg.getAttribute('data-val');
            const curVal = field === 'i18nLocale' ? getActiveLocale() : uiState.config[field];
            if (field && val && curVal !== val) {
              commitPatch({ [field]: val });
            }
            return;
          }

          const nestedSeg = ev.target && ev.target.closest ? ev.target.closest('.ag-s-seg-btn[data-nested-seg]') : null;
          if (nestedSeg) {
            const spec = nestedSeg.getAttribute('data-nested-seg') || '';
            const rawVal = nestedSeg.getAttribute('data-val');
            const parts = spec.split('.');
            if (parts.length === 2 && rawVal !== null && rawVal !== '') {
              const val =
                spec === 'flow.maxContinuations' ||
                spec === 'flow.compactThresholdPct' ||
                spec === 'flow.compactKeepTailTokens' ||
                spec === 'autoTitle.turnInterval' ||
                spec === 'autoTitle.minIntervalMin'
                  ? Number(rawVal)
                  : spec === 'customSystemPrompt.everyInvocation'
                  ? rawVal === 'true'
                  : rawVal;
              const curObj = uiState.config[parts[0]] || {};
              if (curObj[parts[1]] !== val) {
                if (spec === 'customSystemPrompt.mode') {
                  commitPatch({
                    customSystemPrompt: { mode: val },
                    flow: { systemPromptStrategy: val === 'flow-proxy' ? 'seat-only' : 'keep' }
                  });
                } else {
                  commitPatch({ [parts[0]]: { [parts[1]]: val } });
                }
              }
            }
            return;
          }

          const asarToggle = ev.target && ev.target.closest ? ev.target.closest('#ag-s-flow-asar-toggle') : null;
          if (asarToggle && !asarToggle.disabled) {
            const action = asarToggle.getAttribute('data-asar-action') === 'rollback' ? 'rollback' : 'apply';
            if (typeof window.__agFlowAsarAction === 'function') {
              const reqId = 'fl_asar_' + Date.now().toString(36);
              const prevHandler = window.__ag_on_flow_response;
              window.__ag_on_flow_response = (id, payload) => {
                if (id === reqId) {
                  window.__ag_on_flow_response = prevHandler;
                  if (payload && payload.state) uiState.flowStatus = payload.state;
                  flowAsarMsg = payload && payload.ok
                    ? (payload.needsRestart ? '已落盘，重启 Antigravity 生效' : '已对齐')
                    : (payload && payload.error ? payload.error : '操作失败');
                  renderPane();
                  return;
                }
                if (typeof prevHandler === 'function') prevHandler(id, payload);
              };
              try {
                window.__agFlowAsarAction(JSON.stringify({ reqId, action }));
              } catch {}
            }
            return;
          }

          const promptTabBtn = ev.target && ev.target.closest ? ev.target.closest('.ag-s-seg-btn[data-prompt-tab]') : null;
          if (promptTabBtn) {
            const nextTab = promptTabBtn.getAttribute('data-prompt-tab') || 'global';
            if (nextTab !== activePromptTab) {
              setActivePromptTab(nextTab);
              renderPane();
            }
            return;
          }

          const presetBtn = ev.target && ev.target.closest ? ev.target.closest('[data-prompt-preset]') : null;
          if (presetBtn) {
            const pKey = presetBtn.getAttribute('data-prompt-preset');
            const s = getStrings();
            const tpl = s.presets && pKey ? s.presets[pKey] : '';
            if (tpl) {
              commitPromptForTab(activePromptTab, tpl);
            }
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-prompt-save')) {
            const ta = document.getElementById('ag-s-prompt-textarea');
            const nextText = ta ? ta.value : getDraftForTab(activePromptTab);
            commitPromptForTab(activePromptTab, nextText);
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-prompt-clear')) {
            commitPromptForTab(activePromptTab, '');
            return;
          }

          const rmBtn = ev.target && ev.target.closest ? ev.target.closest('[data-rm-host]') : null;
          if (rmBtn) {
            const idx = Number(rmBtn.getAttribute('data-rm-host'));
            const nextHosts = (uiState.config.sshHosts || []).slice();
            if (idx >= 0 && idx < nextHosts.length) {
              nextHosts.splice(idx, 1);
              commitPatch({ sshHosts: nextHosts });
            }
            return;
          }

          const cycleTierBtn = ev.target && ev.target.closest ? ev.target.closest('[data-cycle-submodel-tier]') : null;
          if (cycleTierBtn) {
            const idx = Number(cycleTierBtn.getAttribute('data-cycle-submodel-tier'));
            const curList = ((uiState.config.subagentRouting && uiState.config.subagentRouting.allowedModels) || []).map((m) =>
              Object.assign({}, m)
            );
            if (idx >= 0 && idx < curList.length) {
              const order = ['fast', 'balanced', 'strong'];
              const curIdx = order.indexOf(curList[idx].tier);
              curList[idx].tier = order[(curIdx + 1) % order.length];
              commitPatch({ subagentRouting: { allowedModels: curList } });
            }
            return;
          }

          const rmSubBtn = ev.target && ev.target.closest ? ev.target.closest('[data-rm-submodel]') : null;
          if (rmSubBtn) {
            const idx = Number(rmSubBtn.getAttribute('data-rm-submodel'));
            const curList = ((uiState.config.subagentRouting && uiState.config.subagentRouting.allowedModels) || []).map((m) =>
              Object.assign({}, m)
            );
            if (idx >= 0 && idx < curList.length) {
              curList.splice(idx, 1);
              commitPatch({ subagentRouting: { allowedModels: curList } });
            }
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-subagent-custom-add')) {
            const inp = document.getElementById('ag-s-subagent-custom-input');
            const sel = document.getElementById('ag-s-subagent-custom-tier');
            const rawVal = inp ? inp.value : '';
            const tierVal = sel ? sel.value : '';
            if (addSubagentAllowedModel(rawVal, tierVal)) {
              if (inp) {
                inp.value = '';
                inp.removeAttribute('data-invalid');
              }
            } else if (inp) {
              inp.setAttribute('data-invalid', '1');
              inp.focus();
            }
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-auto-title-now')) {
            if (autoTitleBusy) return;
            autoTitleBusy = true;
            autoTitleStatusMsg = '';
            renderPane();
            let activeCid = '';
            try {
              if (typeof window.__ag_get_watched_cascade_ids === 'function') {
                const list = window.__ag_get_watched_cascade_ids();
                if (Array.isArray(list) && list[0]) activeCid = String(list[0]).trim();
              }
              if (!activeCid) {
                const m = String(window.location?.pathname || '').match(/\/c\/([0-9a-f-]{36})/i);
                if (m && m[1]) activeCid = m[1];
              }
              if (!activeCid) {
                const cv = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
                if (cv) activeCid = String(cv.getAttribute('data-cascade-id') || '').trim();
              }
            } catch {}
            void callDaemonBinding('__agRefreshConversationTitle', { cascadeId: activeCid }, 40000).then((res) => {
              if (disposed) return;
              autoTitleBusy = false;
              if (res && res.ok && res.title) {
                autoTitleStatusMsg = (res.unchanged ? '无需变更：' : '已更新：') + res.title;
              } else {
                autoTitleStatusMsg = (res && res.error) || '暂无足够对话进展，请先在会话中交流';
              }
              renderPane();
            });
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-add-host')) {
            addingHost = true;
            invalidHost = false;
            renderPane();
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-host-ok')) {
            const inp = document.getElementById('ag-s-host-input');
            submitNewHost(inp ? inp.value : '');
          }
        });

        listen(pane, 'keydown', (ev) => {
          if (ev.target && ev.target.id === 'ag-s-subagent-custom-input' && ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            const sel = document.getElementById('ag-s-subagent-custom-tier');
            const tierVal = sel ? sel.value : '';
            if (addSubagentAllowedModel(ev.target.value, tierVal)) {
              ev.target.value = '';
              ev.target.removeAttribute('data-invalid');
            } else {
              ev.target.setAttribute('data-invalid', '1');
            }
            return;
          }
          if (ev.target && ev.target.id === 'ag-s-prompt-textarea' && (ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            commitPromptForTab(activePromptTab, ev.target.value);
            return;
          }
          const trigger = ev.target && ev.target.closest ? ev.target.closest('[data-model-picker-target]') : null;
          if (trigger && ev.key === 'ArrowDown') {
            ev.preventDefault();
            ev.stopPropagation();
            const root = ensureModelPopovers();
            if (!isPopoverOpen(root) || activeModelPickerTriggerId !== trigger.id) {
              toggleModelMenu(trigger, true);
            } else {
              const first = root.querySelector('.ag-s-menu-list > button');
              if (first) first.focus();
            }
          }
        });
      }

      function isProtectedSettingsChild(node) {
        if (!node || node.nodeType !== 1) return true;
        if (node.id === 'ag-settings-pane' || node.id === 'ag-accounts-pane' || node.tagName === 'STYLE' || node.tagName === 'BUTTON') return true;
        const tid = String(node.getAttribute ? node.getAttribute('data-testid') || '' : '');
        const aria = String(node.getAttribute ? node.getAttribute('aria-label') || '' : '');
        const cls = String(node.className || '');
        if (/close/i.test(tid) || /close|关闭|關閉/i.test(aria)) return true;
        if (/\bw-px\b|\bw-\[1px\]|\bdivider\b/i.test(cls) && (!node.children || node.children.length === 0)) return true;
        return false;
      }

      function resolveSettingsModalTargets() {
        const sidebar = document.querySelector('[data-testid="settings-sidebar"]');
        if (!sidebar) return null;
        const dlg = sidebar.closest('.settings-modal-container') || sidebar.closest('[role="dialog"]');
        if (!dlg) return null;

        const listRoot = sidebar.firstElementChild || sidebar;
        const groups = Array.from(listRoot.children || []);
        const browserBtn = sidebar.querySelector('[data-testid="settings-nav-item-Browser"], #settings-nav-item-Browser');
        let navGroup = null;
        if (browserBtn) {
          let cur = browserBtn.parentElement;
          for (let hop = 0; hop < 4 && cur; hop++) {
            if (groups.includes(cur)) {
              navGroup = cur;
              break;
            }
            cur = cur.parentElement;
          }
        }
        if (!navGroup) {
          navGroup =
            groups.find((el) => el && el.querySelector && el.querySelector('[data-testid^="settings-nav-item-"]')) ||
            groups[1] ||
            listRoot;
        }

        // Find splitRow containing sidebar and pick the true sibling right pane (never hardcoding children[1])
        let splitRow = sidebar.closest('.relative.flex.w-full.h-full') || sidebar.parentElement || null;
        let rightPane = null;
        if (splitRow && splitRow.children) {
          const sibs = Array.from(splitRow.children).filter(
            (ch) => ch && ch !== sidebar && !(ch.contains && ch.contains(sidebar)) && !isProtectedSettingsChild(ch)
          );
          rightPane =
            sibs.find(
              (ch) =>
                (ch.getAttribute && ch.getAttribute('data-settings-content-pane') === 'true') ||
                (ch.querySelector && ch.querySelector('[data-settings-content-pane="true"]'))
            ) ||
            sibs.find((ch) => {
              const cls = String(ch.className || '');
              return /\bflex-1\b|\boverflow-y-auto\b|\boverflow-hidden\b/.test(cls) || (ch.children && ch.children.length > 0);
            }) ||
            sibs[0] ||
            null;
          if (rightPane && rightPane.getAttribute && rightPane.getAttribute('data-settings-content-pane') !== 'true') {
            const inner = rightPane.querySelector && rightPane.querySelector('[data-settings-content-pane="true"]');
            if (inner && !(inner.contains && inner.contains(sidebar))) rightPane = inner;
          }
        }
        if (!rightPane) {
          let cursor = sidebar;
          while (cursor && cursor !== dlg) {
            const parent = cursor.parentElement;
            if (!parent) break;
            const sibs = Array.from(parent.children || []).filter(
              (ch) => ch && ch !== cursor && !(ch.contains && ch.contains(sidebar)) && !isProtectedSettingsChild(ch)
            );
            if (sibs.length > 0) {
              splitRow = parent;
              rightPane = sibs[0];
              break;
            }
            cursor = parent;
          }
        }

        if (!navGroup || !rightPane) return null;
        return { dlg, sidebar, navGroup, splitRow: splitRow || rightPane.parentElement, rightPane };
      }

      function tryMountInSettingsModal() {
        if (disposed) return;
        const targets = resolveSettingsModalTargets();

        if (!targets) {
          if (activeDlg) {
            activeDlg = null;
            if (activeSidebar && boundSidebarClick) {
              try { activeSidebar.removeEventListener('click', boundSidebarClick, true); } catch {}
            }
            activeSidebar = null;
            boundSidebarClick = null;
            window.__ag_settings_tab_open = false;
            window.__ag_settings_scroll_top = 0;
            hideModelMenus({ restoreFocus: false });
            syncStatusPoller();
          }
          return;
        }

        const { dlg, sidebar, navGroup: firstNavGroup, splitRow, rightPane } = targets;

        let justMounted = activeDlg !== dlg;
        activeDlg = dlg;
        if (splitRow && splitRow.setAttribute) {
          splitRow.setAttribute('data-ag-settings-split-row', '1');
        }
        rightPane.setAttribute('data-ag-settings-right-pane', '1');

        // Match native horizontal padding so our nav item aligns cleanly without indenting or stretching sidebar
        let navGroupHasPadding = false;
        try {
          const cs = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(firstNavGroup) : null;
          if (cs && parseFloat(cs.paddingLeft || '0') >= 4) navGroupHasPadding = true;
        } catch {}
        const padAttr = navGroupHasPadding ? '1' : '0';

        if (activeSidebar !== sidebar) {
          if (activeSidebar && boundSidebarClick) {
            try { activeSidebar.removeEventListener('click', boundSidebarClick, true); } catch {}
          }
          activeSidebar = sidebar;
          boundSidebarClick = (ev) => {
            const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
            if (btn && btn.id !== 'ag-settings-nav-btn' && window.__ag_settings_tab_open) {
              setCodexTabOpen(false);
            }
          };
          listen(sidebar, 'click', boundSidebarClick, true);
        }

        let divider = document.getElementById('ag-settings-nav-divider');
        if (!divider) {
          divider = document.createElement('div');
          divider.id = 'ag-settings-nav-divider';
        }
        divider.setAttribute('data-ag-nav-padded', padAttr);
        if (divider.parentElement !== firstNavGroup) {
          firstNavGroup.appendChild(divider);
          justMounted = true;
        }

        let navWrap = document.getElementById('ag-settings-nav-wrap');
        if (!navWrap) {
          navWrap = document.createElement('div');
          navWrap.id = 'ag-settings-nav-wrap';
          navWrap.className = 'relative group/nav-item';
          const btn = document.createElement('button');
          btn.id = 'ag-settings-nav-btn';
          btn.type = 'button';
          btn.setAttribute('data-testid', 'settings-nav-item-CodexTheme');
          btn.innerHTML =
            '<span class="ag-s-nav-left">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.86;flex-shrink:0" aria-hidden="true">' +
            '<path d="M2.25 4h2.5M8.25 4h5.5M2.25 8h7M12.75 8h1M2.25 12h4M9.75 12h4"></path>' +
            '<circle cx="6.5" cy="4" r="1.5"></circle>' +
            '<circle cx="11" cy="8" r="1.5"></circle>' +
            '<circle cx="8" cy="12" r="1.5"></circle>' +
            '</svg>' +
            '<span class="ag-s-nav-label"></span>' +
            '</span>' +
            '<span class="ag-s-nav-ver"></span>';
          navWrap.appendChild(btn);
          justMounted = true;
        }
        const navBtn = document.getElementById('ag-settings-nav-btn');
        if (navBtn && navBtn !== boundNavBtn) {
          boundNavBtn = navBtn;
          listen(navBtn, 'click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setCodexTabOpen(true);
          });
        }
        navWrap.setAttribute('data-ag-nav-padded', padAttr);
        if (navWrap.parentElement !== firstNavGroup) {
          firstNavGroup.appendChild(navWrap);
          justMounted = true;
        }

        let pane = document.getElementById('ag-settings-pane');
        if (!pane) {
          pane = document.createElement('div');
          pane.id = 'ag-settings-pane';
          justMounted = true;
        }
        if (pane !== boundPane) {
          boundPane = pane;
          bindPaneEvents(pane);
        }
        if (pane.parentElement !== rightPane) {
          rightPane.appendChild(pane);
          justMounted = true;
        }

        if (justMounted) {
          renderPane();
          if (window.__ag_settings_tab_open) {
            activeDlg.setAttribute('data-ag-codex-settings-open', '1');
            fetchSettingsState({
              includeModels: !window.__ag_settings_models_cache,
              refreshModels: false
            });
            syncStatusPoller();
          }
        }
        if (typeof window.__ag_sync_accounts_dialog === 'function') {
          try { window.__ag_sync_accounts_dialog(); } catch {}
        }
      }

      function scheduleScan(delayMs) {
        if (disposed || scanTimer) return;
        scanTimer = setTimeout(() => {
          scanTimer = null;
          tryMountInSettingsModal();
        }, delayMs);
      }

      const onDocClick = (ev) => {
        if (disposed) return;
        if (!SUPPORTS_POPOVER) {
          const root = document.getElementById('ag-settings-model-menu');
          if (
            root &&
            !root.hidden &&
            ev.target &&
            ev.target.closest &&
            !ev.target.closest('#ag-settings-model-menu') &&
            !ev.target.closest('[data-model-picker-target]')
          ) {
            hideModelMenus({ restoreFocus: false });
          }
        }
        if (ev.target && ev.target.closest && ev.target.closest('[data-testid="settings-button"]')) {
          scheduleScan(40);
          setTimeout(() => { if (!disposed) tryMountInSettingsModal(); }, 160);
        }
      };

      const observer =
        typeof MutationObserver !== 'undefined'
          ? new MutationObserver(() => {
              if (activeDlg) {
                const navOk = document.getElementById('ag-settings-nav-wrap');
                const paneOk = document.getElementById('ag-settings-pane');
                if (!activeDlg.isConnected || !navOk || !navOk.isConnected || !paneOk || !paneOk.isConnected) {
                  scheduleScan(60);
                }
                return;
              }
              if (
                window.location.search.includes('settingsOpen=true') ||
                document.querySelector('[data-testid="settings-sidebar"]')
              ) {
                scheduleScan(80);
              }
            })
          : null;
      if (observer && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      listen(document, 'click', onDocClick, true);

      tryMountInSettingsModal();

      if (Array.isArray(window.__ag_cleanup_fns)) {
        window.__ag_cleanup_fns.push(() => {
          disposed = true;
          if (scanTimer) clearTimeout(scanTimer);
          if (statusPollTimer) clearInterval(statusPollTimer);
          if (saveBadgeTimer) clearTimeout(saveBadgeTimer);
          if (hoverSwitchTimer) clearTimeout(hoverSwitchTimer);
          if (observer) observer.disconnect();
          if (abortCtrl) {
            try { abortCtrl.abort(); } catch {}
          }
          for (let i = 0; i < manualRemovers.length; i++) {
            try { manualRemovers[i](); } catch {}
          }
          manualRemovers.length = 0;
          if (activeSidebar && boundSidebarClick) {
            try { activeSidebar.removeEventListener('click', boundSidebarClick, true); } catch {}
          }
          hideModelMenus({ restoreFocus: false });
          const oldPopovers = [
            document.getElementById('ag-settings-model-menu'),
            document.getElementById('ag-settings-effort-menu')
          ];
          oldPopovers.forEach((el) => { if (el) el.remove(); });
          // Keep #ag-settings-nav-* / #ag-settings-pane / data-ag-codex-settings-open intact across hot-reloads
          // so the next bundle seamlessly re-binds in place with zero visual flicker.
          // Full teardown when disabled is handled by 00-head.js (!ENABLED) and mountCodexSettingsUi().
          try { delete window.__ag_on_settings_state; } catch { window.__ag_on_settings_state = null; }
          try { delete window.__ag_open_settings_tab; } catch { window.__ag_open_settings_tab = null; }
        });
      }
    })();
  }
