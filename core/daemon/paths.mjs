/**
 * core/daemon/paths.mjs — Cross-Platform Channel Discovery & Dynamic Bundle Builder
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ALLOWED_ORIGINS, extractJsoncNumberProperty, stripUtf8Bom } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let DEFAULT_CUSTOM_SYSTEM_PROMPT = { enabled: false, mode: 'flow-proxy', text: '', everyInvocation: false };
let DEFAULT_HOOK_AUTO_ALLOW = { enabled: false, mode: 'files' };
let normalizeCustomSystemPrompt = (raw) =>
  Object.assign(
    { enabled: false, mode: 'flow-proxy', text: '', everyInvocation: false },
    raw && typeof raw === 'object' ? raw : {}
  );
let normalizeHookAutoAllow = (raw) => Object.assign({ enabled: false, mode: 'files' }, raw && typeof raw === 'object' ? raw : {});
let sanitizePromptAndHooksPatch = () => {};
let syncSystemPromptAndHooks = () => ({ rulePath: '', hooksPath: '' });

if (fs.existsSync(path.join(__dirname, 'hooks-sync.mjs'))) {
  try {
    const hs = await import('./hooks-sync.mjs');
    if (hs.DEFAULT_CUSTOM_SYSTEM_PROMPT) DEFAULT_CUSTOM_SYSTEM_PROMPT = hs.DEFAULT_CUSTOM_SYSTEM_PROMPT;
    if (hs.DEFAULT_HOOK_AUTO_ALLOW) DEFAULT_HOOK_AUTO_ALLOW = hs.DEFAULT_HOOK_AUTO_ALLOW;
    if (typeof hs.normalizeCustomSystemPrompt === 'function') normalizeCustomSystemPrompt = hs.normalizeCustomSystemPrompt;
    if (typeof hs.normalizeHookAutoAllow === 'function') normalizeHookAutoAllow = hs.normalizeHookAutoAllow;
    if (typeof hs.sanitizePromptAndHooksPatch === 'function') sanitizePromptAndHooksPatch = hs.sanitizePromptAndHooksPatch;
    if (typeof hs.syncSystemPromptAndHooks === 'function') syncSystemPromptAndHooks = hs.syncSystemPromptAndHooks;
  } catch {}
}

let DEFAULT_FLOW_CONFIG = {
  port: 18100,
  upstream: 'https://daily-cloudcode-pa.googleapis.com',
  defaultMode: 'default',
  modelPattern: 'gemini',
  maxContinuations: 3,
  refusalRewrite: true,
  outputChannelHardening: false,
  continuationText: '继续输出正文：从已生成内容的中断处精确续写，不要重复已有内容，不要总结，不要致歉。',
  judgeEnabled: false,
  judgeModel: 'gemini-3.8-flash-low',
  judgeTimeoutMs: 20000,
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
let normalizeFlowConfig = (raw) => Object.assign({}, DEFAULT_FLOW_CONFIG, raw && typeof raw === 'object' ? raw : {});
let sanitizeFlowPatch = () => {};

if (fs.existsSync(path.join(__dirname, '..', 'flow', 'contract.mjs'))) {
  try {
    const fc = await import('../flow/contract.mjs');
    if (fc.DEFAULT_FLOW_CONFIG) DEFAULT_FLOW_CONFIG = fc.DEFAULT_FLOW_CONFIG;
    if (typeof fc.normalizeFlowConfig === 'function') normalizeFlowConfig = fc.normalizeFlowConfig;
    if (typeof fc.sanitizeFlowPatch === 'function') sanitizeFlowPatch = fc.sanitizeFlowPatch;
  } catch {}
}

let DEFAULT_AUTO_TITLE_CONFIG = { enabled: false, turnInterval: 4, minIntervalMin: 5 };
let normalizeAutoTitleConfig = (raw) =>
  Object.assign({ enabled: false, turnInterval: 4, minIntervalMin: 5 }, raw && typeof raw === 'object' ? raw : {});

if (fs.existsSync(path.join(__dirname, 'title-updater.mjs'))) {
  try {
    const tu = await import('./title-updater.mjs');
    if (tu.DEFAULT_AUTO_TITLE_CONFIG) DEFAULT_AUTO_TITLE_CONFIG = tu.DEFAULT_AUTO_TITLE_CONFIG;
    if (typeof tu.normalizeAutoTitleConfig === 'function') normalizeAutoTitleConfig = tu.normalizeAutoTitleConfig;
  } catch {}
}

let DEFAULT_SUBAGENT_ROUTING = { enabled: false, allowedModels: [] };
let normalizeSubagentRouting = (raw) =>
  Object.assign({ enabled: false, allowedModels: [] }, raw && typeof raw === 'object' ? raw : {});
let sanitizeSubagentRoutingPatch = () => {};

if (fs.existsSync(path.join(__dirname, '..', 'flow', 'subagent-routing.mjs'))) {
  try {
    const sr = await import('../flow/subagent-routing.mjs');
    if (sr.DEFAULT_SUBAGENT_ROUTING) DEFAULT_SUBAGENT_ROUTING = sr.DEFAULT_SUBAGENT_ROUTING;
    if (typeof sr.normalizeSubagentRouting === 'function') normalizeSubagentRouting = sr.normalizeSubagentRouting;
    if (typeof sr.sanitizeSubagentRoutingPatch === 'function') sanitizeSubagentRoutingPatch = sr.sanitizeSubagentRoutingPatch;
  } catch {}
}
export const ROOT_DIR = path.resolve(__dirname, '../..');
export const CORE_DIR = path.join(ROOT_DIR, 'core');
export const I18N_DIR = path.join(CORE_DIR, 'i18n');
export const STYLES_DIR = path.join(CORE_DIR, 'styles');
export const RUNTIME_DIR = path.join(CORE_DIR, 'runtime');
export const USER_DIR = path.join(ROOT_DIR, 'user');

function readBaseVersion() {
  for (const candidate of [path.join(ROOT_DIR, 'package.json'), path.join(CORE_DIR, 'manifest.json')]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const ver = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
      if (ver) return ver;
    } catch {}
  }
  return '1.4.1';
}

export const BASE_VERSION = readBaseVersion();

export const SUPPORTED_I18N_LOCALES = Object.freeze(['zh-CN', 'zh-SG', 'zh-TW', 'en']);
export const AI_LANG_RULE_FILENAME = '99_antigravity_codex_lang.md';

const AI_OUTPUT_RULE_COPY = Object.freeze({
  'zh-CN':
    '请全程使用自然简练的简体中文进行内部思考推理（Thinking）、任务规划、工具步骤摘要（`toolSummary`）、子智能体角色命名及面向用户的回复；代码标识符、API 名称、命令行参数、文件路径与原始报错保持英文原样。',
  'zh-SG':
    '请全程使用简体中文进行内部思考推理（Thinking）、任务规划、工具步骤摘要（`toolSummary`）与面向用户的回复，同时自然保留常见英文技术术语（如 `Agent`、`Subagent`、`Artifact`、`Workspace`、`MCP`、API 与代码标识符）。',
  'zh-TW':
    '請全程使用自然流暢的繁體中文（台灣開發者慣用術語）進行內部思考推理（Thinking）、任務規劃、工具步驟摘要（`toolSummary`）與面向使用者的回覆；程式碼識別字、API 名稱、命令列參數、檔案路徑與原始錯誤訊息保持英文原樣。'
});

export function normalizeI18nLocale(raw, fallback = 'zh-CN') {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const low = s.toLowerCase();
  if (low === 'en' || low === 'en-us' || low === 'english') return 'en';
  if (low === 'zh-sg' || low === 'zh_sg' || low === 'sg') return 'zh-SG';
  if (low === 'zh-tw' || low === 'zh_tw' || low === 'zh-hk' || low === 'zh-hant' || low === 'tw') return 'zh-TW';
  if (low === 'zh' || low === 'zh-cn' || low === 'zh_cn' || low === 'zh-hans' || low === 'cn') return 'zh-CN';
  return fallback;
}

export function syncAgentLanguageRule(localeCode = 'zh-CN', enabled = false, { customHome = '' } = {}) {
  const home = customHome || os.homedir();
  const rulesDir = path.join(home, '.gemini', 'config', 'rules');
  const rulePath = path.join(rulesDir, AI_LANG_RULE_FILENAME);
  const norm = normalizeI18nLocale(localeCode, 'zh-CN');

  if (!enabled || norm === 'en' || !AI_OUTPUT_RULE_COPY[norm]) {
    try {
      if (fs.existsSync(rulePath)) fs.unlinkSync(rulePath);
    } catch {}
    return '';
  }

  const content = [
    '---',
    'trigger: always_on',
    `description: "Enforce Antigravity AI thinking and reply language (${norm}). Managed by antigravity-theme."`,
    '---',
    '',
    '<!-- antigravity-theme:syncAiOutputLang -->',
    `# AI Thinking & Output Language (${norm})`,
    '',
    `- ${AI_OUTPUT_RULE_COPY[norm]}`,
    ''
  ].join('\n');

  try {
    fs.mkdirSync(rulesDir, { recursive: true });
    if (fs.existsSync(rulePath) && fs.readFileSync(rulePath, 'utf8') === content) {
      return rulePath;
    }
    fs.writeFileSync(rulePath, content, 'utf8');
    return rulePath;
  } catch {
    return '';
  }
}

export function parseDaemonCliArgs(argv = process.argv.slice(2)) {
  const hasFlag = (f) => argv.some((a) => a === f || a.startsWith(f + '='));
  const getArg = (flag, fallback = null) => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1];
      if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
    }
    return fallback;
  };
  return {
    safeMode: hasFlag('--safe-mode'),
    runOnce: hasFlag('--once'),
    cliChannel: getArg('--channel', null),
    portFile: getArg('--port-file', ''),
    conversationsDir: getArg('--conversations-dir', '')
  };
}

export function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(stripUtf8Bom(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return fallback;
  }
}

export function readTextSafe(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function getFileMtimeSig(filePath) {
  try {
    const st = fs.statSync(filePath, { throwIfNoEntry: false });
    return st ? `${st.mtimeMs}:${st.size}` : '0:0';
  } catch {
    return '0:0';
  }
}

export function listSortedFiles(dirPath, ext) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs
      .readdirSync(dirPath)
      .filter((name) => name.endsWith(ext))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => path.join(dirPath, name));
  } catch {
    return [];
  }
}

export function normalizeOverrideDict(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return {};
  const source = rawObj.exact && typeof rawObj.exact === 'object' ? rawObj.exact : rawObj;
  const clean = {};
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') {
      clean[k] = v;
    }
  }
  return clean;
}

export function resolveChannelPaths(singleChannel = 'stable', userCfg = {}, cliOpts = {}) {
  const home = os.homedir();
  const isInsiders = singleChannel === 'insiders';
  const appDirName = isInsiders ? 'Antigravity - Insiders' : 'Antigravity';
  const geminiSubDir = isInsiders ? '.gemini/antigravity-insiders' : '.gemini/antigravity';

  let defaultPortFile;
  if (process.platform === 'darwin') {
    defaultPortFile = path.join(home, 'Library', 'Application Support', appDirName, 'DevToolsActivePort');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    defaultPortFile = path.join(appData, appDirName, 'DevToolsActivePort');
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    defaultPortFile = path.join(xdgConfig, appDirName, 'DevToolsActivePort');
  }

  const defaultConvDir = path.join(home, geminiSubDir, 'conversations');
  const dotDir = path.join(home, isInsiders ? '.antigravity-insiders' : '.antigravity');
  const argvPath = path.join(dotDir, 'argv.json');
  let fallbackPort = isInsiders ? 9223 : 9222;
  try {
    if (fs.existsSync(argvPath)) {
      const parsedPort = extractJsoncNumberProperty(fs.readFileSync(argvPath, 'utf8'), 'remote-debugging-port');
      if (parsedPort && parsedPort > 0) fallbackPort = parsedPort;
    }
  } catch {}

  const portFile = cliOpts.portFile || userCfg.portFile || defaultPortFile;
  const lsLogFile =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', appDirName, 'language_server.log')
      : path.join(path.dirname(defaultPortFile), 'logs', 'language_server.log');
  const channelInstalled =
    fs.existsSync(portFile) || fs.existsSync(path.dirname(defaultPortFile)) || fs.existsSync(dotDir);

  return {
    channel: singleChannel,
    portFile,
    lsLogFile,
    fallbackPort: Number(userCfg.fallbackPort) > 0 ? Number(userCfg.fallbackPort) : fallbackPort,
    channelInstalled,
    conversationsDir: cliOpts.conversationsDir || userCfg.conversationsDir || defaultConvDir
  };
}

export function resolveActiveChannelEndpoints(channelMode = 'auto', userCfg = {}, cliOpts = {}) {
  const explicitPortFile = cliOpts.portFile || userCfg.portFile || '';
  if (explicitPortFile) {
    const ch = channelMode === 'insiders' ? 'insiders' : 'stable';
    return [resolveChannelPaths(ch, userCfg, cliOpts)];
  }
  if (channelMode === 'stable' || channelMode === 'insiders') {
    return [resolveChannelPaths(channelMode, userCfg, cliOpts)];
  }
  return [
    resolveChannelPaths('stable', userCfg, cliOpts),
    resolveChannelPaths('insiders', userCfg, cliOpts)
  ];
}

const EDITABLE_MODULE_KEYS = new Set([
  'theme',
  'i18n',
  'metrics',
  'promptSuggestions',
  'flow',
  'sshRemote',
  'deadlockHealer',
  'zoomShortcuts',
  'cdpAutoRelaunch',
  'customCss',
  'customJs'
]);
const VALID_SSH_HOST_RE = /^[a-zA-Z0-9_@][a-zA-Z0-9._:@-]{0,127}$/;
const VALID_SUGGEST_MODEL_RE = /^[a-zA-Z0-9._:/-]{2,80}$/;

export function sanitizeConfigPatch(currentCfg, patch) {
  const base = currentCfg && typeof currentCfg === 'object' ? JSON.parse(JSON.stringify(currentCfg)) : {};
  if (!patch || typeof patch !== 'object') return base;

  if (patch.modules && typeof patch.modules === 'object') {
    const nextModules = base.modules && typeof base.modules === 'object' ? { ...base.modules } : {};
    for (const [k, v] of Object.entries(patch.modules)) {
      if (EDITABLE_MODULE_KEYS.has(k) && typeof v === 'boolean') {
        nextModules[k] = v;
      }
    }
    base.modules = nextModules;
  }

  if (patch.telemetryLayout === 'compact' || patch.telemetryLayout === 'detailed') {
    base.telemetryLayout = patch.telemetryLayout;
  }
  if (patch.telemetryCacheMode === 'session' || patch.telemetryCacheMode === 'step') {
    base.telemetryCacheMode = patch.telemetryCacheMode;
  }
  if (typeof patch.compactTypography === 'boolean') {
    base.compactTypography = patch.compactTypography;
  }
  if (['quota', 'sessionTokens', 'todayTokens', 'monthTokens', 'monthCost', 'icon'].includes(patch.topbarUsageMetric)) {
    base.topbarUsageMetric = patch.topbarUsageMetric;
  }
  if (typeof patch.overviewQuota === 'boolean') {
    base.overviewQuota = patch.overviewQuota;
  }
  if (typeof patch.overviewProgress === 'boolean') {
    base.overviewProgress = patch.overviewProgress;
  }
  if (typeof patch.showClaudeQuota === 'boolean') {
    base.showClaudeQuota = patch.showClaudeQuota;
  }
  if (typeof patch.i18nLocale === 'string') {
    const loc = normalizeI18nLocale(patch.i18nLocale, '');
    if (loc && SUPPORTED_I18N_LOCALES.includes(loc)) {
      base.i18nLocale = loc;
      if (!base.modules || typeof base.modules !== 'object') base.modules = {};
      if (loc === 'en') {
        base.modules.i18n = false;
      } else {
        base.modules.i18n = true;
      }
    }
  }
  if (typeof patch.syncAiOutputLang === 'boolean') {
    base.syncAiOutputLang = patch.syncAiOutputLang;
  }
  sanitizePromptAndHooksPatch(base, patch);
  sanitizeFlowPatch(base, patch);
  if (patch.autoTitle && typeof patch.autoTitle === 'object') {
    const curAt = normalizeAutoTitleConfig(base.autoTitle);
    base.autoTitle = normalizeAutoTitleConfig({ ...curAt, ...patch.autoTitle });
  }
  sanitizeSubagentRoutingPatch(base, patch);
  if (patch.modules && typeof patch.modules.i18n === 'boolean' && patch.modules.i18n === true && base.i18nLocale === 'en') {
    base.i18nLocale = 'zh-CN';
  }
  if (typeof patch.promptSuggestionModel === 'string') {
    const m = patch.promptSuggestionModel.trim();
    if (m && !m.startsWith('-') && VALID_SUGGEST_MODEL_RE.test(m)) {
      base.promptSuggestionModel = m;
    }
  }
  if (Array.isArray(patch.sshHosts)) {
    const out = [];
    const seen = new Set();
    for (const raw of patch.sshHosts) {
      const h = String(raw || '').trim();
      if (!h || h.startsWith('-') || !VALID_SSH_HOST_RE.test(h) || seen.has(h)) continue;
      seen.add(h);
      out.push(h);
      if (out.length >= 32) break;
    }
    base.sshHosts = out;
  }

  return base;
}

export function createBundleController({ safeMode = false, cliChannel = null, hasSqlite = false, cliOpts = {} } = {}) {
  let cachedBundleSig = '';
  let cachedInjectScript = '';
  let cachedPatchVersion = '';
  let activeConfig = {
    enabled: true,
    channel: 'auto',
    preset: 'codex-pure-white',
    i18nLocale: 'zh-CN',
    syncAiOutputLang: false,
    customSystemPrompt: { ...DEFAULT_CUSTOM_SYSTEM_PROMPT },
    hookAutoAllow: { ...DEFAULT_HOOK_AUTO_ALLOW },
    flow: { ...DEFAULT_FLOW_CONFIG },
    autoTitle: { ...DEFAULT_AUTO_TITLE_CONFIG },
    subagentRouting: { ...DEFAULT_SUBAGENT_ROUTING, allowedModels: [] },
    telemetryLayout: 'compact',
    telemetryCacheMode: 'session',
    compactTypography: true,
    topbarUsageMetric: 'quota',
    overviewQuota: true,
    overviewProgress: true,
    showClaudeQuota: false,
    contextLimit: 'auto',
    manualContextLimit: 0,
    fallbackContextLimit: 256000,
    promptSuggestionModel: 'gemini-3.8-flash-low',
    modules: {
      theme: true,
      i18n: true,
      metrics: Boolean(hasSqlite),
      sshRemote: false,
      promptSuggestions: false,
      flow: true,
      deadlockHealer: true,
      zoomShortcuts: true,
      cdpAutoRelaunch: true,
      customCss: true,
      customJs: true
    },
    sshHosts: [],
    themeVars: {},
    selectors: {},
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    endpoints: []
  };

  function resolveI18nDictPath(localeCode) {
    const loc = normalizeI18nLocale(localeCode, 'zh-CN');
    if (loc === 'en') return '';
    const candidate = path.join(I18N_DIR, `${loc}.json`);
    if (fs.existsSync(candidate)) return candidate;
    return path.join(CORE_DIR, 'i18n.json');
  }

  function rebuildBundleIfNeeded(force = false) {
    const styleFiles = listSortedFiles(STYLES_DIR, '.css');
    const runtimeFiles = listSortedFiles(RUNTIME_DIR, '.js');
    const localeFiles = listSortedFiles(I18N_DIR, '.json');
    const coreFiles = [
      ...styleFiles,
      path.join(CORE_DIR, 'i18n.json'),
      ...localeFiles,
      ...runtimeFiles,
      path.join(ROOT_DIR, 'package.json'),
      path.join(CORE_DIR, 'manifest.json')
    ];
    const userFiles = safeMode
      ? []
      : [
          path.join(USER_DIR, 'config.json'),
          path.join(USER_DIR, 'custom.css'),
          path.join(USER_DIR, 'i18n.override.json'),
          path.join(USER_DIR, 'custom.js')
        ];

    const sig =
      coreFiles.map(getFileMtimeSig).join('|') +
      '|' +
      userFiles.map(getFileMtimeSig).join('|') +
      `|safe:${safeMode}|cli:${cliChannel || ''}|sqlite:${hasSqlite}`;

    if (!force && sig === cachedBundleSig && cachedInjectScript) {
      return false;
    }

    const userCfg = safeMode ? {} : readJsonSafe(path.join(USER_DIR, 'config.json'), {});
    const enabled = safeMode ? true : userCfg.enabled !== false;
    const channel = cliChannel || userCfg.channel || 'auto';
    const presetRaw = String(userCfg.preset || 'codex-pure-white').trim();
    const preset = presetRaw === 'codex-dark' || presetRaw === 'onyx-dark' ? 'codex-dark' : 'codex-pure-white';
    const telemetryLayout = userCfg.telemetryLayout === 'detailed' ? 'detailed' : 'compact';
    const telemetryCacheMode = userCfg.telemetryCacheMode === 'step' ? 'step' : 'session';
    const compactTypography = userCfg.compactTypography !== false;
    const topbarUsageMetric = ['quota', 'sessionTokens', 'todayTokens', 'monthTokens', 'monthCost', 'icon'].includes(
      userCfg.topbarUsageMetric
    )
      ? userCfg.topbarUsageMetric
      : 'quota';
    const overviewQuota = userCfg.overviewQuota !== false;
    const overviewProgress = userCfg.overviewProgress !== false;
    const showClaudeQuota = userCfg.showClaudeQuota === true;

    const rawContextLimit = userCfg.contextLimit;
    const isAutoLimit =
      rawContextLimit === undefined ||
      rawContextLimit === null ||
      String(rawContextLimit).trim() === '' ||
      String(rawContextLimit).trim().toLowerCase() === 'auto';
    const manualContextLimit = !isAutoLimit && Number(rawContextLimit) > 0 ? Number(rawContextLimit) : 0;
    const fallbackContextLimit =
      Number(userCfg.fallbackContextLimit) > 0 ? Number(userCfg.fallbackContextLimit) : 256000;
    const contextLimit = manualContextLimit > 0 ? manualContextLimit : 'auto';

    const rawModules = Object.assign({}, userCfg.features || {}, userCfg.modules || {});
    if (typeof rawModules.metricsCapsule === 'boolean' && typeof rawModules.metrics !== 'boolean') {
      rawModules.metrics = rawModules.metricsCapsule;
    }
    const modules = Object.assign(
      {
        theme: true,
        i18n: true,
        metrics: true,
        sshRemote: false,
        promptSuggestions: false,
        flow: true,
        deadlockHealer: true,
        zoomShortcuts: true,
        cdpAutoRelaunch: true,
        customCss: true,
        customJs: true
      },
      rawModules
    );
    const hasThemeFiles =
      fs.existsSync(path.join(STYLES_DIR, '10-light-codex.css')) ||
      fs.existsSync(path.join(STYLES_DIR, '00-base.css'));
    const hasI18nFiles =
      (fs.existsSync(path.join(CORE_DIR, 'i18n.json')) || fs.existsSync(path.join(I18N_DIR, 'zh-CN.json'))) &&
      fs.existsSync(path.join(RUNTIME_DIR, '60-i18n-engine.js'));
    const hasMetricsFiles =
      fs.existsSync(path.join(RUNTIME_DIR, '50-telemetry-ui.js')) &&
      fs.existsSync(path.join(CORE_DIR, 'daemon', 'sqlite-metrics.mjs'));
    const hasPromptSuggestFiles =
      fs.existsSync(path.join(RUNTIME_DIR, '70-prompt-suggestions.js')) &&
      fs.existsSync(path.join(CORE_DIR, 'daemon', 'prompt-suggest.mjs'));
    const hasFlowFiles =
      fs.existsSync(path.join(RUNTIME_DIR, '78-flow-mode-picker.js')) &&
      fs.existsSync(path.join(CORE_DIR, 'flow', 'proxy.mjs'));
    const hasGuardsFile = fs.existsSync(path.join(RUNTIME_DIR, '10-guards.js'));
    if (!hasThemeFiles) modules.theme = false;
    if (!hasI18nFiles) modules.i18n = false;
    const rawLocale = normalizeI18nLocale(userCfg.i18nLocale, 'zh-CN');
    const i18nLocale = !modules.i18n || rawLocale === 'en' ? 'en' : rawLocale;
    if (i18nLocale === 'en') modules.i18n = false;
    const syncAiOutputLang = !safeMode && userCfg.syncAiOutputLang === true;
    const customSystemPrompt = safeMode
      ? { ...DEFAULT_CUSTOM_SYSTEM_PROMPT }
      : normalizeCustomSystemPrompt(userCfg.customSystemPrompt);
    const hookAutoAllow = safeMode ? { ...DEFAULT_HOOK_AUTO_ALLOW } : normalizeHookAutoAllow(userCfg.hookAutoAllow);
    const flow = safeMode ? { ...DEFAULT_FLOW_CONFIG } : normalizeFlowConfig(userCfg.flow);
    const autoTitle = safeMode ? { ...DEFAULT_AUTO_TITLE_CONFIG } : normalizeAutoTitleConfig(userCfg.autoTitle);
    const subagentRouting = safeMode
      ? { ...DEFAULT_SUBAGENT_ROUTING, allowedModels: [] }
      : normalizeSubagentRouting(userCfg.subagentRouting);
    if (!hasSqlite || !hasMetricsFiles) {
      modules.metrics = false;
      modules.sshRemote = false;
    }
    if (!hasPromptSuggestFiles) modules.promptSuggestions = false;
    if (!hasFlowFiles) modules.flow = false;
    if (!hasGuardsFile) {
      modules.deadlockHealer = false;
      modules.zoomShortcuts = false;
    }

    const themeVars = !safeMode && userCfg.themeVars && typeof userCfg.themeVars === 'object' ? userCfg.themeVars : {};
    const endpoints = resolveActiveChannelEndpoints(channel, userCfg, cliOpts);

    const normalizedSelectors = Object.assign({}, userCfg.selectors || {});
    if (
      normalizedSelectors.branchPillInBox &&
      !String(normalizedSelectors.branchPillInBox).includes('project-branch-picker')
    ) {
      delete normalizedSelectors.branchPillInBox;
    }
    if (normalizedSelectors.homeGreeting && !String(normalizedSelectors.homeGreeting).includes('home-splash-content')) {
      delete normalizedSelectors.homeGreeting;
    }
    if (
      typeof normalizedSelectors.excludeI18n === 'string' &&
      normalizedSelectors.excludeI18n.trim() &&
      !normalizedSelectors.excludeI18n.includes('.monaco-editor')
    ) {
      normalizedSelectors.excludeI18n +=
        ', .monaco-editor, .monaco-diff-editor, .xterm, [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, [class*="onyx-key"]';
    }

    const rawPromptModel = typeof userCfg.promptSuggestionModel === 'string' ? userCfg.promptSuggestionModel.trim() : '';
    const promptSuggestionModel =
      rawPromptModel && !rawPromptModel.startsWith('-') && /^[a-zA-Z0-9._:/-]+$/.test(rawPromptModel)
        ? rawPromptModel
        : 'gemini-3.8-flash-low';

    activeConfig = {
      enabled,
      channel,
      preset,
      compactTypography,
      topbarUsageMetric,
      overviewQuota,
      overviewProgress,
      showClaudeQuota,
      i18nLocale,
      syncAiOutputLang,
      customSystemPrompt,
      hookAutoAllow,
      flow,
      autoTitle,
      subagentRouting,
      telemetryLayout,
      telemetryCacheMode,
      contextLimit,
      manualContextLimit,
      fallbackContextLimit,
      promptSuggestionModel,
      modules,
      sshHosts: Array.isArray(userCfg.sshHosts) ? userCfg.sshHosts : [],
      themeVars,
      selectors: normalizedSelectors,
      allowedOrigins: Array.isArray(userCfg.allowedOrigins) ? userCfg.allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
      endpoints
    };

    if (!safeMode && process.env.AG_DAEMON_LIBRARY !== '1') {
      syncAgentLanguageRule(i18nLocale, Boolean(enabled && modules.i18n && syncAiOutputLang));
      syncSystemPromptAndHooks({
        enabled,
        customSystemPrompt,
        hookAutoAllow,
        flow: modules.flow ? flow : null,
        subagentRouting
      });
    }

    const activeStyleFiles = styleFiles.filter((filePath) => {
      const base = path.basename(filePath);
      if (base === '30-telemetry.css') return Boolean(modules.metrics);
      if (base === '40-prompt-suggestions.css') return Boolean(modules.promptSuggestions);
      if (base === '48-flow-mode-picker.css') return Boolean(modules.flow);
      if (base === '45-settings-ui.css' || base === '49-accounts-dashboard.css') return Boolean(enabled);
      return modules.theme !== false;
    });
    const baseCss = activeStyleFiles.map((f) => readTextSafe(f, '')).join('\n\n');
    const customCss = !safeMode && modules.customCss ? readTextSafe(path.join(USER_DIR, 'custom.css'), '') : '';
    const dictPath = modules.i18n ? resolveI18nDictPath(i18nLocale) : '';
    const baseDict = modules.i18n && dictPath ? readJsonSafe(dictPath, {}) : {};
    const rawOverrideDict =
      modules.i18n && !safeMode ? readJsonSafe(path.join(USER_DIR, 'i18n.override.json'), {}) : {};
    const mergedDict = modules.i18n ? Object.assign({}, baseDict, normalizeOverrideDict(rawOverrideDict)) : {};
    const customJs = !safeMode && modules.customJs ? readTextSafe(path.join(USER_DIR, 'custom.js'), '') : '';
    const runtimeTemplate = runtimeFiles.map((f) => readTextSafe(f, '')).join('\n');

    const hash = crypto
      .createHash('sha256')
      .update(String(enabled))
      .update(runtimeTemplate)
      .update(baseCss)
      .update(customCss)
      .update(JSON.stringify(mergedDict))
      .update(customJs)
      .update(
        JSON.stringify({
          preset,
          compactTypography,
          topbarUsageMetric,
          overviewQuota,
          overviewProgress,
          showClaudeQuota,
          i18nLocale,
          syncAiOutputLang,
          customSystemPrompt,
          hookAutoAllow,
          flow,
          autoTitle,
          subagentRouting,
          telemetryLayout,
          telemetryCacheMode,
          promptSuggestionModel,
          sshHosts: activeConfig.sshHosts,
          modules,
          themeVars,
          selectors: activeConfig.selectors
        })
      )
      .digest('hex')
      .slice(0, 8);

    const channelTag = channel === 'insiders' ? 'insiders' : 'stable';
    const currentBaseVersion = readBaseVersion();
    cachedPatchVersion = `${currentBaseVersion}-${channelTag}-${hash}`;

    const bootPayload = {
      version: cachedPatchVersion,
      platform: process.platform,
      enabled,
      preset,
      compactTypography,
      topbarUsageMetric,
      overviewQuota,
      overviewProgress,
      showClaudeQuota,
      i18nLocale,
      syncAiOutputLang,
      customSystemPrompt,
      hookAutoAllow,
      flow,
      autoTitle,
      subagentRouting,
      telemetryLayout,
      telemetryCacheMode,
      cssText: baseCss,
      customCss,
      themeVars,
      i18nDict: mergedDict,
      modules,
      selectors: activeConfig.selectors,
      userConfig: {
        enabled,
        channel,
        preset,
        compactTypography,
        topbarUsageMetric,
        overviewQuota,
        overviewProgress,
        showClaudeQuota,
        i18nLocale,
        syncAiOutputLang,
        customSystemPrompt,
        hookAutoAllow,
        flow,
        autoTitle,
        subagentRouting,
        telemetryLayout,
        telemetryCacheMode,
        contextLimit,
        promptSuggestionModel,
        sshHosts: activeConfig.sshHosts,
        modules,
        themeVars
      },
      customJs
    };

    cachedInjectScript = runtimeTemplate.replace(
      '})(__AG_BOOT_PAYLOAD__);',
      () => `})(${JSON.stringify(bootPayload)});`
    );
    cachedBundleSig = sig;
    return true;
  }

  function updateUserConfig(patch) {
    if (safeMode) return { ok: false, error: 'safeMode enabled' };
    const cfgPath = path.join(USER_DIR, 'config.json');
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      const current = readJsonSafe(cfgPath, {});
      const next = sanitizeConfigPatch(current, patch);
      const serialized = JSON.stringify(next, null, 2) + '\n';
      const tmpPath = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, serialized, 'utf8');
      try {
        fs.renameSync(tmpPath, cfgPath);
      } catch {
        fs.writeFileSync(cfgPath, serialized, 'utf8');
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
      cachedBundleSig = '';
      rebuildBundleIfNeeded();
      return { ok: true, config: activeConfig };
    } catch (err) {
      return { ok: false, error: err?.message || String(err || 'write failed') };
    }
  }

  return {
    rebuildBundleIfNeeded,
    updateUserConfig,
    getState: () => ({
      activeConfig,
      cachedInjectScript,
      cachedPatchVersion
    })
  };
}
