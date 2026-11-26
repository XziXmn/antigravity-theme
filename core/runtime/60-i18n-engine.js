/**
 * Part 60: Multi-Variant Chinese DOM Localization Engine
 * Combines WeakMap-backed safe text/attribute replacement with:
 * - zh-CN (Modern Simplified Chinese), zh-SG (Simplified Chinese + English tech terms),
 *   zh-TW (Traditional Chinese), and en (instant native restoration)
 * - Fine-grained chat body & code isolation (adapted from antigravity-zh-launcher)
 * - Dynamic greetings, file-action verbs, quota/AI-credits banners, tooltips & aria labels
 */
  if (window.__ag_i18n_observer) {
    try {
      window.__ag_i18n_observer.disconnect();
    } catch (e) {}
    window.__ag_i18n_observer = null;
  }

  const ACTIVE_LOCALE = typeof I18N_LOCALE === 'string' && I18N_LOCALE ? I18N_LOCALE : 'zh-CN';
  const I18N_ACTIVE = Boolean(MODULES.i18n && ACTIVE_LOCALE !== 'en');

  const DICT = Object.assign(Object.create(null), I18N_ACTIVE ? boot.i18nDict || {} : {});
  const LOWER_DICT = Object.create(null);
  for (const k in DICT) {
    const v = DICT[k];
    if (typeof v !== 'string' || !v || v === k) continue;
    if (!/\s/.test(k)) continue;
    const low = k.toLowerCase();
    if (LOWER_DICT[low] === undefined) {
      LOWER_DICT[low] = v;
    }
  }
  window.__ag_i18n_dict = DICT;
  window.__ag_i18n_locale = ACTIVE_LOCALE;

  let scanBodyFn = null;
  const I18N_OBS_OPTS = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'placeholder', 'data-tooltip-content']
  };

  if (I18N_ACTIVE) {
    const IS_TW = ACTIVE_LOCALE === 'zh-TW';
    const IS_SG = ACTIVE_LOCALE === 'zh-SG';

    const L = IS_TW
      ? {
          unitSec: '秒',
          unitMin: '分鐘',
          unitHour: '小時',
          unitDay: '天',
          unitWeek: '週',
          unitMonth: '個月',
          unitYear: '年',
          lessThan1m: '不到 1 分鐘',
          ago: '前',
          pctLeft: ' 剩餘',
          limitSuffix: '限額',
          resetsAfter: '後重設',
          namedPeriod: { weekly: '每週', daily: '每日', monthly: '每月' },
          updatesCount: ' 則進度更新',
          filesChanged: ' 個檔案變更',
          toolsCount: ' 個工具',
          demotedCount: ' 項已降級',
          excludedCount: ' 項已排除',
          toolsExcluded: ' 個工具已排除',
          activeConvs: ' 個進行中的對話',
          projectsCount: ' 個專案',
          callsMb: ' 次通話 · ',
          seeAll: '檢視全部',
          showBreakdowns: '顯示明細',
          showMoreSubagents: (n) => '顯示另外 ' + n + ' 個子代理',
          searchGoogle: (q) => '使用 Google 搜尋「' + q + '」',
          permDelete: (target, cnt) => '永久刪除 ' + target + ' 及 ' + cnt + ' 個進行中的對話。',
          workedForUpdates: (dur, cnt) => '已執行 ' + dur + ' · ' + cnt + ' 則更新',
          workedFor: (dur) => '已執行 ' + dur,
          thoughtFor: (dur) => '已思考 ' + dur,
          thinkingFor: (dur) => '正在思考 ' + dur,
          runningFor: (dur) => '已執行 ' + dur,
          runningCmd: (cmd) => '正在執行 ' + cmd,
          zipping: (folder) => '正在壓縮 ' + folder + '…',
          deletedRec: (n, mb) => '已刪除 ' + n + ' 筆錄音 (' + mb + ')',
          deleteRecConfirm: (n, mb) => '這將從你的裝置中刪除 ' + n + ' 筆通話錄音（' + mb + '），此操作無法復原。',
          updatedAt: '更新於 ',
          yourPlan: '目前方案：',
          availCredits: '可用 AI 點數：',
          startedFrom: (q) => '發起自「' + q + '」',
          startedDuring: (q) => '發起於「' + q + '」期間',
          exitCode: '結束碼 ',
          thisModel: '此模型',
          quotaResetSwitch: (mod, dt) => (mod === '此模型' ? '此模型' : mod + ' ') + '的配額將於 ' + dt + ' 重設。請切換至其他可用模型繼續。',
          quotaReachedSwitch: (mod) => (mod === '此模型' ? '此模型' : mod + ' ') + '的配額已用盡。請切換至其他可用模型繼續。',
          quotaNeedCredits: (need, mod) =>
            '傳送訊息需要' + need + 'AI 點數。若要立即繼續使用' + (mod === '此模型' ? '此模型' : ' ' + mod) + '，請購買更多 AI 點數。',
          quotaAtLeast: (n) => '至少 ' + n + ' ',
          quotaMore: '更多 ',
          quotaBaselineRefresh: (dt) => '目前方案的基礎配額將於 ' + dt + ' 重新整理。',
          quotaEnableOverages: (mod) => '若要立即繼續使用' + (mod === '此模型' ? '此模型' : ' ' + mod) + '，請開啟 AI 點數超額抵扣。',
          quotaUpgradePlan: (higher, tier, highest) =>
            '你可以升級至' + (higher ? '更高的 ' : '') + 'Google AI ' + tier + ' 方案以獲得' + (highest ? '最高速率配額' : '更高的速率限制') + '。',
          usedLimit: (deg, type, timeStr) => '你已消耗' + deg + type + '額度，將於 ' + timeStr + ' 後完全重設。',
          notUsedLimit: (type) => '你尚未消耗任何' + type + '額度。',
          degreeMap: { some: '部分', all: '全部', most: '大部分' },
          limitTypeMap: { weekly: '每週', '5-hour': '5 小時', 'five-hour': '5 小時', daily: '每日' },
          ariaModelCur: '模型，目前：',
          ariaSelectModel: '選擇模型',
          ariaPermCur: '權限模式，目前：',
          ariaPermFixed: '權限模式：',
          ariaCantChangeMid: '對話進行中無法變更',
          ariaTurnOf: (a, b) => '第 ' + a + ' / ' + b + ' 輪對話',
          ariaTurnBy: (n, isUser) => '第 ' + n + ' 輪對話（' + (isUser ? '使用者' : '代理') + '）',
          ariaLoadOlderShow: (a, b) => '載入更早的訊息（目前顯示 ' + a + ' / ' + b + '）',
          ariaLoadOlderTurns: (n) => '載入更早的 ' + n + ' 輪對話',
          ariaBranchCur: '分支，目前：',
          ariaSelectBranch: '選擇分支',
          ariaProjCur: '選擇專案，目前：',
          ariaNoProject: '未關聯專案',
          ariaLocCur: '代理執行位置，目前：',
          ariaThisComputer: '本機',
          ariaRemote: '遠端',
          ariaVersion: '版本 ',
          ctxPlanDialog: '訂閱方案',
          ctxGlobalDefault: '全域預設',
          ctxPermDefault: '預設',
          ctxViewBtn: '檢視',
          ctxTypeVerb: '輸入',
          ctxSlashActions: '快捷指令 (/)',
          ctxMachineHost: '執行主機',
          ctxBlockedRestricted: '已受限',
          ctxWhenWorking: '，適用於',
          ctxInProject: '目前專案',
          ctxInWorkspace: '目前工作區',
          ephemeralClause: {
            explored: '已探索',
            'explored file': '已探索檔案',
            'explored files': '已探索檔案',
            'explored artifact': '已探索產物',
            'explored artifacts': '已探索產物',
            'explored file and artifact': '已探索檔案與產物',
            'explored files and artifact': '已探索檔案與產物',
            'explored file and artifacts': '已探索檔案與產物',
            'explored files and artifacts': '已探索檔案與產物',
            'ran command': '已執行指令',
            'ran commands': '已執行指令',
            edited: '已編輯',
            'edited file': '已編輯檔案',
            'edited files': '已編輯檔案',
            'edited artifact': '已編輯產物',
            'edited artifacts': '已編輯產物',
            'edited file and artifact': '已編輯檔案與產物',
            'edited files and artifact': '已編輯檔案與產物',
            'edited file and artifacts': '已編輯檔案與產物',
            'edited files and artifacts': '已編輯檔案與產物'
          },
          ephemeralCountVerb: { explored: '已探索', edited: '已編輯', ran: '已執行' },
          ephemeralCountNoun: {
            file: '個檔案',
            files: '個檔案',
            artifact: '個產物',
            artifacts: '個產物',
            command: '條指令',
            commands: '條指令'
          },
          ephemeralActiveVerb: { Editing: '正在編輯', Reading: '正在讀取', Listing: '正在列出', Searching: '正在搜尋' },
          ephemeralActiveNoun: {
            file: '檔案',
            files: '檔案',
            artifact: '產物',
            artifacts: '產物',
            'file and artifact': '檔案與產物',
            'files and artifact': '檔案與產物',
            'file and artifacts': '檔案與產物',
            'files and artifacts': '檔案與產物'
          },
          fileActionVerb: {
            analyzed: '已分析',
            analyzing: '正在分析',
            editing: '正在編輯',
            edited: '已編輯',
            creating: '正在建立',
            created: '已建立',
            updating: '正在更新',
            updated: '已更新',
            deleting: '正在刪除',
            deleted: '已刪除',
            reading: '正在讀取',
            writing: '正在寫入',
            wrote: '已寫入',
            listing: '正在列出',
            listed: '已列出',
            checking: '正在檢查',
            checked: '已檢查',
            viewing: '正在檢視',
            viewed: '已檢視',
            exploring: '正在探索',
            invoking: '正在呼叫',
            invoked: '已呼叫',
            starting: '正在啟動',
            started: '已啟動',
            running: '正在執行'
          },
          greetings: [
            (n) => '嗨 ' + n + '，今天要完成什麼工作？',
            (n) => '嗨 ' + n + '，今天要建置什麼？',
            () => '嗨，今天要建置什麼？',
            () => '歡迎回來，從哪裡繼續？',
            (n) => '歡迎回來，' + n + '。從哪裡繼續？',
            () => '很高興再次見到你，接下來要做什麼？',
            (n) => '很高興再次見到你，' + n + '。接下來要做什麼？'
          ],
          dynInstall: (x) => '安裝 ' + x,
          dynDetailsFor: (x) => x + ' 詳情',
          dynMoreActionsFor: (x) => x + ' 的更多操作',
          dynFixWithAgent: (x) => '使用代理修復：' + x,
          dynSeeMoreIn: (x) => '在 ' + x + ' 中查看更多',
          dynPluginsIn: (x) => x + ' 中的外掛',
          dynFilterSkills: (x) => '篩選技能與規則：' + x,
          dynSeeNMore: (n) => '檢視另外 ' + n + ' 項',
          dynSeeNMoreSkills: (n) => '檢視另外 ' + n + ' 項技能與規則'
        }
      : {
          unitSec: '秒',
          unitMin: '分钟',
          unitHour: '小时',
          unitDay: '天',
          unitWeek: '周',
          unitMonth: '个月',
          unitYear: '年',
          lessThan1m: '不到 1 分钟',
          ago: '前',
          pctLeft: ' 剩余',
          limitSuffix: '限额',
          resetsAfter: '后重置',
          namedPeriod: { weekly: '每周', daily: '每日', monthly: '每月' },
          updatesCount: ' 条进展',
          filesChanged: ' 个文件变更',
          toolsCount: ' 个工具',
          demotedCount: ' 项已降级',
          excludedCount: ' 项已排除',
          toolsExcluded: ' 个工具已排除',
          activeConvs: ' 个进行中的对话',
          projectsCount: ' 个项目',
          callsMb: ' 次通话 · ',
          seeAll: '查看全部',
          showBreakdowns: '展开明细',
          showMoreSubagents: (n) => '显示另外 ' + n + (IS_SG ? ' 个 Subagent' : ' 个子智能体'),
          searchGoogle: (q) => '使用 Google 搜索“' + q + '”',
          permDelete: (target, cnt) => '永久删除 ' + target + ' 及 ' + cnt + ' 个进行中的对话。',
          workedForUpdates: (dur, cnt) => '已工作 ' + dur + ' · ' + cnt + ' 条进展',
          workedFor: (dur) => '已工作 ' + dur,
          thoughtFor: (dur) => '已思考 ' + dur,
          thinkingFor: (dur) => '正在思考 ' + dur,
          runningFor: (dur) => '已运行 ' + dur,
          runningCmd: (cmd) => '正在运行 ' + cmd,
          zipping: (folder) => '正在打包 ' + folder + '…',
          deletedRec: (n, mb) => '已删除 ' + n + ' 条录音 (' + mb + ')',
          deleteRecConfirm: (n, mb) => '这将从你的设备中删除 ' + n + ' 条通话录音（' + mb + '），此操作无法撤销。',
          updatedAt: '更新于 ',
          yourPlan: '当前套餐：',
          availCredits: '可用 AI 积分：',
          startedFrom: (q) => '发起自「' + q + '」',
          startedDuring: (q) => '发起于「' + q + '」期间',
          exitCode: '退出码 ',
          thisModel: '该模型',
          quotaResetSwitch: (mod, dt) => (mod === '该模型' ? '该模型' : mod + ' ') + '的配额将于 ' + dt + ' 重置。请切换至其他可用模型继续。',
          quotaReachedSwitch: (mod) => (mod === '该模型' ? '该模型' : mod + ' ') + '的配额已用尽。请切换至其他可用模型继续。',
          quotaNeedCredits: (need, mod) =>
            '发送消息需要' + need + 'AI 积分。如需立即继续使用' + (mod === '该模型' ? '该模型' : ' ' + mod) + '，请购买更多 AI 积分。',
          quotaAtLeast: (n) => '至少 ' + n + ' ',
          quotaMore: '更多 ',
          quotaBaselineRefresh: (dt) => '当前套餐的基础配额将于 ' + dt + ' 刷新。',
          quotaEnableOverages: (mod) => '如需立即继续使用' + (mod === '该模型' ? '该模型' : ' ' + mod) + '，请开启 AI 积分超额抵扣。',
          quotaUpgradePlan: (higher, tier, highest) =>
            '你可以升级到' + (higher ? '更高的 ' : '') + 'Google AI ' + tier + ' 套餐以获得' + (highest ? '最高速率配额' : '更高的配额速率限制') + '。',
          usedLimit: (deg, type, timeStr) => '你已消耗' + deg + type + '额度，将在 ' + timeStr + ' 后完全重置。',
          notUsedLimit: (type) => '你尚未消耗任何' + type + '额度。',
          degreeMap: { some: '部分', all: '全部', most: '大部分' },
          limitTypeMap: { weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日' },
          ariaModelCur: '模型，当前：',
          ariaSelectModel: '选择模型',
          ariaPermCur: '权限模式，当前：',
          ariaPermFixed: '权限模式：',
          ariaCantChangeMid: '对话中途无法更改',
          ariaTurnOf: (a, b) => '第 ' + a + ' / ' + b + ' 轮对话',
          ariaTurnBy: (n, isUser) => '第 ' + n + ' 轮对话（' + (isUser ? '用户' : IS_SG ? 'Agent' : '智能体') + '）',
          ariaLoadOlderShow: (a, b) => '加载更早的消息（当前显示 ' + a + ' / ' + b + '）',
          ariaLoadOlderTurns: (n) => '加载更早的 ' + n + ' 轮对话',
          ariaBranchCur: '分支，当前：',
          ariaSelectBranch: '选择分支',
          ariaProjCur: '选择项目，当前：',
          ariaNoProject: '未关联项目',
          ariaLocCur: (IS_SG ? 'Agent' : '智能体') + '运行位置，当前：',
          ariaThisComputer: '本机',
          ariaRemote: '远程',
          ariaVersion: '版本 ',
          ctxPlanDialog: '订阅套餐',
          ctxGlobalDefault: '全局默认',
          ctxPermDefault: '默认',
          ctxViewBtn: '查看',
          ctxTypeVerb: '输入',
          ctxSlashActions: '快捷指令 (/)',
          ctxMachineHost: '运行主机',
          ctxBlockedRestricted: '已受限',
          ctxWhenWorking: '，适用于',
          ctxInProject: '当前项目',
          ctxInWorkspace: IS_SG ? '当前 Workspace' : '当前工作区',
          ephemeralClause: {
            explored: '已探索',
            'explored file': '已探索文件',
            'explored files': '已探索文件',
            'explored artifact': IS_SG ? '已探索 Artifact' : '已探索产物',
            'explored artifacts': IS_SG ? '已探索 Artifact' : '已探索产物',
            'explored file and artifact': IS_SG ? '已探索文件与 Artifact' : '已探索文件与产物',
            'explored files and artifact': IS_SG ? '已探索文件与 Artifact' : '已探索文件与产物',
            'explored file and artifacts': IS_SG ? '已探索文件与 Artifact' : '已探索文件与产物',
            'explored files and artifacts': IS_SG ? '已探索文件与 Artifact' : '已探索文件与产物',
            'ran command': '已运行命令',
            'ran commands': '已运行命令',
            edited: '已编辑',
            'edited file': '已编辑文件',
            'edited files': '已编辑文件',
            'edited artifact': IS_SG ? '已编辑 Artifact' : '已编辑产物',
            'edited artifacts': IS_SG ? '已编辑 Artifact' : '已编辑产物',
            'edited file and artifact': IS_SG ? '已编辑文件与 Artifact' : '已编辑文件与产物',
            'edited files and artifact': IS_SG ? '已编辑文件与 Artifact' : '已编辑文件与产物',
            'edited file and artifacts': IS_SG ? '已编辑文件与 Artifact' : '已编辑文件与产物',
            'edited files and artifacts': IS_SG ? '已编辑文件与 Artifact' : '已编辑文件与产物'
          },
          ephemeralCountVerb: { explored: '已探索', edited: '已编辑', ran: '已运行' },
          ephemeralCountNoun: {
            file: '个文件',
            files: '个文件',
            artifact: IS_SG ? '个 Artifact' : '个产物',
            artifacts: IS_SG ? '个 Artifact' : '个产物',
            command: '条命令',
            commands: '条命令'
          },
          ephemeralActiveVerb: { Editing: '正在编辑', Reading: '正在读取', Listing: '正在列出', Searching: '正在搜索' },
          ephemeralActiveNoun: {
            file: '文件',
            files: '文件',
            artifact: IS_SG ? 'Artifact' : '产物',
            artifacts: IS_SG ? 'Artifact' : '产物',
            'file and artifact': IS_SG ? '文件与 Artifact' : '文件与产物',
            'files and artifact': IS_SG ? '文件与 Artifact' : '文件与产物',
            'file and artifacts': IS_SG ? '文件与 Artifact' : '文件与产物',
            'files and artifacts': IS_SG ? '文件与 Artifact' : '文件与产物'
          },
          fileActionVerb: {
            analyzed: '已分析',
            analyzing: '正在分析',
            editing: '正在编辑',
            edited: '已编辑',
            creating: '正在创建',
            created: '已创建',
            updating: '正在更新',
            updated: '已更新',
            deleting: '正在删除',
            deleted: '已删除',
            reading: '正在读取',
            writing: '正在写入',
            wrote: '已写入',
            listing: '正在列出',
            listed: '已列出',
            checking: '正在检查',
            checked: '已检查',
            viewing: '正在查看',
            viewed: '已查看',
            exploring: '正在探索',
            invoking: '正在调用',
            invoked: '已调用',
            starting: '正在启动',
            started: '已启动',
            running: '正在运行'
          },
          greetings: [
            (n) => '嗨 ' + n + '，今天想完成什么？',
            (n) => '嗨 ' + n + '，今天要构建什么？',
            () => '嗨，今天要构建什么？',
            () => '欢迎回来，从哪里继续？',
            (n) => '欢迎回来，' + n + '。从哪里继续？',
            () => '很高兴再次见到你，接下来做什么？',
            (n) => '很高兴再次见到你，' + n + '。接下来做什么？'
          ],
          dynInstall: (x) => '安装 ' + x,
          dynDetailsFor: (x) => x + ' 详情',
          dynMoreActionsFor: (x) => x + ' 的更多操作',
          dynFixWithAgent: (x) => (IS_SG ? '使用 Agent 修复：' : '使用智能体修复：') + x,
          dynSeeMoreIn: (x) => '在 ' + x + ' 中查看更多',
          dynPluginsIn: (x) => x + (IS_SG ? ' 中的 Plugin' : ' 中的插件'),
          dynFilterSkills: (x) => (IS_SG ? '筛选 Skill 与规则：' : '筛选技能与规则：') + x,
          dynSeeNMore: (n) => '查看另外 ' + n + ' 项',
          dynSeeNMoreSkills: (n) => '查看另外 ' + n + (IS_SG ? ' 项 Skill 与规则' : ' 项技能与规则')
        };

    function splitTopLevelSelectors(selStr) {
      const parts = [];
      let cur = '';
      let bracketDepth = 0;
      let parenDepth = 0;
      let quote = '';
      const s = String(selStr || '');
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
          cur += ch;
          if (ch === quote && s[i - 1] !== '\\') quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          cur += ch;
        } else if (ch === '[') {
          bracketDepth++;
          cur += ch;
        } else if (ch === ']') {
          if (bracketDepth > 0) bracketDepth--;
          cur += ch;
        } else if (ch === '(') {
          parenDepth++;
          cur += ch;
        } else if (ch === ')') {
          if (parenDepth > 0) parenDepth--;
          cur += ch;
        } else if (ch === ',' && bracketDepth === 0 && parenDepth === 0) {
          if (cur.trim()) parts.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) parts.push(cur.trim());
      return parts;
    }

    const CONTAINER_IMMUTABLE_EXCLUDE_SELECTOR =
      'code, pre, kbd, samp, style, script, noscript, [data-markdown-root], [data-testid="user-message-content"], [data-testid="user-message-bubble"], .agy-user-bubble, .agy-user-bubble-frame, .monaco-editor, .monaco-diff-editor, .xterm, #ag-live-metrics-pill, .ag-live-metrics-pill, #ag-live-metrics-tooltip, #ag-turn-metrics-tooltip, .ag-turn-metrics';
    const TEXT_IMMUTABLE_EXCLUDE_SELECTOR = 'textarea, input, ' + CONTAINER_IMMUTABLE_EXCLUDE_SELECTOR;

    const mergedExcludeParts = splitTopLevelSelectors(DEFAULT_EXCLUDE_I18N);
    const userExcludeParts = splitTopLevelSelectors(SELECTORS.excludeI18n);
    for (let i = 0; i < userExcludeParts.length; i++) {
      if (!mergedExcludeParts.includes(userExcludeParts[i])) {
        mergedExcludeParts.push(userExcludeParts[i]);
      }
    }
    const EXCLUDE_SELECTOR = mergedExcludeParts.join(', ');
    const FORM_ATTR_EXCLUDE_SELECTOR = mergedExcludeParts
      .filter((tok) => {
        const low = tok.toLowerCase();
        return low !== 'input' && low !== 'textarea';
      })
      .join(', ');

    const immutableTextExclCache = new WeakMap();
    const immutableContainerExclCache = new WeakMap();

    const KEEP_UNTRANSLATED_EXACT = new Set([
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Extra',
      'Extra High',
      'XHigh',
      'Max',
      'Orchestrator',
      'Orchestrator (Carbon)',
      'Orchestrator (Argon)',
      'Orchestrator (Neon)'
    ]);

    const RE_HAS_CJK = /[\u4e00-\u9fa5]/;
    const RE_PURE_ALPHA = /^\s*[a-zA-Z]+\s*$/;
    const RE_HAS_ALPHA = /[a-zA-Z]/;
    const RE_REL_TIME = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mo|y|yr|yrs)\s+ago$/i;
    const REL_UNIT_MAP = {
      s: L.unitSec,
      sec: L.unitSec,
      secs: L.unitSec,
      m: L.unitMin,
      min: L.unitMin,
      mins: L.unitMin,
      h: L.unitHour,
      hr: L.unitHour,
      hrs: L.unitHour,
      d: L.unitDay,
      w: L.unitWeek,
      mo: L.unitMonth,
      y: L.unitYear,
      yr: L.unitYear,
      yrs: L.unitYear
    };
    const UNIT_MAP_SHORT = {
      s: L.unitSec,
      m: L.unitMin,
      h: L.unitHour,
      d: L.unitDay,
      w: L.unitWeek,
      mo: L.unitMonth,
      y: L.unitYear,
      yr: L.unitYear
    };
    const MONTH_SHORT_MAP = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12
    };
    // 客户端 main.js 在 onBlur 中硬编码判断 relatedTarget.getAttribute("aria-label") === "Cancel"
    const SKIP_ARIA_LABEL_VALUES = new Set(['Cancel']);

    const GREETING_PATTERNS = [
      /^Hi ([\s\S]+?), what can we get done today\?$/,
      /^Hey (?!there,)([\s\S]+?), what should we build today\?$/,
      /^Hey there, what should we build today\?$/,
      /^Welcome back\. Where should we pick up\?$/,
      /^Welcome back, ([\s\S]+?)\. Where should we pick up\?$/,
      /^Good to see you\. What's next\?$/,
      /^Good to see you, ([\s\S]+?)\. What's next\?$/
    ];

    const RE_PCT_LEFT = /^(\d+(?:\.\d+)?)%\s*left$/i;
    const RE_WINDOW_LIMIT_COMBINED = /^(\d+)\s*([smhd])\s+limit,\s*resets in\s+(.+)$/i;
    const RE_WINDOW_LIMIT = /^(\d+)\s*([smhd])\s+limit$/i;
    const RE_NAMED_LIMIT_RESETS = /^(Weekly|Daily|Monthly)\s+limit,\s*resets in\s+(.+)$/i;
    const RE_MODEL_NAMED_LIMIT = /^(.+?)\s+(Weekly|Daily|Monthly)\s+limit$/i;
    const RE_RESETS_IN = /^Resets in\s+(.+)$/i;
    const RE_SEARCH_GOOGLE = /^Search Google for "(.+)"$/;
    const RE_UPDATED_AT =
      /^Updated\s+(?:((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{1,2}月\d{1,2}日),\s*)?((?:上午|下午)?\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)$/;

    const RE_FILES_CHANGED = /^(\d+)\s+files?\s+changed$/i;
    const RE_TOOLS = /^(\d+)\s+tools?$/i;
    const RE_DEMOTED = /^(\d+)\s+demoted$/i;
    const RE_EXCLUDED = /^(\d+)\s+excluded$/i;
    const RE_TOOLS_EXCLUDED = /^(\d+)\s+tools?\s+excluded$/i;
    const RE_ACTIVE_CONVS = /^(\d+)\s+active\s+conversations$/i;
    const RE_UPDATES_COUNT = /^(\d+)\s+updates?$/i;
    const RE_PROJECTS_COUNT = /^(\d+)\s+projects?$/i;
    const RE_CALLS_MB = /^(\d+)\s+calls?\s*·\s*([\d.]+\s*MB)$/i;
    const RE_SEE_ALL = /^See all\s*\((\d+)\)$/i;
    const RE_SEE_N_MORE = /^See\s+(\d+)\s+more$/i;
    const RE_SEE_N_MORE_SKILLS = /^See\s+(\d+)\s+more\s+skills\s+and\s+rules$/i;
    const RE_SHOW_BREAKDOWNS = /^Show\s+(\d+)\s+breakdowns?$/i;
    const RE_SHOW_MORE_SUBAGENTS = /^Show\s+(\d+)\s+more\s+subagents?$/i;
    const RE_ZIPPING_FOLDER = /^Zipping\s+(.+?)(?:…|\.\.\.)$/i;
    const RE_PERM_DELETE = /^Permanently delete\s+(.*)\s+including\s+(\d+)\s+active\s+conversations\.?$/i;
    const RE_WORKED_FOR_UPDATES = /^Worked for\s+([<0-9smhd\s]+?)\s*·\s*(\d+)\s+updates?$/i;
    const RE_WORKED_FOR = /^Worked for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_THOUGHT_FOR = /^Thought for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_THINKING_FOR = /^Thinking for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_RUNNING_FOR = /^Running\s+for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_EPHEMERAL_SUMMARY =
      /^(Explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|Ran\s+(?:\d+\s+)?commands?|Edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?)(?:,\s*(explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|ran\s+(?:\d+\s+)?commands?|edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?))*$/i;
    const RE_EPHEMERAL_COUNT_CLAUSE = /^(explored|edited|ran)\s+(\d+)\s+(files?|artifacts?|commands?)$/i;
    const RE_EPHEMERAL_ACTIVE = /^(Editing|Reading|Listing|Searching)\s+(.+)$/;
    const RE_FILE_ACTION =
      /^(Analyzed|Analyzing|Editing|Edited|Creating|Created|Updating|Updated|Deleting|Deleted|Reading|Writing|Wrote|Listing|Listed|Checking|Checked|Viewing|Viewed|Exploring|Invoking|Invoked|Starting|Started|Running)\s+(Task Logs?|[^\r\n]+?\.[a-z0-9]{1,8}(?:\s+#L\d+(?:-\d+)?)?)$/i;
    const RE_RUNNING_CMD = /^Running\s+(?!commands?\b|processes\b|for\b|\(Dev\b)(.+)$/;
    const RE_DELETED_RECORDINGS = /^Deleted\s+(\d+)\s+recordings?\s*\(([\d.]+\s*MB)\)$/i;
    const RE_DELETE_RECORDINGS_CONFIRM =
      /^This deletes\s+(\d+)\s+call recordings?\s*\(([\d.]+\s*MB)\)\s+from your machine\.\s*You can't undo this\.$/i;
    const RE_USED_LIMIT = /^You have used (some|all|most) of your (weekly|5-hour|five-hour|daily) limit,?\s*it will fully refresh in (.*)\.?$/i;
    const RE_NOT_USED_LIMIT = /^You have not used any of your (weekly|5-hour|five-hour|daily) limit\.?$/i;
    const RE_QUOTA_RESET_SWITCH =
      /^Your quota for (.+?) will reset on (.+?)\.\s*Switch to another available model to continue\.?$/i;
    const RE_QUOTA_REACHED_SWITCH =
      /^Your quota for (.+?) has been reached\.\s*Switch to another available model to continue\.?$/i;
    const RE_QUOTA_NEED_CREDITS =
      /^You need (?:at least (\d+)|more) AI Credits to send messages\.\s*To continue using (.+?) now, purchase more AI Credits\.?\s*/i;
    const RE_QUOTA_BASELINE_REFRESH =
      /^Your plan['’]s baseline quota will refresh on (.+?)\.(?=\s|$)\s*/i;
    const RE_QUOTA_ENABLE_OVERAGES =
      /^To continue using (.+?) now, enable AI Credit overages\.(?=\s|$)\s*/i;
    const RE_QUOTA_UPGRADE_PLAN =
      /^You can upgrade to a (higher )?Google AI (Ultra|Pro) plan to receive (higher|the highest) rate limits\.?$/i;

    const RE_INSTALL_X = /^Install\s+([^\r\n]{1,80})$/;
    const RE_DETAILS_FOR_X = /^Details for\s+([^\r\n]{1,80})$/;
    const RE_MORE_ACTIONS_FOR_X = /^More actions for\s+([^\r\n]{1,80})$/;
    const RE_FIX_WITH_AGENT_X = /^Fix with Agent:\s*(.+)$/i;
    const RE_SEE_MORE_IN_X = /^See more in\s+([^\r\n]{1,80})$/;
    const RE_PLUGINS_IN_X = /^Plugins in\s+([^\r\n]{1,80})$/;
    const RE_FILTER_SKILLS_X = /^Filter skills and rules:\s*(.+)$/i;

    const RE_ARIA_BRANCH = /^Branch, current:\s*(.*)$/i;
    const RE_ARIA_PROJECT = /^Select project(?:, current)?:\s*(.*)$/i;
    const RE_ARIA_LOCATION = /^(?:Where the agent runs, current|Select location(?:, current)?):\s*(.*)$/i;
    const RE_ARIA_VERSION = /^Version\s+([\d.]+(?:\s*·\s*\S+)?)$/i;
    const RE_ARIA_MODEL = /^(?:Select model|Model(?:\s+selector)?)(?:,\s*current)?:\s*(.*)$/i;
    const RE_ARIA_PERM_SEL =
      /^(?:(?:Permission mode|Agent permissions preset)\s+selector(?:,\s*current)?|(?:Permission mode|Agent permissions preset),\s*current):\s*(.*)$/i;
    const RE_ARIA_PERM_FIXED = /^(?:Permission mode|Agent permissions preset):\s*([^,(]+?)(?:\s*(?:,\s*(.+?)|\(([^)]+)\)))?$/i;
    const RE_ARIA_TURN = /^(?:Conversation turn\s+(\d+)\s+by\s+(User|Agent|Assistant)|Turn\s+(\d+)\s+of\s+(\d+))$/i;
    const RE_ARIA_LOAD_OLDER = /^(?:Load\s+(\d+)\s+older\s+turns?.*|Load older messages,\s*showing\s+(\d+)\s+of\s+(\d+))$/i;
    const RE_YOUR_PLAN = /^Your Plan:\s*([^\r\n]{1,80})$/i;
    const RE_AVAILABLE_AI_CREDITS = /^Available AI Credits:\s*([^\r\n]{1,40})$/i;
    const RE_EXITED_CODE_ONLY = /^Exited with code\s+(-?\d+)(\.)?$/i;
    const RE_SUMMARY_EXITED_CODE = /^([^\r\n]{1,220}?)\s*·\s*Exited with code\s+(-?\d+)$/;
    const RE_STARTED_SIDE_QUOTE = /^Started\s+(from|during)\s+[“"](.+)[”"]$/;

    function translateEphemeralClause(clause) {
      const low = clause.trim().toLowerCase();
      if (L.ephemeralClause[low]) return L.ephemeralClause[low];
      const mCount = low.match(RE_EPHEMERAL_COUNT_CLAUSE);
      if (mCount) {
        return L.ephemeralCountVerb[mCount[1]] + ' ' + mCount[2] + ' ' + L.ephemeralCountNoun[mCount[3]];
      }
      return clause.trim();
    }

    function formatQuotaModelZh(rawModel) {
      const m = String(rawModel || '').trim();
      return !m || /^this model$/i.test(m) ? L.thisModel : m;
    }

    function translateQuotaExhaustedZh(trimmed) {
      if (!trimmed || (!trimmed.includes('quota') && !trimmed.includes('AI Credit'))) return null;
      const mReset = trimmed.match(RE_QUOTA_RESET_SWITCH);
      if (mReset) {
        return L.quotaResetSwitch(formatQuotaModelZh(mReset[1]), mReset[2].trim());
      }
      const mReached = trimmed.match(RE_QUOTA_REACHED_SWITCH);
      if (mReached) {
        return L.quotaReachedSwitch(formatQuotaModelZh(mReached[1]));
      }

      let rest = trimmed;
      const parts = [];

      const mCredits = rest.match(RE_QUOTA_NEED_CREDITS);
      if (mCredits) {
        const needPart = mCredits[1] ? L.quotaAtLeast(mCredits[1]) : L.quotaMore;
        parts.push(L.quotaNeedCredits(needPart, formatQuotaModelZh(mCredits[2])));
        rest = rest.slice(mCredits[0].length);
      }

      const mRefresh = rest.match(RE_QUOTA_BASELINE_REFRESH);
      if (mRefresh) {
        parts.push(L.quotaBaselineRefresh(mRefresh[1].trim()));
        rest = rest.slice(mRefresh[0].length);
      }

      const mOver = rest.match(RE_QUOTA_ENABLE_OVERAGES);
      if (mOver) {
        parts.push(L.quotaEnableOverages(formatQuotaModelZh(mOver[1])));
        rest = rest.slice(mOver[0].length);
      }

      if (parts.length === 0) return null;

      rest = rest.trim();
      if (rest) {
        const exactRest = lookupRawDict(rest) ?? (rest.endsWith('.') ? lookupRawDict(rest.slice(0, -1)) : undefined);
        if (typeof exactRest === 'string') {
          parts.push(exactRest.endsWith('。') ? exactRest : exactRest + '。');
        } else {
          const mUp = rest.match(RE_QUOTA_UPGRADE_PLAN);
          if (mUp) {
            parts.push(L.quotaUpgradePlan(Boolean(mUp[1]), mUp[2], mUp[3].toLowerCase() === 'the highest'));
          } else {
            parts.push(rest);
          }
        }
      }
      return parts.join('');
    }

    function formatCompactDurationZh(str) {
      const s = String(str || '').trim();
      if (s === '<1m' || s === '< 1m') return L.lessThan1m;
      return s
        .replace(/(\d+)\s*d\b/gi, '$1 ' + L.unitDay)
        .replace(/(\d+)\s*h\b/gi, '$1 ' + L.unitHour)
        .replace(/(\d+)\s*m\b/gi, '$1 ' + L.unitMin)
        .replace(/(\d+)\s*s\b/gi, '$1 ' + L.unitSec)
        .replace(/\s+/g, ' ')
        .trim();
    }

    function formatUpdatedAtZh(datePart, timePart) {
      if (!datePart) return L.updatedAt + timePart.trim();
      const mEnDate = datePart.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
      if (mEnDate) {
        const mNum = MONTH_SHORT_MAP[mEnDate[1].toLowerCase()];
        if (mNum) {
          return L.updatedAt + mNum + '月' + mEnDate[2] + '日 ' + timePart.trim();
        }
      }
      return L.updatedAt + datePart.trim() + ' ' + timePart.trim();
    }

    function isChatBodyExcluded(el) {
      if (!el || typeof el.closest !== 'function') return false;
      const userStep = el.closest('[data-testid="user-input-step"], [aria-label="User message"]');
      if (userStep && !el.closest('[data-testid="user-message-actions"], button, [role="button"], time')) {
        return true;
      }
      const agentResp = el.closest('[aria-label="Agent response"], [data-testid="agent-response"]');
      if (
        agentResp &&
        !el.closest(
          'button, [role="button"], [data-testid="cascade-system-message-toolbar"], [data-testid="cleared-step-notice"], .files-changed-header, [data-screenshot-volatile]'
        )
      ) {
        return true;
      }
      return false;
    }

    function isExcludedElement(el, batchSafeSet) {
      if (!el || el.nodeType !== 1) return true;
      if (immutableTextExclCache.get(el) === true) return true;
      if (batchSafeSet && batchSafeSet.has(el)) return false;
      if (el.closest(TEXT_IMMUTABLE_EXCLUDE_SELECTOR)) {
        if (el.isConnected) immutableTextExclCache.set(el, true);
        return true;
      }
      if (el.closest(EXCLUDE_SELECTOR)) {
        return true;
      }
      if (isChatBodyExcluded(el)) {
        return true;
      }
      if (batchSafeSet) batchSafeSet.add(el);
      return false;
    }

    function canTranslateElementAttrs(el, batchSafeSet) {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (immutableContainerExclCache.get(el) === true) return false;
        if (el.closest(CONTAINER_IMMUTABLE_EXCLUDE_SELECTOR)) {
          if (el.isConnected) immutableContainerExclCache.set(el, true);
          return false;
        }
        return FORM_ATTR_EXCLUDE_SELECTOR ? !el.closest(FORM_ATTR_EXCLUDE_SELECTOR) : true;
      }
      return !isExcludedElement(el, batchSafeSet);
    }

    function isInHeaderOrBreadcrumb(el) {
      return !!(el && el.closest && el.closest('header, [data-testid="breadcrumb-segment"]'));
    }

    function resolveContextualDictTranslation(trimmed, contextEl, baseVal) {
      if (!contextEl || !contextEl.closest) return baseVal;
      if (trimmed === 'Plan' && (baseVal === '计划' || baseVal === '計畫') && contextEl.closest('[role="dialog"]')) {
        return L.ctxPlanDialog;
      }
      if (trimmed === 'Default') {
        if (contextEl.closest('[data-testid="permissions-default-tag"]')) {
          return L.ctxGlobalDefault;
        }
        if (contextEl.closest('[data-testid="permissions-preset-option-default"], [data-testid="permissions-selector-trigger"]')) {
          return L.ctxPermDefault;
        }
      }
      if (
        trimmed === 'View' &&
        (baseVal === '视图' || baseVal === '檢視') &&
        contextEl.closest('button') &&
        !contextEl.closest('[aria-haspopup], [role="menuitem"], [role="menu"], header')
      ) {
        return L.ctxViewBtn;
      }
      if (trimmed === 'Type' && (baseVal === '类型' || baseVal === '類型')) {
        const pTxt = contextEl.parentElement ? contextEl.parentElement.textContent || '' : '';
        if (/\band select\b|\/plan\b/i.test(pTxt)) return L.ctxTypeVerb;
      }
      if (trimmed === 'Actions' && (baseVal === '操作' || baseVal === '動作')) {
        const menuContainer = contextEl.closest('[role="menu"], [data-radix-popper-content-wrapper]');
        if (menuContainer && !contextEl.closest('[role="dialog"], [cmdk-list]')) {
          const mTxt = menuContainer.textContent || '';
          if (mTxt.includes('Mentions') || mTxt.includes('提及引用') || mTxt.includes('Add Context') || mTxt.includes('添加上下文')) {
            return L.ctxSlashActions;
          }
        }
      }
      if (trimmed === 'Machine' && (baseVal === '整机' || baseVal === '本機')) {
        const rowContainer = contextEl.closest('div') && contextEl.closest('div').parentElement;
        if (rowContainer && rowContainer.querySelector('[data-testid="new-sidecar-cloud-environment"]')) {
          return L.ctxMachineHost;
        }
      }
      if (trimmed === 'Blocked' && (baseVal === '已阻塞' || baseVal === '已封鎖') && !contextEl.closest('[data-testid="conversation-row-sidebar"]')) {
        const aria = contextEl.getAttribute ? contextEl.getAttribute('aria-label') || '' : '';
        if (aria.startsWith('Blocked') || contextEl.closest('[class*="destructive"]')) {
          return L.ctxBlockedRestricted;
        }
      }
      if (trimmed === 'when working') {
        const pTxt = contextEl.parentElement ? contextEl.parentElement.textContent || '' : '';
        if (pTxt.includes('Global Permissions') || pTxt.includes('全局权限') || pTxt.includes('全域權限')) return L.ctxWhenWorking;
      }
      if ((trimmed === 'in this project' || trimmed === 'in this workspace') && baseVal === undefined) {
        const pTxt = contextEl.parentElement ? contextEl.parentElement.textContent || '' : '';
        if (
          pTxt.includes('Global Permissions') ||
          pTxt.includes('全局权限') ||
          pTxt.includes('全域權限') ||
          pTxt.includes('when working') ||
          pTxt.includes('适用于') ||
          pTxt.includes('適用於')
        ) {
          return trimmed === 'in this project' ? L.ctxInProject : L.ctxInWorkspace;
        }
      }
      return baseVal;
    }

    function lookupRawDict(trimmed) {
      if (KEEP_UNTRANSLATED_EXACT.has(trimmed)) return undefined;
      if (Object.prototype.hasOwnProperty.call(DICT, trimmed)) {
        return DICT[trimmed];
      }
      if (trimmed.indexOf(' ') !== -1) {
        return LOWER_DICT[trimmed.toLowerCase()];
      }
      return undefined;
    }

    function lookupTermOrSelf(rawTerm) {
      const t = String(rawTerm || '').trim();
      if (!t) return '';
      return lookupRawDict(t) || DICT[t.charAt(0).toUpperCase() + t.slice(1)] || t;
    }

    function computeTextTranslation(raw, contextEl) {
      if (!raw) return null;
      const trimmed = raw.trim();
      if (!trimmed || KEEP_UNTRANSLATED_EXACT.has(trimmed)) return null;

      // 1. O(1) dictionary exact lookup + sentence-case fallback + contextual disambiguation
      let replacement = resolveContextualDictTranslation(trimmed, contextEl, lookupRawDict(trimmed));
      if (typeof replacement !== 'string' && trimmed.endsWith('.')) {
        const withoutDot = lookupRawDict(trimmed.slice(0, -1));
        if (typeof withoutDot === 'string') {
          replacement = withoutDot.endsWith('。') ? withoutDot : withoutDot + '。';
        }
      }
      if (typeof replacement === 'string') {
        if (RE_HAS_CJK.test(replacement) && RE_PURE_ALPHA.test(raw)) {
          return replacement;
        }
        return raw.replace(trimmed, () => replacement);
      }

      // 2. Fast bailout when no ASCII letters exist
      if (!RE_HAS_ALPHA.test(trimmed)) return null;

      // 3. Home screen dynamic greetings (from antigravity-zh-launcher)
      if (trimmed.length <= 120) {
        for (let gi = 0; gi < GREETING_PATTERNS.length; gi++) {
          const gm = trimmed.match(GREETING_PATTERNS[gi]);
          if (gm) {
            return raw.replace(trimmed, () => L.greetings[gi](gm[1] || ''));
          }
        }
      }

      // 4. Leading-char O(1) dispatched dynamic patterns
      const c0 = trimmed.charCodeAt(0);
      if (c0 >= 48 && c0 <= 57) {
        if (RE_PCT_LEFT.test(trimmed)) return raw.replace(RE_PCT_LEFT, '$1%' + L.pctLeft);
        const mWinComb = trimmed.match(RE_WINDOW_LIMIT_COMBINED);
        if (mWinComb) {
          const u = UNIT_MAP_SHORT[mWinComb[2].toLowerCase()] || mWinComb[2];
          return raw.replace(trimmed, () => mWinComb[1] + ' ' + u + L.limitSuffix + '，' + formatCompactDurationZh(mWinComb[3]) + L.resetsAfter);
        }
        const mWin = trimmed.match(RE_WINDOW_LIMIT);
        if (mWin) {
          const u = UNIT_MAP_SHORT[mWin[2].toLowerCase()] || mWin[2];
          return raw.replace(trimmed, () => mWin[1] + ' ' + u + L.limitSuffix);
        }
        const mRel = trimmed.match(RE_REL_TIME);
        if (mRel) {
          const unit = REL_UNIT_MAP[mRel[2].toLowerCase()] || mRel[2];
          return raw.replace(trimmed, () => mRel[1] + ' ' + unit + L.ago);
        }
        if (RE_UPDATES_COUNT.test(trimmed)) return raw.replace(RE_UPDATES_COUNT, '$1' + L.updatesCount);
        if (RE_FILES_CHANGED.test(trimmed)) return raw.replace(RE_FILES_CHANGED, '$1' + L.filesChanged);
        if (RE_TOOLS.test(trimmed)) return raw.replace(RE_TOOLS, '$1' + L.toolsCount);
        if (RE_DEMOTED.test(trimmed)) return raw.replace(RE_DEMOTED, '$1' + L.demotedCount);
        if (RE_EXCLUDED.test(trimmed)) return raw.replace(RE_EXCLUDED, '$1' + L.excludedCount);
        if (RE_TOOLS_EXCLUDED.test(trimmed)) return raw.replace(RE_TOOLS_EXCLUDED, '$1' + L.toolsExcluded);
        if (RE_ACTIVE_CONVS.test(trimmed)) return raw.replace(RE_ACTIVE_CONVS, '$1' + L.activeConvs);
        if (RE_PROJECTS_COUNT.test(trimmed)) return raw.replace(RE_PROJECTS_COUNT, '$1' + L.projectsCount);
        if (RE_CALLS_MB.test(trimmed)) return raw.replace(RE_CALLS_MB, '$1' + L.callsMb + '$2');
        return null;
      }

      const firstUpper = trimmed[0].toUpperCase();
      if (firstUpper === 'S') {
        if (RE_SEE_ALL.test(trimmed)) return raw.replace(RE_SEE_ALL, L.seeAll + ' ($1)');
        const mSeeMoreSkills = trimmed.match(RE_SEE_N_MORE_SKILLS);
        if (mSeeMoreSkills) return raw.replace(trimmed, () => L.dynSeeNMoreSkills(mSeeMoreSkills[1]));
        const mSeeMore = trimmed.match(RE_SEE_N_MORE);
        if (mSeeMore) return raw.replace(trimmed, () => L.dynSeeNMore(mSeeMore[1]));
        const mSeeMoreIn = trimmed.match(RE_SEE_MORE_IN_X);
        if (mSeeMoreIn) return raw.replace(trimmed, () => L.dynSeeMoreIn(lookupTermOrSelf(mSeeMoreIn[1])));
        if (RE_SHOW_BREAKDOWNS.test(trimmed)) return raw.replace(RE_SHOW_BREAKDOWNS, L.showBreakdowns + ' ($1)');
        const mSub = trimmed.match(RE_SHOW_MORE_SUBAGENTS);
        if (mSub) return raw.replace(trimmed, () => L.showMoreSubagents(mSub[1]));
        const mG = trimmed.match(RE_SEARCH_GOOGLE);
        if (mG) return raw.replace(trimmed, () => L.searchGoogle(mG[1]));
        if (!isInHeaderOrBreadcrumb(contextEl)) {
          const mSearch = trimmed.match(RE_EPHEMERAL_ACTIVE);
          if (mSearch) {
            const noun = L.ephemeralActiveNoun[mSearch[2].toLowerCase()];
            const out = noun ? L.ephemeralActiveVerb[mSearch[1]] + noun : L.ephemeralActiveVerb[mSearch[1]] + ' ' + mSearch[2];
            return raw.replace(trimmed, () => out);
          }
        }
      } else if (firstUpper === 'P') {
        const mDel = trimmed.match(RE_PERM_DELETE);
        if (mDel) return raw.replace(trimmed, () => L.permDelete(mDel[1], mDel[2]));
        const mPlugIn = trimmed.match(RE_PLUGINS_IN_X);
        if (mPlugIn) return raw.replace(trimmed, () => L.dynPluginsIn(lookupTermOrSelf(mPlugIn[1])));
      } else if (firstUpper === 'I') {
        const mInst = trimmed.match(RE_INSTALL_X);
        if (mInst) return raw.replace(trimmed, () => L.dynInstall(mInst[1].trim()));
      } else if (firstUpper === 'F') {
        const mFix = trimmed.match(RE_FIX_WITH_AGENT_X);
        if (mFix) return raw.replace(trimmed, () => L.dynFixWithAgent(mFix[1].trim()));
        const mFilt = trimmed.match(RE_FILTER_SKILLS_X);
        if (mFilt) return raw.replace(trimmed, () => L.dynFilterSkills(lookupTermOrSelf(mFilt[1])));
      } else if (firstUpper === 'W' || firstUpper === 'M') {
        const mNamed = trimmed.match(RE_NAMED_LIMIT_RESETS);
        if (mNamed) {
          const pZh = L.namedPeriod[mNamed[1].toLowerCase()] || mNamed[1];
          return raw.replace(trimmed, () => pZh + L.limitSuffix + '，' + formatCompactDurationZh(mNamed[2]) + L.resetsAfter);
        }
        if (firstUpper === 'M') {
          const mMore = trimmed.match(RE_MORE_ACTIONS_FOR_X);
          if (mMore) return raw.replace(trimmed, () => L.dynMoreActionsFor(mMore[1].trim()));
        }
        if (firstUpper === 'W') {
          const mWorkUpd = trimmed.match(RE_WORKED_FOR_UPDATES);
          if (mWorkUpd) return raw.replace(trimmed, () => L.workedForUpdates(mWorkUpd[1].trim(), mWorkUpd[2]));
          const mWork = trimmed.match(RE_WORKED_FOR);
          if (mWork) return raw.replace(trimmed, () => L.workedFor(mWork[1]));
        }
      } else if (firstUpper === 'T') {
        const mThought = trimmed.match(RE_THOUGHT_FOR);
        if (mThought) return raw.replace(trimmed, () => L.thoughtFor(mThought[1]));
        const mThinking = trimmed.match(RE_THINKING_FOR);
        if (mThinking) return raw.replace(trimmed, () => L.thinkingFor(mThinking[1]));
        const mDelRec = trimmed.match(RE_DELETE_RECORDINGS_CONFIRM);
        if (mDelRec) return raw.replace(trimmed, () => L.deleteRecConfirm(mDelRec[1], mDelRec[2]));
        const mQuotaT = translateQuotaExhaustedZh(trimmed);
        if (mQuotaT) return raw.replace(trimmed, () => mQuotaT);
      } else if (firstUpper === 'E' || firstUpper === 'R' || firstUpper === 'L') {
        if (firstUpper === 'R') {
          const mResets = trimmed.match(RE_RESETS_IN);
          if (mResets) {
            return raw.replace(trimmed, () => formatCompactDurationZh(mResets[1]) + L.resetsAfter);
          }
        }
        if (RE_EPHEMERAL_SUMMARY.test(trimmed)) {
          const translatedSummary = trimmed
            .split(/,\s*/)
            .map((part) => translateEphemeralClause(part))
            .join('、');
          return raw.replace(trimmed, () => translatedSummary);
        }
        const inHdr = isInHeaderOrBreadcrumb(contextEl);
        if (!inHdr) {
          const mActive = trimmed.match(RE_EPHEMERAL_ACTIVE);
          if (mActive) {
            const noun = L.ephemeralActiveNoun[mActive[2].toLowerCase()];
            const out = noun ? L.ephemeralActiveVerb[mActive[1]] + noun : L.ephemeralActiveVerb[mActive[1]] + ' ' + mActive[2];
            return raw.replace(trimmed, () => out);
          }
        }
        if (firstUpper === 'R') {
          const mRunFor = trimmed.match(RE_RUNNING_FOR);
          if (mRunFor) return raw.replace(trimmed, () => L.runningFor(mRunFor[1]));
          if (!inHdr) {
            const mRunCmd = trimmed.match(RE_RUNNING_CMD);
            if (mRunCmd) return raw.replace(trimmed, () => L.runningCmd(mRunCmd[1]));
          }
        }
      } else if (firstUpper === 'D') {
        const mDet = trimmed.match(RE_DETAILS_FOR_X);
        if (mDet) return raw.replace(trimmed, () => L.dynDetailsFor(mDet[1].trim()));
        const mNamedD = trimmed.match(RE_NAMED_LIMIT_RESETS);
        if (mNamedD) {
          const pZh = L.namedPeriod[mNamedD[1].toLowerCase()] || mNamedD[1];
          return raw.replace(trimmed, () => pZh + L.limitSuffix + '，' + formatCompactDurationZh(mNamedD[2]) + L.resetsAfter);
        }
        const mDelR = trimmed.match(RE_DELETED_RECORDINGS);
        if (mDelR) return raw.replace(trimmed, () => L.deletedRec(mDelR[1], mDelR[2]));
      } else if (firstUpper === 'U') {
        const mUpd = trimmed.match(RE_UPDATED_AT);
        if (mUpd) {
          return raw.replace(trimmed, () => formatUpdatedAtZh(mUpd[1], mUpd[2]));
        }
      } else if (firstUpper === 'Z') {
        const mZip = trimmed.match(RE_ZIPPING_FOLDER);
        if (mZip) return raw.replace(trimmed, () => L.zipping(mZip[1]));
      } else if (firstUpper === 'Y') {
        const mPlan = trimmed.match(RE_YOUR_PLAN);
        if (mPlan) return raw.replace(trimmed, () => L.yourPlan + mPlan[1].trim());
        const mUsed = trimmed.match(RE_USED_LIMIT);
        if (mUsed) {
          const degree = L.degreeMap[mUsed[1].toLowerCase()] || mUsed[1];
          const type = L.limitTypeMap[mUsed[2].toLowerCase()] || mUsed[2];
          const timeStr = mUsed[3]
            .replace(/\.$/, '')
            .replace(/(\d+)\s*days?/gi, '$1 ' + L.unitDay)
            .replace(/(\d+)\s*hours?/gi, '$1 ' + L.unitHour)
            .replace(/(\d+)\s*minutes?/gi, '$1 ' + L.unitMin)
            .replace(/(\d+)\s*seconds?/gi, '$1 ' + L.unitSec)
            .replace(/,\s*/g, ' ')
            .trim();
          return L.usedLimit(degree, type, timeStr);
        }
        const mNotUsed = trimmed.match(RE_NOT_USED_LIMIT);
        if (mNotUsed) {
          const type = L.limitTypeMap[mNotUsed[1].toLowerCase()] || mNotUsed[1];
          return L.notUsedLimit(type);
        }
        const mQuotaY = translateQuotaExhaustedZh(trimmed);
        if (mQuotaY) return raw.replace(trimmed, () => mQuotaY);
      } else if (firstUpper === 'A') {
        const mCred = trimmed.match(RE_AVAILABLE_AI_CREDITS);
        if (mCred) return raw.replace(trimmed, () => L.availCredits + mCred[1].trim());
      }

      // File action verbs (e.g. "Analyzed foo.ts", "Viewing README.md #L10-20")
      if (!isInHeaderOrBreadcrumb(contextEl) && trimmed.length < 220) {
        const mFileAct = trimmed.match(RE_FILE_ACTION);
        if (mFileAct) {
          const verb = L.fileActionVerb[mFileAct[1].toLowerCase()];
          if (verb) {
            const obj = lookupRawDict(mFileAct[2]) || mFileAct[2];
            return raw.replace(trimmed, () => verb + ' ' + obj);
          }
        }
      }

      if (firstUpper === 'S' && trimmed.length < 240) {
        const mSideStart = trimmed.match(RE_STARTED_SIDE_QUOTE);
        if (mSideStart) {
          const quote = mSideStart[2].trim();
          const zh = mSideStart[1] === 'during' ? L.startedDuring(quote) : L.startedFrom(quote);
          return raw.replace(trimmed, () => zh);
        }
      }

      if (trimmed.length < 40 && firstUpper === 'E') {
        const mExit = trimmed.match(RE_EXITED_CODE_ONLY);
        if (mExit) {
          return raw.replace(trimmed, () => L.exitCode + mExit[1] + (mExit[2] ? '。' : ''));
        }
      }
      if (trimmed.length < 240 && trimmed.includes('Exited with code')) {
        const mSumExit = trimmed.match(RE_SUMMARY_EXITED_CODE);
        if (mSumExit) {
          return raw.replace(trimmed, () => mSumExit[1].trim() + ' · ' + L.exitCode + mSumExit[2]);
        }
      }

      const lastCh = trimmed.charCodeAt(trimmed.length - 1);
      if (lastCh === 116 || lastCh === 84) {
        const mModLim = trimmed.match(RE_MODEL_NAMED_LIMIT);
        if (mModLim) {
          const pZh = L.namedPeriod[mModLim[2].toLowerCase()] || mModLim[2];
          return raw.replace(trimmed, () => mModLim[1].trim() + ' ' + pZh + L.limitSuffix);
        }
      }

      return null;
    }

    function translateTextNode(node) {
      const currentVal = node.nodeValue;
      if (!currentVal) return;

      const rec = origTextMap.get(node);
      if (rec && rec.lastVal === currentVal && rec.ver === PATCH_VERSION) {
        return;
      }
      const origRaw = rec && rec.lastVal === currentVal ? rec.origRaw : currentVal;

      const nextVal = computeTextTranslation(origRaw, node.parentElement);
      if (nextVal !== null) {
        origTextMap.set(node, { origRaw, lastVal: nextVal, ver: PATCH_VERSION });
        if (node.nodeValue !== nextVal) {
          node.nodeValue = nextVal;
        }
      } else if (rec && rec.lastVal === currentVal) {
        node.nodeValue = origRaw;
        origTextMap.delete(node);
      }
    }

    function translateSingleAttr(el, attrName, origDataAttr, customResolver) {
      const verProp = '__ag_attr_ver_' + attrName;
      const lastDataAttr = origDataAttr + '-last';
      const cur = el.getAttribute(attrName);
      if (!cur) {
        if (el.hasAttribute(origDataAttr)) el.removeAttribute(origDataAttr);
        if (el.hasAttribute(lastDataAttr)) el.removeAttribute(lastDataAttr);
        delete el[verProp];
        return;
      }
      const savedOrig = el.getAttribute(origDataAttr);
      const savedLast = el.getAttribute(lastDataAttr);
      if (savedOrig !== null && savedLast === cur && el[verProp] === PATCH_VERSION) {
        return;
      }
      const origVal = savedOrig !== null && savedLast === cur ? savedOrig : cur;
      const trimmed = origVal.trim();
      const shouldSkipAttr = attrName === 'aria-label' && SKIP_ARIA_LABEL_VALUES.has(trimmed);
      const nextVal = shouldSkipAttr
        ? null
        : customResolver
        ? customResolver(trimmed, el)
        : typeof DICT[trimmed] === 'string'
        ? DICT[trimmed]
        : null;
      if (typeof nextVal === 'string') {
        if (savedOrig !== origVal) el.setAttribute(origDataAttr, origVal);
        if (savedLast !== nextVal) el.setAttribute(lastDataAttr, nextVal);
        el[verProp] = PATCH_VERSION;
        if (cur !== nextVal) {
          el.setAttribute(attrName, nextVal);
        }
      } else {
        if (savedOrig !== null && savedLast === cur) {
          el.setAttribute(attrName, savedOrig);
        }
        if (savedOrig !== null) el.removeAttribute(origDataAttr);
        if (savedLast !== null) el.removeAttribute(lastDataAttr);
        el[verProp] = PATCH_VERSION;
      }
    }

    function resolveAttrTranslation(atrim, el) {
      const directHit = lookupRawDict(atrim);
      if (typeof directHit === 'string') return resolveContextualDictTranslation(atrim, el, directHit);
      const mModel = atrim.match(RE_ARIA_MODEL);
      if (mModel) {
        let mName = mModel[1].trim();
        let noteZh = '';
        const mNoteSplit = mName.match(
          /^(.+?)(?:\.\s+(Applies to\b.*)$|,\s+(Model cannot be changed\b.*|[A-Z].*)$)/i
        );
        if (mNoteSplit) {
          mName = mNoteSplit[1].trim();
          const rawTailNote = (mNoteSplit[2] || mNoteSplit[3] || '').trim().replace(/\.$/, '');
          const noteHit = lookupRawDict(rawTailNote) || computeTextTranslation(rawTailNote, el) || rawTailNote;
          if (noteHit) noteZh = '（' + noteHit + '）';
        } else {
          const commaIdx = mName.indexOf(', ');
          if (commaIdx > 0) {
            const maybeNote = mName.slice(commaIdx + 2).trim();
            const noteHit = lookupRawDict(maybeNote);
            if (typeof noteHit === 'string' && noteHit) {
              mName = mName.slice(0, commaIdx).trim();
              noteZh = '（' + noteHit + '）';
            }
          }
        }
        if (mName === 'Select model') return L.ariaModelCur + L.ariaSelectModel + noteZh;
        return L.ariaModelCur + mName + noteZh;
      }
      const lookupPerm = (s) => {
        if (s && s.toLowerCase() === 'default') return L.ctxPermDefault;
        return lookupRawDict(s) || DICT[s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()] || s;
      };
      const mPermSel = atrim.match(RE_ARIA_PERM_SEL);
      if (mPermSel) {
        return L.ariaPermCur + lookupPerm(mPermSel[1].trim());
      }
      const mPermFixed = atrim.match(RE_ARIA_PERM_FIXED);
      if (mPermFixed) {
        const pMode = mPermFixed[1].trim();
        const rawNote = (mPermFixed[2] || mPermFixed[3] || '').trim();
        if (!rawNote) {
          return L.ariaPermFixed + lookupPerm(pMode);
        }
        const mappedNote =
          rawNote.toLowerCase() === 'cannot be changed mid-conversation'
            ? L.ariaCantChangeMid
            : lookupRawDict(rawNote) || computeTextTranslation(rawNote, el) || rawNote;
        return L.ariaPermFixed + lookupPerm(pMode) + '（' + mappedNote + '）';
      }
      const mTurn = atrim.match(RE_ARIA_TURN);
      if (mTurn) {
        if (mTurn[3] && mTurn[4]) return L.ariaTurnOf(mTurn[3], mTurn[4]);
        return L.ariaTurnBy(mTurn[1], mTurn[2].toLowerCase() === 'user');
      }
      const mOlder = atrim.match(RE_ARIA_LOAD_OLDER);
      if (mOlder) {
        if (mOlder[2] && mOlder[3]) return L.ariaLoadOlderShow(mOlder[2], mOlder[3]);
        return L.ariaLoadOlderTurns(mOlder[1]);
      }
      const mBranch = atrim.match(RE_ARIA_BRANCH);
      if (mBranch) {
        const bName = mBranch[1].trim();
        return L.ariaBranchCur + (bName === 'Select branch' ? L.ariaSelectBranch : bName);
      }
      const mProj = atrim.match(RE_ARIA_PROJECT);
      if (mProj) {
        const pName = mProj[1].trim();
        return L.ariaProjCur + (pName === 'No project' || pName === 'No Project' ? L.ariaNoProject : pName);
      }
      const mLoc = atrim.match(RE_ARIA_LOCATION);
      if (mLoc) {
        const locName = mLoc[1].trim();
        const mappedLoc =
          locName.toLowerCase() === 'this computer'
            ? L.ariaThisComputer
            : locName.toLowerCase() === 'remote'
            ? L.ariaRemote
            : lookupRawDict(locName) || locName;
        return L.ariaLocCur + mappedLoc;
      }
      const mVer = atrim.match(RE_ARIA_VERSION);
      if (mVer) {
        return L.ariaVersion + mVer[1].trim();
      }
      return computeTextTranslation(atrim, el);
    }

    function hasTranslatableAttrs(el) {
      return (
        el &&
        el.hasAttribute &&
        (el.hasAttribute('title') ||
          el.hasAttribute('aria-label') ||
          el.hasAttribute('placeholder') ||
          el.hasAttribute('data-tooltip-content'))
      );
    }

    function translateElementAttrs(el) {
      if (!el || el.nodeType !== 1) return;
      translateSingleAttr(el, 'title', 'data-ag-orig-title', resolveAttrTranslation);
      translateSingleAttr(el, 'placeholder', 'data-ag-orig-placeholder', resolveAttrTranslation);
      translateSingleAttr(el, 'aria-label', 'data-ag-orig-aria-label', resolveAttrTranslation);
      translateSingleAttr(el, 'data-tooltip-content', 'data-ag-orig-tooltip', resolveAttrTranslation);
    }

    const walkerFilter = {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node.matches && node.matches(EXCLUDE_SELECTOR)) {
            if (node.isConnected && node.matches(TEXT_IMMUTABLE_EXCLUDE_SELECTOR)) {
              immutableTextExclCache.set(node, true);
            }
            if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && canTranslateElementAttrs(node) && hasTranslatableAttrs(node)) {
              translateElementAttrs(node);
            }
            return NodeFilter.FILTER_REJECT;
          }
          if (isChatBodyExcluded(node)) {
            return NodeFilter.FILTER_SKIP;
          }
          if (hasTranslatableAttrs(node)) {
            translateElementAttrs(node);
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    };

    function scanAndTranslate(root = document.body) {
      if (!root) return;
      if (root.nodeType === 3) {
        if (root.parentElement && !isExcludedElement(root.parentElement)) {
          translateTextNode(root);
        }
        return;
      }
      if (root.nodeType !== 1) return;
      if (isExcludedElement(root)) {
        if ((root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') && canTranslateElementAttrs(root) && hasTranslatableAttrs(root)) {
          translateElementAttrs(root);
        }
        return;
      }

      if (hasTranslatableAttrs(root)) {
        translateElementAttrs(root);
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkerFilter);
      while (walker.nextNode()) {
        if (walker.currentNode.parentElement && !isChatBodyExcluded(walker.currentNode.parentElement)) {
          translateTextNode(walker.currentNode);
        }
      }
    }

    scanBodyFn = scanAndTranslate;
    if (document.body) {
      scanAndTranslate(document.body);
    }

    const dirtyRoots = new Set();
    let pending = false;
    let fallbackTimer = null;

    function flushTranslations() {
      pending = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (dirtyRoots.size === 0) return;

      if (dirtyRoots.size > 200) {
        dirtyRoots.clear();
        try {
          scanAndTranslate(document.body);
        } catch (e) {}
        return;
      }

      const roots = Array.from(dirtyRoots);
      const rootSet = new Set(roots);
      dirtyRoots.clear();

      for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        if (!r || !r.isConnected) continue;
        let covered = false;
        for (let p = r.parentNode; p; p = p.parentNode) {
          if (rootSet.has(p)) {
            covered = true;
            break;
          }
        }
        if (!covered) {
          try {
            scanAndTranslate(r);
          } catch (e) {}
        }
      }
    }

    function scheduleFlush() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(flushTranslations);
      fallbackTimer = setTimeout(flushTranslations, 80);
    }

    window.__ag_i18n_observer = new MutationObserver((mutations) => {
      const batchSafeSet = new Set();
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'characterData') {
          const t = m.target;
          if (t && t.parentElement && !isExcludedElement(t.parentElement, batchSafeSet)) {
            dirtyRoots.add(t);
          }
        } else if (m.type === 'attributes') {
          const el = m.target;
          if (el && el.nodeType === 1 && canTranslateElementAttrs(el, batchSafeSet)) {
            try {
              translateElementAttrs(el);
            } catch (e) {}
          }
        } else if (m.type === 'childList' && m.addedNodes.length > 0) {
          if (m.target && m.target.nodeType === 1 && isExcludedElement(m.target, batchSafeSet)) {
            continue;
          }
          for (let j = 0; j < m.addedNodes.length; j++) {
            const n = m.addedNodes[j];
            if (n.nodeType === 1 || n.nodeType === 3) {
              dirtyRoots.add(n);
            }
          }
        }
      }
      if (dirtyRoots.size > 0) {
        scheduleFlush();
      }
    });

    if (document.body) {
      window.__ag_i18n_observer.observe(document.body, I18N_OBS_OPTS);
    }
  } else if (document.body) {
    restoreAllTranslations(document.body);
  }
