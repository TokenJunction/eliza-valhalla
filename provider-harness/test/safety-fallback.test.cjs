'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTarget, authorizeRelay, boundFallbackPlan } = require('../lib/safety');
const { executeCapability } = require('../lib/execute');
const { createFetchMock } = require('../lib/fetch-mock');

test('loopback gateway vs blocked direct ollama port', () => {
  assert.equal(classifyTarget('http://127.0.0.1:8788').class, 'customer_pc_loopback');
  assert.equal(classifyTarget('http://127.0.0.1:11434').class, 'blocked_direct_ollama');
  assert.equal(classifyTarget('http://localhost:11434/api/chat').reason, 'ollama_port_blocked');
});

test('cloud-to-pc relay requires https allowlist and auth', () => {
  assert.equal(classifyTarget('https://pc.customer.example').class, 'cloud_to_pc_relay_candidate');
  assert.equal(
    authorizeRelay({
      baseUrl: 'https://pc.customer.example',
      allowHosts: ['pc.customer.example'],
      token: 'relay-token-value-1234',
    }).ok,
    true,
  );
  assert.equal(
    authorizeRelay({
      baseUrl: 'https://pc.customer.example',
      allowHosts: ['other.example'],
      token: 'relay-token-value-1234',
    }).reason,
    'remote_host_not_allowed',
  );
  assert.equal(
    authorizeRelay({
      baseUrl: 'https://pc.customer.example',
      allowHosts: ['pc.customer.example'],
      guard: 'cloudflare-access',
      accessJwt: '',
    }).reason,
    'tunnel_guard_missing',
  );
  assert.equal(classifyTarget('https://svc.onrender.com').class, 'blocked_website_or_platform');
  assert.equal(classifyTarget('https://10.0.0.5').class, 'blocked_internal');
});

test('fallback is bounded to one cloud attempt', () => {
  assert.deepEqual(boundFallbackPlan(true, true), { attempts: 1, fallback: false });
  assert.equal(boundFallbackPlan(false, true).maxCloudAttempts, 1);
  assert.equal(boundFallbackPlan(false, false).result, 'unavailable');
});

test('executeCapability falls back once from local failure to deepseek', async () => {
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    if (entry.url.includes('/api/chat')) {
      return jsonResponse({ error: 'down' }, 503);
    }
    if (entry.url.includes('api.deepseek.com')) {
      return jsonResponse({
        choices: [{ message: { content: 'CLOUD1' }, finish_reason: 'stop' }],
      });
    }
    throw new Error(`unexpected ${entry.url}`);
  });

  const result = await executeCapability(
    {
      role: 'odin',
      capability: 'reasoning',
      runtime: 'local-pc',
      localPcAwake: true,
      prompt: 'Return CLOUD1 only.',
    },
    {
      fetchImpl,
      env: {
        DEEPSEEK_API_KEY: 'test-deepseek-key-012345',
        DEEPSEEK_MODEL: 'deepseek-flash',
      },
    },
  );
  assert.equal(result.available, true);
  assert.equal(result.route, 'deepseek');
  assert.equal(result.content, 'CLOUD1');
  assert.equal(result.fallbackFrom, 'local_ollama_unavailable');
  assert.equal(calls.length, 2);
});

test('listing-only success path does not exist on executeCapability', async () => {
  // If someone only mocks /api/tags, generation must fail closed.
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    if (entry.url.endsWith('/api/tags')) {
      return jsonResponse({ models: [{ name: 'qwen2.5-coder:14b' }] });
    }
    if (entry.url.endsWith('/api/chat')) {
      return jsonResponse({ message: { content: '' }, done: true }, 200);
    }
    throw new Error(entry.url);
  });
  const result = await executeCapability(
    {
      role: 'odin',
      capability: 'reasoning',
      runtime: 'local-pc',
      localPcAwake: true,
      prompt: 'Return X.',
    },
    { fetchImpl, env: {} },
  );
  assert.equal(result.available, false);
  assert.equal(result.content, null);
  assert.equal(calls.some((c) => c.url.endsWith('/api/tags')), false);
  assert.equal(calls.some((c) => c.url.endsWith('/api/chat')), true);
});
