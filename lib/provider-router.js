'use strict';

// Odin routes voice (Gemini) and reasoning (DeepSeek). Thalos is paper and view only.
// A local desktop calls a loopback gateway and can finish with no cloud call.
// A named tunnel is a separate route: Cloudflare Access or a bearer token, never a
// website host. The relay body has no network target. This module does not open
// Ollama's port, resolve DNS, provision a tunnel, or store credentials.
// If the PC or tunnel does not answer, a configured cloud provider is tried once.
// A missing provider, capability, guard, or budget is unavailable. Secrets are not logged.

const { isIP } = require('node:net');
const { parseGeminiNativeBody, parseOpenAIChatBody } = require('../provider-harness/lib/parse');

const CALL_USD = 0.01;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const OLLAMA_DIRECT_PORT = '11434';
const GATEWAY_PATH = '/v1/generate';

const CLOUD = Object.freeze({
  gemini: Object.freeze({
    provider: 'gemini',
    // Model id comes from GEMINI_MODEL. Native generateContent stays the default.
    // OpenAI-compatible chat is used only when geminiApiStyle is "openai".
    modelEnv: 'GEMINI_MODEL',
    keyNames: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']),
    nativeUrlTemplate: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    openaiCompatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  }),
  deepseek: Object.freeze({
    provider: 'deepseek',
    // Model id comes from DEEPSEEK_MODEL. This router does not invent a model name.
    modelEnv: 'DEEPSEEK_MODEL',
    keyNames: Object.freeze(['DEEPSEEK_API_KEY']),
    url: 'https://api.deepseek.com/chat/completions',
  }),
});

const ROLES = Object.freeze({
  odin: Object.freeze({
    voice: Object.freeze({ cloud: 'gemini' }),
    reasoning: Object.freeze({ cloud: 'deepseek' }),
  }),
  thalos: Object.freeze({
    paper: Object.freeze({ cloud: 'deepseek' }),
    view: Object.freeze({ cloud: 'deepseek' }),
  }),
});

function unavailable(role, capability, reason, extra = {}) {
  return {
    available: false,
    status: 'unavailable',
    providerState: 'unavailable',
    role: role || null,
    capability: capability || null,
    reason,
    route: null,
    content: null,
    chargedUsd: 0,
    liveExecution: false,
    ...extra,
  };
}

function budgetDecision(budget) {
  if (!budget || typeof budget !== 'object') return { ok: false };
  const remaining = budget.remainingUsd;
  const call = budget.callUsd === undefined ? CALL_USD : budget.callUsd;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return { ok: false };
  if (typeof call !== 'number' || !Number.isFinite(call) || call <= 0) return { ok: false };
  if (remaining < call) return { ok: false };
  return { ok: true, callUsd: call };
}

function tokenOf(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return token.length >= 16 ? token : '';
}

function modelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(name) ? name : null;
}

function normalizeHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function grants(list, capability) {
  return Array.isArray(list) && list.includes(capability);
}

function fixedGenerateUrl(origin) {
  return `${origin}${GATEWAY_PATH}`;
}

function localGatewayTarget(gateway) {
  if (!gateway || typeof gateway !== 'object') return { ok: false, reason: 'gateway_not_configured' };
  const token = tokenOf(gateway.token);
  if (!token) return { ok: false, reason: 'gateway_token_missing' };
  let url;
  try {
    url = new URL(gateway.baseUrl);
  } catch {
    return { ok: false, reason: 'gateway_not_loopback' };
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(normalizeHost(url.hostname))) {
    return { ok: false, reason: 'gateway_not_loopback' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: 'gateway_not_loopback' };
  }
  if (url.port === OLLAMA_DIRECT_PORT) return { ok: false, reason: 'ollama_port_blocked' };
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && path !== GATEWAY_PATH) return { ok: false, reason: 'gateway_path_rejected' };
  return { ok: true, url: fixedGenerateUrl(url.origin), token };
}

function blockedRemoteHost(host) {
  if (!host || isIP(host) || !host.includes('.')) return true;
  if (host.split('.').every((label) => /^\d+$/.test(label))) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;
  if (host === 'onrender.com' || host.endsWith('.onrender.com')) return true;
  return false;
}

function websiteHost(host) {
  return host === 'valhalla-app.xyz'
    || host === 'www.valhalla-app.xyz'
    || host === 'workers.dev'
    || host.endsWith('.workers.dev')
    || host === 'onrender.com'
    || host.endsWith('.onrender.com');
}

function httpsGenerateTarget(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'remote_url_rejected' };
  }
  const host = normalizeHost(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: 'remote_url_rejected' };
  }
  if (url.port === OLLAMA_DIRECT_PORT || (url.port && url.port !== '443')) {
    return { ok: false, reason: 'remote_url_rejected' };
  }
  if (websiteHost(host)) return { ok: false, reason: 'website_host' };
  if (blockedRemoteHost(host)) return { ok: false, reason: 'remote_internal_url' };
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && path !== GATEWAY_PATH) return { ok: false, reason: 'remote_url_rejected' };
  return { ok: true, url: fixedGenerateUrl(`https://${host}`), host };
}

function authorizeRemoteOllama(endpoint) {
  if (!endpoint || typeof endpoint !== 'object' || endpoint.enabled !== true) {
    return { ok: false, reason: 'remote_ollama_not_configured' };
  }
  const token = tokenOf(endpoint.token);
  if (!token) return { ok: false, reason: 'remote_token_missing' };
  const target = httpsGenerateTarget(endpoint.baseUrl);
  if (!target.ok) {
    return { ok: false, reason: target.reason === 'website_host' ? 'remote_internal_url' : target.reason };
  }
  const allow = Array.isArray(endpoint.allowHosts)
    ? endpoint.allowHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!allow.includes(target.host)) return { ok: false, reason: 'remote_host_not_allowed' };
  return { ok: true, url: target.url, token };
}

function authorizeNamedTunnel(tunnel) {
  if (!tunnel || typeof tunnel !== 'object' || tunnel.enabled !== true) {
    return { ok: false, reason: 'tunnel_not_configured' };
  }
  const headers = {};
  if (tunnel.guard === 'cloudflare-access') {
    const jwt = tokenOf(tunnel.accessJwt);
    const clientId = tokenOf(tunnel.accessClientId);
    const clientSecret = tokenOf(tunnel.accessClientSecret);
    if (jwt) headers['cf-access-jwt-assertion'] = jwt;
    else if (clientId && clientSecret) {
      headers['cf-access-client-id'] = clientId;
      headers['cf-access-client-secret'] = clientSecret;
    } else return { ok: false, reason: 'tunnel_guard_missing' };
  } else if (tunnel.guard === 'bearer') {
    const token = tokenOf(tunnel.token);
    if (!token) return { ok: false, reason: 'tunnel_guard_missing' };
    headers.authorization = `Bearer ${token}`;
  } else {
    return { ok: false, reason: 'tunnel_guard_missing' };
  }
  const target = httpsGenerateTarget(tunnel.baseUrl);
  if (!target.ok) {
    const reason = target.reason === 'website_host'
      ? 'tunnel_route_not_independent'
      : target.reason === 'remote_internal_url'
        ? 'tunnel_host_rejected'
        : 'tunnel_url_rejected';
    return { ok: false, reason };
  }
  const allow = Array.isArray(tunnel.allowHosts)
    ? tunnel.allowHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!allow.includes(target.host)) return { ok: false, reason: 'tunnel_host_not_allowed' };
  if (Object.values(headers).some((value) => target.url.includes(value))) {
    return { ok: false, reason: 'tunnel_url_rejected' };
  }
  return { ok: true, url: target.url, headers };
}

function cloudSecret(name, secrets) {
  const spec = CLOUD[name];
  if (!spec || !secrets || typeof secrets !== 'object') return null;
  for (const keyName of spec.keyNames) {
    const value = secrets[keyName];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cloudModel(name, input) {
  const spec = CLOUD[name];
  if (!spec || !spec.modelEnv) return null;
  const bags = [input && input.models, input && input.secrets, input && input.env];
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    const value = bag[spec.modelEnv];
    if (typeof value !== 'string') continue;
    const model = modelName(value);
    if (model) return model;
  }
  return null;
}

function geminiNativeUrl(model) {
  return CLOUD.gemini.nativeUrlTemplate.replace('{model}', encodeURIComponent(model));
}

function roleSpec(role, capability) {
  const table = ROLES[role];
  if (!table || !Object.hasOwn(table, capability)) return null;
  return table[capability];
}

function routed(fields) {
  return {
    available: true,
    status: 'routed',
    providerState: 'not_probed',
    content: null,
    chargedUsd: 0,
    liveExecution: false,
    fallback: null,
    fallbackFrom: null,
    ...fields,
  };
}

function selectRoute(input = {}) {
  const role = input.role;
  const capability = input.capability;
  const spec = roleSpec(role, capability);
  if (!spec) return unavailable(role, capability, 'capability_unavailable');
  const budget = budgetDecision(input.budget);
  if (!budget.ok) return unavailable(role, capability, 'budget_exhausted');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return unavailable(role, capability, 'prompt_missing');
  }

  const mode = role === 'thalos' ? 'paper' : 'advisory';
  if (input.target === 'remote-ollama') {
    if (input.desktop === 'local-browser') return unavailable(role, capability, 'remote_blocked_on_local_desktop');
    const remote = authorizeRemoteOllama(input.remoteOllama);
    if (!remote.ok) return unavailable(role, capability, remote.reason);
    if (!grants(input.remoteOllama.capabilities, capability)) {
      return unavailable(role, capability, 'capability_denied');
    }
    const model = modelName(input.remoteOllama.model);
    if (input.remoteOllama.model != null && !model) return unavailable(role, capability, 'model_rejected');
    return routed({
      role,
      capability,
      route: 'remote-ollama',
      model,
      mode,
      callUsd: budget.callUsd,
    });
  }

  let localReason = 'runtime_not_local';
  if (input.runtime === 'local-pc' && input.localPcAwake === true) {
    const gateway = localGatewayTarget(input.localGateway);
    if (!gateway.ok) localReason = gateway.reason;
    else if (!grants(input.localGateway.capabilities, capability)) localReason = 'capability_denied';
    else {
      const model = modelName(input.localGateway.model);
      if (input.localGateway.model != null && !model) return unavailable(role, capability, 'model_rejected');
      return routed({
        role,
        capability,
        route: 'local-gateway',
        model,
        mode,
        callUsd: budget.callUsd,
      });
    }
  } else if (input.runtime === 'local-pc' && input.localPcAwake !== true) {
    localReason = 'local_pc_asleep';
  }

  const tunnel = authorizeNamedTunnel(input.namedTunnel);
  if (tunnel.ok && grants(input.namedTunnel.capabilities, capability)) {
    const model = modelName(input.namedTunnel.model);
    if (input.namedTunnel.model != null && !model) return unavailable(role, capability, 'model_rejected');
    return routed({
      role,
      capability,
      route: 'named-tunnel',
      model,
      mode,
      callUsd: budget.callUsd,
      fallbackFrom: localReason,
    });
  }
  const tunnelRejected = input.namedTunnel && input.namedTunnel.enabled === true && !tunnel.ok;
  if (tunnelRejected) localReason = tunnel.reason;

  const cloudName = spec.cloud;
  if (!cloudSecret(cloudName, input.secrets)) {
    return unavailable(role, capability, tunnelRejected ? tunnel.reason : 'provider_missing', { detail: localReason });
  }
  const model = cloudModel(cloudName, input);
  if (!model) {
    return unavailable(role, capability, 'model_env_missing', { detail: localReason });
  }
  return routed({
    role,
    capability,
    route: cloudName,
    model,
    mode,
    callUsd: budget.callUsd,
    fallbackFrom: localReason,
  });
}

function parseGatewayBody(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'parse_error' };
  }
  if (payload.error) return { ok: false, reason: 'provider_error' };
  if (payload.object === 'list' || (Array.isArray(payload.models) && payload.content == null) || Array.isArray(payload.data)) {
    return { ok: false, reason: 'listing_not_generation' };
  }
  if (typeof payload.content !== 'string' || payload.content.trim().length === 0) {
    return { ok: false, reason: 'empty_content' };
  }
  return { ok: true, content: payload.content };
}

async function readBody(response) {
  if (response && typeof response.text === 'function') return response.text();
  if (response && typeof response.json === 'function') {
    const payload = await response.json();
    return JSON.stringify(payload);
  }
  return '';
}

function systemFor(role, capability) {
  if (role === 'thalos') {
    return 'You are Thalos. Paper and view only. Do not place orders, move funds, or invent a fill. If data is missing, say unavailable.';
  }
  if (capability === 'voice') {
    return 'You are Odin voice. Speak only from supplied text. If you cannot, say the capability is unavailable.';
  }
  return 'You are Odin. Reason from supplied text. Do not invent market data or a healthy status.';
}

function gatewayBody(input, model) {
  const body = {
    capability: input.capability,
    role: input.role,
    messages: [
      { role: 'system', content: systemFor(input.role, input.capability) },
      { role: 'user', content: input.prompt.trim() },
    ],
  };
  if (model) body.model = model;
  return body;
}

async function callProvider(route, input, fetchImpl) {
  const prompt = input.prompt.trim();
  const system = systemFor(input.role, input.capability);
  let url;
  const headers = { 'content-type': 'application/json' };
  let body;
  if (route.route === 'local-gateway' || route.route === 'remote-ollama' || route.route === 'named-tunnel') {
    const target = route.route === 'local-gateway'
      ? localGatewayTarget(input.localGateway)
      : route.route === 'named-tunnel'
        ? authorizeNamedTunnel(input.namedTunnel)
        : authorizeRemoteOllama(input.remoteOllama);
    if (!target.ok) return { ok: false };
    const secretValues = target.headers ? Object.values(target.headers) : [target.token];
    if (secretValues.some((value) => value && target.url.includes(value))) return { ok: false };
    url = target.url;
    if (target.headers) Object.assign(headers, target.headers);
    else headers.authorization = `Bearer ${target.token}`;
    headers['x-valhalla-capability'] = input.capability;
    body = gatewayBody(input, route.model);
  } else if (route.route === 'gemini') {
    const key = cloudSecret('gemini', input.secrets);
    const openai = input.geminiApiStyle === 'openai';
    url = openai ? CLOUD.gemini.openaiCompatUrl : geminiNativeUrl(route.model);
    if (!key || !route.model || url.includes(key)) return { ok: false, reason: 'provider_missing' };
    if (openai) {
      headers.authorization = `Bearer ${key}`;
      body = {
        model: route.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 64,
        stream: false,
      };
    } else {
      headers['x-goog-api-key'] = key;
      body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      };
    }
  } else if (route.route === 'deepseek') {
    const key = cloudSecret('deepseek', input.secrets);
    url = CLOUD.deepseek.url;
    if (!key || !route.model || url.includes(key)) return { ok: false, reason: 'provider_missing' };
    headers.authorization = `Bearer ${key}`;
    body = {
      model: route.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
  } else {
    return { ok: false, reason: 'provider_unavailable' };
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response || !response.ok) return { ok: false, reason: 'provider_unavailable' };
  const raw = await readBody(response);
  const relayRoute = route.route === 'local-gateway' || route.route === 'remote-ollama' || route.route === 'named-tunnel';
  const parsed = relayRoute
    ? parseGatewayBody(raw)
    : route.route === 'gemini' && input.geminiApiStyle !== 'openai'
      ? parseGeminiNativeBody(raw)
      : parseOpenAIChatBody(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason || 'provider_unavailable' };
  return { ok: true, content: parsed.content };
}

function answered(route, content, callUsd) {
  return {
    available: true,
    status: 'routed',
    providerState: 'responded',
    role: route.role,
    capability: route.capability,
    reason: null,
    route: route.route,
    model: route.model,
    mode: route.mode,
    fallbackFrom: route.fallbackFrom || null,
    liveExecution: false,
    content,
    chargedUsd: callUsd,
  };
}

async function executeRoute(input = {}, deps = {}) {
  const selected = selectRoute(input);
  if (!selected.available) return selected;
  if (typeof deps.fetchImpl !== 'function') {
    return unavailable(input.role, input.capability, 'provider_unavailable');
  }
  const relay = selected.route === 'local-gateway' || selected.route === 'named-tunnel';
  const cloudRoute = () => {
    const spec = roleSpec(input.role, input.capability);
    if (!spec || !cloudSecret(spec.cloud, input.secrets)) return null;
    const model = cloudModel(spec.cloud, input);
    if (!model) return { missingModel: true };
    return {
      ...selected,
      route: spec.cloud,
      model,
      fallbackFrom: selected.route === 'named-tunnel' ? 'pc_unreachable' : 'local_gateway_unavailable',
    };
  };
  try {
    const first = await callProvider(selected, input, deps.fetchImpl);
    if (first.ok) return answered(selected, first.content, selected.callUsd);
    if (!relay) return unavailable(input.role, input.capability, first.reason || 'provider_unavailable');
  } catch {
    if (!relay) return unavailable(input.role, input.capability, 'provider_unavailable');
  }
  const cloud = cloudRoute();
  if (cloud && cloud.missingModel) return unavailable(input.role, input.capability, 'model_env_missing');
  if (!cloud) return unavailable(input.role, input.capability, 'provider_unavailable');
  try {
    const fallback = await callProvider(cloud, input, deps.fetchImpl);
    if (!fallback.ok) return unavailable(input.role, input.capability, 'provider_unavailable');
    return answered(cloud, fallback.content, selected.callUsd);
  } catch {
    return unavailable(input.role, input.capability, 'provider_unavailable');
  }
}

module.exports = {
  CALL_USD,
  CLOUD,
  GATEWAY_PATH,
  authorizeNamedTunnel,
  authorizeRemoteOllama,
  budgetDecision,
  executeRoute,
  localGatewayTarget,
  selectRoute,
};
