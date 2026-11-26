/**
 * core/flow/subagent-routing.mjs — Subagent Allowed-Model Whitelist, Prompt Policy Builder & Proxy Model Router
 *
 * Allows users to curate a whitelist of models (both native Antigravity models and custom/third-party IDs
 * such as `deepseek-4.1`), authorizes the main session agent to assign subagent models by task difficulty,
 * and enforces exact model routing at the local proxy layer (supporting `[model:<id>]` tags in subagent prompts).
 */

export const VALID_SUBAGENT_TIERS = Object.freeze(['fast', 'balanced', 'strong']);
const VALID_MODEL_ID_RE = /^[a-zA-Z0-9._:/-]{2,80}$/;

export const DEFAULT_SUBAGENT_ROUTING = Object.freeze({
  enabled: false,
  allowedModels: Object.freeze([])
});

export function inferDefaultTier(modelId) {
  const low = String(modelId || '').toLowerCase();
  if (/flash|lite|mini|haiku|small|fast|worker|m669|low$/.test(low)) return 'fast';
  if (/opus|xhigh|max|pro|r1|reasoner|4\.1|high$/.test(low)) return 'strong';
  return 'balanced';
}

export function normalizeSubagentModelEntry(raw) {
  if (typeof raw === 'string') {
    const id = raw.trim();
    if (!id || id.startsWith('-') || !VALID_MODEL_ID_RE.test(id)) return null;
    return { id, tier: inferDefaultTier(id), note: '' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id || id.startsWith('-') || !VALID_MODEL_ID_RE.test(id)) return null;
  const tier = VALID_SUBAGENT_TIERS.includes(raw.tier) ? raw.tier : inferDefaultTier(id);
  const note = typeof raw.note === 'string' ? raw.note.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) : '';
  return { id, tier, note };
}

export function normalizeSubagentRouting(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.allowedModels) ? src.allowedModels : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const norm = normalizeSubagentModelEntry(item);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);
    out.push(norm);
    if (out.length >= 24) break;
  }
  return {
    enabled: Boolean(src.enabled),
    allowedModels: out
  };
}

export function sanitizeSubagentRoutingPatch(base, patch) {
  if (!patch || typeof patch !== 'object') return;
  if (!patch.subagentRouting || typeof patch.subagentRouting !== 'object') return;
  const cur = normalizeSubagentRouting(base.subagentRouting);
  const p = patch.subagentRouting;
  const merged = {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.enabled,
    allowedModels: Array.isArray(p.allowedModels) ? p.allowedModels : cur.allowedModels
  };
  base.subagentRouting = normalizeSubagentRouting(merged);
}

const TIER_DESC = Object.freeze({
  fast: '轻量/快速（适合搜索、文件浏览、简单校验、批量提取）',
  balanced: '均衡/主力（适合常规编码、文档整理、单元测试）',
  strong: '高阶/深度（适合复杂架构、疑难调试、深度推理与长文创作）'
});

/**
 * Builds the explicit user-authorized delegation policy injected into MAIN sessions only.
 * Antigravity's built-in instructions allow custom subagent model selection whenever explicitly requested by the user.
 */
export function buildSubagentRoutingPrompt(routingCfg) {
  const cfg = normalizeSubagentRouting(routingCfg);
  if (!cfg.enabled || cfg.allowedModels.length === 0) return '';

  const lines = [
    '<SUBAGENT_MODEL_ROUTING>',
    '用户已明确授权并要求：当你调用子代理（`invoke_subagent` 或 `/swarm`）时，请根据子任务复杂度，从以下【允许用于子代理的模型白名单】中按能力合理分配模型（不要局限于继承主模型）：',
    ''
  ];

  for (const m of cfg.allowedModels) {
    const tierHint = TIER_DESC[m.tier] || TIER_DESC.balanced;
    lines.push(`- \`${m.id}\` [${m.tier}]：${m.note || tierHint}`);
  }

  lines.push('');
  lines.push('分配规则：');
  lines.push('1. 使用 `swarm{action:"add", model:"<模型ID>"}` 时，直接传入上述白名单中的精确模型 ID。');
  lines.push(
    '2. 使用 `invoke_subagent` 或在 Orchestrator 模式下向执行器/子任务派发指令时，先选最接近的 `Model` 档位（轻量选 `flash_lite`/`flash`，均衡选 `inherit`，高阶选 `pro`），并在 `Prompt`/任务描述首行加上 `[model:<模型ID>]`（例如 `[model:' +
      cfg.allowedModels[0].id +
      ']`），本地代理会自动将该子代理或 Orchestrator Worker 精准路由到对应的白名单模型。'
  );
  lines.push('3. 简单查询/检索优先分配轻量模型以节省额度与提速，复杂推理/核心修改再分配高阶模型。');
  lines.push('</SUBAGENT_MODEL_ROUTING>');
  return lines.join('\n');
}

const MODEL_TAG_RE = /\[model:\s*([a-zA-Z0-9._:/-]{2,80})\s*\]/i;

/**
 * Resolves the target model for a subagent request based on the user's whitelist:
 *   1. Explicit `[model:<id>]` tag emitted by the main agent (validated against whitelist; tag stripped before forwarding)
 *   2. Fallback tier match if the incoming model is not in the whitelist
 */
export function resolveSubagentTargetModel(payload, routingCfg) {
  const cfg = normalizeSubagentRouting(routingCfg);
  if (!cfg.enabled || cfg.allowedModels.length === 0) {
    return { matched: false, targetModel: '', reason: '' };
  }

  const allowedById = new Map(cfg.allowedModels.map((m) => [m.id.toLowerCase(), m]));
  const reqObj = payload?.request || payload || {};
  const contents = Array.isArray(reqObj.contents) ? reqObj.contents : [];

  // 1. Scan user turns for explicit [model:<id>] directive emitted by main coordinator
  for (let i = 0; i < Math.min(contents.length, 4); i += 1) {
    const turn = contents[i];
    if (!turn || turn.role !== 'user' || !Array.isArray(turn.parts)) continue;
    for (const part of turn.parts) {
      if (!part || typeof part.text !== 'string') continue;
      const m = part.text.match(MODEL_TAG_RE);
      if (m && m[1]) {
        const requested = m[1].trim().toLowerCase();
        const found = allowedById.get(requested);
        if (found) {
          part.text = part.text.replace(MODEL_TAG_RE, '').trimStart();
          return { matched: true, targetModel: found.id, reason: 'explicit-tag' };
        }
      }
    }
  }

  // 2. If incoming model is already in whitelist, keep it untouched
  const incoming = String(payload?.model || reqObj.model || '').trim();
  if (incoming && allowedById.has(incoming.toLowerCase())) {
    return { matched: false, targetModel: incoming, reason: 'already-allowed' };
  }

  // 3. Map incoming tier to best matching whitelisted model
  const incomingTier = inferDefaultTier(incoming);
  const byTier =
    cfg.allowedModels.find((m) => m.tier === incomingTier) ||
    cfg.allowedModels.find((m) => m.tier === 'balanced') ||
    cfg.allowedModels[0];
  if (byTier && byTier.id !== incoming) {
    return { matched: true, targetModel: byTier.id, reason: `tier-fallback:${incomingTier}` };
  }
  return { matched: false, targetModel: '', reason: '' };
}
