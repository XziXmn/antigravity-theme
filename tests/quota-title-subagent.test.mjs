/**
 * tests/quota-title-subagent.test.mjs — Unit tests for Language Server Quota, Auto-Title Updater & Subagent Whitelist Routing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverLiveHub,
  parseUserStatusQuota,
  parseQuotaSummary,
  createLanguageServerClient
} from '../core/daemon/ls-client.mjs';
import {
  normalizeAutoTitleConfig,
  cleanGeneratedTitle,
  buildTitlePrompt,
  createAutoTitleUpdater
} from '../core/daemon/title-updater.mjs';
import {
  inferDefaultTier,
  normalizeSubagentRouting,
  sanitizeSubagentRoutingPatch,
  buildSubagentRoutingPrompt,
  resolveSubagentTargetModel
} from '../core/flow/subagent-routing.mjs';

test('discoverLiveHub finds newest live hub json and ignores dead PIDs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ls-hub-'));
  const dir = path.join(home, '.gemini', 'antigravity', 'daemon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hub_11111.json'),
    JSON.stringify({ pid: 99999, httpPort: 11111, csrfToken: 'dead-token', lsVersion: '1.0' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'hub_22222.json'),
    JSON.stringify({ pid: 4321, httpPort: 22222, csrfToken: 'live-token', lsVersion: '2.35.1' }),
    'utf8'
  );

  const found = discoverLiveHub({ customHome: home, isAliveFn: (pid) => pid === 4321 });
  assert.ok(found);
  assert.equal(found.port, 22222);
  assert.equal(found.csrfToken, 'live-token');
  assert.equal(found.address, '127.0.0.1:22222');
});

test('parseUserStatusQuota aggregates model quota pools without retaining PII', () => {
  const nowMs = Date.parse('2026-11-26T00:00:00.000Z');
  const raw = {
    userStatus: {
      email: 'secret@example.com',
      planStatus: {
        planInfo: { planName: 'Pro' },
        availablePromptCredits: 500,
        availableFlowCredits: 100
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Neon (High)',
            quotaInfo: { remainingFraction: 0.735, resetTime: '2026-11-26T04:30:00.000Z' }
          },
          {
            label: 'Gemini 3.8 Flash (Low)',
            quotaInfo: { remainingFraction: 0.735, resetTime: '2026-11-26T04:30:00.000Z' }
          },
          {
            label: 'Claude Opus 5.5 (High)',
            quotaInfo: { remainingFraction: 1, resetTime: '2026-11-26T05:00:00.000Z' }
          },
          {
            label: 'GPT-OSS 120B (Medium)',
            quotaInfo: { remainingFraction: 1, resetTime: '2026-11-26T05:00:00.000Z' }
          }
        ]
      }
    }
  };
  const parsed = parseUserStatusQuota(raw, nowMs);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.planName, 'Pro');
  assert.equal(parsed.buckets.length, 2);
  assert.equal(parsed.buckets[0].key, 'gemini');
  assert.equal(parsed.buckets[0].remainingPct, 74);
  assert.equal(parsed.buckets[0].resetInSec, 4.5 * 3600);
  assert.equal(parsed.buckets[1].key, 'claude-gpt');
  assert.equal(parsed.buckets[1].remainingPct, 100);
  assert.equal(JSON.stringify(parsed).includes('secret@example.com'), false, 'must never retain user PII');
});

test('parseQuotaSummary extracts both 5-hour and weekly quota windows per model group', () => {
  const nowMs = Date.parse('2026-11-26T00:00:00.000Z');
  const raw = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.816, resetTime: '2026-12-02T12:00:00.000Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.348, resetTime: '2026-11-26T03:48:00.000Z' }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-12-02T12:00:00.000Z' },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-26T04:00:00.000Z' }
          ]
        }
      ]
    }
  };
  const parsed = parseQuotaSummary(raw, nowMs, { planName: 'Pro' });
  assert.ok(parsed);
  assert.equal(parsed.planName, 'Pro');
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.groups[0].key, 'gemini');
  assert.equal(parsed.groups[0].fiveHour.remainingPct, 35);
  assert.equal(parsed.groups[0].weekly.remainingPct, 82);
  assert.equal(parsed.groups[1].key, 'claude-gpt');
  assert.equal(parsed.groups[1].fiveHour.remainingPct, 100);
  assert.equal(parsed.groups[1].weekly.remainingPct, 100);
});

test('createLanguageServerClient caches quota status within TTL and supports force refresh', async () => {
  let summaryCalls = 0;
  let now = 100000;
  const client = createLanguageServerClient({
    discoverFn: () => ({ host: '127.0.0.1', port: 34463, address: '127.0.0.1:34463', csrfToken: 'tok', pid: 1 }),
    nowFn: () => now,
    cacheTtlMs: 15000,
    fetchImpl: async (url) => {
      if (String(url).includes('RetrieveUserQuotaSummary')) {
        summaryCalls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              response: {
                groups: [
                  {
                    displayName: 'Gemini Models',
                    buckets: [
                      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 },
                      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8 }
                    ]
                  }
                ]
              }
            })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            userStatus: {
              planStatus: { planInfo: { planName: 'Pro' } },
              cascadeModelConfigData: {
                clientModelConfigs: [{ label: 'Gemini 4 Neon', quotaInfo: { remainingFraction: 0.8 } }]
              }
            }
          })
      };
    }
  });

  const q1 = await client.getQuotaStatus();
  const q2 = await client.getQuotaStatus();
  assert.equal(summaryCalls, 1, 'second call inside TTL should use cache');
  assert.equal(q1.planName, 'Pro');
  assert.equal(q1.groups[0].fiveHour.remainingPct, 80);
  assert.equal(q1.groups[0].weekly.remainingPct, 90);
  assert.equal(q2.buckets[0].remainingPct, 80);

  await client.getQuotaStatus({ force: true });
  assert.equal(summaryCalls, 2, 'force=true should bypass TTL cache');
});

test('auto-title updater cleans generated titles, enforces turn interval & cooldown, and updates via LS RPC', async () => {
  assert.equal(cleanGeneratedTitle('<|thought|>thinking...<|thought|>\n标题：《子代理路由与额度集成》！'), '子代理路由与额度集成');
  assert.deepEqual(normalizeAutoTitleConfig({ enabled: true, turnInterval: 1, minIntervalMin: 99 }), {
    enabled: true,
    turnInterval: 2,
    minIntervalMin: 60
  });
  assert.match(buildTitlePrompt(['添加额度弹窗'], { locale: 'en' }), /Generate a short/);

  let now = 1_000_000;
  const updates = [];
  const updater = createAutoTitleUpdater({
    getConfig: () => ({ autoTitle: { enabled: true, turnInterval: 2, minIntervalMin: 5 }, i18nLocale: 'zh-CN' }),
    lsClient: {
      getConversation: async () => ({ ok: true, data: { annotations: { title: '旧标题' } } }),
      updateConversationTitle: async (cid, title) => {
        updates.push({ cid, title });
        return { ok: true };
      }
    },
    generateTitle: async () => '「模型额度与子代理白名单」',
    nowFn: () => now
  });

  const cid = '88888888-8888-4888-8888-888888888888';
  updater.observeTurn({ cascadeId: cid, userText: '帮我把额度查询合并到信息弹窗' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(updates.length, 0, 'turn 1 below interval 2 should not update yet');

  updater.observeTurn({ cascadeId: cid, userText: '再加上子代理模型白名单支持 deepseek-4.1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].title, '模型额度与子代理白名单');

  // Within 5 min cooldown, even 2 more turns should not trigger an update
  now += 60_000;
  updater.observeTurn({ cascadeId: cid, userText: '继续完善测试' });
  updater.observeTurn({ cascadeId: cid, userText: '热重载部署' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(updates.length, 1, 'cooldown must suppress premature refreshes');
});

test('subagent-routing supports custom third-party models, builds authorization prompt, and validates explicit tags', () => {
  assert.equal(inferDefaultTier('gemini-3.8-flash-low'), 'fast');
  assert.equal(inferDefaultTier('deepseek-4.1'), 'strong');

  const base = {};
  sanitizeSubagentRoutingPatch(base, {
    subagentRouting: {
      enabled: true,
      allowedModels: [
        { id: 'gemini-3.8-flash-low', tier: 'fast', note: '检索' },
        { id: 'deepseek-4.1', tier: 'strong', note: '深度推理' },
        { id: '-bad-flag', tier: 'fast' }
      ]
    }
  });
  const norm = normalizeSubagentRouting(base.subagentRouting);
  assert.equal(norm.enabled, true);
  assert.equal(norm.allowedModels.length, 2);
  assert.equal(norm.allowedModels[1].id, 'deepseek-4.1');

  const policy = buildSubagentRoutingPrompt(norm);
  assert.match(policy, /<SUBAGENT_MODEL_ROUTING>/);
  assert.match(policy, /deepseek-4\.1/);

  // Explicit whitelisted tag
  const p1 = {
    model: 'gemini-4-neon-high',
    request: { contents: [{ role: 'user', parts: [{ text: '[model:deepseek-4.1]\n开始代码审查' }] }] }
  };
  const r1 = resolveSubagentTargetModel(p1, norm);
  assert.equal(r1.matched, true);
  assert.equal(r1.targetModel, 'deepseek-4.1');
  assert.equal(r1.reason, 'explicit-tag');
  assert.equal(p1.request.contents[0].parts[0].text, '开始代码审查');

  // Non-whitelisted tag falls back to tier match
  const p2 = {
    model: 'gemini-3.5-flash',
    request: { contents: [{ role: 'user', parts: [{ text: '[model:unlisted-evil]\n检索文件' }] }] }
  };
  const r2 = resolveSubagentTargetModel(p2, norm);
  assert.equal(r2.matched, true);
  assert.equal(r2.targetModel, 'gemini-3.8-flash-low');
  assert.equal(r2.reason, 'tier-fallback:fast');
});
