'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const integrations = require('./integrations');
const providerHealth = require('./provider-health');

const GEMINI = 'gemini-server-test-key-value';
const DEEPSEEK = 'deepseek-server-test-key-value';
const LOCAL_TOKEN = 'local-gateway-token-value';
const TUNNEL_TOKEN = 'named-tunnel-token-value';
const repo = path.join(__dirname, '..');

function json(status, body) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function gaugeShape(health) {
  return {
    status: health.status,
    mode: health.mode,
    checks: health.checks.map((check) => ({
      name: check.name,
      status: check.status,
      error: check.error || null,
      privileged: check.privileged === true,
    })),
    safety: health.safety,
  };
}

function route(report, role, capability) {
  return report.routes.find((item) => item.role === role && item.capability === capability);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe('provider router and gauge health', { concurrency: false }, () => {
  test('an unconfigured gauge stays partial when every provider is unavailable', async () => {
    const before = gaugeShape(await integrations.collectHealth({}));
    const report = providerHealth.collectProviderRoutes({});
    const after = gaugeShape(await providerHealth.readGauge({}));
    assert.deepEqual(before, {
      status: 'partial',
      mode: 'paper',
      checks: [
        { name: 'supabase', status: 'not_configured', error: null, privileged: false },
        { name: 'upstash-redis', status: 'not_configured', error: null, privileged: false },
        { name: 'elizaos', status: 'not_configured', error: null, privileged: false },
      ],
      safety: {
        trading: 'disabled',
        social: 'disabled',
        keyStorage: 'disabled',
        adminConfigured: false,
      },
    });
    assert.deepEqual(after, before);
    assert.equal(report.healthy, false);
    assert.equal(report.measured, false);
    assert.equal(report.assumed, false);
    assert.equal(report.liveExecution, false);
    assert.equal(report.routes.every((item) => item.available === false && item.healthy === false), true);
    assert.equal(report.budget.reason, 'budget_exhausted');
  });

  test('a down redis gauge stays degraded when a local route can be selected', async () => {
    const original = global.fetch;
    global.fetch = async () => json(500, { error: 'boom' });
    try {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'redis-token',
        VALHALLA_RUNTIME: 'local-pc',
        VALHALLA_LOCAL_PC_AWAKE: 'true',
        VALHALLA_PROVIDER_BUDGET_USD: '1',
        VALHALLA_LOCAL_GATEWAY_URL: 'http://127.0.0.1:8787',
        VALHALLA_LOCAL_GATEWAY_TOKEN: LOCAL_TOKEN,
        VALHALLA_LOCAL_MODEL: 'qwen2.5-coder:14b',
        VALHALLA_LOCAL_GATEWAY_CAPABILITIES: 'reasoning',
      };
      const health = await integrations.collectHealth(env);
      const report = providerHealth.collectProviderRoutes(env);
      assert.equal(health.status, 'degraded');
      assert.equal(health.checks.find((check) => check.name === 'upstash-redis').status, 'down');
      assert.equal(route(report, 'odin', 'reasoning').route, 'local-gateway');
      assert.equal(route(report, 'odin', 'reasoning').healthy, false);
      assert.equal(route(report, 'odin', 'reasoning').measured, false);
      assert.equal((await integrations.collectHealth(env)).status, 'degraded');
    } finally {
      global.fetch = original;
    }
  });

  test('a fully up gauge stays ok and does not mark an unprobed provider healthy', async () => {
    const original = global.fetch;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('upstash')) return json(200, { result: 'PONG' });
      if (href.includes('supabase')) return json(200, []);
      if (href.includes('/api/valhalla/health')) {
        return json(200, { capabilities: { trading: 'disabled' }, mode: 'paper' });
      }
      throw new Error(`unexpected probe ${href}`);
    };
    try {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'redis-token',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role',
        ELIZA_URL: 'https://eliza.example.test',
        VALHALLA_PROVIDER_BUDGET_USD: '1',
        GEMINI_API_KEY: GEMINI,
        GEMINI_MODEL: 'gemini-2.5-flash',
        DEEPSEEK_API_KEY: DEEPSEEK,
        DEEPSEEK_MODEL: 'deepseek-flash',
      };
      const health = await integrations.collectHealth(env);
      const probe = global.fetch;
      global.fetch = async () => {
        throw new Error('provider readiness must not call the network');
      };
      const report = providerHealth.collectProviderRoutes(env);
      global.fetch = probe;
      assert.equal(health.status, 'ok');
      assert.equal(health.checks.every((check) => check.status === 'up'), true);
      assert.equal(health.checks.find((check) => check.name === 'supabase').privileged, true);
      assert.equal(health.safety.trading, 'disabled');
      assert.equal(route(report, 'odin', 'voice').route, 'gemini');
      assert.equal(route(report, 'odin', 'voice').model, 'gemini-2.5-flash');
      assert.equal(route(report, 'odin', 'reasoning').route, 'deepseek');
      assert.equal(route(report, 'odin', 'reasoning').model, 'deepseek-flash');
      assert.equal(JSON.stringify(report).includes('deepseek-chat'), false);
      assert.notEqual(report.cloudSeparation.voice.host, report.cloudSeparation.reasoning.host);
      assert.equal(report.cloudSeparation.voice.host, 'generativelanguage.googleapis.com');
      assert.equal(report.cloudSeparation.reasoning.host, 'api.deepseek.com');
      assert.equal(route(report, 'thalos', 'paper').mode, 'paper');
      assert.equal(route(report, 'thalos', 'view').mode, 'paper');
      assert.equal(route(report, 'thalos', 'paper').liveExecution, false);
      assert.equal(route(report, 'thalos', 'view').route, 'deepseek');
      assert.equal(report.thalosLive.available, false);
      assert.equal(report.thalosLive.reason, 'capability_unavailable');
      assert.equal(report.healthy, false);
      assert.equal(report.routes.every((item) => item.healthy === false && item.chargedUsd === 0), true);
      assert.equal((await integrations.collectHealth(env)).status, 'ok');
      assert.equal(JSON.stringify(report).includes(GEMINI), false);
      assert.equal(JSON.stringify(report).includes(DEEPSEEK), false);
    } finally {
      global.fetch = original;
    }
  });

  test('voice and reasoning stay on separate providers when only one key exists', () => {
    const report = providerHealth.collectProviderRoutes({
      VALHALLA_PROVIDER_BUDGET_USD: '1',
      GEMINI_API_KEY: GEMINI,
      GEMINI_MODEL: 'gemini-2.5-flash',
    });
    assert.equal(route(report, 'odin', 'voice').route, 'gemini');
    assert.equal(route(report, 'odin', 'voice').model, 'gemini-2.5-flash');
    assert.equal(route(report, 'odin', 'reasoning').reason, 'provider_missing');
    assert.equal(route(report, 'odin', 'reasoning').route, null);
    assert.equal(report.credentials.gemini, true);
    assert.equal(report.credentials.deepseek, false);
    assert.equal(report.healthy, false);

    const missingModel = providerHealth.collectProviderRoutes({
      VALHALLA_PROVIDER_BUDGET_USD: '1',
      DEEPSEEK_API_KEY: DEEPSEEK,
    });
    assert.equal(route(missingModel, 'odin', 'reasoning').reason, 'model_env_missing');
    assert.equal(route(missingModel, 'odin', 'reasoning').route, null);
    assert.equal(JSON.stringify(missingModel).includes('deepseek-chat'), false);
    assert.equal(missingModel.healthy, false);
  });

  test('a direct Ollama port and an arbitrary relay URL are rejected before use', () => {
    const direct = providerHealth.collectProviderRoutes({
      VALHALLA_LOCAL_GATEWAY_URL: 'http://127.0.0.1:11434',
      VALHALLA_LOCAL_GATEWAY_TOKEN: LOCAL_TOKEN,
    });
    assert.equal(direct.credentials.localGateway, false);
    assert.equal(direct.rejected.localGateway, 'ollama_port_blocked');
    const arbitrary = providerHealth.collectProviderRoutes({
      VALHALLA_REMOTE_OLLAMA_ENABLED: 'true',
      VALHALLA_REMOTE_OLLAMA_URL: 'https://169.254.169.254/latest',
      VALHALLA_REMOTE_OLLAMA_TOKEN: LOCAL_TOKEN,
      VALHALLA_REMOTE_OLLAMA_ALLOW_HOSTS: '169.254.169.254',
    });
    assert.equal(arbitrary.credentials.remoteOllama, false);
    assert.equal(arbitrary.rejected.remoteOllama, 'remote_internal_url');
    assert.equal(JSON.stringify(arbitrary).includes(LOCAL_TOKEN), false);
  });

  test('a named tunnel still requires an allow-listed host and Access or a bearer token', () => {
    const open = providerHealth.collectProviderRoutes({
      VALHALLA_NAMED_TUNNEL_ENABLED: 'true',
      VALHALLA_TUNNEL_URL: 'https://pc.example.com',
      VALHALLA_TUNNEL_ALLOW_HOSTS: 'pc.example.com',
    });
    assert.equal(open.credentials.namedTunnel, false);
    assert.equal(open.rejected.namedTunnel, 'tunnel_guard_missing');

    const website = providerHealth.collectProviderRoutes({
      VALHALLA_NAMED_TUNNEL_ENABLED: 'true',
      VALHALLA_TUNNEL_GUARD: 'bearer',
      VALHALLA_TUNNEL_TOKEN: TUNNEL_TOKEN,
      VALHALLA_TUNNEL_URL: 'https://valhalla-app.xyz',
      VALHALLA_TUNNEL_ALLOW_HOSTS: 'valhalla-app.xyz',
      VALHALLA_TUNNEL_CAPABILITIES: 'reasoning',
    });
    assert.equal(website.rejected.namedTunnel, 'tunnel_route_not_independent');

    const guarded = providerHealth.collectProviderRoutes({
      VALHALLA_PROVIDER_BUDGET_USD: '1',
      VALHALLA_NAMED_TUNNEL_ENABLED: 'true',
      VALHALLA_TUNNEL_GUARD: 'bearer',
      VALHALLA_TUNNEL_TOKEN: TUNNEL_TOKEN,
      VALHALLA_TUNNEL_URL: 'https://pc.example.com/v1/generate',
      VALHALLA_TUNNEL_ALLOW_HOSTS: 'pc.example.com',
      VALHALLA_TUNNEL_CAPABILITIES: 'reasoning',
      GEMINI_API_KEY: GEMINI,
      GEMINI_MODEL: 'gemini-2.5-flash',
      DEEPSEEK_API_KEY: DEEPSEEK,
      DEEPSEEK_MODEL: 'deepseek-flash',
    });
    assert.equal(guarded.credentials.namedTunnel, true);
    assert.equal(route(guarded, 'odin', 'reasoning').route, 'named-tunnel');
    assert.equal(route(guarded, 'odin', 'reasoning').healthy, false);
    assert.equal(route(guarded, 'odin', 'voice').route, 'gemini');
    const serialized = JSON.stringify(guarded);
    assert.equal(serialized.includes(TUNNEL_TOKEN), false);
    assert.equal(serialized.includes(GEMINI), false);
    assert.equal(serialized.includes(DEEPSEEK), false);
    assert.equal(serialized.includes('cf-access-client-secret'), false);
  });

  test('preview health is measured from the response and is not assumed', async () => {
    let calls = 0;
    const missing = await providerHealth.measurePreviewHealth('', async () => {
      calls += 1;
      throw new Error('called');
    });
    assert.equal(missing.measured, false);
    assert.equal(missing.healthy, false);
    assert.equal(missing.reason, 'preview_url_missing');
    assert.equal(calls, 0);

    const rejected = await providerHealth.measurePreviewHealth('http://preview.example.com/api/health', async () => {
      calls += 1;
      throw new Error('called');
    });
    assert.equal(rejected.reason, 'preview_url_rejected');
    assert.equal(rejected.healthy, false);
    assert.equal(calls, 0);
    assert.equal(providerHealth.previewUrlAllowed('http://127.0.0.1:11434/api/health'), false);
    assert.equal(providerHealth.previewUrlAllowed('https://preview.example.com/api/health'), true);

    const down = await providerHealth.measurePreviewHealth('https://preview.example.com/api/health', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    assert.equal(down.measured, false);
    assert.equal(down.healthy, false);
    assert.equal(down.reason, 'preview_unreachable');
    assert.equal(down.credentialsSent, false);

    const server = http.createServer((req, res) => {
      const bodies = {
        '/api/health': [200, { status: 'ok', checks: [{ name: 'supabase', status: 'up' }, { name: 'upstash-redis', status: 'up' }, { name: 'elizaos', status: 'up' }] }],
        '/partial': [200, { status: 'partial', checks: [{ name: 'supabase', status: 'not_configured' }] }],
        '/live': [200, { status: 'UP', engine: 'Valhalla V35' }],
        '/down': [503, { status: 'degraded', checks: [{ name: 'upstash-redis', status: 'down' }] }],
      };
      const found = bodies[req.url];
      res.writeHead(found[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(found[1]));
    });
    const port = await listen(server);
    try {
      const ok = await providerHealth.measurePreviewHealth(`http://127.0.0.1:${port}/api/health`);
      const partial = await providerHealth.measurePreviewHealth(`http://127.0.0.1:${port}/partial`);
      const live = await providerHealth.measurePreviewHealth(`http://127.0.0.1:${port}/live`);
      const degraded = await providerHealth.measurePreviewHealth(`http://127.0.0.1:${port}/down`);
      assert.equal(ok.measured, true);
      assert.equal(ok.healthy, true);
      assert.equal(ok.assumed, false);
      assert.equal(partial.measured, true);
      assert.equal(partial.healthy, false);
      assert.equal(partial.status, 'partial');
      assert.equal(live.measured, false);
      assert.equal(live.healthy, false);
      assert.equal(live.reason, 'not_gauge_snapshot');
      assert.equal(degraded.measured, true);
      assert.equal(degraded.healthy, false);
      assert.equal(degraded.status, 'degraded');
      assert.equal(degraded.httpStatus, 503);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('the backend keeps gauge liveness and provider readiness apart', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['valhallaMasterEngineV35.js'], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || '/tmp',
        PORT: String(port),
        NODE_ENV: 'test',
        VALHALLA_QUEUE_ENABLED: 'false',
        VALHALLA_PROVIDER_BUDGET_USD: '1',
        GEMINI_API_KEY: GEMINI,
        GEMINI_MODEL: 'gemini-2.5-flash',
        DEEPSEEK_API_KEY: DEEPSEEK,
        DEEPSEEK_MODEL: 'deepseek-flash',
        PUBLIC_ORIGIN: 'https://valhalla-app.xyz',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (!exited) child.kill('SIGKILL');
    };
    try {
      const deadline = Date.now() + 8000;
      let live;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.status === 200) {
            live = await response.json();
            break;
          }
        } catch {
          // retry until the process binds
        }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(live && live.status, 'UP');
      const gaugeResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
      const gauge = await gaugeResponse.json();
      const providers = await (await fetch(`http://127.0.0.1:${port}/api/provider/health`)).json();
      assert.equal(gaugeResponse.status, 200);
      assert.equal(gauge.status, 'partial');
      assert.equal(Object.hasOwn(gauge, 'routes'), false);
      assert.equal(Object.hasOwn(gauge, 'healthy'), false);
      assert.deepEqual(gauge.checks.map((check) => check.status), ['not_configured', 'not_configured', 'not_configured']);
      assert.equal(providers.healthy, false);
      assert.equal(providers.measured, false);
      assert.equal(providers.byok, 'server');
      assert.equal(route(providers, 'odin', 'voice').route, 'gemini');
      assert.equal(route(providers, 'odin', 'voice').model, 'gemini-2.5-flash');
      assert.equal(route(providers, 'odin', 'reasoning').route, 'deepseek');
      assert.equal(route(providers, 'odin', 'reasoning').model, 'deepseek-flash');
      assert.equal(JSON.stringify(providers).includes('deepseek-chat'), false);
      assert.equal(route(providers, 'thalos', 'paper').mode, 'paper');
      assert.equal(route(providers, 'thalos', 'paper').liveExecution, false);
      const blob = JSON.stringify({ gauge, providers, live, logs });
      assert.equal(blob.includes(GEMINI), false);
      assert.equal(blob.includes(DEEPSEEK), false);
    } catch (error) {
      const safe = logs.replaceAll(GEMINI, '[redacted]').replaceAll(DEEPSEEK, '[redacted]');
      throw new Error(`${error.message}\n${safe.slice(-600)}`);
    } finally {
      await stop();
    }
  });
});
