#!/usr/bin/env node
/**
 * scripts/sync-i18n.mjs — Upstream Chinese Localization Dictionary Synchronizer
 *
 * Merges curated Chinese locale packs from tracked upstreams:
 *   1. CHANPAJN/antigravity-langpack (GPL-3.0): primary zh-CN / zh-SG / zh-TW packs
 *   2. guuguo/antigravity-zh-launcher (MIT): supplementary IDE & UI phrases (zh-CN / zh-TW)
 *   3. Local 2.35.1+ clean supplements (no redundant parenthetical tails, keeps model/effort labels English)
 *
 * Usage:
 *   node scripts/sync-i18n.mjs                        # Fetch latest from GitHub upstreams
 *   node scripts/sync-i18n.mjs --from-local <refsDir> # Merge from local cloned upstreams
 *   node scripts/sync-i18n.mjs --dry-run              # Print diff stats without writing
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT_DIR, 'core');
const I18N_DIR = path.join(CORE_DIR, 'i18n');
const UPSTREAMS_PATH = path.join(CORE_DIR, 'upstreams.json');

export const SUPPORTED_CHINESE_LOCALES = Object.freeze(['zh-CN', 'zh-SG', 'zh-TW']);

// Model names, thinking effort tiers & technical labels that must stay untranslated
export const KEEP_UNTRANSLATED_KEYS = new Set([
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

export const UPSTREAM_SPECS = Object.freeze({
  theme: {
    id: 'antigravity-codex-theme',
    role: 'theme-and-runtime-base',
    repo: 'nkjDSLcvanv/antigravity-codex-theme',
    url: 'https://github.com/nkjDSLcvanv/antigravity-codex-theme',
    branch: 'main',
    license: 'MIT'
  },
  langpack: {
    id: 'antigravity-langpack',
    role: 'i18n-primary',
    repo: 'CHANPAJN/antigravity-langpack',
    url: 'https://github.com/CHANPAJN/antigravity-langpack',
    branch: 'main',
    license: 'GPL-3.0',
    files: {
      'zh-CN': 'dict/base.zh-CN.json',
      'zh-SG': 'dict/base.zh-SG.json',
      'zh-TW': 'dict/base.zh-TW.json'
    }
  },
  zhLauncher: {
    id: 'antigravity-zh-launcher',
    role: 'i18n-supplement-and-rules',
    repo: 'guuguo/antigravity-zh-launcher',
    url: 'https://github.com/guuguo/antigravity-zh-launcher',
    branch: 'main',
    license: 'MIT',
    files: {
      'zh-CN': 'locales/zh-CN.json',
      'zh-TW': 'locales/zh-TW.json'
    }
  },
  chuanban: {
    id: 'chuanban-antigravity-theme-patch',
    role: 'inspiration-and-research',
    repo: 'Anarcadia/chuanban-antigravity-theme-patch',
    url: 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch',
    branch: 'main',
    license: 'MIT'
  },
  contextViewer: {
    id: 'antigravity-context-viewer',
    role: 'multi-account-oauth-and-heatmap-reference',
    repo: 'elviscjn-cjn/antigravity-context-viewer',
    url: 'https://github.com/elviscjn-cjn/antigravity-context-viewer',
    branch: 'main',
    license: 'MIT'
  },
  agyPowertools: {
    id: 'agy-powertools',
    role: 'credential-vault-and-analytics-reference',
    repo: 'WhiteBr1ck/agy-powertools',
    url: 'https://github.com/WhiteBr1ck/agy-powertools',
    branch: 'main',
    license: 'MIT'
  }
});

// Clean Antigravity 2.35.1+ supplements missing from upstream packs
const LOCAL_SUPPLEMENTS = {
  'zh-CN': {
    'Applies to messages sent after this turn': '对本轮之后发送的消息生效',
    'Applies to /btw and messages sent after this turn': '对支线提问 (/btw) 及本轮之后发送的消息生效',
    'Customizations views': '自定义视图',
    'Too many requests, please try again in a bit!': '请求过于频繁，请稍后再试！',
    'Resource exhausted': '配额已耗尽',
    'Quota exhausted': '配额已耗尽',
    'Model quota exhausted': '模型配额已耗尽',
    'Model cannot be changed while the agent is running': '智能体运行期间无法切换模型',
    'Permissions cannot be changed while the agent is running': '智能体运行期间无法更改权限',
    'New automation': '新建自动化',
    'Failed to create automation.': '创建自动化失败。',
    'Failed to send queued message': '发送排队消息失败',
    'Plugin permissions': '插件权限',
    'Terminal window': '终端窗口',
    'Model selection': '模型选择',
    'Auto (detected)': '自动（检测）',
    'Search by name or username': '按名称或用户名搜索',
    'Ignore events triggered by the automation owner to avoid self-trigger loops.': '忽略由自动化所有者触发的事件，避免自触发循环。',
    "Matches this automation's active identity.": '匹配此自动化的当前身份。',
    'No plugin loads from this folder.': '该文件夹下未加载任何插件。',
    'Terminal: Select All': '终端：全选',
    'Select Sidebar Item 1': '选择侧边栏第 1 项',
    'Select Sidebar Item 2': '选择侧边栏第 2 项',
    'Select Sidebar Item 3': '选择侧边栏第 3 项',
    'Select Sidebar Item 4': '选择侧边栏第 4 项',
    'Select Sidebar Item 5': '选择侧边栏第 5 项',
    'Select Sidebar Item 6': '选择侧边栏第 6 项',
    'Select Sidebar Item 7': '选择侧边栏第 7 项',
    'Select Sidebar Item 8': '选择侧边栏第 8 项',
    'Select Sidebar Item 9': '选择侧边栏第 9 项',
    'Paste': '粘贴',
    'Leaving Soon': '即将下线'
  },
  'zh-SG': {
    'Applies to messages sent after this turn': '对本轮之后发送的消息生效',
    'Applies to /btw and messages sent after this turn': '对支线提问 (/btw) 及本轮之后发送的消息生效',
    'Customizations views': '自定义视图',
    'Too many requests, please try again in a bit!': '请求过于频繁，请稍后再试！',
    'Resource exhausted': '配额已耗尽',
    'Quota exhausted': '配额已耗尽',
    'Model quota exhausted': '模型配额已耗尽',
    'Model cannot be changed while the agent is running': 'Agent 运行期间无法切换模型',
    'Permissions cannot be changed while the agent is running': 'Agent 运行期间无法更改权限',
    'New automation': '新建 Automation',
    'Failed to create automation.': '创建 Automation 失败。',
    'Failed to send queued message': '发送排队消息失败',
    'Plugin permissions': 'Plugin 权限',
    'Terminal window': '终端窗口',
    'Model selection': '模型选择',
    'Auto (detected)': '自动（检测）',
    'Search by name or username': '按名称或用户名搜索',
    'Ignore events triggered by the automation owner to avoid self-trigger loops.': '忽略由 Automation 所有者触发的事件，避免自触发循环。',
    "Matches this automation's active identity.": '匹配此 Automation 的当前身份。',
    'No plugin loads from this folder.': '该文件夹下未加载任何 Plugin。',
    'Terminal: Select All': '终端：全选',
    'Select Sidebar Item 1': '选择侧边栏第 1 项',
    'Select Sidebar Item 2': '选择侧边栏第 2 项',
    'Select Sidebar Item 3': '选择侧边栏第 3 项',
    'Select Sidebar Item 4': '选择侧边栏第 4 项',
    'Select Sidebar Item 5': '选择侧边栏第 5 项',
    'Select Sidebar Item 6': '选择侧边栏第 6 项',
    'Select Sidebar Item 7': '选择侧边栏第 7 项',
    'Select Sidebar Item 8': '选择侧边栏第 8 项',
    'Select Sidebar Item 9': '选择侧边栏第 9 项',
    'Paste': '粘贴',
    'Leaving Soon': '即将下线'
  },
  'zh-TW': {
    'Applies to messages sent after this turn': '對本輪之後發送的訊息生效',
    'Applies to /btw and messages sent after this turn': '對支線提問 (/btw) 及本輪之後發送的訊息生效',
    'Customizations views': '自訂視圖',
    'Too many requests, please try again in a bit!': '請求過於頻繁，請稍後再試！',
    'Resource exhausted': '配額已用盡',
    'Quota exhausted': '配額已用盡',
    'Model quota exhausted': '模型配額已用盡',
    'Model cannot be changed while the agent is running': '代理執行期間無法切換模型',
    'Permissions cannot be changed while the agent is running': '代理執行期間無法變更權限',
    'New automation': '新增自動化',
    'Failed to create automation.': '建立自動化失敗。',
    'Failed to send queued message': '傳送佇列訊息失敗',
    'Plugin permissions': '外掛權限',
    'Terminal window': '終端機視窗',
    'Model selection': '模型選擇',
    'Auto (detected)': '自動（偵測）',
    'Search by name or username': '依名稱或使用者名稱搜尋',
    'Ignore events triggered by the automation owner to avoid self-trigger loops.': '忽略由自動化擁有者觸發的事件，避免自我觸發迴圈。',
    "Matches this automation's active identity.": '符合此自動化目前使用的身分。',
    'No plugin loads from this folder.': '此資料夾未載入任何外掛。',
    'Terminal: Select All': '終端機：全選',
    'Select Sidebar Item 1': '選取側邊欄第 1 項',
    'Select Sidebar Item 2': '選取側邊欄第 2 項',
    'Select Sidebar Item 3': '選取側邊欄第 3 項',
    'Select Sidebar Item 4': '選取側邊栏第 4 項'.replace('栏', '欄'),
    'Select Sidebar Item 5': '選取側邊欄第 5 項',
    'Select Sidebar Item 6': '選取側邊欄第 6 項',
    'Select Sidebar Item 7': '選取側邊欄第 7 項',
    'Select Sidebar Item 8': '選取側邊欄第 8 項',
    'Select Sidebar Item 9': '選取側邊欄第 9 項',
    'Paste': '貼上',
    'Leaving Soon': '即將下線'
  }
};

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function stripBom(raw) {
  return typeof raw === 'string' && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : String(raw || '');
}

function readGitHeadInfo(repoDir) {
  try {
    const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const date = execFileSync('git', ['-C', repoDir, 'log', '-1', '--format=%cs'], { encoding: 'utf8' }).trim();
    const subject = execFileSync('git', ['-C', repoDir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    return { commit: sha, shortCommit: sha.slice(0, 7), commitDate: date, commitSubject: subject };
  } catch {
    return { commit: '', shortCommit: '', commitDate: '', commitSubject: '' };
  }
}

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'antigravity-theme-sync-i18n', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return JSON.parse(stripBom(await res.text()));
}

async function fetchGithubHead(repo, branch) {
  try {
    const data = await fetchJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, 10000);
    const sha = String(data?.sha || '');
    const commitDate = String(data?.commit?.committer?.date || '').slice(0, 10);
    const commitSubject = String(data?.commit?.message || '').split('\n')[0].trim();
    return { commit: sha, shortCommit: sha.slice(0, 7), commitDate, commitSubject };
  } catch {
    return { commit: '', shortCommit: '', commitDate: '', commitSubject: '' };
  }
}

function buildRawUrl(repo, ref, relPath) {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${relPath.replace(/^\/+/, '')}`;
}

export function mergeLocaleDictionaries({ langpackDict = {}, zhLauncherPhrases = {}, localSupplements = {}, locale = 'zh-CN' }) {
  const merged = {};
  const seenLower = new Set();

  const tryAdd = (k, v, { overwrite = false } = {}) => {
    const key = String(k || '').trim();
    const val = typeof v === 'string' ? v.trim() : '';
    if (!key || !val) return;
    if (key.startsWith('__') || key.startsWith('_')) return;
    if (KEEP_UNTRANSLATED_KEYS.has(key)) return;
    const low = key.toLowerCase();
    if (!overwrite && (Object.prototype.hasOwnProperty.call(merged, key) || seenLower.has(low))) {
      return;
    }
    merged[key] = val;
    seenLower.add(low);
  };

  // 1. Primary curated entries from antigravity-langpack
  for (const [k, v] of Object.entries(langpackDict || {})) {
    tryAdd(k, v, { overwrite: true });
  }

  // 2. Supplementary IDE & UI entries from antigravity-zh-launcher (only fill missing keys)
  //    For zh-SG (English-tech-term variant), skip terms that translate Agent/Subagent/Artifact/Workspace
  const skipTechTermForSg = locale === 'zh-SG' ? /\b(?:agent|subagent|artifact|workspace|skill|plugin|mcp)\b/i : null;
  for (const [k, v] of Object.entries(zhLauncherPhrases || {})) {
    if (skipTechTermForSg && skipTechTermForSg.test(k)) continue;
    tryAdd(k, v, { overwrite: false });
  }

  // 3. Clean local 2.35.1+ supplements (fill missing keys)
  for (const [k, v] of Object.entries(localSupplements || {})) {
    tryAdd(k, v, { overwrite: false });
  }

  // Ensure keep-untranslated terms are never present
  for (const keep of KEEP_UNTRANSLATED_KEYS) {
    delete merged[keep];
  }

  return merged;
}

export async function syncChineseLocales({ fromLocalDir = '', dryRun = false } = {}) {
  const existingUpstreams = fs.existsSync(UPSTREAMS_PATH)
    ? JSON.parse(stripBom(fs.readFileSync(UPSTREAMS_PATH, 'utf8')))
    : {};

  let lpHead;
  let zlHead;
  const lpDicts = {};
  const zlDicts = {};

  if (fromLocalDir) {
    const lpDir = path.join(fromLocalDir, 'antigravity-langpack');
    const zlDir = path.join(fromLocalDir, 'antigravity-zh-launcher');
    if (!fs.existsSync(lpDir)) throw new Error(`Missing local antigravity-langpack directory: ${lpDir}`);
    if (!fs.existsSync(zlDir)) throw new Error(`Missing local antigravity-zh-launcher directory: ${zlDir}`);
    lpHead = readGitHeadInfo(lpDir);
    zlHead = readGitHeadInfo(zlDir);
    for (const [loc, rel] of Object.entries(UPSTREAM_SPECS.langpack.files)) {
      lpDicts[loc] = JSON.parse(stripBom(fs.readFileSync(path.join(lpDir, rel), 'utf8')));
    }
    for (const [loc, rel] of Object.entries(UPSTREAM_SPECS.zhLauncher.files)) {
      const raw = JSON.parse(stripBom(fs.readFileSync(path.join(zlDir, rel), 'utf8')));
      zlDicts[loc] = raw && typeof raw.phrases === 'object' ? raw.phrases : raw;
    }
  } else {
    lpHead = await fetchGithubHead(UPSTREAM_SPECS.langpack.repo, UPSTREAM_SPECS.langpack.branch);
    zlHead = await fetchGithubHead(UPSTREAM_SPECS.zhLauncher.repo, UPSTREAM_SPECS.zhLauncher.branch);
    const lpRef = lpHead.commit || UPSTREAM_SPECS.langpack.branch;
    const zlRef = zlHead.commit || UPSTREAM_SPECS.zhLauncher.branch;
    for (const [loc, rel] of Object.entries(UPSTREAM_SPECS.langpack.files)) {
      lpDicts[loc] = await fetchJson(buildRawUrl(UPSTREAM_SPECS.langpack.repo, lpRef, rel));
    }
    for (const [loc, rel] of Object.entries(UPSTREAM_SPECS.zhLauncher.files)) {
      const raw = await fetchJson(buildRawUrl(UPSTREAM_SPECS.zhLauncher.repo, zlRef, rel));
      zlDicts[loc] = raw && typeof raw.phrases === 'object' ? raw.phrases : raw;
    }
  }

  let cbHead;
  if (fromLocalDir) {
    const cbDir = path.join(fromLocalDir, 'chuanban-antigravity-theme-patch');
    if (fs.existsSync(cbDir)) cbHead = readGitHeadInfo(cbDir);
  } else {
    try {
      cbHead = await fetchGithubHead(UPSTREAM_SPECS.chuanban.repo, UPSTREAM_SPECS.chuanban.branch);
    } catch {
      cbHead = existingUpstreams?.upstreams?.chuanban;
    }
  }

  const themeHead = (() => {
    try {
      const sha = execFileSync('git', ['-C', ROOT_DIR, 'rev-parse', 'upstream/main'], { encoding: 'utf8' }).trim();
      const date = execFileSync('git', ['-C', ROOT_DIR, 'log', '-1', '--format=%cs', 'upstream/main'], { encoding: 'utf8' }).trim();
      return { commit: sha, shortCommit: sha.slice(0, 7), commitDate: date };
    } catch {
      return existingUpstreams?.upstreams?.theme || { commit: 'e3be59c', shortCommit: 'e3be59c', commitDate: '' };
    }
  })();

  const summary = {};
  const localeStats = {};

  if (!dryRun) {
    fs.mkdirSync(I18N_DIR, { recursive: true });
  }

  for (const loc of SUPPORTED_CHINESE_LOCALES) {
    const zlPhrases = loc === 'zh-TW' ? zlDicts['zh-TW'] : zlDicts['zh-CN'];
    const merged = mergeLocaleDictionaries({
      langpackDict: lpDicts[loc],
      zhLauncherPhrases: zlPhrases,
      localSupplements: LOCAL_SUPPLEMENTS[loc],
      locale: loc
    });
    const serialized = JSON.stringify(merged, null, 2) + '\n';
    const outPath = path.join(I18N_DIR, `${loc}.json`);
    const prevCount = fs.existsSync(outPath)
      ? Object.keys(JSON.parse(stripBom(fs.readFileSync(outPath, 'utf8')))).length
      : 0;
    if (!dryRun) {
      fs.writeFileSync(outPath, serialized, 'utf8');
      if (loc === 'zh-CN') {
        // Keep core/i18n.json in sync as backward-compatible default fallback
        fs.writeFileSync(path.join(CORE_DIR, 'i18n.json'), serialized, 'utf8');
      }
    }
    const count = Object.keys(merged).length;
    localeStats[loc] = {
      file: `core/i18n/${loc}.json`,
      entries: count,
      sha256: sha256Text(serialized)
    };
    summary[loc] = { prevCount, count, delta: count - prevCount };
  }

  const nowIso = new Date().toISOString();
  const upstreamsDoc = {
    schemaVersion: 1,
    updatedAt: nowIso,
    upstreams: {
      theme: {
        ...UPSTREAM_SPECS.theme,
        commit: themeHead.commit || existingUpstreams?.upstreams?.theme?.commit || '',
        shortCommit: themeHead.shortCommit || existingUpstreams?.upstreams?.theme?.shortCommit || '',
        commitDate: themeHead.commitDate || existingUpstreams?.upstreams?.theme?.commitDate || ''
      },
      langpack: {
        ...UPSTREAM_SPECS.langpack,
        commit: lpHead.commit || existingUpstreams?.upstreams?.langpack?.commit || '',
        shortCommit: lpHead.shortCommit || existingUpstreams?.upstreams?.langpack?.shortCommit || '',
        commitDate: lpHead.commitDate || existingUpstreams?.upstreams?.langpack?.commitDate || '',
        commitSubject: lpHead.commitSubject || existingUpstreams?.upstreams?.langpack?.commitSubject || ''
      },
      zhLauncher: {
        ...UPSTREAM_SPECS.zhLauncher,
        commit: zlHead.commit || existingUpstreams?.upstreams?.zhLauncher?.commit || '',
        shortCommit: zlHead.shortCommit || existingUpstreams?.upstreams?.zhLauncher?.shortCommit || '',
        commitDate: zlHead.commitDate || existingUpstreams?.upstreams?.zhLauncher?.commitDate || '',
        commitSubject: zlHead.commitSubject || existingUpstreams?.upstreams?.zhLauncher?.commitSubject || ''
      },
      chuanban: {
        ...UPSTREAM_SPECS.chuanban,
        commit: cbHead?.commit || existingUpstreams?.upstreams?.chuanban?.commit || 'bd8b937000000000000000000000000000000000',
        shortCommit: cbHead?.shortCommit || existingUpstreams?.upstreams?.chuanban?.shortCommit || 'bd8b937',
        commitDate: cbHead?.commitDate || existingUpstreams?.upstreams?.chuanban?.commitDate || '2026-11-25',
        commitSubject: cbHead?.commitSubject || existingUpstreams?.upstreams?.chuanban?.commitSubject || 'release: v6.0.4 — Antigravity 2.35.2 adaptation, Claude context menu (PR #46) & native menu i18n (#44)'
      },
      contextViewer: { ...UPSTREAM_SPECS.contextViewer },
      agyPowertools: { ...UPSTREAM_SPECS.agyPowertools }
    },
    locales: localeStats
  };

  if (!dryRun) {
    fs.writeFileSync(UPSTREAMS_PATH, JSON.stringify(upstreamsDoc, null, 2) + '\n', 'utf8');
  }

  return { ok: true, dryRun, summary, upstreams: upstreamsDoc };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirect) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  let fromLocalDir = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-local' && i + 1 < argv.length) fromLocalDir = argv[i + 1];
    else if (argv[i].startsWith('--from-local=')) fromLocalDir = argv[i].slice('--from-local='.length);
  }
  try {
    const res = await syncChineseLocales({ fromLocalDir, dryRun });
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('[sync-i18n] Failed:', err?.message || err);
    process.exit(1);
  }
}
