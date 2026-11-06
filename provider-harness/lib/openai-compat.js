'use strict';

const {
  PROVIDERS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  readEnvModel,
  readEnvKey,
} = require('./contracts');
const { parseOpenAIChatBody, parseGeminiNativeBody, parseModelsListing } = require('./parse');

function missingCredential(providerId) {
  return {
    ok: false,
    status: 'unavailable',
    reason: 'provider_missing',
    content: null,
    provider: providerId,
    request: null,
  };
}

function missingModel(providerId) {
  return {
    ok: false,
    status: 'unavailable',
    reason: 'model_env_missing',
    content: null,
    provider: providerId,
    request: null,
  };
}

async function chatOpenAICompat(providerId, opts = {}) {
  const spec = PROVIDERS[providerId];
  if (!spec || !spec.chatUrl) {
    return { ok: false, status: 'unavailable', reason: 'unknown_provider', content: null };
  }
  const {
    fetchImpl,
    env = {},
    prompt,
    system = null,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 'unavailable', reason: 'fetch_missing', content: null };
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, status: 'unavailable', reason: 'prompt_missing', content: null };
  }

  const key = readEnvKey(spec, env);
  if (!key) return missingCredential(providerId);
  const model = readEnvModel(spec, env);
  if (!model) return missingModel(providerId);

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt.trim() });

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  };

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key.value}`,
  };

  const request = { url: spec.chatUrl, method: 'POST', body, keyEnv: key.name };

  let response;
  try {
    response = await fetchImpl(spec.chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: 'unavailable', reason: 'timeout', content: null, request, provider: providerId };
    }
    return { ok: false, status: 'unavailable', reason: 'unreachable', content: null, request, provider: providerId };
  }

  if (!response || !response.ok) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'http_error',
      content: null,
      request,
      provider: providerId,
      httpStatus: response ? response.status : null,
    };
  }

  const text = await response.text();
  const parsed = parseOpenAIChatBody(text, { maxTokens });
  return {
    ...parsed,
    request,
    provider: providerId,
    calledUrl: spec.chatUrl,
    intendedBody: body,
  };
}

async function chatGeminiNative(opts = {}) {
  const spec = PROVIDERS.gemini_native;
  const {
    fetchImpl,
    env = {},
    prompt,
    system = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 'unavailable', reason: 'fetch_missing', content: null };
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, status: 'unavailable', reason: 'prompt_missing', content: null };
  }
  const key = readEnvKey(spec, env);
  if (!key) return missingCredential('gemini_native');
  const model = readEnvModel(spec, env);
  if (!model) return missingModel('gemini_native');

  const url = spec.chatUrlTemplate.replace('{model}', encodeURIComponent(model));
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }],
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  const request = { url, method: 'POST', body, keyEnv: key.name };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key.value,
      },
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
    return { ok: false, status: 'unavailable', reason: 'http_error', content: null, request, httpStatus: response && response.status };
  }
  const text = await response.text();
  const parsed = parseGeminiNativeBody(text);
  return { ...parsed, request, provider: 'gemini_native', calledUrl: url, intendedBody: body };
}

async function listOpenAIModels(providerId, opts = {}) {
  const spec = PROVIDERS[providerId];
  if (!spec || !spec.modelsUrl) {
    return { ok: false, reason: 'unknown_provider', models: [], generationAuthorized: false };
  }
  const { fetchImpl, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const key = readEnvKey(spec, env);
  if (!key) {
    return { ok: false, reason: 'provider_missing', models: [], generationAuthorized: false };
  }
  let response;
  try {
    response = await fetchImpl(spec.modelsUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${key.value}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'unreachable', models: [], generationAuthorized: false };
  }
  if (!response || !response.ok) {
    return { ok: false, reason: 'http_error', models: [], generationAuthorized: false };
  }
  const text = await response.text();
  const listing = parseModelsListing(text, 'openai');
  return { ...listing, generationAuthorized: false, url: spec.modelsUrl };
}

module.exports = {
  chatOpenAICompat,
  chatGeminiNative,
  listOpenAIModels,
  chatGeminiOpenAI: (opts) => chatOpenAICompat('gemini_openai', opts),
  chatDeepSeek: (opts) => chatOpenAICompat('deepseek', opts),
  chatMistral: (opts) => chatOpenAICompat('mistral', opts),
};
