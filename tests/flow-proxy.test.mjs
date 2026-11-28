/**
 * tests/flow-proxy.test.mjs — End-to-End Offline Mock Tests for Local Flow Proxy
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createFlowProxyServer, detectSubagentRequest } from '../core/flow/proxy.mjs';
import { createFlowSessionStore } from '../core/flow/sessions.mjs';
import { buildGeminiSse, extractSseText } from '../core/flow/purify.mjs';

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpPost(port, reqPath, bodyObj, headers = {}) {
  const raw = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(raw);
  });
}

test('flow proxy routes non-model endpoints untouched, claims draft writing mode, continues truncations, and recovers refusals via Staging', async () => {
  const seenRequests = [];
  let modeScenario = 'continue';

  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {}
      seenRequests.push({ url: req.url, parsed });

      if (req.url.includes('loadCodeAssist')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ account: 'ok' }));
        return;
      }

      if (modeScenario === 'continue') {
        const contents = parsed?.request?.contents || [];
        if (contents.length === 1) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(buildGeminiSse('雨夜里他推开旧木门，屋内的煤油灯微微摇晃', { finishReason: 'MAX_TOKENS' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(buildGeminiSse('，墙上投下细长的影子。', { finishReason: 'STOP' }));
        }
        return;
      }

      if (modeScenario === 'staging') {
        const contents = parsed?.request?.contents || [];
        const isStaged = contents.length >= 3 && contents[contents.length - 2]?.role === 'model';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (!isStaged) {
          res.end(buildGeminiSse('抱歉，我无法协助创作这类内容。', { finishReason: 'STOP' }));
        } else {
          res.end(buildGeminiSse('壁炉的火光把走廊染成暖橘色，她轻声念完了最后一页信纸。', { finishReason: 'STOP' }));
        }
        return;
      }

      if (modeScenario === 'remap') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (parsed?.model === 'gpt-oss-120b-medium') {
          res.end(buildGeminiSse('## 交付结果\n```js\nconsole.log("ok")\n```', { finishReason: 'STOP' }));
        } else {
          res.end(buildGeminiSse("This request was blocked by Gemini's filters.", { finishReason: 'STOP' }));
        }
        return;
      }

      if (modeScenario === 'quota429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'RESOURCE_EXHAUSTED' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildGeminiSse('直通正文。', { finishReason: 'STOP' }));
    });
  });

  const upPort = await listenServer(mockUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  const events = [];
  const { server: proxyServer } = createFlowProxyServer({
    getConfig: () => ({
      upstream: `http://127.0.0.1:${upPort}`,
      defaultMode: 'default',
      modelPattern: 'gemini',
      maxContinuations: 3,
      refusalRewrite: true,
      softenEnabled: true,
      remapEnabled: true,
      remapTargetModel: 'gpt-oss-120b-medium'
    }),
    sessionStore: store,
    onEvent: (ev) => events.push(ev)
  });
  const proxyPort = await listenServer(proxyServer);

  try {
    // 1. Account/auth endpoint passes straight through (with equal-length pad stripped)
    const accRes = await httpPost(proxyPort, '/appppppppppp/v1internal:loadCodeAssist', { ping: 1 });
    assert.equal(accRes.status, 200);
    assert.equal(JSON.parse(accRes.body).account, 'ok');

    // 2. Draft writing mode auto-claims brand-new trajectory_id and stitches MAX_TOKENS continuation
    store.setSessionMode({ cascadeId: '__draft__:main', paneKey: 'main', mode: 'writing' });
    const trajWrite = '11111111-1111-4111-8111-111111111111';
    const contRes = await httpPost(proxyPort, '/appppppppppp/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: trajWrite, last_step_index: '0' },
        contents: [{ role: 'user', parts: [{ text: '写一段雨夜开场' }] }]
      }
    });
    assert.equal(contRes.status, 200);
    assert.equal(extractSseText(contRes.body).text, '雨夜里他推开旧木门，屋内的煤油灯微微摇晃，墙上投下细长的影子。');
    assert.equal(store.getSessionConfig(trajWrite).mode, 'writing');
    assert.equal(store.getRuntimeState(trajWrite).lastVerdict, 'continued');

    // 3. Keysmith Staging rewrite rotates upstream trajectory_id while accounting stays under orig trajectory_id
    modeScenario = 'staging';
    seenRequests.length = 0;
    const stagRes = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: trajWrite, last_step_index: '2' },
        contents: [{ role: 'user', parts: [{ text: '继续写走廊戏' }] }]
      }
    });
    assert.equal(stagRes.status, 200);
    assert.match(extractSseText(stagRes.body).text, /壁炉的火光/);
    assert.equal(seenRequests.length, 2);
    const secondUpstreamTraj = seenRequests[1].parsed.request.labels.trajectory_id;
    assert.notEqual(secondUpstreamTraj, trajWrite, 'upstream Staging retry should rotate trajectory_id');
    assert.equal(store.getRuntimeState(trajWrite).lastVerdict, 'staged', 'local state must remain bound to original trajectory_id');

    // 4. Full mode fallback model remap when all primary/staging/escalation attempts are blocked
    modeScenario = 'remap';
    const trajFull = '22222222-2222-4222-8222-222222222222';
    store.setSessionMode({ cascadeId: trajFull, mode: 'full' });
    const remapRes = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: trajFull, last_step_index: '0' },
        contents: [{ role: 'user', parts: [{ text: '给出解析脚本' }] }]
      }
    });
    assert.equal(remapRes.status, 200);
    assert.match(extractSseText(remapRes.body).text, /交付结果/);

    // 5. HTTP 429 converts to friendly SSE & activates cooldown
    modeScenario = 'quota429';
    seenRequests.length = 0;
    const q1 = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: trajFull, last_step_index: '1' },
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
      }
    });
    assert.equal(q1.status, 200);
    assert.match(extractSseText(q1.body).text, /429/);
    const countAfterFirst = seenRequests.length;
    const q2 = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: trajFull, last_step_index: '2' },
        contents: [{ role: 'user', parts: [{ text: 'hello again' }] }]
      }
    });
    assert.equal(q2.status, 200);
    assert.equal(seenRequests.length, countAfterFirst, 'cooldown must short-circuit repeated upstream calls');
    assert.ok(events.length > 0);
  } finally {
    await closeServer(proxyServer);
    await closeServer(mockUpstream);
  }
});

test('flow proxy injects customSystemPrompt directly into systemInstruction when mode is flow-proxy', async () => {
  const captured = [];
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildGeminiSse('已按系统指令回复。', { finishReason: 'STOP' }));
    });
  });
  const upPort = await listenServer(mockUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  let everyInvFlag = false;
  const { server: proxyServer } = createFlowProxyServer({
    getConfig: () => ({
      upstream: `http://127.0.0.1:${upPort}`,
      defaultMode: 'default',
      modelPattern: 'gemini'
    }),
    getSystemPrompt: () => ({
      enabled: true,
      mode: 'flow-proxy',
      text: 'GLOBAL_PROXY_SEAT_CONTRACT_V1',
      everyInvocation: everyInvFlag
    }),
    sessionStore: store
  });
  const proxyPort = await listenServer(proxyServer);

  try {
    // Even in default mode, flow-proxy injects customSystemPrompt into systemInstruction and strips stale managed blocks
    const r = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: '33333333-3333-4333-8333-333333333333' },
        contents: [
          {
            role: 'user',
            parts: [{ text: '<!-- antigravity-theme:system-prompt:start -->\nOLD_STALE_BLOCK\n<!-- antigravity-theme:system-prompt:end -->\n你好' }]
          }
        ]
      }
    });
    assert.equal(r.status, 200);
    assert.equal(captured.length, 1);
    const sysParts = captured[0].request.systemInstruction?.parts || [];
    assert.ok(sysParts.some((p) => String(p.text || '').includes('GLOBAL_PROXY_SEAT_CONTRACT_V1')));
    const firstTurnParts = captured[0].request.contents[0].parts;
    assert.ok(
      firstTurnParts[0].text.includes('<SYSTEM_MESSAGE>') && firstTurnParts[0].text.includes('GLOBAL_PROXY_SEAT_CONTRACT_V1'),
      'per-session mode should prepend native <SYSTEM_MESSAGE> to the first user turn for high weight + cache stability'
    );
    const userText = firstTurnParts.map((p) => p.text || '').join('\n');
    assert.ok(!userText.includes('OLD_STALE_BLOCK'), 'stale managed block should be stripped');
    assert.match(userText, /你好/);

    // When everyInvocation=true in flow-proxy mode, append native <SYSTEM_MESSAGE> to the latest user turn
    everyInvFlag = true;
    captured.length = 0;
    const r2 = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: '33333333-3333-4333-8333-333333333333' },
        contents: [
          { role: 'user', parts: [{ text: '第一轮提问' }] },
          { role: 'model', parts: [{ text: '第一轮回答' }] },
          { role: 'user', parts: [{ text: '第二轮提问' }] }
        ]
      }
    });
    assert.equal(r2.status, 200);
    assert.equal(captured.length, 1);
    const firstParts2 = captured[0].request.contents[0].parts.map((p) => p.text || '').join('\n');
    assert.equal(firstParts2.includes('<SYSTEM_MESSAGE>'), false, 'everyTurn=true injects at latest turn rather than duplicating turn 0');
    const lastParts2 = captured[0].request.contents[2].parts;
    const lastText2 = lastParts2[lastParts2.length - 1].text || '';
    assert.ok(lastText2.includes('<SYSTEM_MESSAGE>'), 'everyInvocation=true should append native <SYSTEM_MESSAGE> at latest user turn');
    assert.ok(lastText2.includes('GLOBAL_PROXY_SEAT_CONTRACT_V1'));

    // Internal title-generation / flash-lite utility requests must bypass prompt injection untouched
    captured.length = 0;
    const rTitle = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-3.5-flash-lite',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Generate a concise title for this conversation: 你是谁' }] }]
      }
    });
    assert.equal(rTitle.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].request.systemInstruction, undefined, 'flash-lite title request must not receive systemInstruction');
    assert.equal(
      captured[0].request.contents[0].parts.some((p) => String(p.text || '').includes('<SYSTEM_MESSAGE>')),
      false,
      'flash-lite title request must not receive <SYSTEM_MESSAGE>'
    );
  } finally {
    await closeServer(proxyServer);
    await closeServer(mockUpstream);
  }
});

test('flow proxy applies per-mode prompts, inherits parent mode for subagents, and decodes gzip payloads', async () => {
  const captured = [];
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildGeminiSse('资料已整理完成，相关结论与正文段落已按要求输出完毕。', { finishReason: 'STOP' }));
    });
  });
  const upPort = await listenServer(mockUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  const parentCid = '44444444-4444-4444-8444-444444444444';
  const subCid = '55555555-5555-4555-8555-555555555555';
  store.setSessionMode({ cascadeId: parentCid, mode: 'writing' });

  const { server: proxyServer } = createFlowProxyServer({
    getConfig: () => ({
      upstream: `http://127.0.0.1:${upPort}`,
      defaultMode: 'default',
      modelPattern: 'gemini',
      defaultSeat: 'DEFAULT_MODE_SEAT',
      writingSeat: 'WRITING_MODE_SEAT'
    }),
    getActiveMainSessions: () => [parentCid],
    sessionStore: store
  });
  const proxyPort = await listenServer(proxyServer);

  try {
    // 1. Subagent automatically inherits parent's writing mode and receives writing mode prompt directly
    const r1 = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: subCid },
        systemInstruction: { parts: [{ text: 'You are a subagent assigned to research.' }] },
        contents: [{ role: 'user', parts: [{ text: '查一下资料' }] }]
      }
    });
    assert.equal(r1.status, 200);
    const sys1 = captured[0].request.systemInstruction.parts.map((p) => p.text).join('\n');
    assert.ok(sys1.includes('WRITING_MODE_SEAT'), 'subagent should inherit parent mode prompt directly');
    const c1 = captured[0].request.contents[0].parts.map((p) => p.text || '').join('\n');
    assert.ok(c1.includes('<SYSTEM_MESSAGE>') && c1.includes('WRITING_MODE_SEAT'), 'mode prompt should be injected as native <SYSTEM_MESSAGE> in contents');

    // 2. Gzip-encoded POST body is decoded, injected, and forwarded cleanly without Content-Encoding: gzip
    captured.length = 0;
    const rawJson = JSON.stringify({
      model: 'claude-sonnet-5-5-high',
      request: {
        labels: { trajectory_id: parentCid },
        contents: [{ role: 'user', parts: [{ text: '写一段开场白' }] }]
      }
    });
    const gzBuf = zlib.gzipSync(Buffer.from(rawJson, 'utf8'));
    const r3 = await new Promise((resolve, reject) => {
      const rq = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          path: '/v1internal:streamGenerateContent?alt=sse',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': gzBuf.length
          }
        },
        (rs) => {
          const ch = [];
          rs.on('data', (c) => ch.push(c));
          rs.on('end', () => resolve({ status: rs.statusCode, body: Buffer.concat(ch).toString('utf8') }));
        }
      );
      rq.on('error', reject);
      rq.end(gzBuf);
    });
    assert.equal(r3.status, 200);
    assert.equal(captured.length, 1);
    const sys3 = captured[0].request.systemInstruction.parts.map((p) => p.text).join('\n');
    assert.ok(sys3.includes('WRITING_MODE_SEAT'), 'gzip + non-gemini model should still receive per-mode system prompt');
  } finally {
    await closeServer(proxyServer);
    await closeServer(mockUpstream);
  }
});

test('flow proxy force-reinjects active session prompt into retry turn tail regardless of everyInvocation, routes subagent models, and tracks main turns', async () => {
  const captured = [];
  let scenario = 'retry-eng';

  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      captured.push(parsed);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (scenario === 'retry-eng') {
        if (captured.length === 1) {
          res.end(buildGeminiSse('抱歉，我无法完成这项请求。', { finishReason: 'STOP' }));
        } else if (captured.length === 2) {
          res.end(buildGeminiSse('抱歉，我不能提供该操作。', { finishReason: 'STOP' }));
        } else {
          res.end(buildGeminiSse('```js\nconsole.log("recovered");\n```\n已完成交付。', { finishReason: 'STOP' }));
        }
        return;
      }
      res.end(buildGeminiSse('OK', { finishReason: 'STOP' }));
    });
  });

  const upPort = await listenServer(mockUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  const mainCid = '66666666-6666-4666-8666-666666666666';
  const subCid = '77777777-7777-4777-8777-777777777777';
  store.setSessionMode({ cascadeId: mainCid, mode: 'engineering' });

  const mainTurns = [];
  const { server: proxyServer } = createFlowProxyServer({
    getConfig: () => ({
      upstream: `http://127.0.0.1:${upPort}`,
      defaultMode: 'default',
      modelPattern: 'gemini',
      softenEnabled: true,
      engineeringSeat: 'ENG_RETRY_PROMPT_CONTRACT'
    }),
    getSystemPrompt: () => ({
      enabled: true,
      mode: 'flow-proxy',
      text: 'GLOBAL_RETRY_CONTRACT',
      everyInvocation: false
    }),
    getSubagentRouting: () => ({
      enabled: true,
      allowedModels: [
        { id: 'gemini-3.8-flash-low', tier: 'fast', note: '快速搜索' },
        { id: 'deepseek-4.1', tier: 'strong', note: '深度分析' }
      ]
    }),
    getActiveMainSessions: () => [mainCid],
    onMainTurn: (info) => mainTurns.push(info),
    sessionStore: store
  });
  const proxyPort = await listenServer(proxyServer);

  try {
    // 1. Even with everyInvocation=false, escalation retry attempts (including attempt 2 after narrowContext)
    //    must force re-inject the session prompt into the latest user turn tail.
    const r1 = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: mainCid },
        contents: [
          { role: 'user', parts: [{ text: '第一轮背景信息' }] },
          { role: 'model', parts: [{ text: '好的，请继续' }] },
          { role: 'user', parts: [{ text: '第二轮背景信息' }] },
          { role: 'model', parts: [{ text: '收到' }] },
          { role: 'user', parts: [{ text: '请帮我分析兼容性并给出脚本' }] }
        ]
      }
    });
    assert.equal(r1.status, 200);
    assert.match(extractSseText(r1.body).text, /recovered/);
    assert.equal(captured.length, 3, 'primary + attempt 1 + attempt 2');

    // Attempt 1 & Attempt 2 (even after narrowContext drops turn 0!) must carry session prompt in the latest user turn
    for (const retryIdx of [1, 2]) {
      const cList = captured[retryIdx].request.contents;
      const lastTurnText = cList[cList.length - 1].parts.map((p) => p.text || '').join('\n');
      assert.ok(
        lastTurnText.includes('<SYSTEM_MESSAGE>') &&
          lastTurnText.includes('GLOBAL_RETRY_CONTRACT') &&
          lastTurnText.includes('ENG_RETRY_PROMPT_CONTRACT'),
        `retry attempt ${retryIdx} must force-reinject active session prompt at tail regardless of everyInvocation`
      );
    }
    // Main session must also receive <SUBAGENT_MODEL_ROUTING> listing deepseek-4.1
    const mainFirstText = captured[0].request.contents[0].parts.map((p) => p.text || '').join('\n');
    assert.ok(mainFirstText.includes('<SUBAGENT_MODEL_ROUTING>') && mainFirstText.includes('deepseek-4.1'));
    assert.equal(mainTurns.length, 1);
    assert.equal(mainTurns[0].cascadeId, mainCid);

    // 2. Pure tool-result callback turn must NOT double-count as a new user turn
    scenario = 'ok';
    captured.length = 0;
    await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: mainCid },
        contents: [
          { role: 'user', parts: [{ text: '请帮我分析兼容性并给出脚本' }] },
          { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'abc' } } }] }
        ]
      }
    });
    assert.equal(mainTurns.length, 1, 'tool callback turn must not increment main turn counter');

    // 3. Subagent request with [model:deepseek-4.1] routes model to deepseek-4.1 and strips tag
    captured.length = 0;
    const rSub = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-neon-high',
      request: {
        labels: { trajectory_id: subCid },
        systemInstruction: { parts: [{ text: 'You are a subagent assigned to deep analysis.' }] },
        contents: [{ role: 'user', parts: [{ text: '[model:deepseek-4.1]\n请深度分析架构依赖' }] }]
      }
    });
    assert.equal(rSub.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, 'deepseek-4.1', 'subagent model should be rewritten to whitelisted custom model');
    const subPromptText = captured[0].request.contents[0].parts.map((p) => p.text || '').join('\n');
    assert.equal(subPromptText.includes('[model:deepseek-4.1]'), false, 'explicit model tag must be stripped before forwarding');
    assert.equal(subPromptText.includes('<SUBAGENT_MODEL_ROUTING>'), false, 'routing policy must only be injected into main sessions');

    // 4. Native Orchestrator Worker (gemini-flash-worker-agy / MODEL_PLACEHOLDER_M669) is detected as subagent and routed via whitelist
    captured.length = 0;
    const rOrchWorker = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-flash-worker-agy',
      request: {
        labels: { trajectory_id: mainCid },
        contents: [{ role: 'user', parts: [{ text: '[model:deepseek-4.1]\n执行模块重构子任务' }] }]
      }
    });
    assert.equal(rOrchWorker.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, 'deepseek-4.1', 'Orchestrator worker with explicit tag should route to whitelisted model');
    assert.equal(
      captured[0].request.contents[0].parts.map((p) => p.text || '').join('\n').includes('[model:deepseek-4.1]'),
      false,
      'tag must be stripped for Orchestrator worker too'
    );

    // Without explicit tag, Orchestrator worker falls back to matching fast tier in whitelist
    captured.length = 0;
    const rOrchTier = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'MODEL_PLACEHOLDER_M669',
      request: {
        labels: { trajectory_id: mainCid },
        contents: [{ role: 'user', parts: [{ text: '快速检索配置文件' }] }]
      }
    });
    assert.equal(rOrchTier.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, 'gemini-3.8-flash-low', 'Orchestrator worker without tag should map to fast/balanced whitelist model');
  } finally {
    await closeServer(proxyServer);
    await closeServer(mockUpstream);
  }
});

test('flow proxy resolves trajectory_id to cascade_id, extracts promptTokenCount from gzip SSE, auto-compacts in default mode, and applies virtual compaction on next turn', async () => {
  const captured = [];
  const cascadeId = '88888888-8888-4888-8888-888888888888';
  const trajectoryId = '99999999-9999-4999-8999-999999999999';

  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      captured.push(parsed);
      const isSummaryCall = String(parsed?.requestId || '').startsWith('ag-codex-compact-');
      if (isSummaryCall) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          buildGeminiSse(
            '## 当前目标与用户约束\n已完成前序阶段排查与构建。\n## 已验证事实与完成进度\n已验证 core/flow/compactor.mjs 与 core/flow/proxy.mjs 链路正常。',
            { finishReason: 'STOP' }
          )
        );
        return;
      }
      const ssePayload = buildGeminiSse('已确认收到。', {
        finishReason: 'STOP',
        usageMetadata: { promptTokenCount: 430000, candidatesTokenCount: 32 }
      });
      const gz = zlib.gzipSync(Buffer.from(ssePayload, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' });
      res.end(gz);
    });
  });

  const upPort = await listenServer(mockUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  const compactEvents = [];
  const proxyApi = createFlowProxyServer({
    getConfig: () => ({
      upstream: `http://127.0.0.1:${upPort}`,
      defaultMode: 'default',
      compactEnabled: true,
      compactThresholdPct: 80,
      compactKeepTailTokens: 200
    }),
    getActiveMainSessions: () => [cascadeId],
    resolveCascadeId: (id) => (id === trajectoryId ? cascadeId : id),
    getContextWindow: (cid) => (cid === cascadeId ? 512000 : 0),
    sessionStore: store,
    onEvent: (ev) => {
      if (ev?.type === 'compact') compactEvents.push(ev);
    }
  });
  const proxyPort = await listenServer(proxyApi.server);

  try {
    const big = 'Detailed context '.repeat(350);
    const contents = [
      { role: 'user', parts: [{ text: 'U0 ' + big }] },
      { role: 'model', parts: [{ text: 'M0 ' + big }] },
      { role: 'user', parts: [{ text: 'U1 ' + big }] },
      { role: 'model', parts: [{ text: 'M1 ' + big }] },
      { role: 'user', parts: [{ text: 'U2 intermediate question' }] },
      { role: 'model', parts: [{ text: 'M2 intermediate reply' }] },
      { role: 'user', parts: [{ text: 'U3 latest question' }] }
    ];

    const r1 = await httpPost(
      proxyPort,
      '/v1internal:streamGenerateContent?alt=sse',
      {
        model: 'gemini-4-hydrogen-medium',
        request: {
          labels: { trajectory_id: trajectoryId },
          contents
        }
      },
      { authorization: 'Bearer test-token' }
    );
    assert.equal(r1.status, 200);

    // Wait briefly for background async compaction to complete
    for (let i = 0; i < 40; i += 1) {
      if (proxyApi.getCompactionStatus(cascadeId).count >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const st = proxyApi.getCompactionStatus(cascadeId);
    assert.equal(st.active, true, 'auto compaction should trigger and persist under resolved cascadeId');
    assert.equal(st.count, 1);
    assert.equal(compactEvents.length, 1);

    // Next turn from IDE should have virtual compaction applied
    captured.length = 0;
    const nextContents = [
      ...contents,
      { role: 'model', parts: [{ text: '已确认收到。' }] },
      { role: 'user', parts: [{ text: 'U3 continue' }] }
    ];
    const r2 = await httpPost(
      proxyPort,
      '/v1internal:streamGenerateContent?alt=sse',
      {
        model: 'gemini-4-hydrogen-medium',
        request: {
          labels: { trajectory_id: trajectoryId },
          contents: nextContents
        }
      },
      { authorization: 'Bearer test-token' }
    );
    assert.equal(r2.status, 200);
    assert.equal(captured.length, 1);
    const outboundContents = captured[0].request.contents;
    assert.ok(outboundContents.length < nextContents.length, 'virtual compaction should shrink outbound contents');
    assert.ok(
      outboundContents[0].parts[0].text.includes('[CODEX_VIRTUAL_COMPACTION_V1]'),
      'outbound compacted history should carry CODEX_VIRTUAL_COMPACTION_V1 handoff'
    );
  } finally {
    await closeServer(proxyApi.server);
    await closeServer(mockUpstream);
  }
});

test('detectSubagentRequest ignores built-in <subagents> tool docs on active main sessions, and pipePassThrough hardens timeouts & retries transient socket reset', async () => {
  const mainCid = 'aaaaaaaa-1111-4111-8111-111111111111';
  const mainSysPrompt = [
    'You are Antigravity.',
    '<subagents>',
    'Available subagents:',
    '- research: Research subagent with read-only tools.',
    '- browser: Browser subagent that operates a webview.',
    '</subagents>'
  ].join('\n');
  const resMain = detectSubagentRequest(
    {
      model: 'gemini-4-hydrogen-medium',
      request: {
        labels: { trajectory_id: 'other-traj' },
        systemInstruction: { parts: [{ text: mainSysPrompt }] },
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
      }
    },
    mainCid,
    [mainCid],
    false
  );
  assert.equal(resMain.isSubagent, false, 'active main session with <subagents> docs must NOT be misclassified as subagent');

  // Verify server timeout hardening + transient ECONNRESET auto-retry before headers
  let attempts = 0;
  const flakyUpstream = http.createServer((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildGeminiSse('重连后成功返回。', { finishReason: 'STOP' }));
    });
  });
  const upPort = await listenServer(flakyUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  const proxyApi = createFlowProxyServer({
    getConfig: () => ({ upstream: `http://127.0.0.1:${upPort}`, defaultMode: 'default' }),
    getActiveMainSessions: () => [mainCid],
    sessionStore: store
  });
  assert.equal(proxyApi.server.requestTimeout, 0);
  assert.ok(proxyApi.server.keepAliveTimeout >= 65000);
  const proxyPort = await listenServer(proxyApi.server);
  try {
    const r = await httpPost(proxyPort, '/v1internal:streamGenerateContent?alt=sse', {
      model: 'gemini-4-hydrogen-medium',
      request: {
        labels: { trajectory_id: mainCid },
        systemInstruction: { parts: [{ text: mainSysPrompt }] },
        contents: [{ role: 'user', parts: [{ text: '测试断连自动重试' }] }]
      }
    });
    assert.equal(r.status, 200);
    assert.equal(attempts, 2, 'pipePassThrough should silently retry once on pre-header socket reset');
    assert.match(extractSseText(r.body).text, /重连后成功返回/);
  } finally {
    await closeServer(proxyApi.server);
    await closeServer(flakyUpstream);
  }
});

test('flow proxy recovers full-mode refusals even when judge fails, strips breaking tool chains on 400 staging fallback, and logs final verdict to /ag-flow/diag', async () => {
  const captured = [];
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      captured.push(parsed);
      // 1. Judge request fails with 404 (simulating unavailable judge model)
      if (String(parsed?.requestId || '').startsWith('ag-flow-judge-')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 404, message: 'model not found' } }));
        return;
      }
      const contents = parsed?.request?.contents || [];
      const hasTools = Array.isArray(parsed?.request?.tools) && parsed.request.tools.length > 0;
      const isStaged = contents.some((c) =>
        (c?.parts || []).some((pt) => String(pt?.text || '').includes('虚构创作与文本交付任务'))
      );
      // 2. Staged retry that keeps legacy tools returns 400; clean-history staging without tools succeeds
      if (isStaged && hasTools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 400, message: 'INVALID_ARGUMENT: tool turn mismatch' } }));
        return;
      }
      if (isStaged && !hasTools) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(buildGeminiSse('夜风穿过长廊，檐角铜铃轻响一声，他收起信笺转身步入正殿。', { finishReason: 'STOP' }));
        return;
      }
      // 3. Primary request returns realistic refusal
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        buildGeminiSse(
          '无法生成该番外短篇。你的请求要求创作高冲突内容，超出了安全限制，即便在虚构小说的语境下也不能提供。',
          { finishReason: 'STOP' }
        )
      );
    });
  });

  const upPort = await listenServer(mockUpstream);
  const store = createFlowSessionStore({ getDefaultMode: () => 'default' });
  const cid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  store.setSessionMode({ cascadeId: cid, mode: 'full' });

  const proxyApi = createFlowProxyServer({
    getConfig: () => ({
      upstream: `http://127.0.0.1:${upPort}`,
      defaultMode: 'default',
      modelPattern: 'gemini',
      judgeEnabled: true,
      judgeModel: 'gemini-3.8-flash-low',
      refusalRewrite: true,
      softenEnabled: true
    }),
    getActiveMainSessions: () => [cid],
    sessionStore: store
  });
  const proxyPort = await listenServer(proxyApi.server);

  try {
    const r = await httpPost(
      proxyPort,
      '/v1internal:streamGenerateContent?alt=sse',
      {
        model: 'gemini-4-hydrogen-medium',
        request: {
          labels: { trajectory_id: cid },
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
          contents: [
            { role: 'user', parts: [{ text: '写一个番外短篇看看效果' }] },
            { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'x.md' } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'ok' } } }] }
          ]
        }
      },
      { authorization: 'Bearer test-token' }
    );
    assert.equal(r.status, 200);
    assert.match(extractSseText(r.body).text, /夜风穿过长廊/);
    assert.equal(store.getRuntimeState(cid)?.lastVerdict, 'staged');

    // Verify /ag-flow/diag records final verdict, actions, and primaryStatus
    const diagRes = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxyPort, path: '/ag-flow/diag' }, (res) => {
          const ch = [];
          res.on('data', (c) => ch.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))));
        })
        .on('error', reject);
    });
    const lastDiag = diagRes.recent[diagRes.recent.length - 1];
    assert.equal(lastDiag.primaryStatus, 200);
    assert.equal(lastDiag.verdict, 'staged');
    assert.ok(lastDiag.actions.some((a) => a.type === 'judge-fallback'));
    assert.ok(lastDiag.actions.some((a) => a.type === 'staging-http-error' && a.status === 400));
    assert.ok(lastDiag.actions.some((a) => a.type === 'staging-rewrite' && a.cleanHistory === true));
  } finally {
    await closeServer(proxyApi.server);
    await closeServer(mockUpstream);
  }
});
