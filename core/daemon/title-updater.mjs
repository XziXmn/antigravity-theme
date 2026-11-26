/**
 * core/daemon/title-updater.mjs — Progress-Based Automatic Conversation Title Updater
 *
 * Tracks compact in-memory turn summaries per active conversation and periodically refreshes
 * the conversation title via Antigravity's native ConversationService/UpdateConversation RPC
 * when enough turns and cooldown time have elapsed. Never writes user content to disk.
 */

export const DEFAULT_AUTO_TITLE_CONFIG = Object.freeze({
  enabled: false,
  turnInterval: 4,
  minIntervalMin: 5
});

export function normalizeAutoTitleConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const turnNum = Number(src.turnInterval);
  const turnInterval = Number.isInteger(turnNum)
    ? Math.max(2, Math.min(20, turnNum))
    : DEFAULT_AUTO_TITLE_CONFIG.turnInterval;
  const minNum = Number(src.minIntervalMin);
  const minIntervalMin = Number.isFinite(minNum)
    ? Math.max(1, Math.min(60, Math.round(minNum)))
    : DEFAULT_AUTO_TITLE_CONFIG.minIntervalMin;
  return {
    enabled: Boolean(src.enabled),
    turnInterval,
    minIntervalMin
  };
}

export function cleanGeneratedTitle(rawText) {
  const firstLine = String(rawText || '')
    .replace(/<\|thought\|>[\s\S]*?<\|thought\|>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  const cleaned = firstLine
    .replace(/^(?:标题|Title|Summary|主题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’「」『』《》【】\[\]`*#\-•\s]+|["'“”‘’「」『』《》【】\[\]`*#\-•\s.。!！?？]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 2) return '';
  return cleaned.slice(0, 36);
}

export function buildTitlePrompt(snippets = [], { locale = 'zh-CN', currentTitle = '' } = {}) {
  const isEn = locale === 'en';
  const isTw = locale === 'zh-TW';
  const contextLines = snippets
    .slice(-4)
    .map((s, idx) => `${idx + 1}. ${String(s || '').trim().slice(0, 220)}`)
    .filter(Boolean)
    .join('\n');
  if (isEn) {
    return [
      'Generate a short, accurate conversation title reflecting the latest task progress.',
      'Rules: 3-7 words, plain text only, no quotes, no markdown, no explanations.',
      currentTitle ? `Previous title: ${currentTitle}` : '',
      'Recent progress:',
      contextLines
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (isTw) {
    return [
      '請根據以下最近對話進展，產生一個簡短準確的繁體中文會話標題。',
      '要求：6-16 字，僅輸出標題純文字，不加引號、標點或解釋。',
      currentTitle ? `目前標題：${currentTitle}` : '',
      '近期進展：',
      contextLines
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    '请根据以下最近对话进展，生成一个简短准确的简体中文会话标题。',
    '要求：6-16 字，仅输出标题纯文本，不加引号、句号或任何解释。',
    currentTitle ? `当前标题：${currentTitle}` : '',
    '近期进展：',
    contextLines
  ]
    .filter(Boolean)
    .join('\n');
}

export function createAutoTitleUpdater({
  getConfig = () => ({ autoTitle: DEFAULT_AUTO_TITLE_CONFIG, i18nLocale: 'zh-CN' }),
  lsClient = null,
  generateTitle = null,
  nowFn = () => Date.now(),
  log = () => {}
} = {}) {
  const states = new Map(); // cid -> { turnsSinceUpdate, lastUpdatedAt, inFlight, snippets: string[], lastTitle }

  function getOrCreate(cid) {
    let st = states.get(cid);
    if (!st) {
      st = { turnsSinceUpdate: 0, lastUpdatedAt: 0, inFlight: false, snippets: [], lastTitle: '' };
      states.set(cid, st);
      if (states.size > 40) {
        const oldest = states.keys().next().value;
        if (oldest) states.delete(oldest);
      }
    }
    return st;
  }

  function recordSnippet(cid, text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cid || clean.length < 4) return;
    const st = getOrCreate(cid);
    const clip = clean.slice(0, 220);
    if (st.snippets[st.snippets.length - 1] !== clip) {
      st.snippets.push(clip);
      if (st.snippets.length > 6) st.snippets.shift();
    }
  }

  async function maybeRefreshTitle(cid, { force = false } = {}) {
    const cleanCid = String(cid || '').trim();
    if (!cleanCid || !lsClient || typeof generateTitle !== 'function') return { ok: false, skipped: true };
    const cfg = getConfig() || {};
    const atCfg = normalizeAutoTitleConfig(cfg.autoTitle);
    if (!force && !atCfg.enabled) return { ok: false, skipped: true };

    const st = getOrCreate(cleanCid);
    if (st.inFlight || st.snippets.length === 0) return { ok: false, skipped: true };

    const now = nowFn();
    const minIntervalMs = atCfg.minIntervalMin * 60 * 1000;
    if (!force) {
      if (st.turnsSinceUpdate < atCfg.turnInterval) return { ok: false, skipped: true };
      if (st.lastUpdatedAt > 0 && now - st.lastUpdatedAt < minIntervalMs) return { ok: false, skipped: true };
    }

    st.inFlight = true;
    try {
      let currentTitle = st.lastTitle || '';
      try {
        const cur = await lsClient.getConversation(cleanCid);
        if (cur?.ok && cur.data) {
          currentTitle = String(cur.data.annotations?.title || cur.data.state?.summary || '').trim();
        }
      } catch {}

      const prompt = buildTitlePrompt(st.snippets, {
        locale: cfg.i18nLocale || 'zh-CN',
        currentTitle
      });
      const raw = await generateTitle(prompt);
      const nextTitle = cleanGeneratedTitle(raw);
      if (!nextTitle) return { ok: false, error: 'empty title' };
      if (nextTitle === currentTitle) {
        st.turnsSinceUpdate = 0;
        st.lastUpdatedAt = nowFn();
        return { ok: true, unchanged: true, title: nextTitle };
      }

      const upd = await lsClient.updateConversationTitle(cleanCid, nextTitle);
      if (upd?.ok) {
        st.turnsSinceUpdate = 0;
        st.lastUpdatedAt = nowFn();
        st.lastTitle = nextTitle;
        log(`[AutoTitle] Updated ${cleanCid.slice(0, 8)} -> "${nextTitle}"`);
        return { ok: true, title: nextTitle };
      }
      return { ok: false, error: upd?.error || 'UpdateConversation failed' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err || 'title update failed') };
    } finally {
      st.inFlight = false;
    }
  }

  function observeTurn({ cascadeId, userText = '' } = {}) {
    const cid = String(cascadeId || '').trim();
    if (!cid) return;
    const st = getOrCreate(cid);
    if (userText) recordSnippet(cid, userText);
    st.turnsSinceUpdate += 1;
    void maybeRefreshTitle(cid, { force: false });
  }

  return {
    observeTurn,
    recordSnippet,
    maybeRefreshTitle,
    getState: (cid) => (states.has(cid) ? { ...states.get(cid) } : null)
  };
}
