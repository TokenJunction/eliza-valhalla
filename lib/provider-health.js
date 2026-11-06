'use strict';

// Provider readiness sits beside the existing gauge snapshot from collectHealth.
// This module does not change that snapshot, call a model, or open a tunnel.
// A route can be selected and still be unhealthy: selection is not a measurement.

const { isIP } = require('node:net');
const integrations = require('./integrations');
const router = require('./provider-router');

const PAIRS = Object.freeze([
  Object.freeze(['odin', 'voice']),
  Object.freeze(['odin', 'reasoning']),
  Object.freeze(['thalos', 'paper']),
  Object.freeze(['thalos', 'view']),
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function usableSecret(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  if (token.length < 16) return '';
  if (token.toLowerCase().startsWith('replace-me')) return '';
  return token;
}

function modelsFromEnv(env) {
  const models = {};
  for (const name of ['GEMINI_MODEL', 'DEEPSEEK_MODEL']) {
    if (typeof env[name] === 'string' && env[name].trim()) models[name] = env[name].trim();
  }
  return models;
}

function secretsFromEnv(env) {
  const secrets = {};
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'DEEPSEEK_API_KEY']) {
    const token = usableSecret(env[name]);
    if (token) secrets[name] = token;
  }
  return secrets;
}

function budgetFromEnv(env) {
  const raw = env.VALHALLA_PROVIDER_BUDGET_USD;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { remainingUsd: Number.NaN, callUsd: router.CALL_USD };
  }
  return { remainingUsd: Number(raw), callUsd: router.CALL_USD };
}

function localGatewayFromEnv(env) {
  const baseUrl = typeof env.VALHALLA_LOCAL_GATEWAY_URL === 'string'
    ? env.VALHALLA_LOCAL_GATEWAY_URL.trim()
    : '';
  const token = usableSecret(env.VALHALLA_LOCAL_GATEWAY_TOKEN);
  if (!baseUrl && !token) return null;
  const model = typeof env.VALHALLA_LOCAL_MODEL === 'string' ? env.VALHALLA_LOCAL_MODEL.trim() : '';
  return {
    baseUrl,
    token,
    model: model || null,
    capabilities: splitList(env.VALHALLA_LOCAL_GATEWAY_CAPABILITIES),
  };
}

function namedTunnelFromEnv(env) {
  if (env.VALHALLA_NAMED_TUNNEL_ENABLED !== 'true') return { enabled: false };
  return {
    enabled: true,
    guard: typeof env.VALHALLA_TUNNEL_GUARD === 'string' ? env.VALHALLA_TUNNEL_GUARD.trim() : '',
    baseUrl: typeof env.VALHALLA_TUNNEL_URL === 'string' ? env.VALHALLA_TUNNEL_URL.trim() : '',
    token: usableSecret(env.VALHALLA_TUNNEL_TOKEN),
    accessJwt: usableSecret(env.VALHALLA_TUNNEL_ACCESS_JWT),
    accessClientId: usableSecret(env.VALHALLA_TUNNEL_ACCESS_CLIENT_ID),
    accessClientSecret: usableSecret(env.VALHALLA_TUNNEL_ACCESS_CLIENT_SECRET),
    allowHosts: splitList(env.VALHALLA_TUNNEL_ALLOW_HOSTS),
    capabilities: splitList(env.VALHALLA_TUNNEL_CAPABILITIES),
    model: typeof env.VALHALLA_TUNNEL_MODEL === 'string' && env.VALHALLA_TUNNEL_MODEL.trim()
      ? env.VALHALLA_TUNNEL_MODEL.trim()
      : null,
  };
}

function remoteOllamaFromEnv(env) {
  if (env.VALHALLA_REMOTE_OLLAMA_ENABLED !== 'true') return { enabled: false };
  return {
    enabled: true,
    baseUrl: typeof env.VALHALLA_REMOTE_OLLAMA_URL === 'string' ? env.VALHALLA_REMOTE_OLLAMA_URL.trim() : '',
    token: usableSecret(env.VALHALLA_REMOTE_OLLAMA_TOKEN),
    allowHosts: splitList(env.VALHALLA_REMOTE_OLLAMA_ALLOW_HOSTS),
    capabilities: splitList(env.VALHALLA_REMOTE_OLLAMA_CAPABILITIES),
    model: typeof env.VALHALLA_REMOTE_OLLAMA_MODEL === 'string' && env.VALHALLA_REMOTE_OLLAMA_MODEL.trim()
      ? env.VALHALLA_REMOTE_OLLAMA_MODEL.trim()
      : null,
  };
}

function decisionCode(decision) {
  return decision && decision.ok === true ? null : (decision && decision.reason) || 'rejected';
}

function publicRoute(decision) {
  return {
    available: decision.available === true,
    status: decision.status || 'unavailable',
    providerState: decision.providerState || 'unavailable',
    role: decision.role || null,
    capability: decision.capability || null,
    reason: decision.reason || null,
    route: decision.route || null,
    model: decision.model || null,
    mode: decision.mode || null,
    liveExecution: false,
    chargedUsd: 0,
    healthy: false,
    measured: false,
    detail: decision.detail || decision.fallbackFrom || null,
  };
}

function collectProviderRoutes(env = process.env) {
  const secrets = secretsFromEnv(env);
  const budget = budgetFromEnv(env);
  const budgetGate = router.budgetDecision(budget);
  const localGateway = localGatewayFromEnv(env);
  const namedTunnel = namedTunnelFromEnv(env);
  const remoteOllama = remoteOllamaFromEnv(env);
  const localDecision = localGateway
    ? router.localGatewayTarget(localGateway)
    : { ok: false, reason: 'gateway_not_configured' };
  const tunnelDecision = router.authorizeNamedTunnel(namedTunnel);
  const remoteDecision = router.authorizeRemoteOllama(remoteOllama);
  const input = {
    prompt: 'provider-route-check',
    budget,
    runtime: env.VALHALLA_RUNTIME === 'local-pc' ? 'local-pc' : 'cloud',
    localPcAwake: env.VALHALLA_LOCAL_PC_AWAKE === 'true',
    desktop: env.VALHALLA_DESKTOP === 'local-browser' ? 'local-browser' : undefined,
    target: env.VALHALLA_PROVIDER_TARGET === 'remote-ollama' ? 'remote-ollama' : undefined,
    secrets,
    models: modelsFromEnv(env),
    localGateway,
    namedTunnel,
    remoteOllama,
  };
  const routes = PAIRS.map(([role, capability]) => publicRoute(router.selectRoute({ ...input, role, capability })));
  const thalosLive = router.selectRoute({ ...input, role: 'thalos', capability: 'live' });
  return {
    healthy: false,
    assumed: false,
    measured: false,
    liveExecution: false,
    byok: 'server',
    cloudSeparation: {
      voice: { provider: 'gemini', host: new URL(router.CLOUD.gemini.openaiCompatUrl).host },
      reasoning: { provider: 'deepseek', host: new URL(router.CLOUD.deepseek.url).host },
    },
    budget: {
      allowed: budgetGate.ok === true,
      reason: budgetGate.ok ? null : 'budget_exhausted',
    },
    credentials: {
      gemini: Boolean(secrets.GEMINI_API_KEY || secrets.GOOGLE_GENERATIVE_AI_API_KEY),
      deepseek: Boolean(secrets.DEEPSEEK_API_KEY),
      localGateway: localDecision.ok === true,
      namedTunnel: tunnelDecision.ok === true,
      remoteOllama: remoteDecision.ok === true,
    },
    rejected: {
      localGateway: decisionCode(localDecision),
      namedTunnel: decisionCode(tunnelDecision),
      remoteOllama: decisionCode(remoteDecision),
    },
    thalosLive: {
      available: false,
      reason: thalosLive.reason || 'capability_unavailable',
      liveExecution: false,
    },
    routes,
    checkedAt: new Date().toISOString(),
  };
}

function hostOf(url) {
  const host = String(url.hostname || '').toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function previewUrlAllowed(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  const host = hostOf(url);
  if (url.port === '11434') return false;
  if (LOOPBACK_HOSTS.has(host)) return url.protocol === 'http:';
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  if (!host || isIP(host) || !host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === 'metadata.google.internal') return false;
  return true;
}

function gaugeHealthy(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.status !== 'ok' || !Array.isArray(body.checks) || body.checks.length === 0) return false;
  return body.checks.every((check) => check && check.status === 'up');
}

function isGaugeSnapshot(body) {
  return Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && (body.status === 'ok' || body.status === 'partial' || body.status === 'degraded')
    && Array.isArray(body.checks),
  );
}

async function measurePreviewHealth(rawUrl, fetchImpl = globalThis.fetch) {
  const base = {
    package: 'preview',
    assumed: false,
    liveExecution: false,
    credentialsSent: false,
    healthy: false,
    status: null,
    httpStatus: null,
  };
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ...base, measured: false, reason: 'preview_url_missing' };
  }
  const target = rawUrl.trim();
  if (!previewUrlAllowed(target)) {
    return { ...base, measured: false, reason: 'preview_url_rejected' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ...base, measured: false, reason: 'preview_unreachable' };
  }
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    const body = await response.json().catch(() => null);
    const snapshot = isGaugeSnapshot(body);
    const healthy = snapshot && response.status === 200 && gaugeHealthy(body);
    return {
      ...base,
      measured: snapshot,
      healthy,
      status: snapshot ? body.status : null,
      httpStatus: response.status,
      reason: healthy ? null : (snapshot ? 'preview_not_healthy' : (body ? 'not_gauge_snapshot' : 'preview_body_unreadable')),
    };
  } catch {
    return { ...base, measured: false, reason: 'preview_unreachable' };
  }
}

async function readGauge(env = process.env) {
  return integrations.collectHealth(env);
}

module.exports = {
  collectProviderRoutes,
  gaugeHealthy,
  measurePreviewHealth,
  previewUrlAllowed,
  readGauge,
  usableSecret,
};
