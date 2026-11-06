'use strict';

// Customer local qwen smoke. The PC gateway is loopback only.
// This file does not open a tunnel, write a file, or call a cloud model.

const router = require('../lib/provider-router');
const { measurePreviewHealth, usableSecret } = require('../lib/provider-health');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function fail(reason, message, extra = {}) {
  return {
    ok: false,
    package: 'local-qwen',
    measured: false,
    healthy: false,
    assumed: false,
    liveExecution: false,
    offline: true,
    cloudCalled: false,
    reason,
    message,
    ...extra,
  };
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._~+/=-]{20,}/g, '[redacted]')
    .slice(0, 120);
}

function loopbackGenerate(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:'
    && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    && parsed.port !== '11434'
    && parsed.pathname === router.GATEWAY_PATH
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash;
}

function smokeBudget(env) {
  const raw = env.VALHALLA_PROVIDER_BUDGET_USD;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const budget = { remainingUsd: Number(raw), callUsd: router.CALL_USD };
  return router.budgetDecision(budget).ok ? budget : null;
}

async function runLocalQwen(env = {}, deps = {}) {
  if (typeof deps.fetchImpl !== 'function') {
    return fail('gateway_unavailable', 'No gateway client is available. Local qwen was not called.');
  }
  const baseUrl = typeof env.VALHALLA_LOCAL_GATEWAY_URL === 'string' ? env.VALHALLA_LOCAL_GATEWAY_URL.trim() : '';
  const token = usableSecret(env.VALHALLA_LOCAL_GATEWAY_TOKEN);
  const model = typeof env.VALHALLA_LOCAL_MODEL === 'string' && env.VALHALLA_LOCAL_MODEL.trim()
    ? env.VALHALLA_LOCAL_MODEL.trim()
    : 'qwen2.5-coder:14b';
  if (!baseUrl) {
    return fail('gateway_not_configured', 'Set VALHALLA_LOCAL_GATEWAY_URL to the loopback gateway. This script does not open a tunnel.');
  }
  if (!token) {
    return fail('gateway_token_missing', 'Set VALHALLA_LOCAL_GATEWAY_TOKEN in the process environment. The sample value is rejected.');
  }
  if (!/qwen/i.test(model)) {
    return fail('model_not_qwen', 'VALHALLA_LOCAL_MODEL must name a local qwen model. This package does not download one.');
  }
  const target = router.localGatewayTarget({ baseUrl, token, model });
  if (!target.ok) {
    return fail(target.reason, 'The gateway URL was rejected before any call.');
  }
  const budget = smokeBudget(env);
  if (!budget) {
    return fail('budget_exhausted', 'Set VALHALLA_PROVIDER_BUDGET_USD above the call amount. No gateway call was made.');
  }

  const calls = [];
  const wrapped = async (url, options) => {
    const href = String(url);
    calls.push(href);
    if (!loopbackGenerate(href)) {
      throw new Error('cloud_call_blocked');
    }
    return deps.fetchImpl(url, options);
  };

  let result;
  try {
    result = await router.executeRoute({
      role: 'odin',
      capability: 'reasoning',
      prompt: 'Reply with the single word pong.',
      runtime: 'local-pc',
      localPcAwake: true,
      budget,
      secrets: {},
      localGateway: {
        baseUrl,
        token,
        model,
        capabilities: ['reasoning'],
      },
      namedTunnel: { enabled: false },
      remoteOllama: { enabled: false },
    }, { fetchImpl: wrapped });
  } catch (error) {
    return fail('gateway_unavailable', redact(error && error.message), { measured: calls.length > 0 });
  }

  if (calls.some((href) => !loopbackGenerate(href))) {
    return fail('cloud_call_blocked', 'The local smoke stopped because a call left the loopback gateway.', {
      measured: true,
    });
  }
  if (!result || result.available !== true || result.route !== 'local-gateway' || result.liveExecution !== false) {
    return {
      ...fail(result && result.reason ? result.reason : 'gateway_unavailable', 'The local gateway did not answer. No cloud provider was called.'),
      measured: calls.length > 0,
      route: result && result.route || null,
    };
  }
  return {
    ok: true,
    package: 'local-qwen',
    measured: true,
    healthy: true,
    assumed: false,
    liveExecution: false,
    offline: true,
    cloudCalled: false,
    route: 'local-gateway',
    model: result.model,
    reason: null,
    message: 'Local qwen answered through the loopback gateway.',
    content: redact(result.content),
  };
}

async function runPreview(env = {}, deps = {}) {
  const result = await measurePreviewHealth(
    env.VALHALLA_PREVIEW_HEALTH_URL,
    deps.fetchImpl || globalThis.fetch,
  );
  return {
    ok: result.healthy === true,
    ...result,
  };
}

module.exports = {
  loopbackGenerate,
  redact,
  runLocalQwen,
  runPreview,
};
