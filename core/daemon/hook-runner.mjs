#!/usr/bin/env node
/**
 * core/daemon/hook-runner.mjs — Cross-Platform Antigravity Lifecycle Hook Runner
 *
 * Executed synchronously by Antigravity via hooks.json (cmd /c on Windows, sh -c on POSIX).
 * Reads JSON payload from stdin and writes protocol-compliant JSON to stdout.
 *
 * Modes:
 *   node hook-runner.mjs system-prompt   # SessionStart / PreInvocation system prompt injector
 *   node hook-runner.mjs auto-allow      # PreToolUse tool auto-approval with destructive-command guard
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripUtf8Bom } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const USER_CONFIG_PATH = path.join(ROOT_DIR, 'user', 'config.json');

const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content'
]);

// High-risk / destructive command patterns that must stay interactive ("ask") under safe-cmd mode
export const DESTRUCTIVE_COMMAND_PATTERNS = Object.freeze([
  /(?:^|[;&|]\s*)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\$HOME|\*|\.\.)/i,
  /(?:^|[;&|]\s*)rm\s+-[a-z]*f[a-z]*r[a-z]*\s+(?:\/|~|\$HOME|\*|\.\.)/i,
  /\b(?:format|diskpart|mkfs(?:\.[a-z0-9]+)?|fdisk|dd\s+if=)\b/i,
  /\b(?:shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b/i,
  /\breg\s+delete\b/i,
  /\bRemove-Item\b[^\r\n]*-Recurse[^\r\n]*(?:C:\\(?:\s|$|["'])|\/(?:\s|$)|\$env:USERPROFILE|\$HOME)/i,
  /\bgit\s+push\b[^\r\n]*(?:--force\b|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*d/i,
  /\b(?:curl|wget|irm|Invoke-RestMethod|Invoke-WebRequest)\b[^\r\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i,
  /\b(?:DROP\s+DATABASE|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i
]);

export function isDestructiveCommandLine(cmdLine) {
  const s = String(cmdLine || '').trim();
  if (!s) return false;
  return DESTRUCTIVE_COMMAND_PATTERNS.some((re) => re.test(s));
}

export function evaluateSystemPromptHook(payload = {}, userCfg = {}) {
  if (!userCfg || userCfg.enabled === false) return {};
  const sp = userCfg.customSystemPrompt;
  if (!sp || sp.enabled !== true) return {};
  const text = typeof sp.text === 'string' ? sp.text.trim() : '';
  if (!text) return {};
  const mode = sp.mode || 'system-dual';
  if (mode !== 'system-dual' && mode !== 'session-start' && mode !== 'pre-invocation') return {};

  const eventName = String(payload?.hookEventName || '');
  if (eventName === 'PreInvocation') {
    if (mode !== 'pre-invocation') return {};
    const invNum = Number(payload?.invocationNum || 0);
    // By default inject once on the first invocation to protect prompt cache;
    // when everyInvocation is enabled, re-assert as systemMessage before every model call.
    if (!sp.everyInvocation && invNum > 1) return {};
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text
        }
      }
    ]
  };
}

export function evaluateAutoAllowHook(payload = {}, userCfg = {}) {
  if (!userCfg || userCfg.enabled === false) return { decision: 'ask' };
  const aa = userCfg.hookAutoAllow;
  if (!aa || aa.enabled !== true) return { decision: 'ask' };

  const mode = aa.mode || 'files';
  const toolName = String(payload?.toolCall?.name || '').trim().toLowerCase();
  if (!toolName) return { decision: 'ask' };

  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { decision: 'allow' };
  }

  if (toolName === 'run_command') {
    if (mode === 'files') {
      return { decision: 'ask' };
    }
    if (mode === 'all') {
      return { decision: 'allow' };
    }
    // safe-cmd mode: allow normal dev commands, escalate destructive commands to interactive approval
    const args = payload?.toolCall?.args || {};
    const cmdLine = String(args.CommandLine || args.commandLine || args.command || '');
    if (isDestructiveCommandLine(cmdLine)) {
      return {
        decision: 'ask',
        reason: 'Safety guard: potentially destructive command requires manual approval.'
      };
    }
    return { decision: 'allow' };
  }

  return { decision: 'ask' };
}

function readUserConfigSafe(cfgPath = USER_CONFIG_PATH) {
  try {
    if (!fs.existsSync(cfgPath)) return {};
    return JSON.parse(stripUtf8Bom(fs.readFileSync(cfgPath, 'utf8')));
  } catch {
    return {};
  }
}

function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    const timer = setTimeout(() => resolve({}), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(data.trim() ? JSON.parse(stripUtf8Bom(data)) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirect) {
  const action = process.argv[2] || '';
  const payload = await readStdinJson();
  const cfg = readUserConfigSafe();
  let result = {};
  if (action === 'system-prompt') {
    result = evaluateSystemPromptHook(payload, cfg);
  } else if (action === 'auto-allow') {
    result = evaluateAutoAllowHook(payload, cfg);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
