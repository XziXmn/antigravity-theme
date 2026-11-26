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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripUtf8Bom } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const USER_CONFIG_PATH = path.join(ROOT_DIR, 'user', 'config.json');
const FLOW_SESSIONS_PATH = path.join(ROOT_DIR, 'user', 'flow-sessions.json');
const HOOK_PROMPT_STATE_PATH = path.join(ROOT_DIR, 'user', '.hook-prompt-state.json');
const HOOK_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

let buildSubagentRoutingPrompt = () => '';
if (fs.existsSync(path.join(__dirname, '..', 'flow', 'subagent-routing.mjs'))) {
  try {
    const srMod = await import('../flow/subagent-routing.mjs');
    if (typeof srMod.buildSubagentRoutingPrompt === 'function') {
      buildSubagentRoutingPrompt = srMod.buildSubagentRoutingPrompt;
    }
  } catch {}
}

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

function extractHookConversationMeta(payload = {}) {
  const candidates = [
    payload.cascadeId,
    payload.conversationId,
    payload.trajectoryId,
    payload.sessionId,
    payload.session_id,
    payload.conversation_id,
    payload.trajectory_id,
    payload.transcriptPath,
    payload.transcript_path
  ];
  let cid = '';
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.trim()) continue;
    const m = c.match(HOOK_UUID_RE);
    if (m && m[1]) {
      cid = m[1];
      break;
    }
  }
  const parentCandidates = [
    payload.parentCascadeId,
    payload.parentConversationId,
    payload.parentTrajectoryId,
    payload.parent_conversation_id,
    payload.parent_trajectory_id
  ];
  let parentId = '';
  for (const p of parentCandidates) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const m = p.match(HOOK_UUID_RE);
    if (m && m[1]) {
      parentId = m[1];
      break;
    }
  }
  const roleStr = String(payload.agentRole || payload.subagentRole || payload.role || '');
  const isSubagent = Boolean(
    parentId ||
      payload.isSubagent === true ||
      payload.is_subagent === true ||
      payload.subagent === true ||
      /subagent|worker/i.test(roleStr)
  );
  return { cid, parentId, isSubagent };
}

function getFlowModePromptText(mode, flowCfg) {
  if (!flowCfg || typeof flowCfg !== 'object') return '';
  if (mode === 'writing') return String(flowCfg.writingSeat || '').trim();
  if (mode === 'engineering') return String(flowCfg.engineeringSeat || '').trim();
  if (mode === 'full') {
    const explicitFull = String(flowCfg.fullSeat || '').trim();
    if (explicitFull) return explicitFull;
    return [String(flowCfg.writingSeat || '').trim(), String(flowCfg.engineeringSeat || '').trim()]
      .filter(Boolean)
      .join('\n\n');
  }
  return String(flowCfg.defaultSeat || '').trim();
}

function dedupePush(list, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (list.some((x) => x === clean)) return;
  list.push(clean);
}

function hashPromptFingerprint(mode, text) {
  return crypto.createHash('sha256').update(`${mode}\n---\n${text}`).digest('hex').slice(0, 16);
}

export function evaluateSystemPromptHook(payload = {}, userCfg = {}, flowSessions = null, hookState = null) {
  if (!userCfg || userCfg.enabled === false) return {};
  const sp = userCfg.customSystemPrompt && typeof userCfg.customSystemPrompt === 'object' ? userCfg.customSystemPrompt : {};
  const mode = sp.mode || 'flow-proxy';
  const flowEnabled = userCfg.modules?.flow !== false;
  const subRoutingCfg = userCfg.subagentRouting && typeof userCfg.subagentRouting === 'object' ? userCfg.subagentRouting : null;
  const hasSubRouting = Boolean(
    subRoutingCfg && subRoutingCfg.enabled && Array.isArray(subRoutingCfg.allowedModels) && subRoutingCfg.allowedModels.length > 0
  );

  const isHookMode = mode === 'system-dual' || mode === 'session-start' || mode === 'pre-invocation';
  const spActive = Boolean(sp.enabled === true && isHookMode);
  const subHookActive = Boolean(hasSubRouting && (isHookMode || !flowEnabled));
  if (!spActive && !subHookActive) return {};

  const eventName = String(payload?.hookEventName || '');
  if (eventName === 'PreInvocation' && mode !== 'pre-invocation' && !subHookActive) return {};

  const globalText = spActive && typeof sp.text === 'string' ? sp.text.trim() : '';
  const flowCfg = userCfg.flow && typeof userCfg.flow === 'object' ? userCfg.flow : {};
  const sessionsMap =
    flowSessions && typeof flowSessions === 'object' && flowSessions.sessions && typeof flowSessions.sessions === 'object'
      ? flowSessions.sessions
      : {};

  const { cid, parentId, isSubagent } = extractHookConversationMeta(payload);
  let activeSessionRec = cid && sessionsMap[cid] ? sessionsMap[cid] : null;
  let activeFlowMode = activeSessionRec?.mode || flowCfg.defaultMode || 'default';
  if (isSubagent && !activeSessionRec && parentId && sessionsMap[parentId]) {
    activeFlowMode = sessionsMap[parentId].mode || activeFlowMode;
  }

  const parts = [];
  const modeText = spActive && flowEnabled ? getFlowModePromptText(activeFlowMode, flowCfg) : '';
  const sessionNote =
    spActive && flowEnabled && activeSessionRec?.seatOverride ? String(activeSessionRec.seatOverride).trim() : '';
  const subRoutingPrompt = !isSubagent && subHookActive ? buildSubagentRoutingPrompt(subRoutingCfg) : '';

  dedupePush(parts, globalText);
  dedupePush(parts, modeText);
  dedupePush(parts, sessionNote);
  dedupePush(parts, subRoutingPrompt);

  const assembled = parts.join('\n\n').trim();
  if (!assembled) return {};

  if (eventName === 'PreInvocation' && !sp.everyInvocation) {
    const fp = hashPromptFingerprint(activeFlowMode, assembled);
    if (cid && hookState && typeof hookState === 'object') {
      const prev = hookState[cid];
      if (prev && prev.hash === fp) {
        return {};
      }
      hookState[cid] = { hash: fp, mode: activeFlowMode, at: Date.now() };
      hookState.__dirty = true;
    } else {
      const invNum = Number(payload?.invocationNum || 0);
      if (invNum > 1) return {};
    }
  } else if (eventName === 'PreInvocation' && cid && hookState && typeof hookState === 'object') {
    hookState[cid] = {
      hash: hashPromptFingerprint(activeFlowMode, assembled),
      mode: activeFlowMode,
      at: Date.now()
    };
    hookState.__dirty = true;
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: assembled
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

function writeHookStateSafe(stateObj, statePath = HOOK_PROMPT_STATE_PATH) {
  if (!stateObj || !stateObj.__dirty) return;
  try {
    const clean = {};
    const entries = Object.entries(stateObj)
      .filter(([k, v]) => k !== '__dirty' && v && typeof v === 'object' && typeof v.hash === 'string')
      .sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
      .slice(0, 120);
    for (const [k, v] of entries) {
      clean[k] = { hash: v.hash, mode: v.mode || 'default', at: Number(v.at || Date.now()) };
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, statePath);
    } catch {
      fs.writeFileSync(statePath, JSON.stringify(clean, null, 2) + '\n', 'utf8');
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  } catch {}
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirect) {
  const action = process.argv[2] || '';
  const payload = await readStdinJson();
  const cfg = readUserConfigSafe();
  const flowSessions = readUserConfigSafe(FLOW_SESSIONS_PATH);
  let result = {};
  if (action === 'system-prompt') {
    const hookState = readUserConfigSafe(HOOK_PROMPT_STATE_PATH);
    result = evaluateSystemPromptHook(payload, cfg, flowSessions, hookState);
    writeHookStateSafe(hookState);
  } else if (action === 'auto-allow') {
    result = evaluateAutoAllowHook(payload, cfg);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
