'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const relay = require('./local-qwen-relay');

const TOKEN = 'local-gateway-token-value';
const repo = path.join(__dirname, '..');

function env(overrides = {}) {
  return {
    VALHALLA_LOCAL_GATEWAY_URL: 'http://127.0.0.1:8787',
    VALHALLA_LOCAL_GATEWAY_TOKEN: TOKEN,
    VALHALLA_LOCAL_MODEL: 'qwen2.5-coder:14b',
    VALHALLA_PROVIDER_BUDGET_USD: '1',
    ...overrides,
  };
}

function answer(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content }),
  };
}

test('missing gateway credentials and a zero budget do not call the gateway', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return answer('pong');
  };
  const missing = await relay.runLocalQwen({}, { fetchImpl });
  const placeholder = await relay.runLocalQwen(env({ VALHALLA_LOCAL_GATEWAY_TOKEN: 'replace-me' }), { fetchImpl });
  const blockedPort = await relay.runLocalQwen(env({ VALHALLA_LOCAL_GATEWAY_URL: 'http://127.0.0.1:11434' }), { fetchImpl });
  const publicUrl = await relay.runLocalQwen(env({ VALHALLA_LOCAL_GATEWAY_URL: 'https://gpu.example.com' }), { fetchImpl });
  const otherModel = await relay.runLocalQwen(env({ VALHALLA_LOCAL_MODEL: 'llama3' }), { fetchImpl });
  const noBudget = await relay.runLocalQwen(env({ VALHALLA_PROVIDER_BUDGET_USD: '0' }), { fetchImpl });
  assert.equal(missing.reason, 'gateway_not_configured');
  assert.equal(placeholder.reason, 'gateway_token_missing');
  assert.equal(blockedPort.reason, 'ollama_port_blocked');
  assert.equal(publicUrl.reason, 'gateway_not_loopback');
  assert.equal(otherModel.reason, 'model_not_qwen');
  assert.equal(noBudget.reason, 'budget_exhausted');
  assert.equal([missing, placeholder, blockedPort, publicUrl, otherModel, noBudget].every((item) => item.ok === false && item.healthy === false && item.measured === false), true);
  assert.equal(calls, 0);
});

test('a local qwen reply stays on the loopback gateway and redacts the token', async () => {
  const calls = [];
  const result = await relay.runLocalQwen(env({
    VALHALLA_NAMED_TUNNEL_ENABLED: 'true',
    VALHALLA_TUNNEL_URL: 'https://evil.example',
    upstreamUrl: 'https://evil.example/v1/generate',
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return answer(`pong ${TOKEN}`);
    },
    upstreamUrl: 'http://10.0.0.8:11434',
  });
  assert.equal(result.ok, true);
  assert.equal(result.measured, true);
  assert.equal(result.healthy, true);
  assert.equal(result.assumed, false);
  assert.equal(result.route, 'local-gateway');
  assert.equal(result.model, 'qwen2.5-coder:14b');
  const fallback = { ...env() };
  delete fallback.VALHALLA_LOCAL_MODEL;
  const defaulted = await relay.runLocalQwen(fallback, {
    fetchImpl: async () => answer('pong'),
  });
  assert.equal(defaulted.model, 'qwen2.5-coder:14b');
  assert.equal(result.liveExecution, false);
  assert.equal(result.offline, true);
  assert.equal(result.cloudCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/v1/generate');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(calls[0].options.body).model, 'qwen2.5-coder:14b');
  assert.equal(result.content.includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('an unavailable gateway is measured and does not become a cloud call', async () => {
  const calls = [];
  const result = await relay.runLocalQwen(env({ DEEPSEEK_API_KEY: 'deepseek-server-test-key-value' }), {
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:8787/v1/generate']);
  assert.equal(result.ok, false);
  assert.equal(result.measured, true);
  assert.equal(result.healthy, false);
  assert.equal(result.cloudCalled, false);
  assert.equal(result.reason, 'provider_unavailable');
  assert.equal(JSON.stringify(result).includes('deepseek-server-test-key-value'), false);
});

test('preview smoke fails closed until a gauge snapshot measures ok', async () => {
  let calls = 0;
  const missing = await relay.runPreview({}, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('called');
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.healthy, false);
  assert.equal(missing.measured, false);
  assert.equal(missing.reason, 'preview_url_missing');
  assert.equal(calls, 0);

  const down = await relay.runPreview({
    VALHALLA_PREVIEW_HEALTH_URL: 'https://preview.example.com/api/health',
  }, {
    fetchImpl: async () => {
      throw new Error('unavailable');
    },
  });
  assert.equal(down.ok, false);
  assert.equal(down.assumed, false);
  assert.equal(down.healthy, false);
  assert.equal(down.reason, 'preview_unreachable');
});

test('sample variables contain no usable secret', () => {
  const sample = fs.readFileSync(path.join(__dirname, 'env.sample'), 'utf8');
  const installer = fs.readFileSync(path.join(__dirname, 'install-smoke.ps1'), 'utf8');
  assert.match(sample, /VALHALLA_LOCAL_GATEWAY_TOKEN=replace-me/);
  assert.match(sample, /VALHALLA_LOCAL_MODEL=qwen2\.5/);
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(sample), false);
  assert.equal(sample.includes('Bearer '), false);
  for (const banned of ['Set-Content', 'Out-File', 'New-Item', 'Add-Content', 'cloudflared', 'Invoke-WebRequest', 'Start-Process', 'Copy-Item', 'Remove-Item']) {
    assert.equal(installer.includes(banned), false, banned);
  }
});

test('the executable smoke fails closed with an empty environment', () => {
  const local = spawnSync(process.execPath, ['customer/smoke.mjs', 'local-qwen'], {
    cwd: repo,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  const preview = spawnSync(process.execPath, ['customer/smoke.mjs', 'preview'], {
    cwd: repo,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  const localBody = JSON.parse(local.stdout);
  const previewBody = JSON.parse(preview.stdout);
  assert.equal(local.status, 1);
  assert.equal(localBody.ok, false);
  assert.equal(localBody.healthy, false);
  assert.equal(localBody.measured, false);
  assert.equal(localBody.reason, 'gateway_not_configured');
  assert.equal(preview.status, 1);
  assert.equal(previewBody.healthy, false);
  assert.equal(previewBody.measured, false);
  assert.equal(previewBody.reason, 'preview_url_missing');
  assert.equal(previewBody.assumed, false);
});
