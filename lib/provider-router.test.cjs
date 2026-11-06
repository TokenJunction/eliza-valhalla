'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeRemoteOllama, executeRoute, localGatewayTarget, selectRoute } = require('./provider-router');

const SECRET = 'super-secret-byok-value';
const LOCAL_TOKEN = 'local-gateway-token-value';
const REMOTE_TOKEN = 'remote-ollama-token-value';
const budget = { remainingUsd: 1, callUsd: 0.01 };

function gateway(overrides = {}) {
  return {
    baseUrl: 'http://127.0.0.1:8788',
    token: LOCAL_TOKEN,
    capabilities: ['voice', 'reasoning', 'paper', 'view'],
    model: 'qwen2.5-coder:14b',
    ...overrides,
  };
}

function base(overrides = {}) {
  return {
    role: 'odin',
    capability: 'reasoning',
    prompt: 'Summarize the paper desk.',
    runtime: 'local-pc',
    localPcAwake: true,
    budget,
    secrets: {
      DEEPSEEK_API_KEY: SECRET,
      GEMINI_API_KEY: SECRET,
      DEEPSEEK_MODEL: 'deepseek-flash',
      GEMINI_MODEL: 'gemini-2.5-flash',
    },
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function leaked(value, secret) {
  return JSON.stringify(value).includes(secret);
}

test('a local browser desktop generates through the loopback gateway and stays offline', async () => {
  const calls = [];
  const result = await executeRoute(base({
    desktop: 'local-browser',
    capability: 'voice',
    localGateway: gateway(),
    secrets: {},
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ content: 'Local voice reply.' });
    },
  });
  assert.equal(result.route, 'local-gateway');
  assert.equal(result.model, 'qwen2.5-coder:14b');
  assert.equal(result.content, 'Local voice reply.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/v1/generate');
  assert.equal(calls[0].url.includes('11434'), false);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(calls[0].options.headers['x-valhalla-capability'], 'voice');
  assert.equal(calls[0].options.headers['x-goog-api-key'], undefined);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.capability, 'voice');
  assert.equal(body.model, 'qwen2.5-coder:14b');
  assert.equal(leaked(body, LOCAL_TOKEN), false);
  assert.equal(leaked(body, SECRET), false);
  assert.equal(leaked(result, LOCAL_TOKEN), false);
});

test('an unreachable PC falls back to cloud, and stays unavailable when no cloud key exists', async () => {
  const downUrls = [];
  const down = await executeRoute(base({
    desktop: 'local-browser',
    localGateway: gateway(),
  }), {
    fetchImpl: async (url) => {
      downUrls.push(String(url));
      if (downUrls.length === 1) return jsonResponse({ error: 'down' }, 503);
      return jsonResponse({ choices: [{ message: { content: 'Cloud after the PC missed.' } }] });
    },
  });
  assert.deepEqual(downUrls, [
    'http://127.0.0.1:8788/v1/generate',
    'https://api.deepseek.com/chat/completions',
  ]);
  assert.equal(down.route, 'deepseek');
  assert.equal(down.fallbackFrom, 'local_gateway_unavailable');

  const asleepUrls = [];
  const asleep = await executeRoute(base({
    desktop: 'local-browser',
    localPcAwake: false,
    localGateway: gateway(),
  }), {
    fetchImpl: async (url) => {
      asleepUrls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'Cloud while the PC is asleep.' } }] });
    },
  });
  assert.deepEqual(asleepUrls, ['https://api.deepseek.com/chat/completions']);
  assert.equal(asleep.fallbackFrom, 'local_pc_asleep');

  let offlineCalls = 0;
  const offline = await executeRoute(base({
    desktop: 'local-browser',
    localGateway: gateway(),
    secrets: {},
  }), {
    fetchImpl: async () => {
      offlineCalls += 1;
      return jsonResponse({ error: 'down' }, 503);
    },
  });
  assert.equal(offlineCalls, 1);
  assert.equal(offline.status, 'unavailable');
  assert.equal(offline.content, null);
});

test('the adapter never dials Ollama port 11434, including a direct or Render URL', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return jsonResponse({ choices: [{ message: { content: 'Cloud reasoning.' } }] });
  };
  for (const ollamaBaseUrl of [
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/api/chat',
    'https://ollama.example.onrender.com',
  ]) {
    const result = await executeRoute(base({
      ollamaBaseUrl,
      localGateway: gateway({ baseUrl: 'http://127.0.0.1:11434' }),
    }), { fetchImpl });
    assert.equal(result.route, 'deepseek');
  }
  assert.equal(urls.every((url) => url === 'https://api.deepseek.com/chat/completions'), true);
  assert.equal(urls.some((url) => url.includes('11434') || url.includes('onrender')), false);
  assert.equal(localGatewayTarget(gateway({ baseUrl: 'http://127.0.0.1:11434' })).reason, 'ollama_port_blocked');
});

test('a cloud runtime does not use the local gateway and keeps the DeepSeek call separate', async () => {
  const calls = [];
  const result = await executeRoute(base({
    runtime: 'render',
    localPcAwake: true,
    localGateway: gateway(),
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ choices: [{ message: { content: 'Cloud reasoning.' } }] });
    },
  });
  assert.equal(result.route, 'deepseek');
  assert.equal(result.fallbackFrom, 'runtime_not_local');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].options.headers.authorization.includes(LOCAL_TOKEN), false);
  assert.equal(calls[0].url.includes(SECRET), false);
  assert.equal(leaked(result, SECRET), false);
  assert.equal(leaked(result, LOCAL_TOKEN), false);
});

test('an asleep PC skips the gateway and uses the separate cloud provider', async () => {
  const calls = [];
  const result = await executeRoute(base({
    localPcAwake: false,
    capability: 'voice',
    localGateway: gateway(),
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), goog: options.headers['x-goog-api-key'], authorization: options.headers.authorization });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Gemini voice.' }] } }] });
    },
  });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  ]);
  assert.equal(calls[0].goog, SECRET);
  assert.equal(calls[0].authorization, undefined);
  assert.equal(result.route, 'gemini');
  assert.equal(result.fallbackFrom, 'local_pc_asleep');
  assert.equal(leaked(result, SECRET), false);
});

test('gateway failure falls back once to the matching cloud provider', async () => {
  const calls = [];
  const result = await executeRoute(base({ localGateway: gateway() }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.authorization });
      if (calls.length === 1) return jsonResponse({ error: 'down' }, 503);
      return jsonResponse({ choices: [{ message: { content: 'Cloud after local failure.' } }] });
    },
  });
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:8788/v1/generate',
    'https://api.deepseek.com/chat/completions',
  ]);
  assert.equal(calls[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(calls[1].authorization, `Bearer ${SECRET}`);
  assert.equal(result.route, 'deepseek');
  assert.equal(result.fallbackFrom, 'local_gateway_unavailable');
  assert.equal(result.chargedUsd, 0.01);
});

test('a denied gateway capability does not call the gateway', async () => {
  let calls = 0;
  const result = await executeRoute(base({
    capability: 'voice',
    localGateway: gateway({ capabilities: ['reasoning'] }),
  }), {
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(String(url).includes('8788'), false);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Gemini voice.' }] } }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.route, 'gemini');
  assert.equal(result.fallbackFrom, 'capability_denied');
});

test('a missing provider or empty provider body is unavailable and is not filled in', async () => {
  const asleep = await executeRoute(base({
    localPcAwake: false,
    secrets: {},
  }), {
    fetchImpl: async () => {
      throw new Error(`unexpected call with ${SECRET}`);
    },
  });
  assert.equal(asleep.status, 'unavailable');
  assert.equal(asleep.reason, 'provider_missing');
  assert.equal(asleep.content, null);
  assert.equal(JSON.stringify(asleep).includes('healthy'), false);

  let calls = 0;
  const empty = await executeRoute(base({ localPcAwake: false }), {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: '   ' } }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.reason, 'empty_content');
  assert.equal(empty.content, null);
  assert.equal(empty.chargedUsd, 0);
});

test('provider errors stay unavailable and do not leak a key', async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const thrown = await executeRoute(base({ localPcAwake: false }), {
      fetchImpl: async () => {
        throw new Error(`connect failed Authorization Bearer ${SECRET}`);
      },
    });
    assert.equal(thrown.status, 'unavailable');
    assert.equal(thrown.content, null);
    assert.equal(leaked(thrown, SECRET), false);
    assert.equal(logs.some((line) => line.includes(SECRET)), false);
  } finally {
    console.error = original;
  }
});

test('budget failures do not call a provider', async () => {
  const cases = [
    { remainingUsd: 0, callUsd: 0.01 },
    { remainingUsd: 0.001, callUsd: 0.01 },
    { remainingUsd: Number.NaN, callUsd: 0.01 },
    { remainingUsd: 1, callUsd: 0 },
    null,
  ];
  for (const item of cases) {
    let calls = 0;
    const result = await executeRoute(base({
      budget: item,
      localGateway: gateway(),
      desktop: 'local-browser',
    }), {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ content: 'should not run' });
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'budget_exhausted');
    assert.equal(result.content, null);
  }
});

test('Thalos accepts paper and view only and never reports live execution', async () => {
  const paper = await executeRoute(base({
    role: 'thalos',
    capability: 'paper',
    desktop: 'local-browser',
    localGateway: gateway(),
    secrets: {},
  }), {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /Paper and view only/);
      assert.equal(body.capability, 'paper');
      return jsonResponse({ content: 'View of the paper book.' });
    },
  });
  assert.equal(paper.mode, 'paper');
  assert.equal(paper.liveExecution, false);
  assert.equal(paper.content, 'View of the paper book.');

  let calls = 0;
  for (const capability of ['trade', 'live', 'sign', 'withdraw']) {
    const refused = await executeRoute(base({ role: 'thalos', capability, localGateway: gateway() }), {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ content: 'filled' });
      },
    });
    assert.equal(refused.status, 'unavailable');
    assert.equal(refused.reason, 'capability_unavailable');
    assert.equal(refused.liveExecution, false);
  }
  assert.equal(calls, 0);
});

test('route selection does not copy a secret into the decision object', () => {
  const decision = selectRoute(base({
    runtime: 'render',
    localPcAwake: false,
    localGateway: gateway(),
  }));
  assert.equal(decision.route, 'deepseek');
  assert.equal(decision.providerState, 'not_probed');
  assert.equal(Object.hasOwn(decision, 'secrets'), false);
  assert.equal(Object.hasOwn(decision, 'token'), false);
  assert.equal(leaked(decision, SECRET), false);
  assert.equal(leaked(decision, LOCAL_TOKEN), false);
  assert.equal(JSON.stringify(decision).includes('healthy'), false);
});

test('a remote Ollama target must be an allow-listed HTTPS host with a token', async () => {
  const calls = [];
  const result = await executeRoute(base({
    target: 'remote-ollama',
    runtime: 'render',
    remoteOllama: {
      enabled: true,
      baseUrl: 'https://ollama.customer.example/v1/generate',
      token: REMOTE_TOKEN,
      allowHosts: ['ollama.customer.example'],
      capabilities: ['reasoning'],
      model: 'qwen2.5-coder:14b',
    },
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ content: 'Remote reply.' });
    },
  });
  assert.equal(result.route, 'remote-ollama');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ollama.customer.example/v1/generate');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${REMOTE_TOKEN}`);
  assert.equal(calls[0].options.headers['x-goog-api-key'], undefined);
  assert.equal(leaked(result, REMOTE_TOKEN), false);
  assert.equal(leaked(JSON.parse(calls[0].options.body), REMOTE_TOKEN), false);
});

test('remote Ollama rejects internal, non-HTTPS, and non-allow-listed targets without a fetch', async () => {
  const samples = [
    ['http://ollama.customer.example', ['ollama.customer.example'], 'remote_url_rejected'],
    ['https://user:pass@ollama.customer.example', ['ollama.customer.example'], 'remote_url_rejected'],
    ['https://ollama.customer.example:11434', ['ollama.customer.example'], 'remote_url_rejected'],
    ['https://ollama.customer.example/api/chat', ['ollama.customer.example'], 'remote_url_rejected'],
    ['https://ollama.customer.example/?next=http://127.0.0.1', ['ollama.customer.example'], 'remote_url_rejected'],
    ['https://127.0.0.1', ['127.0.0.1'], 'remote_internal_url'],
    ['https://10.0.0.5', ['10.0.0.5'], 'remote_internal_url'],
    ['https://169.254.169.254', ['169.254.169.254'], 'remote_internal_url'],
    ['https://[::1]', ['::1'], 'remote_internal_url'],
    ['https://printer.local', ['printer.local'], 'remote_internal_url'],
    ['https://metadata.google.internal', ['metadata.google.internal'], 'remote_internal_url'],
    ['https://ollama.example.onrender.com', ['ollama.example.onrender.com'], 'remote_internal_url'],
    ['https://ollama.customer.example.evil.com', ['ollama.customer.example'], 'remote_host_not_allowed'],
    ['https://evil.com', ['ollama.customer.example'], 'remote_host_not_allowed'],
  ];
  for (const [baseUrl, allowHosts, reason] of samples) {
    let calls = 0;
    const result = await executeRoute(base({
      target: 'remote-ollama',
      remoteOllama: {
        enabled: true,
        baseUrl,
        token: REMOTE_TOKEN,
        allowHosts,
        capabilities: ['reasoning'],
      },
    }), {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ content: 'should not run' });
      },
    });
    assert.equal(calls, 0, baseUrl);
    assert.equal(result.status, 'unavailable', baseUrl);
    assert.equal(result.reason, reason, baseUrl);
    assert.equal(authorizeRemoteOllama({
      enabled: true,
      baseUrl,
      token: REMOTE_TOKEN,
      allowHosts,
    }).ok, false);
  }
});

test('an asleep PC does not use a configured remote Ollama endpoint as the cloud fallback', async () => {
  const urls = [];
  const result = await executeRoute(base({
    localPcAwake: false,
    remoteOllama: {
      enabled: true,
      baseUrl: 'https://ollama.customer.example',
      token: REMOTE_TOKEN,
      allowHosts: ['ollama.customer.example'],
      capabilities: ['reasoning'],
    },
  }), {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'Cloud reasoning.' } }] });
    },
  });
  assert.deepEqual(urls, ['https://api.deepseek.com/chat/completions']);
  assert.equal(result.route, 'deepseek');
});

test('a named tunnel requires Access or a bearer token and does not carry a network target', async () => {
  const ACCESS_JWT = 'access-jwt-assertion-value';
  const calls = [];
  const result = await executeRoute(base({
    runtime: 'render',
    localPcAwake: false,
    upstream: 'http://169.254.169.254/latest',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    namedTunnel: {
      enabled: true,
      guard: 'cloudflare-access',
      accessJwt: ACCESS_JWT,
      baseUrl: 'https://pc.customer.example/v1/generate',
      allowHosts: ['pc.customer.example'],
      capabilities: ['reasoning'],
      model: 'qwen2.5-coder:14b',
    },
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ content: 'Tunnel reply.' });
    },
  });
  assert.equal(result.route, 'named-tunnel');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://pc.customer.example/v1/generate');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['cf-access-jwt-assertion'], ACCESS_JWT);
  assert.equal(calls[0].url.includes(ACCESS_JWT), false);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['capability', 'messages', 'model', 'role']);
  assert.equal(JSON.stringify(body).includes('169.254.169.254'), false);
  assert.equal(JSON.stringify(body).includes('11434'), false);
  assert.equal(leaked(result, ACCESS_JWT), false);
  assert.equal(localGatewayTarget(gateway({ baseUrl: 'http://[::1]:8788' })).url, 'http://[::1]:8788/v1/generate');
  assert.equal(localGatewayTarget(gateway({ baseUrl: 'http://[::]:8788' })).ok, false);
});

test('a named tunnel rejects an unguarded route, a website host, and an internal URL', async () => {
  const samples = [
    [{ enabled: true, guard: 'none', baseUrl: 'https://pc.customer.example', allowHosts: ['pc.customer.example'], token: REMOTE_TOKEN }, 'tunnel_guard_missing'],
    [{ enabled: true, guard: 'bearer', baseUrl: 'https://valhalla-app.xyz', allowHosts: ['valhalla-app.xyz'], token: REMOTE_TOKEN }, 'tunnel_route_not_independent'],
    [{ enabled: true, guard: 'bearer', baseUrl: 'https://desk.valhalla-app.workers.dev', allowHosts: ['desk.valhalla-app.workers.dev'], token: REMOTE_TOKEN }, 'tunnel_route_not_independent'],
    [{ enabled: true, guard: 'bearer', baseUrl: 'https://10.1.1.1', allowHosts: ['10.1.1.1'], token: REMOTE_TOKEN }, 'tunnel_host_rejected'],
    [{ enabled: true, guard: 'bearer', baseUrl: 'http://pc.customer.example', allowHosts: ['pc.customer.example'], token: REMOTE_TOKEN }, 'tunnel_url_rejected'],
  ];
  for (const [namedTunnel, reason] of samples) {
    let calls = 0;
    const result = await executeRoute(base({
      runtime: 'render',
      namedTunnel: { ...namedTunnel, capabilities: ['reasoning'] },
      secrets: {},
    }), {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ content: 'should not run' });
      },
    });
    assert.equal(calls, 0, namedTunnel.baseUrl || namedTunnel.guard);
    assert.equal(result.reason, reason, namedTunnel.baseUrl || namedTunnel.guard);
  }
});

test('an unreachable named tunnel falls back to the separate cloud provider', async () => {
  const urls = [];
  const result = await executeRoute(base({
    runtime: 'render',
    capability: 'voice',
    namedTunnel: {
      enabled: true,
      guard: 'bearer',
      token: REMOTE_TOKEN,
      baseUrl: 'https://pc.customer.example',
      allowHosts: ['pc.customer.example'],
      capabilities: ['voice'],
    },
  }), {
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (urls.length === 1) throw new Error('tunnel unreachable');
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Gemini after the PC missed.' }] } }] });
    },
  });
  assert.deepEqual(urls, [
    'https://pc.customer.example/v1/generate',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  ]);
  assert.equal(result.route, 'gemini');
  assert.equal(result.fallbackFrom, 'pc_unreachable');
  assert.equal(leaked(result, REMOTE_TOKEN), false);
});

test('a local browser desktop refuses an explicit remote Ollama target', async () => {
  let calls = 0;
  const result = await executeRoute(base({
    desktop: 'local-browser',
    target: 'remote-ollama',
    localGateway: gateway(),
    remoteOllama: {
      enabled: true,
      baseUrl: 'https://ollama.customer.example',
      token: REMOTE_TOKEN,
      allowHosts: ['ollama.customer.example'],
      capabilities: ['reasoning'],
    },
  }), {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ content: 'should not run' });
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, 'remote_blocked_on_local_desktop');
});

test('a missing DeepSeek model does not invent deepseek-chat or call the provider', async () => {
  let calls = 0;
  const result = await executeRoute(base({
    runtime: 'cloud',
    secrets: {
      DEEPSEEK_API_KEY: SECRET,
      GEMINI_API_KEY: SECRET,
      GEMINI_MODEL: 'gemini-2.5-flash',
    },
  }), {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: 'nope' } }] });
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, 'model_env_missing');
  assert.equal(result.route, null);
  assert.equal(result.content, null);
  assert.equal(JSON.stringify(result).includes('deepseek-chat'), false);
});

test('generation parsing accepts one token and an echoed prompt', async () => {
  const prompt = 'Summarize the paper desk.';
  let modelSent = '';
  const single = await executeRoute(base({ runtime: 'cloud', prompt }), {
    fetchImpl: async (_url, options) => {
      modelSent = JSON.parse(options.body).model;
      return jsonResponse({ choices: [{ message: { content: 'Z' }, finish_reason: 'stop' }] });
    },
  });
  assert.equal(modelSent, 'deepseek-flash');
  assert.equal(single.available, true);
  assert.equal(single.content, 'Z');
  assert.equal(single.liveExecution, false);

  const echo = await executeRoute(base({ runtime: 'cloud', prompt }), {
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: prompt }, finish_reason: 'stop' }],
    }),
  });
  assert.equal(echo.available, true);
  assert.equal(echo.content, prompt);
});

test('refusal, whitespace, model listings, and broken NDJSON stay unavailable', async () => {
  const prompt = 'Summarize the paper desk.';
  const refusal = await executeRoute(base({ runtime: 'cloud', prompt }), {
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: 'Z', refusal: 'declined' }, finish_reason: 'stop' }],
    }),
  });
  assert.equal(refusal.reason, 'refusal');
  assert.equal(refusal.content, null);

  const listing = await executeRoute(base({ runtime: 'cloud', prompt }), {
    fetchImpl: async () => jsonResponse({ object: 'list', data: [{ id: 'deepseek-flash' }] }),
  });
  assert.equal(listing.reason, 'listing_not_generation');
  assert.equal(listing.content, null);

  const ndjson = await executeRoute(base({ runtime: 'cloud', prompt }), {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '{"error":"ndjson"}\n{"choices":[{"message":{"content":"Z"}}]}',
    }),
  });
  assert.equal(ndjson.reason, 'parse_error');
  assert.equal(ndjson.content, null);

  const filtered = await executeRoute(base({ runtime: 'cloud', prompt }), {
    fetchImpl: async () => jsonResponse({
      choices: [{ message: { content: 'Z' }, finish_reason: 'content_filter' }],
    }),
  });
  assert.equal(filtered.reason, 'content_filtered');
  assert.equal(filtered.content, null);
});

test('gemini stays on native generateContent unless the openai style is requested', async () => {
  const native = [];
  const nativeResult = await executeRoute(base({
    runtime: 'cloud',
    localPcAwake: false,
    capability: 'voice',
  }), {
    fetchImpl: async (url, options) => {
      native.push({
        url: String(url),
        auth: options.headers.authorization,
        goog: options.headers['x-goog-api-key'],
      });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Z' }] } }] });
    },
  });
  assert.equal(nativeResult.content, 'Z');
  assert.equal(native[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(native[0].goog, SECRET);
  assert.equal(native[0].auth, undefined);

  const openai = [];
  const openaiResult = await executeRoute(base({
    runtime: 'cloud',
    localPcAwake: false,
    capability: 'voice',
    geminiApiStyle: 'openai',
  }), {
    fetchImpl: async (url, options) => {
      openai.push({
        url: String(url),
        auth: options.headers.authorization,
        body: JSON.parse(options.body),
      });
      return jsonResponse({ choices: [{ message: { content: 'Z' }, finish_reason: 'stop' }] });
    },
  });
  assert.equal(openai[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(openai[0].auth, `Bearer ${SECRET}`);
  assert.equal(openai[0].body.model, 'gemini-2.5-flash');
  assert.equal(openaiResult.content, 'Z');
  assert.equal(openaiResult.route, 'gemini');
});

test('a mistral key does not move Odin or Thalos off their providers', () => {
  const result = selectRoute(base({
    runtime: 'cloud',
    secrets: {
      DEEPSEEK_API_KEY: SECRET,
      DEEPSEEK_MODEL: 'deepseek-flash',
      MISTRAL_API_KEY: 'mistral-optional-byok-value',
      MISTRAL_MODEL: 'mistral-small-2603',
    },
  }));
  assert.equal(result.route, 'deepseek');
  assert.equal(result.model, 'deepseek-flash');
});
