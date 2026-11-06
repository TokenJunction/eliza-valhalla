'use strict';

/**
 * Portable ValhallaOS provider contracts for the offline harness.
 * Models are env-defined except the local Ollama default required by TJ/Wren:
 *   qwen2.5-coder:14b
 * Do not invent free tiers or unlisted model ids. Cite official docs in the report.
 */

const LOCAL_OLLAMA_MODEL_DEFAULT = 'qwen2.5-coder:14b';
const LOCAL_OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
const OLLAMA_CHAT_PATH = '/api/chat';
const OLLAMA_TAGS_PATH = '/api/tags';
const GATEWAY_GENERATE_PATH = '/v1/generate';

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);
const OLLAMA_DIRECT_PORT = '11434';

/** Bounded generation defaults for harness + proposed adapters (not live spend). */
const DEFAULT_MAX_TOKENS = 64;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_FALLBACK_ATTEMPTS = 1; // primary + at most one cloud fallback

const PROVIDERS = Object.freeze({
  ollama_local: Object.freeze({
    id: 'ollama_local',
    transport: 'loopback-only',
    chatPath: OLLAMA_CHAT_PATH,
    tagsPath: OLLAMA_TAGS_PATH,
    origin: LOCAL_OLLAMA_ORIGIN,
    modelEnv: 'OLLAMA_MODEL',
    modelDefault: LOCAL_OLLAMA_MODEL_DEFAULT,
    keyEnv: null, // local ignores key
    docs: 'https://docs.ollama.com/api/chat',
  }),
  gemini_openai: Object.freeze({
    id: 'gemini_openai',
    transport: 'cloud-https',
    // Official OpenAI-compat base (docs): https://ai.google.dev/gemini-api/docs/openai
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    modelEnv: 'GEMINI_MODEL',
    // No hardcoded product default: missing env => unavailable (Wren).
    modelDefault: null,
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    docs: 'https://ai.google.dev/gemini-api/docs/openai',
  }),
  // PR16 currently calls native generateContent; harness also documents that shape.
  gemini_native: Object.freeze({
    id: 'gemini_native',
    transport: 'cloud-https',
    chatUrlTemplate:
      'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    modelEnv: 'GEMINI_MODEL',
    modelDefault: null,
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    docs: 'https://ai.google.dev/gemini-api/docs',
    note: 'PR16 uses this shape with a hardcoded model id; harness prefers env GEMINI_MODEL.',
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    transport: 'cloud-https',
    chatUrl: 'https://api.deepseek.com/chat/completions',
    modelsUrl: 'https://api.deepseek.com/models',
    modelEnv: 'DEEPSEEK_MODEL',
    modelDefault: null, // env-defined only; do not invent deepseek-chat v2 / free
    keyEnv: ['DEEPSEEK_API_KEY'],
    docs: 'https://api-docs.deepseek.com/api/create-chat-completion',
  }),
  mistral: Object.freeze({
    id: 'mistral',
    transport: 'cloud-https',
    chatUrl: 'https://api.mistral.ai/v1/chat/completions',
    modelsUrl: 'https://api.mistral.ai/v1/models',
    modelEnv: 'MISTRAL_MODEL',
    modelDefault: null,
    keyEnv: ['MISTRAL_API_KEY'],
    docs: 'https://docs.mistral.ai/api/endpoint/chat',
  }),
});

/** Odin/Thalos capability table aligned with PR16 roles; Mistral is optional BYOK. */
const CAPABILITY_ROUTES = Object.freeze({
  odin: Object.freeze({
    voice: Object.freeze({ preferredLocal: 'ollama_local', cloud: 'gemini_openai', altCloud: 'gemini_native' }),
    reasoning: Object.freeze({ preferredLocal: 'ollama_local', cloud: 'deepseek' }),
  }),
  thalos: Object.freeze({
    paper: Object.freeze({ preferredLocal: 'ollama_local', cloud: 'deepseek' }),
    view: Object.freeze({ preferredLocal: 'ollama_local', cloud: 'deepseek' }),
  }),
});

function readEnvModel(spec, env) {
  const raw = env && typeof env[spec.modelEnv] === 'string' ? env[spec.modelEnv].trim() : '';
  if (raw) return raw;
  return spec.modelDefault;
}

function readEnvKey(spec, env) {
  if (!spec.keyEnv) return null;
  const names = Array.isArray(spec.keyEnv) ? spec.keyEnv : [spec.keyEnv];
  for (const name of names) {
    const v = env && typeof env[name] === 'string' ? env[name].trim() : '';
    if (v) return { name, value: v };
  }
  return null;
}

module.exports = {
  LOCAL_OLLAMA_MODEL_DEFAULT,
  LOCAL_OLLAMA_ORIGIN,
  OLLAMA_CHAT_PATH,
  OLLAMA_TAGS_PATH,
  GATEWAY_GENERATE_PATH,
  LOOPBACK_HOSTS,
  OLLAMA_DIRECT_PORT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_FALLBACK_ATTEMPTS,
  PROVIDERS,
  CAPABILITY_ROUTES,
  readEnvModel,
  readEnvKey,
};
