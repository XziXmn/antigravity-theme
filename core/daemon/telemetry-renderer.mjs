/**
 * core/daemon/telemetry-renderer.mjs — Codex Inline Pill, Bento Tooltip & Per-Turn Formatters
 */

export function fmtTok(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function fmtNum(n) {
  return (n || 0).toLocaleString('en-US');
}

export function formatContextLimitLabel(tokens) {
  if (!tokens || tokens <= 0) return '0k';
  if (tokens >= 1000000) {
    if (tokens === 1000000 || tokens === 1048576) return '1M';
    return (tokens / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }
  return Math.round(tokens / 1000) + 'k';
}

export function computeSegPcts(values, targetTotalPct = 100, minVisiblePct = 1.6) {
  const sum = values.reduce((acc, v) => acc + (v > 0 ? v : 0), 0);
  const clampedTotal = Math.max(0, Math.min(100, targetTotalPct));
  if (sum <= 0 || clampedTotal <= 0) {
    return values.map(() => 0);
  }
  const raw = values.map((v) => (v > 0 ? (v / sum) * clampedTotal : 0));
  const nonZeroIdxs = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) nonZeroIdxs.push(i);
  }
  if (nonZeroIdxs.length > 1 && clampedTotal > minVisiblePct * nonZeroIdxs.length) {
    let deficit = 0;
    let flexibleSum = 0;
    for (const idx of nonZeroIdxs) {
      if (raw[idx] < minVisiblePct) {
        deficit += minVisiblePct - raw[idx];
        raw[idx] = minVisiblePct;
      } else {
        flexibleSum += raw[idx] - minVisiblePct;
      }
    }
    if (deficit > 0 && flexibleSum > 0) {
      const ratio = Math.min(1, deficit / flexibleSum);
      for (const idx of nonZeroIdxs) {
        if (raw[idx] > minVisiblePct) {
          raw[idx] -= (raw[idx] - minVisiblePct) * ratio;
        }
      }
    }
  }
  return raw.map((pct) => Number(pct.toFixed(1)));
}

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildInlineTelemetryHtml({
  telemetryLayout = 'compact',
  telemetryCacheMode = 'session',
  statusDotHtml,
  displayTps,
  ttft,
  lastCtx,
  limitKStr,
  ctxClass,
  ctxPct,
  compactedPending,
  outTok,
  lastCacheRate,
  sessionCacheRate
}) {
  if (telemetryLayout === 'detailed') {
    const inlineCtxHtml = compactedPending
      ? '<span class="ag-ctx-compacted">Ctx 已压缩</span>'
      : `<span>Ctx ${fmtTok(lastCtx)}/${limitKStr} <span class="${ctxClass}">(${ctxPct}%)</span></span>`;
    return (
      statusDotHtml +
      [
        `<span>${Math.round(displayTps)} tok/s</span>`,
        '<span class="ag-sep">·</span>',
        `<span>TTFT ${Number(ttft || 0).toFixed(1)}s</span>`,
        '<span class="ag-sep">·</span>',
        inlineCtxHtml,
        '<span class="ag-sep">·</span>',
        `<span>Out ${fmtTok(outTok)}</span>`
      ].join('')
    );
  }

  const cacheVal = telemetryCacheMode === 'step' ? lastCacheRate : sessionCacheRate;
  const compactCtxHtml = compactedPending
    ? '<span class="ag-ctx-compacted">Ctx 已压缩</span>'
    : `<span>Ctx <span class="${ctxClass}">${ctxPct}%</span></span>`;

  return (
    statusDotHtml +
    [
      `<span>${Math.round(displayTps)} tok/s</span>`,
      '<span class="ag-sep">·</span>',
      compactCtxHtml,
      '<span class="ag-sep">·</span>',
      `<span>Cache ${cacheVal}%</span>`
    ].join('')
  );
}

const CTX_CATEGORY_ZH = {
  'Chat Messages': '消息',
  'System Prompt': '系统提示',
  'System Tools': '系统工具',
  Skills: '技能',
  Subagents: '子智能体',
  Plugins: '插件',
  'Other Overhead': '其他开销',
  'MCP Tools': 'MCP 工具',
  Rules: '规则',
  Free: '剩余空间'
};

const CTX_CATEGORY_COLORS = {
  'Chat Messages': '#2563EB',
  'System Prompt': '#EA580C',
  'System Tools': '#0D9488',
  Skills: '#78716C',
  Subagents: '#6366F1',
  Plugins: '#9333EA',
  'Other Overhead': '#94A3B8',
  'MCP Tools': '#A1A1AA',
  Rules: '#64748B',
  Free: 'var(--ag-tt-track)'
};

function fmtDurationText(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${mins}分${rem}秒`;
}

export function buildMetricsTooltipHtml({
  genIdx,
  streamTps,
  e2eTps,
  streamTpsValid,
  last,
  lastCacheRate,
  ctxPct,
  contextLimitTokens,
  limitKStr,
  remainCtx,
  compactedPending,
  compactSummaryKb,
  compactingNow,
  generatingPending,
  pendingRetrying,
  lastErrorMsg,
  turnSteps,
  turnOut,
  turnThink,
  turnResp,
  turnDur,
  userStepsCount,
  validCount,
  totalStepsCount = 0,
  totalIn,
  totalCacheWrite,
  totalCache,
  totalPrompt,
  sessionCacheRate,
  totalOut,
  totalThink,
  totalResp,
  ctxBreakdown = null,
  multiModels = null,
  sessAvgTps = 0,
  peakTps = 0,
  latestTps = 0,
  avgTtftSec = 0,
  modelTimeSec = 0,
  estCostUsd = 0,
  totalErrorCount = 0,
  toolCount = 0,
  lastReqTsMs = 0
}) {
  const ctxLevelClass = compactedPending
    ? 'ag-tt-compacted'
    : ctxPct >= 90
    ? 'ag-tt-crit'
    : ctxPct >= 75
    ? 'ag-tt-warn'
    : 'ag-tt-ok';
  const mainTpsVal = streamTpsValid ? streamTps : e2eTps;
  const speedSub = streamTpsValid ? `端到端 ${e2eTps.toFixed(1)}` : '端到端均值';
  const hasSessionCache = parseFloat(sessionCacheRate) > 0;
  const liveChipClass =
    lastErrorMsg && !compactingNow && !generatingPending && !pendingRetrying
      ? ' is-error'
      : pendingRetrying
      ? ' is-slow'
      : '';
  const liveChipText =
    lastErrorMsg && !compactingNow && !generatingPending && !pendingRetrying
      ? '执行报错'
      : pendingRetrying
      ? '重试连接中…'
      : compactingNow
      ? '压缩中…'
      : generatingPending
      ? '新步执行中…'
      : '';
  const liveChipHtml = `<span class="ag-tt-live-chip${liveChipClass}">${liveChipText}</span>`;
  const ctxBentoValHtml = compactedPending
    ? '<span class="ag-tt-pill ag-tt-compacted-val">已压缩</span>'
    : `<span class="ag-tt-pill">${ctxPct}%</span>`;
  const ctxBentoSubText = compactedPending
    ? generatingPending
      ? '新步落盘后刷新'
      : '下次调用后刷新'
    : `余 ${fmtTok(remainCtx)} / ${limitKStr}`;

  const ctxUsedTargetPct = contextLimitTokens > 0 ? Math.min(100, (last.ctx / contextLimitTokens) * 100) : 0;
  const hasStepWrite = last.cacheWrite > 0;
  const ctxPcts = hasStepWrite
    ? computeSegPcts([last.inTok, last.cacheWrite, last.cacheRead], ctxUsedTargetPct, 1.5)
    : computeSegPcts([last.inTok, last.cacheRead], ctxUsedTargetPct, 1.6);
  const ctxSegsHtml = compactedPending
    ? '<div class="ag-tt-seg ag-tt-c-emerald" style="width:8%"></div>'
    : hasStepWrite
    ? `<div class="ag-tt-seg ag-tt-c-ctx-new" style="width:${ctxPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-slate" style="width:${ctxPcts[1]}%"></div><div class="ag-tt-seg ag-tt-c-ctx-cache" style="width:${ctxPcts[2]}%"></div>`
    : `<div class="ag-tt-seg ag-tt-c-ctx-new" style="width:${ctxPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-ctx-cache" style="width:${ctxPcts[1]}%"></div>`;
  const ctxWriteLeg = hasStepWrite
    ? `<span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-slate"></span>写缓存 ${fmtNum(last.cacheWrite)}</span>`
    : '';
  const ctxBarTopMetaHtml = compactedPending
    ? `<strong>已完成压缩</strong>${compactSummaryKb > 0 ? ` · 摘要 ${compactSummaryKb} KB` : ''}`
    : `<strong>${fmtNum(last.ctx)}</strong> / ${limitKStr}`;
  const ctxBarLegendHtml = compactedPending
    ? `<span class="ag-tt-legend-left"><span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-emerald"></span>压缩前 ${fmtNum(last.ctx)} (${ctxPct}%) · 下轮落盘更新精确占比</span></span>`
    : `<span class="ag-tt-legend-left">
          <span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-ctx-new"></span>新增 ${fmtNum(last.inTok)}</span>
          ${ctxWriteLeg}
          <span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-ctx-cache"></span>缓存 ${fmtNum(last.cacheRead)} (${lastCacheRate}%)</span>
        </span>
        <span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-dot-outline"></span>余 ${fmtTok(remainCtx)}</span>`;

  const durPcts = computeSegPcts([last.ttft, last.stream], 100, 3);
  const stepOutPcts = computeSegPcts([last.thinkTok, last.respTok], 100, 3);
  const turnPcts = turnSteps > 1 ? computeSegPcts([turnThink, turnResp], 100, 3) : null;
  const hasTotalWrite = totalCacheWrite > 0;
  const totalInPcts = hasTotalWrite
    ? computeSegPcts([totalIn, totalCacheWrite, totalCache], 100, 2)
    : computeSegPcts([totalIn, totalCache], 100, 2);
  const totalOutPcts = computeSegPcts([totalThink, totalResp], 100, 2);

  const turnBarHtml =
    turnSteps > 1
      ? `<div class="ag-tt-bar-blk ag-tt-none">
          <div class="ag-tt-bar-top">
            <span class="ag-tt-bar-name">本轮合计（${turnSteps}步 · 耗时 ${turnDur.toFixed(1)}s）</span>
            <span class="ag-tt-bar-meta">输出 <strong>${fmtNum(turnOut)}</strong></span>
          </div>
          <div class="ag-tt-track">
            <div class="ag-tt-seg ag-tt-c-indigo" style="width:${turnPcts[0]}%"></div>
            <div class="ag-tt-seg ag-tt-c-brand" style="width:${turnPcts[1]}%"></div>
          </div>
          <div class="ag-tt-legend">
            <span class="ag-tt-legend-left">
              <span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-indigo"></span>思考 ${fmtNum(turnThink)}</span>
              <span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-brand"></span>响应 ${fmtNum(turnResp)}</span>
            </span>
          </div>
        </div>`
      : '';

  const totalInSegsHtml = hasTotalWrite
    ? `<div class="ag-tt-seg ag-tt-c-mist" style="width:${totalInPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-slate" style="width:${totalInPcts[1]}%"></div><div class="ag-tt-seg ag-tt-c-emerald" style="width:${totalInPcts[2]}%"></div>`
    : `<div class="ag-tt-seg ag-tt-c-mist" style="width:${totalInPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-emerald" style="width:${totalInPcts[1]}%"></div>`;
  const totalWriteLeg = hasTotalWrite
    ? `<span class="ag-tt-leg"><span class="ag-tt-dot ag-tt-c-slate"></span>写缓存 ${fmtTok(totalCacheWrite)}</span>`
    : '';

  const usedPctDisp =
    ctxBreakdown && typeof ctxBreakdown.usedPercent === 'number'
      ? ctxBreakdown.usedPercent.toFixed(1)
      : String(ctxPct);
  const usedTokDisp = ctxBreakdown && ctxBreakdown.usedTokens > 0 ? fmtTok(ctxBreakdown.usedTokens) : fmtTok(last.ctx);
  const maxTokDisp = ctxBreakdown && ctxBreakdown.maxTokens > 0 ? fmtTok(ctxBreakdown.maxTokens) : limitKStr;
  const totalCompactions = multiModels?.compactions || (compactedPending ? 1 : 0);

  const rawCats = Array.isArray(ctxBreakdown?.categories) && ctxBreakdown.categories.length > 0
    ? ctxBreakdown.categories
    : [
        { key: 'new', label: '本步新增', tokens: last.inTok, percent: contextLimitTokens > 0 ? Number(((last.inTok / contextLimitTokens) * 100).toFixed(1)) : 0 },
        { key: 'cache', label: '缓存复用', tokens: last.cacheRead, percent: contextLimitTokens > 0 ? Number(((last.cacheRead / contextLimitTokens) * 100).toFixed(1)) : 0 },
        { key: 'free', label: 'Free', tokens: remainCtx, percent: contextLimitTokens > 0 ? Number(((remainCtx / contextLimitTokens) * 100).toFixed(1)) : 0 }
      ];
  const fallbackSwatches = ['#3B82F6', '#06B6D4', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981'];
  const catColor = (c, idx) =>
    c.key === 'free'
      ? 'var(--ag-tt-track)'
      : CTX_CATEGORY_COLORS[c.label] || fallbackSwatches[idx % fallbackSwatches.length];

  const catBarHtml = rawCats
    .filter((c) => c.key !== 'free' && (c.percent || 0) > 0)
    .map((c, idx) => `<span class="ag-tt-cat-seg" style="width:${Math.max(0.5, c.percent || 0)}%;background:${catColor(c, idx)}"></span>`)
    .join('');

  const catListHtml = rawCats
    .map((c, idx) => {
      const dispName = CTX_CATEGORY_ZH[c.label] || c.label;
      const pctStr = c.percent == null ? '-' : `${Number(c.percent).toFixed(1)}%`;
      const swStyle =
        c.key === 'free'
          ? `background:var(--ag-tt-track);box-shadow:inset 0 0 0 1px var(--ag-tt-hairline)`
          : `background:${catColor(c, idx)}`;
      return `<div class="ag-tt-cat-row">
        <span class="ag-tt-cat-sw" style="${swStyle}"></span>
        <span class="ag-tt-cat-lbl">${escapeHtml(dispName)}</span>
        <span class="ag-tt-cat-tok">${fmtTok(c.tokens)}</span>
        <span class="ag-tt-cat-pct">${pctStr}</span>
      </div>`;
    })
    .join('');

  const stepPromptTotal = (last.cacheRead || 0) + (last.inTok || 0);
  const stepNewPct = stepPromptTotal > 0 ? ((last.inTok / stepPromptTotal) * 100).toFixed(1) : '0.0';

  const nativeCompStateText = compactingNow
    ? '压缩中…'
    : compactedPending
    ? `刚完成压缩${compactSummaryKb > 0 ? ` · ${compactSummaryKb} KB` : ''}`
    : totalCompactions > 0
    ? `已触发 ${totalCompactions} 次`
    : '未触发';
  const nativeCompTone = compactingNow ? 'is-active' : compactedPending || totalCompactions > 0 ? 'is-ready' : 'is-idle';
  const compStatusHtml = `<div class="ag-tt-comp-status" data-native-count="${totalCompactions}" data-native-pending="${compactedPending ? '1' : '0'}" data-native-running="${compactingNow ? '1' : '0'}" data-native-kb="${compactSummaryKb || 0}">
    <div class="ag-tt-comp-hdr"><span class="ag-tt-sub-hdr" style="margin-bottom:0">压缩状态</span><span class="ag-tt-comp-mode-pill is-native">原生</span></div>
    <div class="ag-tt-comp-row"><span class="ag-tt-comp-lbl"><i class="ag-tt-comp-dot ${nativeCompTone}"></i>原生压缩</span><span class="ag-tt-comp-val">${nativeCompStateText}</span></div>
  </div>`;

  const orchModelsHtml =
    multiModels?.hasOrchestrator && Array.isArray(multiModels.models) && multiModels.models.length > 1
      ? `<div class="ag-tt-orch-blk">
          <div class="ag-tt-sub-hdr">Orchestrator 上下文</div>
          ${multiModels.models
            .map((m) => {
              const roleTxt = m.role === 'execution' ? '执行' : m.role === 'planner' ? '规划' : '';
              const pct = Math.min(100, Math.max(0, m.usedPercent || 0));
              const fillClr = pct >= 95 ? '#DC2626' : pct >= 80 ? '#D97706' : m.isCurrent ? '#2563EB' : '#60A5FA';
              return `<div class="ag-tt-orch-item" title="${escapeHtml(m.fullName)}">
                <div class="ag-tt-orch-top">
                  <span class="ag-tt-orch-name">${roleTxt ? `<span class="ag-tt-role-pill">${roleTxt}</span>` : ''}${escapeHtml(m.shortName)}${m.isCurrent ? '<span class="ag-tt-active-pill">当前</span>' : ''}</span>
                  <span class="ag-tt-orch-pct">${m.usedPercent != null ? `${m.usedPercent.toFixed(1)}%` : ''}</span>
                </div>
                <div class="ag-tt-orch-bar"><span style="width:${pct}%;background:${fillClr}"></span></div>
              </div>`;
            })
            .join('')}
        </div>`
      : '';

  const sessTotalAll = totalPrompt + totalOut;
  const avgTpsShow = sessAvgTps > 0 ? sessAvgTps.toFixed(1) : mainTpsVal.toFixed(1);
  const peakTpsShow = peakTps > 0 ? peakTps.toFixed(1) : mainTpsVal.toFixed(1);
  const latestTpsShow = latestTps > 0 ? latestTps.toFixed(1) : mainTpsVal.toFixed(1);

  return `<div class="ag-tt-wrap ${ctxLevelClass}">
    <div class="ag-tt-hdr">
      <span class="ag-tt-hdr-left">会话统计</span>
      <span class="ag-tt-hdr-right">${liveChipHtml}<span class="ag-tt-flow-chip-slot"></span></span>
    </div>
    <div class="ag-tt-wait-note" id="ag-tt-wait-note"></div>
    <div class="ag-tt-dual-grid">
      <div class="ag-tt-col ag-tt-col-ctx">
        <div class="ag-tt-col-top">
          <span class="ag-tt-col-title">上下文窗口</span>
        </div>
        <div class="ag-tt-ctx-headline">
          <span class="ag-tt-ctx-pct-main">${compactedPending ? '约已使用 ' : '已使用 '}${usedPctDisp}%</span>
          <span class="ag-tt-ctx-cap">${compactedPending ? '≈' : ''}${usedTokDisp} / ${maxTokDisp}</span>
        </div>
        <div class="ag-tt-cat-bar">${catBarHtml}</div>
        <div class="ag-tt-cat-list">${catListHtml}</div>
        <div class="ag-tt-step-cache-blk">
          <div class="ag-tt-cat-row">
            <span class="ag-tt-dot-round" style="background:#2563EB"></span>
            <span class="ag-tt-cat-lbl">缓存复用上下文</span>
            <span class="ag-tt-cat-tok">${fmtTok(last.cacheRead)}</span>
            <span class="ag-tt-cat-pct">${lastCacheRate}%</span>
          </div>
          ${last.cacheWrite > 0 ? `<div class="ag-tt-cat-row">
            <span class="ag-tt-dot-round" style="background:#94A3B8"></span>
            <span class="ag-tt-cat-lbl">写缓存</span>
            <span class="ag-tt-cat-tok">${fmtTok(last.cacheWrite)}</span>
            <span class="ag-tt-cat-pct">—</span>
          </div>` : ''}
          <div class="ag-tt-cat-row">
            <span class="ag-tt-dot-round" style="background:#38BDF8"></span>
            <span class="ag-tt-cat-lbl">本步新增输入</span>
            <span class="ag-tt-cat-tok">${fmtTok(last.inTok)}</span>
            <span class="ag-tt-cat-pct">${stepNewPct}%</span>
          </div>
        </div>
        ${compStatusHtml}
        ${orchModelsHtml}
      </div>
      <div class="ag-tt-col ag-tt-col-stats">
        <div class="ag-tt-col-top">
          <span class="ag-tt-col-title">运行指标</span>
          <span class="ag-tt-col-sub">${escapeHtml(last.modelName ? shortModelDisplaySafe(last.modelName) : '')}</span>
        </div>
        <div class="ag-tt-kpi-pair">
          <div class="ag-tt-kpi-item">
            <div class="ag-tt-kpi-lbl">生成速度</div>
            <div class="ag-tt-kpi-val">${mainTpsVal.toFixed(1)} <span>t/s</span></div>
            <div class="ag-tt-kpi-sub">均 ${Math.round(e2eTps)} · 峰 ${peakTpsShow}</div>
          </div>
          <div class="ag-tt-kpi-item">
            <div class="ag-tt-kpi-lbl">缓存命中</div>
            <div class="ag-tt-kpi-val${hasSessionCache ? ' ag-tt-val-good' : ''}">${sessionCacheRate}%</div>
            <div class="ag-tt-kpi-sub">本步 ${lastCacheRate}% · <span class="ag-tt-cache-obs-val" data-last-req-ts="${lastReqTsMs || 0}" data-model="${escapeHtml(last.modelName || '')}">—</span></div>
          </div>
        </div>
        <div class="ag-tt-mini-pair">
          <div class="ag-tt-mini-col">
            <div class="ag-tt-mini-top"><span>响应耗时</span><b>${last.totDur.toFixed(1)}s</b></div>
            <div class="ag-tt-mini-track"><div class="ag-tt-seg ag-tt-c-slate" style="width:${durPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-brand" style="width:${durPcts[1]}%"></div></div>
            <div class="ag-tt-mini-leg"><span>TTFT ${last.ttft.toFixed(1)}s</span><span>流式 ${last.stream.toFixed(1)}s</span></div>
          </div>
          <div class="ag-tt-mini-col">
            <div class="ag-tt-mini-top"><span>本步输出</span><b>${fmtTok(last.outTok)}</b></div>
            <div class="ag-tt-mini-track"><div class="ag-tt-seg ag-tt-c-indigo" style="width:${stepOutPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-brand" style="width:${stepOutPcts[1]}%"></div></div>
            <div class="ag-tt-mini-leg"><span>思考 ${fmtTok(last.thinkTok)}</span><span>响应 ${fmtTok(last.respTok)}</span></div>
          </div>
        </div>
        ${turnSteps > 1 && turnPcts ? `<div class="ag-tt-turn-blk">
          <div class="ag-tt-mini-top"><span>本轮合计（${turnSteps}步 · ${turnDur.toFixed(1)}s）</span><b>输出 ${fmtTok(turnOut)}</b></div>
          <div class="ag-tt-mini-track"><div class="ag-tt-seg ag-tt-c-indigo" style="width:${turnPcts[0]}%"></div><div class="ag-tt-seg ag-tt-c-brand" style="width:${turnPcts[1]}%"></div></div>
          <div class="ag-tt-mini-leg"><span>思考 ${fmtTok(turnThink)}</span><span>响应 ${fmtTok(turnResp)}</span></div>
        </div>` : ''}
        <div class="ag-tt-stats-rows">
          <div class="ag-tt-stat-row"><span>轮次 / 步数</span><b>${userStepsCount} / ${totalStepsCount || validCount}</b></div>
          <div class="ag-tt-stat-row"><span>累计 Token</span><b>${fmtTok(sessTotalAll)}</b></div>
          <div class="ag-tt-stat-row"><span>API 参考费用</span><b>$${Number(estCostUsd || 0).toFixed(2)}</b></div>
          <div class="ag-tt-stat-row"><span>模型总用时</span><b>${fmtDurationText(modelTimeSec)}</b></div>
        </div>
        <details class="ag-tt-more-stats">
          <summary>更多明细</summary>
          <div class="ag-tt-more-body">
            <div class="ag-tt-stat-row"><span>累计输入</span><b>${fmtTok(totalIn)}</b></div>
            <div class="ag-tt-stat-row"><span>缓存读取</span><b>${fmtTok(totalCache)}</b></div>
            ${hasTotalWrite ? `<div class="ag-tt-stat-row"><span>写缓存</span><b>${fmtTok(totalCacheWrite)}</b></div>` : ''}
            <div class="ag-tt-stat-row"><span>累计输出</span><b>${fmtTok(totalOut)}</b></div>
            <div class="ag-tt-stat-row"><span>思考 Token</span><b>${fmtTok(totalThink)}</b></div>
            <div class="ag-tt-stat-row"><span>平均 / 最近速度</span><b>${avgTpsShow} / ${latestTpsShow} t/s</b></div>
            <div class="ag-tt-stat-row"><span>请求 / 工具 / 错误</span><b>${validCount} / ${toolCount} / ${totalErrorCount}</b></div>
          </div>
        </details>
      </div>
    </div>
  </div>`;
}

function shortModelDisplaySafe(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

export function formatTurnModelName(gens) {
  const models = [];
  for (let i = 0; i < gens.length; i++) {
    const m = gens[i].modelName;
    if (m && !models.includes(m)) {
      models.push(m);
    }
  }
  if (models.length === 0) return '';
  if (models.length === 1) return models[0];
  const first = models[0];
  let last = models[models.length - 1];
  if (/^Orchestrator\b/i.test(first)) {
    last = last.replace(/\s*\(Orchestrator\)\s*$/i, '').trim();
  }
  return last && last !== first ? `${first} → ${last}` : first;
}

export function buildTurnSummaries(valid, userStepIdxs, manualLim, fallbackLim) {
  if (!valid || valid.length === 0 || !valid.some((it) => it.maxStepIdx >= 0)) {
    return [];
  }
  const bucketMap = new Map();
  for (let i = 0; i < valid.length; i++) {
    const item = valid[i];
    const si = item.maxStepIdx;
    if (si < 0) continue;
    let lo = 0;
    let hi = userStepIdxs.length - 1;
    let foundIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (userStepIdxs[mid] <= si) {
        foundIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const key = foundIdx >= 0 ? foundIdx : -1;
    let arr = bucketMap.get(key);
    if (!arr) {
      arr = [];
      bucketMap.set(key, arr);
    }
    arr.push(item);
  }

  const keys = Array.from(bucketMap.keys()).sort((a, b) => a - b);
  const MIN_STREAM_DUR_SEC = 0.12;
  const MAX_SANITY_STREAM_TPS = 3000;
  const turns = [];

  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki];
    const gens = bucketMap.get(k);
    if (!gens || gens.length === 0) continue;

    const startStepIdx = k >= 0 ? userStepIdxs[k] : -1;
    const nextUserStep = k + 1 < userStepIdxs.length ? userStepIdxs[k + 1] : Infinity;
    const endStepIdx = Number.isFinite(nextUserStep) ? nextUserStep - 1 : -1;

    let inTokSum = 0;
    let cacheWriteSum = 0;
    let cacheReadSum = 0;
    let outTokSum = 0;
    let thinkTokSum = 0;
    let respTokSum = 0;
    let streamSum = 0;
    let totDurSum = 0;
    let nativeMaxCtx = 0;

    for (let j = 0; j < gens.length; j++) {
      const g = gens[j];
      inTokSum += g.inTok;
      cacheWriteSum += g.cacheWrite;
      cacheReadSum += g.cacheRead;
      outTokSum += g.outTok;
      thinkTokSum += g.thinkTok;
      respTokSum += g.respTok;
      streamSum += g.stream;
      totDurSum += g.totDur;
      if (g.maxCtx > 0) nativeMaxCtx = g.maxCtx;
    }

    const firstG = gens[0];
    const lastG = gens[gens.length - 1];
    const lastCtx = lastG.ctx;
    const contextLimit = manualLim > 0 ? manualLim : nativeMaxCtx > 0 ? nativeMaxCtx : fallbackLim;
    const streamTps = streamSum >= MIN_STREAM_DUR_SEC ? outTokSum / streamSum : 0;
    const e2eTps = totDurSum > 0 ? outTokSum / totDurSum : 0;
    const tps = Math.round(streamTps > 0 && streamTps <= MAX_SANITY_STREAM_TPS ? streamTps : e2eTps);
    const totalPromptTurn = inTokSum + cacheWriteSum + cacheReadSum;
    const model = formatTurnModelName(gens);
    const cacheRate = totalPromptTurn > 0 ? ((cacheReadSum / totalPromptTurn) * 100).toFixed(1) + '%' : '0.0%';
    const ctxStr = fmtTok(lastCtx);
    const outStr = fmtTok(outTokSum);
    const limitStr = formatContextLimitLabel(contextLimit);
    const ctxPct = Math.round((lastCtx / contextLimit) * 100);

    const badgeParts = [];
    if (model) badgeParts.push(model);
    badgeParts.push(`${tps} t/s`);
    badgeParts.push(`In ${fmtTok(inTokSum + cacheReadSum)}`);
    badgeParts.push(`Out ${outStr}`);
    badgeParts.push(`Cache ${cacheRate}`);
    const badgeText = badgeParts.join(' · ');

    const badgeHtml = [
      model ? `<span class="ag-turn-model">${escapeHtml(model)}</span><span class="ag-sep">·</span>` : '',
      `<span>${tps} t/s</span><span class="ag-sep">·</span>`,
      `<span>Out ${outStr}</span><span class="ag-sep">·</span>`,
      `<span>Cache ${cacheRate}</span>`
    ].join('');

    const badgeTitle = `Ctx ${ctxStr}/${limitStr} (${ctxPct}%) · ${gens.length} 步 · 耗时 ${totDurSum.toFixed(1)}s`;

    turns.push({
      turnIndex: k >= 0 ? k + 1 : 0,
      startStepIdx,
      endStepIdx,
      minGenIdx: firstG.idx,
      maxGenIdx: lastG.idx,
      steps: gens.length,
      model,
      lastCtx,
      ctxStr,
      promptTok: totalPromptTurn,
      promptStr: fmtTok(totalPromptTurn),
      outTok: outTokSum,
      outStr,
      inTok: inTokSum,
      cacheWrite: cacheWriteSum,
      cacheRead: cacheReadSum,
      thinkTok: thinkTokSum,
      respTok: respTokSum,
      streamDur: Number(streamSum.toFixed(1)),
      totDur: Number(totDurSum.toFixed(1)),
      tps,
      e2eTps: Number(e2eTps.toFixed(1)),
      contextLimit,
      limitStr,
      ctxPct,
      cacheRate,
      badgeText,
      badgeHtml,
      badgeTitle
    });
  }

  return turns;
}
