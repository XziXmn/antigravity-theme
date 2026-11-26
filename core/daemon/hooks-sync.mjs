/**
 * core/daemon/hooks-sync.mjs — Managed Custom System Prompt Rules & Lifecycle Hooks Synchronizer
 *
 * Safely manages:
 *   1. ~/.gemini/config/rules/98_antigravity_theme_system_prompt.md (when mode === 'rule')
 *   2. ~/.gemini/config/hooks.json keys:
 *        - "ag-theme-system-prompt" (SessionStart / PreInvocation)
 *        - "ag-theme-auto-allow"    (PreToolUse)
 *      Preserves all user-defined hooks in hooks.json completely untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStableNodeExecPath, stripUtf8Bom } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SYSTEM_PROMPT_RULE_FILENAME = '98_antigravity_theme_system_prompt.md';
export const GLOBAL_GEMINI_FILENAME = 'GEMINI.md';
export const GEMINI_BLOCK_START = '<!-- antigravity-theme:system-prompt:start -->';
export const GEMINI_BLOCK_END = '<!-- antigravity-theme:system-prompt:end -->';
export const HOOK_KEY_SYSTEM_PROMPT = 'ag-theme-system-prompt';
export const HOOK_KEY_AUTO_ALLOW = 'ag-theme-auto-allow';
export const MAX_CUSTOM_PROMPT_LENGTH = 20000;

export const VALID_SYSTEM_PROMPT_MODES = Object.freeze([
  'system-dual',
  'global-gemini',
  'rule',
  'session-start',
  'pre-invocation',
  'flow-proxy'
]);
export const VALID_AUTO_ALLOW_MODES = Object.freeze(['files', 'safe-cmd', 'all']);

export const DEFAULT_CUSTOM_SYSTEM_PROMPT = Object.freeze({
  enabled: false,
  mode: 'flow-proxy',
  text: '',
  everyInvocation: false
});

export const DEFAULT_HOOK_AUTO_ALLOW = Object.freeze({
  enabled: false,
  mode: 'files'
});

export function normalizeCustomSystemPrompt(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = VALID_SYSTEM_PROMPT_MODES.includes(src.mode) ? src.mode : 'flow-proxy';
  const text = typeof src.text === 'string' ? src.text.slice(0, MAX_CUSTOM_PROMPT_LENGTH) : '';
  return {
    enabled: Boolean(src.enabled),
    mode,
    text,
    everyInvocation: Boolean(src.everyInvocation)
  };
}

export function normalizeHookAutoAllow(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = VALID_AUTO_ALLOW_MODES.includes(src.mode) ? src.mode : 'files';
  return {
    enabled: Boolean(src.enabled),
    mode
  };
}

export function sanitizePromptAndHooksPatch(base, patch) {
  if (!patch || typeof patch !== 'object') return;
  if (patch.customSystemPrompt && typeof patch.customSystemPrompt === 'object') {
    const cur = normalizeCustomSystemPrompt(base.customSystemPrompt);
    const next = { ...cur };
    if (typeof patch.customSystemPrompt.enabled === 'boolean') {
      next.enabled = patch.customSystemPrompt.enabled;
    }
    if (VALID_SYSTEM_PROMPT_MODES.includes(patch.customSystemPrompt.mode)) {
      next.mode = patch.customSystemPrompt.mode;
    }
    if (typeof patch.customSystemPrompt.text === 'string') {
      next.text = patch.customSystemPrompt.text.slice(0, MAX_CUSTOM_PROMPT_LENGTH);
    }
    if (typeof patch.customSystemPrompt.everyInvocation === 'boolean') {
      next.everyInvocation = patch.customSystemPrompt.everyInvocation;
    }
    base.customSystemPrompt = next;
  }
  if (patch.hookAutoAllow && typeof patch.hookAutoAllow === 'object') {
    const cur = normalizeHookAutoAllow(base.hookAutoAllow);
    const next = { ...cur };
    if (typeof patch.hookAutoAllow.enabled === 'boolean') {
      next.enabled = patch.hookAutoAllow.enabled;
    }
    if (VALID_AUTO_ALLOW_MODES.includes(patch.hookAutoAllow.mode)) {
      next.mode = patch.hookAutoAllow.mode;
    }
    base.hookAutoAllow = next;
  }
}

function buildHookCommand(nodeExec, runnerPath, action) {
  const quotedNode = JSON.stringify(nodeExec);
  const quotedRunner = JSON.stringify(runnerPath);
  return `${quotedNode} ${quotedRunner} ${action}`;
}

export function hasUtf8Bom(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(3);
      const n = fs.readSync(fd, head, 0, 3, 0);
      return n === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function writeFileAtomicIfChanged(filePath, content, { stripBom = false } = {}) {
  if (fs.existsSync(filePath)) {
    try {
      const hasBom = stripBom && hasUtf8Bom(filePath);
      if (!hasBom && fs.readFileSync(filePath, 'utf8') === content) return false;
    } catch {}
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.writeFileSync(filePath, content, 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
  return true;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GEMINI_BLOCK_RE = new RegExp(
  `${escapeRegExp(GEMINI_BLOCK_START)}[\\s\\S]*?${escapeRegExp(GEMINI_BLOCK_END)}`,
  'g'
);

export function syncManagedGeminiMd(geminiPath, promptText, active) {
  const existed = fs.existsSync(geminiPath);
  const existingRaw = existed ? stripUtf8Bom(fs.readFileSync(geminiPath, 'utf8')) : '';
  const stripped = existingRaw.replace(GEMINI_BLOCK_RE, '').trim();

  if (!active) {
    if (!existed || !existingRaw.includes(GEMINI_BLOCK_START)) return '';
    if (!stripped) {
      try {
        fs.unlinkSync(geminiPath);
      } catch {}
      return '';
    }
    try {
      writeFileAtomicIfChanged(geminiPath, stripped + '\n');
    } catch {}
    return '';
  }

  const block = [
    GEMINI_BLOCK_START,
    '# System-Level Custom Instructions',
    '',
    promptText,
    GEMINI_BLOCK_END
  ].join('\n');

  const nextContent = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  try {
    writeFileAtomicIfChanged(geminiPath, nextContent);
    return geminiPath;
  } catch {
    return '';
  }
}

export function syncSystemPromptAndHooks(
  {
    enabled = true,
    customSystemPrompt = DEFAULT_CUSTOM_SYSTEM_PROMPT,
    hookAutoAllow = DEFAULT_HOOK_AUTO_ALLOW,
    flow = null,
    subagentRouting = null
  } = {},
  {
    customHome = '',
    runnerPath = path.join(__dirname, 'hook-runner.mjs'),
    nodeExec = resolveStableNodeExecPath()
  } = {}
) {
  const home = customHome || os.homedir();
  const geminiRootDir = path.join(home, '.gemini');
  const configDir = path.join(geminiRootDir, 'config');
  const rulesDir = path.join(configDir, 'rules');
  const rulePath = path.join(rulesDir, SYSTEM_PROMPT_RULE_FILENAME);
  const geminiMdPath = path.join(geminiRootDir, GLOBAL_GEMINI_FILENAME);
  const hooksPath = path.join(configDir, 'hooks.json');

  const sp = normalizeCustomSystemPrompt(customSystemPrompt);
  const aa = normalizeHookAutoAllow(hookAutoAllow);

  const spTextTrimmed = sp.text.trim();
  const hasModeSeat = Boolean(
    flow &&
      typeof flow === 'object' &&
      ['defaultSeat', 'writingSeat', 'engineeringSeat', 'fullSeat'].some(
        (k) => typeof flow[k] === 'string' && flow[k].trim().length > 0
      )
  );
  const hasSubagentRouting = Boolean(
    subagentRouting &&
      typeof subagentRouting === 'object' &&
      subagentRouting.enabled &&
      Array.isArray(subagentRouting.allowedModels) &&
      subagentRouting.allowedModels.length > 0
  );
  const spFileActive = Boolean(enabled && sp.enabled && spTextTrimmed);
  const spHookActive = Boolean(enabled && ((sp.enabled && (spTextTrimmed || hasModeSeat)) || hasSubagentRouting));
  const aaActive = Boolean(enabled && aa.enabled);

  const useGeminiMd = spFileActive && (sp.mode === 'system-dual' || sp.mode === 'global-gemini');
  const useRuleMd = spFileActive && sp.mode === 'rule';
  const useHookPrompt =
    spHookActive &&
    (sp.mode === 'system-dual' ||
      sp.mode === 'session-start' ||
      sp.mode === 'pre-invocation' ||
      (hasSubagentRouting && !flow));

  // 1. Sync system-wide ~/.gemini/GEMINI.md (managed block, preserves any user-authored text)
  const syncedGeminiPath = syncManagedGeminiMd(geminiMdPath, spTextTrimmed, useGeminiMd);

  // 2. Sync modular global rule file with required YAML frontmatter (trigger: always_on)
  if (useRuleMd) {
    const ruleContent = [
      '---',
      'trigger: always_on',
      'description: "User-defined global system prompt managed by antigravity-theme."',
      '---',
      '',
      '<!-- antigravity-theme:customSystemPrompt -->',
      '# Custom System Prompt',
      '',
      spTextTrimmed,
      ''
    ].join('\n');
    try {
      writeFileAtomicIfChanged(rulePath, ruleContent);
    } catch {}
  } else {
    try {
      if (fs.existsSync(rulePath)) fs.unlinkSync(rulePath);
    } catch {}
  }

  // 3. Sync managed entries in ~/.gemini/config/hooks.json without touching user-defined hooks
  let hooksObj = {};
  const hooksFileExisted = fs.existsSync(hooksPath);
  if (hooksFileExisted) {
    try {
      const parsed = JSON.parse(stripUtf8Bom(fs.readFileSync(hooksPath, 'utf8')));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hooksObj = parsed;
      }
    } catch {
      // Do not overwrite corrupted user hooks.json
      return {
        geminiMdPath: syncedGeminiPath,
        rulePath: useRuleMd ? rulePath : '',
        hooksPath: '',
        skippedCorruptHooks: true
      };
    }
  }

  const hadSpKey = Object.prototype.hasOwnProperty.call(hooksObj, HOOK_KEY_SYSTEM_PROMPT);
  const hadAaKey = Object.prototype.hasOwnProperty.call(hooksObj, HOOK_KEY_AUTO_ALLOW);

  if (useHookPrompt) {
    const eventKey = sp.mode === 'pre-invocation' ? 'PreInvocation' : 'SessionStart';
    hooksObj[HOOK_KEY_SYSTEM_PROMPT] = {
      [eventKey]: [
        {
          type: 'command',
          command: buildHookCommand(nodeExec, runnerPath, 'system-prompt'),
          timeout: 10
        }
      ]
    };
  } else if (hadSpKey) {
    delete hooksObj[HOOK_KEY_SYSTEM_PROMPT];
  }

  if (aaActive) {
    const matcher =
      aa.mode === 'files'
        ? 'write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content'
        : 'run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content';
    hooksObj[HOOK_KEY_AUTO_ALLOW] = {
      PreToolUse: [
        {
          matcher,
          hooks: [
            {
              type: 'command',
              command: buildHookCommand(nodeExec, runnerPath, 'auto-allow'),
              timeout: 5
            }
          ]
        }
      ]
    };
  } else if (hadAaKey) {
    delete hooksObj[HOOK_KEY_AUTO_ALLOW];
  }

  const remainingKeys = Object.keys(hooksObj);
  if (remainingKeys.length === 0) {
    if (hooksFileExisted && (hadSpKey || hadAaKey)) {
      try {
        fs.unlinkSync(hooksPath);
      } catch {}
    }
  } else if (useHookPrompt || aaActive || hadSpKey || hadAaKey || (hooksFileExisted && hasUtf8Bom(hooksPath))) {
    try {
      writeFileAtomicIfChanged(hooksPath, JSON.stringify(hooksObj, null, 2) + '\n', { stripBom: true });
    } catch {}
  }

  return {
    geminiMdPath: syncedGeminiPath,
    rulePath: useRuleMd ? rulePath : '',
    hooksPath: remainingKeys.length > 0 && (useHookPrompt || aaActive) ? hooksPath : '',
    skippedCorruptHooks: false
  };
}
