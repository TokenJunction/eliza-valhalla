'use strict';

const {
  LOCAL_OLLAMA_ORIGIN,
  OLLAMA_CHAT_PATH,
  OLLAMA_TAGS_PATH,
  LOCAL_OLLAMA_MODEL_DEFAULT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  readEnvModel,
  PROVIDERS,
} = require('./contracts');
const { parseOllamaChatBody, parseModelsListing } = require('./parse');

/**
 * Customer-PC / relay-side Ollama adapter.
 * Only loopback origins are allowed. Cloud must never dial :11434 directly.
 */

function assertLoopbackOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: 'origin_invalid' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'http:') return { ok: false, reason: 'ollama_requires_http_loopback' };
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    return { ok: false, reason: 'ollama_not_loopback' };
  }
  // This PC-local adapter is the only caller of port 11434, and only on loopback.
  if (url.port !== '11434') return { ok: false, reason: 'ollama_port_blocked' };
  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

function buildChatRequest({ prompt, model, maxTokens, system }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = {
    model,
    messages,
    stream: false,
    options: {
      num_predict: maxTokens,
    },
  };
  return body;
}

async function chat(opts = {}) {
  const {
    fetchImpl,
    env = {},
    origin = LOCAL_OLLAMA_ORIGIN,
    prompt,
    system = null,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 'unavailable', reason: 'fetch_missing', content: null, request: null };
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, status: 'unavailable', reason: 'prompt_missing', content: null, request: null };
  }

  const gate = assertLoopbackOrigin(origin);
  if (!gate.ok) {
    return { ok: false, status: 'unavailable', reason: gate.reason, content: null, request: null };
  }

  const model = readEnvModel(PROVIDERS.ollama_local, env) || LOCAL_OLLAMA_MODEL_DEFAULT;
  const url = `${gate.origin}${OLLAMA_CHAT_PATH}`;
  const body = buildChatRequest({ prompt: prompt.trim(), model, maxTokens, system });
  const request = { url, method: 'POST', body };

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: 'unavailable', reason: 'timeout', content: null, request };
    }
    return { ok: false, status: 'unavailable', reason: 'unreachable', content: null, request };
  }

  if (!response || !response.ok) {
    return {
      ok: false,
      status: 'unavailable',
      reason: response && response.status === 404 ? 'model_missing' : 'http_error',
      content: null,
      request,
      httpStatus: response ? response.status : null,
    };
  }

  const text = await response.text();
  const parsed = parseOllamaChatBody(text, { maxTokens });
  return {
    ...parsed,
    request,
    calledUrl: url,
    intendedBody: body,
  };
}

async function listModels(opts = {}) {
  const { fetchImpl, origin = LOCAL_OLLAMA_ORIGIN, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'fetch_missing', models: [], generationAuthorized: false };
  }
  const gate = assertLoopbackOrigin(origin);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason, models: [], generationAuthorized: false };
  }
  const url = `${gate.origin}${OLLAMA_TAGS_PATH}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'unreachable', models: [], generationAuthorized: false, url };
  }
  if (!response || !response.ok) {
    return { ok: false, reason: 'http_error', models: [], generationAuthorized: false, url };
  }
  const text = await response.text();
  const listing = parseModelsListing(text, 'ollama_tags');
  return { ...listing, url, generationAuthorized: false };
}

module.exports = {
  assertLoopbackOrigin,
  buildChatRequest,
  chat,
  listModels,
};
