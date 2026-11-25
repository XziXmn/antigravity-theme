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
      let addingHost = false;
      let invalidHost = false;
      let refreshingModels = false;
      let refreshingAll = false;
      let activeDlg = null;
      let activeSidebar = null;
      let boundSidebarClick = null;
      let boundNavBtn = null;
      let boundPane = null;
      let promptDraft =
        typeof window.__ag_settings_prompt_draft === 'string' ? window.__ag_settings_prompt_draft : null;
      function setPromptDraft(val) {
        promptDraft = typeof val === 'string' ? val : null;
        window.__ag_settings_prompt_draft = promptDraft;
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

      const uiState = {
        config: {
          i18nLocale: bootUserCfg.i18nLocale || boot.i18nLocale || (MODULES.i18n ? 'zh-CN' : 'en'),
          syncAiOutputLang: Boolean(bootUserCfg.syncAiOutputLang ?? boot.syncAiOutputLang),
          customSystemPrompt: {
            enabled: Boolean(bootPromptCfg.enabled),
            mode: bootPromptCfg.mode || 'system-dual',
            text: typeof bootPromptCfg.text === 'string' ? bootPromptCfg.text : '',
            everyInvocation: Boolean(bootPromptCfg.everyInvocation)
          },
          hookAutoAllow: {
            enabled: Boolean(bootHookAllowCfg.enabled),
            mode: bootHookAllowCfg.mode || 'files'
          },
          telemetryLayout: bootUserCfg.telemetryLayout || boot.telemetryLayout || 'compact',
          telemetryCacheMode: bootUserCfg.telemetryCacheMode || boot.telemetryCacheMode || 'session',
          promptSuggestionModel: bootUserCfg.promptSuggestionModel || 'gemini-3.8-flash-low',
          sshHosts: Array.isArray(bootUserCfg.sshHosts) ? bootUserCfg.sshHosts.slice() : [],
          modules: Object.assign({}, MODULES, bootUserCfg.modules || {})
        },
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
            manualRefreshLabel: '手動重新整理主題與設定',
            savedBadge: '已同步',
            refreshedBadge: '已重新整理',
            githubLabel: 'GitHub',
            feedbackLabel: '回報問題',
            subtitlePrefix: '管理主題配色、介面語言、工作階段統計與可選增強模組，變更即時同步至 ',
            subtitleSuffix: '。',
            secCore: '核心模組',
            modTheme: 'Codex 晝夜主題',
            modThemeDesc: '純白淺色與中性炭灰深色配色，隨 IDE 外觀自動切換',
            modI18n: '中文介面本地化',
            modI18nDesc: '內建 2,300+ 精校詞條，原地更新不影響互動，關閉即還原英文',
            localeLbl: '顯示語言與術語風格',
            localeDesc: '即時切換介面語言，無需重啟',
            locZhCn: '简体中文',
            locZhSg: '简中·英术',
            locZhTw: '繁體中文',
            locEn: 'English',
            syncAiLangLbl: '同步 AI 思考與回覆語言',
            syncAiLangDesc: '開啟後自動託管全域規則檔，使代理的思考與回覆跟隨目前介面語言（預設關閉）',
            secPromptHooks: '系統提示詞與 Hooks',
            secPromptHooksHint: '託管 GEMINI.md、rules 與 hooks.json，保留原有設定',
            modCustomPrompt: '系統級自訂提示詞',
            modCustomPromptDesc: '跨所有專案與工作區生效，直接寫入全域系統指令檔與系統角色 Hook（不改動官方安裝包）',
            promptModeLbl: '系統級注入通道',
            promptModeDesc: '推薦「系統雙通道」：同步寫入全域 GEMINI.md 並於新對話以 systemMessage 系統角色強化注入',
            promptModeDual: '系統雙通道',
            promptModeGemini: '全域 GEMINI.md',
            promptModeRule: '全域規則',
            promptModePreInv: '每輪前強注',
            promptEveryInvLbl: '每輪模型呼叫前重複強注（防長對話遺忘）',
            promptEveryInvDesc: '關閉時僅首輪注入以保護 Prompt Cache；開啟後每次模型推理前皆以 systemMessage 強重申',
            promptTargetPrefix: '系統生效目標：',
            promptTargetDual: '~/.gemini/GEMINI.md（託管區塊）+ ~/.gemini/config/hooks.json (SessionStart · systemMessage)',
            promptTargetGemini: '~/.gemini/GEMINI.md（託管區塊，全端通用、零延遲）',
            promptTargetRule: '~/.gemini/config/rules/98_antigravity_theme_system_prompt.md (trigger: always_on)',
            promptTargetSession: '~/.gemini/config/hooks.json (SessionStart · systemMessage)',
            promptTargetPreInv: '~/.gemini/config/hooks.json (PreInvocation · systemMessage)',
            promptPresetLbl: '系統範本：',
            presetSystemRole: '系統級專家設定',
            presetAntiHalluc: '嚴謹防幻覺',
            presetConcise: '簡潔極客',
            presetContract: '契約開發',
            promptPlaceholder: '輸入系統級角色定義、全域工程紀律、回覆風格或操作契約（最多 20,000 字元）…',
            promptClearBtn: '清空',
            promptSaveBtn: '儲存系統提示詞',
            promptUnsaved: '有未儲存的修改',
            promptSavedTip: 'Ctrl/Cmd + Enter 快捷儲存',
            modAutoAllow: '工具自動放行 Hook (PreToolUse)',
            modAutoAllowDesc: '透過 ~/.gemini/config/hooks.json 自動核准指定工具，減少重複確認彈窗',
            autoAllowModeLbl: '放行範圍',
            autoAllowModeDesc: '「含安全指令」內建高危破壞性指令攔截，高危操作仍交由人工確認',
            autoAllowFiles: '僅檔案讀寫',
            autoAllowSafeCmd: '含安全指令',
            autoAllowAll: '全部放行',
            autoAllowAllWarn: '注意：全部放行將略過所有終端機指令確認，包含具破壞性的操作，請謹慎開啟。',
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
            modMetrics: '即時工作階段狀態與用量統計',
            modMetricsDesc: '底部四態狀態指示、一/二級明細面板與每輪對話尾部統計',
            secOptional: '可選增強',
            secOptionalHint: '預設關閉，按需開啟',
            modSuggest: '輸入框下一句預測',
            modSuggestDescPre: '回覆結束後預測下一句指令，按 ',
            modSuggestDescMid: ' 或 ',
            modSuggestDescPost: ' 補全（開啟後背景常駐 ',
            modSuggestDescEnd: ' 程序）',
            agyIdle: '未啟動',
            agyWarming: '預熱中…',
            agyReady: 'agy 就緒',
            agyMissing: '未偵測到 agy',
            suggestModelLbl: '預測模型',
            suggestModelDescPre: '由 ',
            suggestModelDescPost: ' 自動依模型與檔位分組，推薦 Gemini 3.8 Flash Low',
            refreshModelsTitle: '重新取得 agy models',
            menuModelsHdr: '模型',
            recommendedBadge: '推薦',
            modSsh: 'SSH Remote 遠端唯讀統計',
            modSshDesc: '透過遠端唯讀 Python 擷取脫敏數值中繼資料，不在本機複製 .db 檔案',
            sshHostsLbl: '允許探測的主機（sshHosts）',
            addHostBtn: '+ 新增主機',
            addHostPlaceholder: '例如 node032',
            addHostOk: '新增',
            secTelemetry: '狀態列偏好',
            layoutLbl: '底部狀態列密度',
            layoutDesc: '精簡模式置中嵌於工具列內；詳細模式展開為底部置中獨立列，補充 TTFT 與本步輸出',
            layoutCompact: '精簡',
            layoutDetailed: '詳細',
            cacheLbl: '快取命中率口徑',
            cacheDesc: '選擇狀態列顯示整個工作階段的累計命中率，或最近單步命中率',
            cacheSession: '工作階段累計',
            cacheStep: '單步',
            secUpdate: '版本與更新',
            updTitle: '外掛版本',
            updDescIdle: '從 GitHub 倉庫檢查新版本並直接更新，保留 user/ 個人設定',
            updDescChecking: '正在連線 GitHub 檢查最新版本與檔案清單…',
            updDescUpToDate: '目前已與遠端最新版本保持一致',
            updDescAhead: '目前本機版本高於遠端發佈版本',
            updDescAvailable: '發現新版本，點擊直接更新並熱重載生效，無需重啟 Antigravity',
            updDescMainDiff: '遠端 main 分支有檔案差異，可一鍵同步最新 main',
            updDescUpdating: '正在下載並驗證更新檔案，同時備份舊版本，請稍候…',
            updDescApplied: '已更新完成，背景服務正在重啟並熱重載至目前視窗…',
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
            manualRefreshLabel: '手动刷新主题与配置',
            savedBadge: '已同步',
            refreshedBadge: '已刷新',
            githubLabel: 'GitHub',
            feedbackLabel: '反馈',
            subtitlePrefix: '管理主题配色、中文界面、会话统计与可选增强模块，修改实时同步至 ',
            subtitleSuffix: '。',
            secCore: '核心模块',
            modTheme: 'Codex 昼夜主题',
            modThemeDesc: '浅色纯白与中性炭灰深色配色，随 IDE 外观自动切换',
            modI18n: '中文界面汉化',
            modI18nDesc: '内置 2,300+ 精校词条，原地更新不影响交互，关闭即恢复英文',
            localeLbl: '显示语言与术语风格',
            localeDesc: '实时切换界面语言，无需重启',
            locZhCn: '简体中文',
            locZhSg: '简中·英术',
            locZhTw: '繁體中文',
            locEn: 'English',
            syncAiLangLbl: '同步 AI 思考与回复语言',
            syncAiLangDesc: '开启后自动托管全局规则文件，让智能体的思考与回复跟随当前界面语言（默认关闭）',
            secPromptHooks: '系统提示词与 Hooks',
            secPromptHooksHint: '托管 GEMINI.md、rules 与 hooks.json，保留原有配置',
            modCustomPrompt: '系统级自定义提示词',
            modCustomPromptDesc: '跨所有项目与工作区生效，直接写入全局系统指令文件与系统角色 Hook（零改包、不破签名）',
            promptModeLbl: '系统级注入通道',
            promptModeDesc: '推荐「系统双通道」：同步写入全局 GEMINI.md 并在新会话以 systemMessage 系统角色强化注入',
            promptModeDual: '系统双通道',
            promptModeGemini: '全局 GEMINI.md',
            promptModeRule: '全局规则',
            promptModePreInv: '每轮前强注',
            promptEveryInvLbl: '每轮模型调用前重复强注（防长对话遗忘）',
            promptEveryInvDesc: '关闭时仅首轮注入以保护 Prompt Cache；开启后每次模型推理前均以 systemMessage 强重申',
            promptTargetPrefix: '系统生效目标：',
            promptTargetDual: '~/.gemini/GEMINI.md（托管块）+ ~/.gemini/config/hooks.json (SessionStart · systemMessage)',
            promptTargetGemini: '~/.gemini/GEMINI.md（托管块，App/CLI/IDE 全端通用、零延迟）',
            promptTargetRule: '~/.gemini/config/rules/98_antigravity_theme_system_prompt.md (trigger: always_on)',
            promptTargetSession: '~/.gemini/config/hooks.json (SessionStart · systemMessage)',
            promptTargetPreInv: '~/.gemini/config/hooks.json (PreInvocation · systemMessage)',
            promptPresetLbl: '系统模板：',
            presetSystemRole: '系统级专家设定',
            presetAntiHalluc: '严谨防幻觉',
            presetConcise: '简洁极客',
            presetContract: '契约开发',
            promptPlaceholder: '输入系统级角色定义、全局工程纪律、回复风格或操作契约（最多 20,000 字符）…',
            promptClearBtn: '清空',
            promptSaveBtn: '保存系统提示词',
            promptUnsaved: '有未保存的修改',
            promptSavedTip: 'Ctrl/Cmd + Enter 快捷保存',
            modAutoAllow: '工具自动放行 Hook (PreToolUse)',
            modAutoAllowDesc: '通过 ~/.gemini/config/hooks.json 自动放行指定工具，减少重复确认弹窗',
            autoAllowModeLbl: '放行范围',
            autoAllowModeDesc: '「含安全命令」内置高危破坏性命令拦截守卫，高危操作仍交由人工确认',
            autoAllowFiles: '仅文件读写',
            autoAllowSafeCmd: '含安全命令',
            autoAllowAll: '全部放行',
            autoAllowAllWarn: '注意：全部放行将跳过所有终端命令审批（含潜在破坏性命令），请谨慎开启。',
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
            modMetrics: '实时会话状态与用量统计',
            modMetricsDesc: '底部四态状态指示、一/二级明细面板与每轮对话尾部统计',
            secOptional: '可选增强',
            secOptionalHint: '默认关闭，按需开启',
            modSuggest: '输入框下一句预测',
            modSuggestDescPre: '回复结束后预测下一句指令，按 ',
            modSuggestDescMid: ' 或 ',
            modSuggestDescPost: ' 补全（开启后后台常驻 ',
            modSuggestDescEnd: ' 进程）',
            agyIdle: '未启动',
            agyWarming: '预热中…',
            agyReady: 'agy 就绪',
            agyMissing: '未检测到 agy',
            suggestModelLbl: '预测模型',
            suggestModelDescPre: '由 ',
            suggestModelDescPost: ' 自动按模型与档位分组，推荐 Gemini 3.8 Flash Low',
            refreshModelsTitle: '重新拉取 agy models',
            menuModelsHdr: '模型',
            recommendedBadge: '推荐',
            modSsh: 'SSH Remote 远端只读统计',
            modSshDesc: '通过远端只读 Python 提取脱敏数值元数据，不在本地拷贝 .db 文件',
            sshHostsLbl: '允许探测的主机（sshHosts）',
            addHostBtn: '+ 添加主机',
            addHostPlaceholder: '如 node032',
            addHostOk: '添加',
            secTelemetry: '状态栏偏好',
            layoutLbl: '底部状态栏密度',
            layoutDesc: '紧凑模式居中嵌在工具栏内；详细模式展开为底部居中独立行，补充 TTFT 与本步输出',
            layoutCompact: '紧凑',
            layoutDetailed: '详细',
            cacheLbl: '缓存命中率口径',
            cacheDesc: '选择状态栏展示整个会话的累计命中率，或最近单步命中率',
            cacheSession: '会话累计',
            cacheStep: '单步',
            secUpdate: '版本与更新',
            updTitle: '插件版本',
            updDescIdle: '从 GitHub 仓库检查新版本并直接更新，保留 user/ 个人配置',
            updDescChecking: '正在连接 GitHub 检查最新版本与文件清单…',
            updDescUpToDate: '当前已与远端最新版本保持一致',
            updDescAhead: '当前本地版本高于远端发布版本',
            updDescAvailable: '发现新版本，点击直接更新并热重载生效，无需重启 Antigravity',
            updDescMainDiff: '远端 main 分支有文件差异（含热修复或本地未推送改动），可一键同步最新 main',
            updDescUpdating: '正在下载并校验更新文件，同时备份旧版本，请稍候…',
            updDescApplied: '已更新完成，后台服务正在重启并热重载到当前窗口…',
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
          manualRefreshLabel: 'Reload theme & config',
          savedBadge: 'Synced',
          refreshedBadge: 'Refreshed',
          githubLabel: 'GitHub',
          feedbackLabel: 'Issues',
          subtitlePrefix: 'Manage theme colors, localization, live telemetry, and opt-in modules. Changes sync directly to ',
          subtitleSuffix: '.',
          secCore: 'Core Modules',
          modTheme: 'Codex Light & Dark Theme',
          modThemeDesc: 'Pure white light and charcoal dark palettes that follow IDE appearance automatically',
          modI18n: 'Chinese UI Localization',
          modI18nDesc: '2,300+ curated UI entries applied in place; disable to restore English immediately',
          localeLbl: 'Display Language',
          localeDesc: 'Switch interface locale live without restarting',
          locZhCn: '简体中文',
          locZhSg: '简中·英术',
          locZhTw: '繁體中文',
          locEn: 'English',
          syncAiLangLbl: 'Sync AI Thinking & Reply Language',
          syncAiLangDesc: 'Manages a global rule file so agent thinking and replies follow your active UI locale (off by default)',
          secPromptHooks: 'System Prompt & Lifecycle Hooks',
          secPromptHooksHint: 'Manages GEMINI.md, rules & hooks.json safely',
          modCustomPrompt: 'System-Level Custom Prompt',
          modCustomPromptDesc: 'Applies across all workspaces via global system instruction files and system-role hooks (zero binary patching)',
          promptModeLbl: 'System Injection Channel',
          promptModeDesc: 'System Dual recommended: syncs global ~/.gemini/GEMINI.md plus a SessionStart systemMessage',
          promptModeDual: 'System Dual',
          promptModeGemini: 'Global GEMINI.md',
          promptModeRule: 'Global Rule',
          promptModePreInv: 'PreInvocation',
          promptEveryInvLbl: 'Re-assert before every model invocation',
          promptEveryInvDesc: 'Off injects once per turn (cache-friendly); On re-injects as systemMessage on every call to prevent drift',
          promptTargetPrefix: 'Active system target: ',
          promptTargetDual: '~/.gemini/GEMINI.md (managed block) + ~/.gemini/config/hooks.json (SessionStart · systemMessage)',
          promptTargetGemini: '~/.gemini/GEMINI.md (managed block, App/CLI/IDE universal)',
          promptTargetRule: '~/.gemini/config/rules/98_antigravity_theme_system_prompt.md (trigger: always_on)',
          promptTargetSession: '~/.gemini/config/hooks.json (SessionStart · systemMessage)',
          promptTargetPreInv: '~/.gemini/config/hooks.json (PreInvocation · systemMessage)',
          promptPresetLbl: 'System Presets:',
          presetSystemRole: 'System Architect',
          presetAntiHalluc: 'Anti-Hallucination',
          presetConcise: 'Concise Engineer',
          presetContract: 'Contract Mode',
          promptPlaceholder: 'Enter system-level persona, engineering standards, or operator contract (up to 20,000 chars)…',
          promptClearBtn: 'Clear',
          promptSaveBtn: 'Save System Prompt',
          promptUnsaved: 'Unsaved changes',
          promptSavedTip: 'Ctrl/Cmd + Enter to save',
          modAutoAllow: 'Tool Auto-Allow Hook (PreToolUse)',
          modAutoAllowDesc: 'Automatically approves matching tools via ~/.gemini/config/hooks.json',
          autoAllowModeLbl: 'Approval Scope',
          autoAllowModeDesc: 'Safe Commands guards against destructive shell commands and escalates them to manual ask',
          autoAllowFiles: 'Files Only',
          autoAllowSafeCmd: 'Safe Commands',
          autoAllowAll: 'Allow All',
          autoAllowAllWarn: 'Warning: Allow All skips confirmation for every run_command call, including destructive commands.',
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
          modMetrics: 'Live Session Status & Telemetry',
          modMetricsDesc: 'Bottom 4-state status indicator, expandable L1/L2 panels, and per-turn footer stats',
          secOptional: 'Optional Enhancements',
          secOptionalHint: 'Off by default, opt-in',
          modSuggest: 'Prompt Suggestions',
          modSuggestDescPre: 'Predicts the next prompt after each turn; press ',
          modSuggestDescMid: ' or ',
          modSuggestDescPost: ' to accept (runs a background ',
          modSuggestDescEnd: ' worker when enabled)',
          agyIdle: 'Stopped',
          agyWarming: 'Warming up…',
          agyReady: 'agy Ready',
          agyMissing: 'agy not found',
          suggestModelLbl: 'Suggestion Model',
          suggestModelDescPre: 'Grouped automatically from ',
          suggestModelDescPost: '; Gemini 3.8 Flash Low recommended',
          refreshModelsTitle: 'Refresh agy models',
          menuModelsHdr: 'Models',
          recommendedBadge: 'Rec',
          modSsh: 'SSH Remote Read-Only Telemetry',
          modSshDesc: 'Extracts sanitized numeric metadata via remote read-only Python with zero local .db copy',
          sshHostsLbl: 'Allowed SSH Hosts (sshHosts)',
          addHostBtn: '+ Add host',
          addHostPlaceholder: 'e.g. node032',
          addHostOk: 'Add',
          secTelemetry: 'Status Bar Preferences',
          layoutLbl: 'Status Bar Density',
          layoutDesc: 'Compact sits centered inline; Detailed expands to a centered bottom row with TTFT and step output',
          layoutCompact: 'Compact',
          layoutDetailed: 'Detailed',
          cacheLbl: 'Cache Hit Rate Scope',
          cacheDesc: 'Display cumulative session cache hit rate or last-step hit rate',
          cacheSession: 'Session',
          cacheStep: 'Step',
          secUpdate: 'Updates',
          updTitle: 'Plugin Version',
          updDescIdle: 'Check GitHub for updates and apply directly; user/ config is preserved',
          updDescChecking: 'Checking GitHub for the latest release and manifest…',
          updDescUpToDate: 'You are running the latest version',
          updDescAhead: 'Local build is ahead of remote release',
          updDescAvailable: 'A newer release is available; updates apply live without restarting Antigravity',
          updDescMainDiff: 'Remote main branch differs (hotfix or local changes); click Sync main to pull latest',
          updDescUpdating: 'Downloading and verifying update files while backing up previous version…',
          updDescApplied: 'Update applied; restarting background daemon to hot-reload this window…',
          updPillChecking: 'Checking…',
          updPillLatest: 'Up to date',
          updPillAhead: 'Local ahead',
          updPillAvailablePrefix: 'New ',
          updPillMainDiff: 'main differs',
          updPillUpdating: 'Updating…',
          updPillApplied: 'Updated',
          updPillErr: 'Failed',
          updBtnCheck: 'Check for Updates',
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
                  mode: res.config.customSystemPrompt.mode || 'system-dual',
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
          uiState.config = {
            i18nLocale: res.config.i18nLocale || uiState.config.i18nLocale || 'zh-CN',
            syncAiOutputLang:
              typeof res.config.syncAiOutputLang === 'boolean'
                ? res.config.syncAiOutputLang
                : Boolean(uiState.config.syncAiOutputLang),
            customSystemPrompt: nextSp,
            hookAutoAllow: nextAa,
            telemetryLayout: res.config.telemetryLayout || uiState.config.telemetryLayout,
            telemetryCacheMode: res.config.telemetryCacheMode || uiState.config.telemetryCacheMode,
            promptSuggestionModel: res.config.promptSuggestionModel || uiState.config.promptSuggestionModel,
            sshHosts: Array.isArray(res.config.sshHosts) ? res.config.sshHosts.slice() : uiState.config.sshHosts,
            modules: Object.assign({}, uiState.config.modules, res.config.modules || {})
          };
          if (promptDraft === null) {
            setPromptDraft(nextSp.text);
          }
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
            setPromptDraft(patch.customSystemPrompt.text);
          }
        }
        if (patch.hookAutoAllow && typeof patch.hookAutoAllow === 'object') {
          uiState.config.hookAutoAllow = Object.assign({}, uiState.config.hookAutoAllow, patch.hookAutoAllow);
        }
        if (patch.telemetryLayout) uiState.config.telemetryLayout = patch.telemetryLayout;
        if (patch.telemetryCacheMode) uiState.config.telemetryCacheMode = patch.telemetryCacheMode;
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

      function updateRefreshSpin() {
        const icon = document.getElementById('ag-s-refresh-icon');
        if (icon) icon.classList.toggle('ag-s-spin', Boolean(refreshingModels));
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
        const trigger = document.getElementById('ag-s-model-trigger');
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
        if (trigger) {
          trigger.setAttribute('aria-expanded', 'false');
          if (restoreFocus) {
            try {
              trigger.focus({ focusVisible: !fromPointer });
            } catch {
              try { trigger.focus(); } catch {}
            }
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
          const curId = uiState.config.promptSuggestionModel;
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
        const selInfo = findSelectedModelInfo(uiState.config.promptSuggestionModel);
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
              (fam.recommended ? '<span class="ag-s-menu-badge">' + escHtml(s.recommendedBadge) + '</span>' : '') +
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
          const trigger = document.getElementById('ag-s-model-trigger');
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
            hideModelMenus({ restoreFocus: true, fromPointer: ev.detail !== 0 });
            commitPatch({ promptSuggestionModel: fam.singleId });
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
          hideModelMenus({ restoreFocus: true, fromPointer: ev.detail !== 0 });
          commitPatch({ promptSuggestionModel: id });
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
        if (isPopoverOpen(root)) {
          hideModelMenus({ restoreFocus: fromKeyboard, fromPointer: !fromKeyboard });
          return;
        }
        const selInfo = findSelectedModelInfo(uiState.config.promptSuggestionModel);
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
        const psOn = Boolean(mods.promptSuggestions);
        const sshOn = Boolean(mods.sshRemote);
        const sp = cfg.customSystemPrompt || { enabled: false, mode: 'system-dual', text: '', everyInvocation: false };
        const aa = cfg.hookAutoAllow || { enabled: false, mode: 'files' };
        const draftVal = promptDraft !== null ? promptDraft : sp.text || '';
        const isDirty = draftVal !== (sp.text || '');
        const promptTargetText =
          sp.mode === 'global-gemini'
            ? s.promptTargetGemini
            : sp.mode === 'rule'
            ? s.promptTargetRule
            : sp.mode === 'session-start'
            ? s.promptTargetSession
            : sp.mode === 'pre-invocation'
            ? s.promptTargetPreInv
            : s.promptTargetDual;
        const selInfo = findSelectedModelInfo(cfg.promptSuggestionModel);
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
          pane.querySelector('#ag-s-update-card')
        ) {
          const syncSwitch = (id, checked) => {
            const el = document.getElementById(id);
            if (el && Boolean(el.checked) !== Boolean(checked)) {
              el.checked = Boolean(checked);
            }
          };
          syncSwitch('ag-s-sw-theme', mods.theme !== false);
          syncSwitch('ag-s-sw-i18n', mods.i18n !== false);
          syncSwitch('ag-s-sw-ai-lang', Boolean(cfg.syncAiOutputLang));
          syncSwitch('ag-s-sw-metrics', mods.metrics !== false);
          syncSwitch('ag-s-sw-suggest', psOn);
          syncSwitch('ag-s-sw-ssh', sshOn);
          syncSwitch('ag-s-sw-custom-prompt', Boolean(sp.enabled));
          syncSwitch('ag-s-sw-prompt-every-inv', Boolean(sp.everyInvocation));
          syncSwitch('ag-s-sw-auto-allow', Boolean(aa.enabled));

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
            const curObj = parts.length === 2 ? cfg[parts[0]] || {} : {};
            const nextStr = curObj[parts[1]] === val ? 'true' : 'false';
            if (btn.getAttribute('aria-pressed') !== nextStr) btn.setAttribute('aria-pressed', nextStr);
          });

          const setHidden = (id, hide) => {
            const el = document.getElementById(id);
            if (el && Boolean(el.hidden) !== Boolean(hide)) el.hidden = Boolean(hide);
          };
          setHidden('ag-s-sub-ai-lang', !(mods.i18n !== false && activeLoc !== 'en'));
          setHidden('ag-s-sub-suggest', !psOn);
          setHidden('ag-s-sub-ssh', !sshOn);
          setHidden('ag-s-sub-custom-prompt', !sp.enabled);
          setHidden('ag-s-prompt-every-inv-row', sp.mode !== 'pre-invocation');
          setHidden('ag-s-sub-auto-allow', !aa.enabled);
          setHidden('ag-s-warn-auto-allow-all', aa.mode !== 'all');

          const targetPathEl = document.getElementById('ag-s-prompt-target-path');
          if (targetPathEl && targetPathEl.textContent !== promptTargetText) {
            targetPathEl.textContent = promptTargetText;
          }

          const workerPill = document.getElementById('ag-s-worker-pill');
          if (workerPill && workerPill.getAttribute('data-status') !== workerStatus) {
            workerPill.setAttribute('data-status', workerStatus);
          }
          const workerLblEl = document.getElementById('ag-s-worker-label');
          if (workerLblEl && workerLblEl.textContent !== workerLabel) {
            workerLblEl.textContent = workerLabel;
          }

          const modelNameEl = document.getElementById('ag-s-model-name');
          if (modelNameEl && modelNameEl.textContent !== selInfo.family.name) {
            modelNameEl.textContent = selInfo.family.name;
          }
          const modelEffEl = document.getElementById('ag-s-model-effort');
          if (modelEffEl) {
            const effText = selInfo.effortLabel || '';
            if (modelEffEl.textContent !== effText) modelEffEl.textContent = effText;
            modelEffEl.hidden = !effText;
          }

          const ta = document.getElementById('ag-s-prompt-textarea');
          if (ta && document.activeElement !== ta && ta.value !== draftVal) {
            ta.value = draftVal;
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
          '<p class="ag-s-subtitle">' +
          escHtml(s.subtitlePrefix) +
          '<span class="ag-s-mono">user/config.json</span>' +
          escHtml(s.subtitleSuffix) +
          '</p>' +
          '</div>' +
          '<div class="ag-s-sections">' +
          // Group 1: Core Modules
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
          '</div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-i18n">' +
          escHtml(s.modI18n) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modI18nDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-i18n" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="i18n" aria-label="' +
          escHtml(s.modI18n) +
          '" ' +
          (mods.i18n !== false ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div class="ag-s-subrow">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.localeLbl) +
          '</div><div class="ag-s-sub-desc">' +
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
          (mods.i18n !== false && activeLoc !== 'en' ? '' : ' hidden') +
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
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><label class="ag-s-row-label" for="ag-s-sw-metrics">' +
          escHtml(s.modMetrics) +
          '</label><div class="ag-s-row-desc">' +
          escHtml(s.modMetricsDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-metrics" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-mod="metrics" aria-label="' +
          escHtml(s.modMetrics) +
          '" ' +
          (mods.metrics !== false ? 'checked' : '') +
          ' />' +
          '</div></div>' +
          '</div>' +
          '</div>' +
          // Group 2: Optional Enhancements
          '<div>' +
          '<div class="ag-s-section-head">' +
          '<span class="ag-s-section-title">' +
          escHtml(s.secOptional) +
          '</span>' +
          '<span class="ag-s-section-hint">' +
          escHtml(s.secOptionalHint) +
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
          '<button type="button" id="ag-s-model-trigger" class="ag-s-pill-trigger" aria-haspopup="menu" aria-expanded="false">' +
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
          '<button type="button" id="ag-s-refresh-models" class="ag-s-icon-btn" aria-label="' +
          escHtml(s.refreshModelsTitle) +
          '">' +
          '<svg id="ag-s-refresh-icon" class="' +
          (refreshingModels ? 'ag-s-spin' : '') +
          '" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.67M13.5 2.5v2.8h-2.8"/></svg>' +
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
          // Group 2b: Custom System Prompt & Lifecycle Hooks
          '<div>' +
          '<div class="ag-s-section-head">' +
          '<span class="ag-s-section-title">' +
          escHtml(s.secPromptHooks) +
          '</span>' +
          '<span class="ag-s-section-hint">' +
          escHtml(s.secPromptHooksHint) +
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
          '<div class="ag-s-sub-head">' +
          '<div class="ag-s-row-info"><div class="ag-s-sub-label">' +
          escHtml(s.promptModeLbl) +
          '</div><div class="ag-s-sub-desc">' +
          escHtml(s.promptModeDesc) +
          '</div></div>' +
          '<div class="ag-s-seg" role="group" aria-label="' +
          escHtml(s.promptModeLbl) +
          '">' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.mode" data-val="system-dual" aria-pressed="' +
          (sp.mode === 'system-dual' || !sp.mode ? 'true' : 'false') +
          '">' +
          escHtml(s.promptModeDual) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.mode" data-val="global-gemini" aria-pressed="' +
          (sp.mode === 'global-gemini' ? 'true' : 'false') +
          '">' +
          escHtml(s.promptModeGemini) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.mode" data-val="rule" aria-pressed="' +
          (sp.mode === 'rule' ? 'true' : 'false') +
          '">' +
          escHtml(s.promptModeRule) +
          '</button>' +
          '<button type="button" class="ag-s-seg-btn" data-nested-seg="customSystemPrompt.mode" data-val="pre-invocation" aria-pressed="' +
          (sp.mode === 'pre-invocation' ? 'true' : 'false') +
          '">' +
          escHtml(s.promptModePreInv) +
          '</button>' +
          '</div>' +
          '</div>' +
          '<div class="ag-s-target-bar">' +
          '<span>' +
          escHtml(s.promptTargetPrefix) +
          '</span>' +
          '<span id="ag-s-prompt-target-path" class="ag-s-target-path">' +
          escHtml(promptTargetText) +
          '</span>' +
          '</div>' +
          '<div id="ag-s-prompt-every-inv-row" class="ag-s-inline-toggle"' +
          (sp.mode === 'pre-invocation' ? '' : ' hidden') +
          '>' +
          '<div class="ag-s-row-info"><label class="ag-s-sub-label" for="ag-s-sw-prompt-every-inv" style="cursor:pointer">' +
          escHtml(s.promptEveryInvLbl) +
          '</label><div class="ag-s-sub-desc">' +
          escHtml(s.promptEveryInvDesc) +
          '</div></div>' +
          '<input id="ag-s-sw-prompt-every-inv" type="checkbox" switch role="switch" class="ag-s-switch" data-bind-nested="customSystemPrompt.everyInvocation" aria-label="' +
          escHtml(s.promptEveryInvLbl) +
          '" ' +
          (sp.everyInvocation ? 'checked' : '') +
          ' />' +
          '</div>' +
          '<div class="ag-s-preset-bar">' +
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
          '<textarea id="ag-s-prompt-textarea" class="ag-s-textarea" placeholder="' +
          escHtml(s.promptPlaceholder) +
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
          // Group 3: Telemetry Preferences
          '<div>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secTelemetry) +
          '</span></div>' +
          '<div class="ag-s-card">' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><div class="ag-s-row-label">' +
          escHtml(s.layoutLbl) +
          '</div><div class="ag-s-row-desc">' +
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
          '</div></div>' +
          '<div class="ag-s-row"><div class="ag-s-row-main">' +
          '<div class="ag-s-row-info"><div class="ag-s-row-label">' +
          escHtml(s.cacheLbl) +
          '</div><div class="ag-s-row-desc">' +
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
          '</div></div>' +
          '</div>' +
          '</div>' +
          // Group 4: Plugin Version & Updates
          '<div>' +
          '<div class="ag-s-section-head"><span class="ag-s-section-title">' +
          escHtml(s.secUpdate) +
          '</span></div>' +
          '<div id="ag-s-update-card" class="ag-s-card">' +
          updateCardHtml +
          '</div>' +
          '</div>' +
          '</div>';

        if (pane.setAttribute) pane.setAttribute('data-ag-rendered-locale', activeLoc);
        const chipsMounted = document.getElementById('ag-s-ssh-chips');
        if (chipsMounted) chipsMounted.__ag_html = chipsHtml;
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
          hideModelMenus({ restoreFocus: false });
          syncStatusPoller();
        }
      }

      function bindPaneEvents(pane) {
        listen(pane, 'change', (ev) => {
          const sw = ev.target && ev.target.closest ? ev.target.closest('input.ag-s-switch[data-bind-mod]') : null;
          if (sw) {
            const mod = sw.getAttribute('data-bind-mod');
            if (!mod) return;
            const checked = Boolean(sw.checked);
            if (mod === 'promptSuggestions' && !checked) {
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
          }
        });

        listen(pane, 'input', (ev) => {
          const ta = ev.target && ev.target.id === 'ag-s-prompt-textarea' ? ev.target : null;
          if (!ta) return;
          setPromptDraft(ta.value);
          const sp = uiState.config.customSystemPrompt || { text: '' };
          const dirty = promptDraft !== (sp.text || '');
          const s = getStrings();
          const metaEl = document.getElementById('ag-s-prompt-meta');
          if (metaEl) {
            metaEl.textContent = promptDraft.length + ' / 20000 · ' + (dirty ? s.promptUnsaved : s.promptSavedTip);
          }
          const saveBtn = document.getElementById('ag-s-prompt-save');
          if (saveBtn) saveBtn.disabled = !dirty;
        });

        listen(pane, 'click', (ev) => {
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

          const trigger = ev.target && ev.target.closest ? ev.target.closest('#ag-s-model-trigger') : null;
          if (trigger) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleModelMenu(trigger, ev.detail === 0);
            return;
          }

          const refBtn = ev.target && ev.target.closest ? ev.target.closest('#ag-s-refresh-models') : null;
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
            const val = nestedSeg.getAttribute('data-val');
            const parts = spec.split('.');
            if (parts.length === 2 && val) {
              const curObj = uiState.config[parts[0]] || {};
              if (curObj[parts[1]] !== val) {
                commitPatch({ [parts[0]]: { [parts[1]]: val } });
              }
            }
            return;
          }

          const presetBtn = ev.target && ev.target.closest ? ev.target.closest('[data-prompt-preset]') : null;
          if (presetBtn) {
            const pKey = presetBtn.getAttribute('data-prompt-preset');
            const s = getStrings();
            const tpl = s.presets && pKey ? s.presets[pKey] : '';
            if (tpl) {
              setPromptDraft(tpl);
              commitPatch({ customSystemPrompt: { text: tpl } });
            }
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-prompt-save')) {
            const ta = document.getElementById('ag-s-prompt-textarea');
            const nextText = ta ? ta.value : promptDraft || '';
            setPromptDraft(nextText);
            commitPatch({ customSystemPrompt: { text: nextText } });
            return;
          }

          if (ev.target && ev.target.closest && ev.target.closest('#ag-s-prompt-clear')) {
            setPromptDraft('');
            commitPatch({ customSystemPrompt: { text: '' } });
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
          if (ev.target && ev.target.id === 'ag-s-prompt-textarea' && (ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            const nextText = ev.target.value;
            setPromptDraft(nextText);
            commitPatch({ customSystemPrompt: { text: nextText } });
            return;
          }
          const trigger = ev.target && ev.target.closest ? ev.target.closest('#ag-s-model-trigger') : null;
          if (trigger && ev.key === 'ArrowDown') {
            ev.preventDefault();
            ev.stopPropagation();
            const root = ensureModelPopovers();
            if (!isPopoverOpen(root)) {
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
        if (node.id === 'ag-settings-pane' || node.tagName === 'STYLE' || node.tagName === 'BUTTON') return true;
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
            !ev.target.closest('#ag-s-model-trigger')
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
        });
      }
    })();
  }
