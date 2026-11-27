/**
 * core/flow/contract.mjs — Unified Flow Mode, Config Normalization & Outcome Contract
 */

export const VALID_FLOW_MODES = Object.freeze(['default', 'writing', 'engineering', 'full']);

export const VALID_SYSTEM_PROMPT_STRATEGIES = Object.freeze(['keep', 'seat-only']);

export const DEFAULT_CONTINUATION_TEXT =
  '继续输出正文：从已生成内容的中断处精确续写，不要重复已有内容，不要总结，不要致歉。';

export const OUTPUT_CHANNEL_FRAME = [
  '# 文件输出模式',
  '',
  '[文件输出约定]：本条仅在启用文件输出模式时生效。',
  '',
  '用户明确要求将成稿存盘，且宿主提供写文件工具时，通过写文件工具保存内容。遵循用户指定的路径、现有文件的覆盖确认和工具权限。',
  '',
  '文件保存成功后，对话回复给出文件路径和完成状态；用户要求预览时再提供对应内容。',
  '',
  '写工具不可用、被拒绝或保存失败时，如实报告结果，保留已生成内容。不得伪称已落盘。'
].join('\n');

export const DEFAULT_FLOW_CONFIG = Object.freeze({
  port: 18100,
  upstream: 'https://daily-cloudcode-pa.googleapis.com',
  defaultMode: 'default',
  modelPattern: 'gemini',
  maxContinuations: 3,
  refusalRewrite: true,
  outputChannelHardening: false,
  continuationText: DEFAULT_CONTINUATION_TEXT,
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
});

export const Outcome = Object.freeze({
  OK: 'OK',
  FILTER_TRIGGERED: 'FILTER_TRIGGERED',
  REFUSED: 'REFUSED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
  LENGTH_CAPPED: 'LENGTH_CAPPED',
  ABNORMAL: 'ABNORMAL'
});

const FILTER_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'RECITATION',
  'CONTENT_FILTER',
  'SPII',
  'IMAGE_SAFETY'
]);

const LENGTH_FINISH_REASONS = new Set(['MAX_TOKENS', 'LENGTH', 'MAX_OUTPUT_TOKENS', 'LENGTH_CAPPED']);

export function classifyFinishReason(reason) {
  const value = String(reason ?? '')
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, '_');
  if (value === 'STOP' || value === 'END_TURN' || value === 'COMPLETE' || value === 'OK') {
    return Outcome.OK;
  }
  if (FILTER_FINISH_REASONS.has(value)) return Outcome.FILTER_TRIGGERED;
  if (LENGTH_FINISH_REASONS.has(value)) return Outcome.LENGTH_CAPPED;
  if (value === 'REFUSED' || value === 'REFUSAL') return Outcome.REFUSED;
  if (/QUOTA|RESOURCE_EXHAUSTED|RATE_LIMIT/.test(value)) return Outcome.QUOTA_EXCEEDED;
  if (/CONTEXT|TOKEN_LIMIT/.test(value)) return Outcome.CONTEXT_OVERFLOW;
  return Outcome.ABNORMAL;
}

export function classifyError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? '');
  const status = error?.status ?? error?.statusCode;
  if (status === 429 || /quota|resource_exhausted|rate_limit/i.test(`${code} ${message}`)) {
    return Outcome.QUOTA_EXCEEDED;
  }
  if (/context_(?:length|window)_exceeded|token_limit|maximum_context|context_overflow/i.test(`${code} ${message}`)) {
    return Outcome.CONTEXT_OVERFLOW;
  }
  return null;
}

const VALID_MODEL_ID_RE = /^[a-zA-Z0-9._:/-]{2,80}$/;

function isValidRegexString(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (s.length > 200) return false;
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
}

export function normalizeFlowMode(raw, fallback = 'default') {
  const s = String(raw || '').trim().toLowerCase();
  return VALID_FLOW_MODES.includes(s) ? s : fallback;
}

export function normalizeFlowConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const portNum = Number(src.port);
  const port = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535 ? portNum : DEFAULT_FLOW_CONFIG.port;
  const rawUpstream = typeof src.upstream === 'string' ? src.upstream.trim() : '';
  const upstream =
    /^https?:\/\/[a-zA-Z0-9._:-]+(?:\/[^\s]*)?$/.test(rawUpstream) ? rawUpstream : DEFAULT_FLOW_CONFIG.upstream;
  const defaultMode = normalizeFlowMode(src.defaultMode, DEFAULT_FLOW_CONFIG.defaultMode);
  const rawPattern = typeof src.modelPattern === 'string' ? src.modelPattern.trim() : DEFAULT_FLOW_CONFIG.modelPattern;
  const modelPattern = isValidRegexString(rawPattern) ? rawPattern : DEFAULT_FLOW_CONFIG.modelPattern;
  const maxContNum = Number(src.maxContinuations);
  const maxContinuations = Number.isInteger(maxContNum)
    ? Math.max(0, Math.min(8, maxContNum))
    : DEFAULT_FLOW_CONFIG.maxContinuations;
  const timeoutNum = Number(src.judgeTimeoutMs);
  const judgeTimeoutMs = Number.isFinite(timeoutNum)
    ? Math.max(1000, Math.min(120000, Math.round(timeoutNum)))
    : DEFAULT_FLOW_CONFIG.judgeTimeoutMs;
  const rawJudgeModel = typeof src.judgeModel === 'string' ? src.judgeModel.trim() : '';
  const judgeModel =
    rawJudgeModel && !rawJudgeModel.startsWith('-') && VALID_MODEL_ID_RE.test(rawJudgeModel)
      ? rawJudgeModel
      : DEFAULT_FLOW_CONFIG.judgeModel;
  const rawRemapModel = typeof src.remapTargetModel === 'string' ? src.remapTargetModel.trim() : '';
  const remapTargetModel =
    rawRemapModel && !rawRemapModel.startsWith('-') && VALID_MODEL_ID_RE.test(rawRemapModel)
      ? rawRemapModel
      : DEFAULT_FLOW_CONFIG.remapTargetModel;
  const systemPromptStrategy = VALID_SYSTEM_PROMPT_STRATEGIES.includes(src.systemPromptStrategy)
    ? src.systemPromptStrategy
    : DEFAULT_FLOW_CONFIG.systemPromptStrategy;
  const continuationText =
    typeof src.continuationText === 'string' && src.continuationText.trim()
      ? src.continuationText.slice(0, 1000)
      : DEFAULT_FLOW_CONFIG.continuationText;
  const defaultSeat = typeof src.defaultSeat === 'string' ? src.defaultSeat.slice(0, 20000) : '';
  const writingSeat = typeof src.writingSeat === 'string' ? src.writingSeat.slice(0, 20000) : '';
  const engineeringSeat = typeof src.engineeringSeat === 'string' ? src.engineeringSeat.slice(0, 20000) : '';
  const fullSeat = typeof src.fullSeat === 'string' ? src.fullSeat.slice(0, 20000) : '';
  const compactThresholdNum = Number(src.compactThresholdPct);
  const compactThresholdPct = Number.isFinite(compactThresholdNum)
    ? Math.max(50, Math.min(88, Math.round(compactThresholdNum)))
    : DEFAULT_FLOW_CONFIG.compactThresholdPct;
  const compactKeepNum = Number(src.compactKeepTailTokens);
  const compactKeepTailTokens = Number.isFinite(compactKeepNum)
    ? Math.max(4000, Math.min(60000, Math.round(compactKeepNum)))
    : DEFAULT_FLOW_CONFIG.compactKeepTailTokens;
  const rawCompactModel = typeof src.compactModel === 'string' ? src.compactModel.trim() : '';
  const compactModel =
    rawCompactModel && !rawCompactModel.startsWith('-') && VALID_MODEL_ID_RE.test(rawCompactModel)
      ? rawCompactModel
      : '';

  return {
    port,
    upstream,
    defaultMode,
    modelPattern,
    maxContinuations,
    refusalRewrite: src.refusalRewrite !== false,
    outputChannelHardening: Boolean(src.outputChannelHardening),
    continuationText,
    judgeEnabled: Boolean(src.judgeEnabled),
    judgeModel,
    judgeTimeoutMs,
    softenEnabled: src.softenEnabled !== false,
    remapEnabled: Boolean(src.remapEnabled),
    remapTargetModel,
    systemPromptStrategy,
    defaultSeat,
    writingSeat,
    engineeringSeat,
    fullSeat,
    compactEnabled: Boolean(src.compactEnabled),
    compactThresholdPct,
    compactKeepTailTokens,
    compactModel
  };
}

export function sanitizeFlowPatch(base, patch) {
  if (!patch || typeof patch !== 'object') return;
  if (!patch.flow || typeof patch.flow !== 'object') return;
  const cur = normalizeFlowConfig(base.flow);
  const p = patch.flow;
  const merged = { ...cur };

  if (p.port !== undefined) {
    const n = Number(p.port);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) merged.port = n;
  }
  if (typeof p.upstream === 'string' && /^https?:\/\/[a-zA-Z0-9._:-]+(?:\/[^\s]*)?$/.test(p.upstream.trim())) {
    merged.upstream = p.upstream.trim();
  }
  if (typeof p.defaultMode === 'string' && VALID_FLOW_MODES.includes(p.defaultMode.trim().toLowerCase())) {
    merged.defaultMode = p.defaultMode.trim().toLowerCase();
  }
  if (typeof p.modelPattern === 'string' && isValidRegexString(p.modelPattern)) {
    merged.modelPattern = p.modelPattern.trim();
  }
  if (p.maxContinuations !== undefined) {
    const n = Number(p.maxContinuations);
    if (Number.isInteger(n) && n >= 0 && n <= 8) merged.maxContinuations = n;
  }
  if (typeof p.refusalRewrite === 'boolean') merged.refusalRewrite = p.refusalRewrite;
  if (typeof p.outputChannelHardening === 'boolean') merged.outputChannelHardening = p.outputChannelHardening;
  if (typeof p.continuationText === 'string') {
    merged.continuationText = p.continuationText.trim()
      ? p.continuationText.slice(0, 1000)
      : DEFAULT_FLOW_CONFIG.continuationText;
  }
  if (typeof p.judgeEnabled === 'boolean') merged.judgeEnabled = p.judgeEnabled;
  if (typeof p.judgeModel === 'string') {
    const m = p.judgeModel.trim();
    if (m && !m.startsWith('-') && VALID_MODEL_ID_RE.test(m)) merged.judgeModel = m;
  }
  if (p.judgeTimeoutMs !== undefined) {
    const n = Number(p.judgeTimeoutMs);
    if (Number.isFinite(n) && n >= 1000 && n <= 120000) merged.judgeTimeoutMs = Math.round(n);
  }
  if (typeof p.softenEnabled === 'boolean') merged.softenEnabled = p.softenEnabled;
  if (typeof p.remapEnabled === 'boolean') merged.remapEnabled = p.remapEnabled;
  if (typeof p.remapTargetModel === 'string') {
    const m = p.remapTargetModel.trim();
    if (m && !m.startsWith('-') && VALID_MODEL_ID_RE.test(m)) merged.remapTargetModel = m;
  }
  if (VALID_SYSTEM_PROMPT_STRATEGIES.includes(p.systemPromptStrategy)) {
    merged.systemPromptStrategy = p.systemPromptStrategy;
  }
  if (typeof p.defaultSeat === 'string') merged.defaultSeat = p.defaultSeat.slice(0, 20000);
  if (typeof p.writingSeat === 'string') merged.writingSeat = p.writingSeat.slice(0, 20000);
  if (typeof p.engineeringSeat === 'string') merged.engineeringSeat = p.engineeringSeat.slice(0, 20000);
  if (typeof p.fullSeat === 'string') merged.fullSeat = p.fullSeat.slice(0, 20000);
  if (typeof p.compactEnabled === 'boolean') merged.compactEnabled = p.compactEnabled;
  if (p.compactThresholdPct !== undefined) {
    const n = Number(p.compactThresholdPct);
    if (Number.isFinite(n) && n >= 50 && n <= 88) merged.compactThresholdPct = Math.round(n);
  }
  if (p.compactKeepTailTokens !== undefined) {
    const n = Number(p.compactKeepTailTokens);
    if (Number.isFinite(n) && n >= 4000 && n <= 60000) merged.compactKeepTailTokens = Math.round(n);
  }
  if (typeof p.compactModel === 'string') {
    const m = p.compactModel.trim();
    if (!m) merged.compactModel = '';
    else if (!m.startsWith('-') && VALID_MODEL_ID_RE.test(m)) merged.compactModel = m;
  }

  base.flow = normalizeFlowConfig(merged);
}

export function compileModelPattern(patternStr) {
  const s = String(patternStr || '').trim();
  if (!s) return null;
  try {
    return new RegExp(s, 'i');
  } catch {
    return null;
  }
}
