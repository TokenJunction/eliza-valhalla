'use strict';

const {
  CAPABILITY_ROUTES,
  PROVIDERS,
  MAX_FALLBACK_ATTEMPTS,
  readEnvKey,
  readEnvModel,
  LOCAL_OLLAMA_MODEL_DEFAULT,
} = require('./contracts');

/**
 * Env-based capability / route validation.
 * Missing credential or model env => unavailable (no invented defaults for cloud).
 * Local Ollama model defaults to qwen2.5-coder:14b only.
 */

function validateCapabilityRoute(input = {}) {
  const { role, capability, env = {}, runtime = 'cloud', localPcAwake = false } = input;
  const table = CAPABILITY_ROUTES[role];
  if (!table || !Object.prototype.hasOwnProperty.call(table, capability)) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'capability_unavailable',
      route: null,
      fallback: null,
    };
  }
  const spec = table[capability];
  const localProvider = PROVIDERS[spec.preferredLocal];
  const cloudProvider = PROVIDERS[spec.cloud];

  const localModel = readEnvModel(localProvider, env) || LOCAL_OLLAMA_MODEL_DEFAULT;
  const cloudKey = readEnvKey(cloudProvider, env);
  const cloudModel = readEnvModel(cloudProvider, env);

  const canLocal =
    runtime === 'local-pc' &&
    localPcAwake === true &&
    Boolean(localModel);

  if (canLocal) {
    return {
      ok: true,
      status: 'routed',
      reason: null,
      route: 'local-ollama-via-gateway-or-relay',
      provider: 'ollama_local',
      model: localModel,
      cloudFallback: cloudKey && cloudModel
        ? { provider: cloudProvider.id, model: cloudModel, maxAttempts: MAX_FALLBACK_ATTEMPTS }
        : null,
      note: 'Generation still requires /api/chat (or gateway /v1/generate) success; listing is not enough.',
    };
  }

  if (!cloudKey) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'provider_missing',
      route: null,
      provider: cloudProvider.id,
      detail: localPcAwake ? null : 'local_pc_asleep_or_not_local',
    };
  }
  if (!cloudModel) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'model_env_missing',
      route: null,
      provider: cloudProvider.id,
      envVar: cloudProvider.modelEnv,
    };
  }

  return {
    ok: true,
    status: 'routed',
    reason: null,
    route: cloudProvider.id,
    provider: cloudProvider.id,
    model: cloudModel,
    fallbackFrom: runtime === 'local-pc' ? 'local_unavailable' : 'runtime_not_local',
    maxFallbackAttempts: MAX_FALLBACK_ATTEMPTS,
  };
}

/** Optional Mistral BYOK: env MISTRAL_API_KEY + MISTRAL_MODEL required; not in PR16 ROLES. */
function validateMistralOptional(env = {}) {
  const spec = PROVIDERS.mistral;
  const key = readEnvKey(spec, env);
  const model = readEnvModel(spec, env);
  if (!key) {
    return { ok: false, status: 'unavailable', reason: 'provider_missing', provider: 'mistral' };
  }
  if (!model) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'model_env_missing',
      provider: 'mistral',
      envVar: 'MISTRAL_MODEL',
    };
  }
  return {
    ok: true,
    status: 'routed',
    provider: 'mistral',
    model,
    inPr16Roles: false,
    note: 'Mistral is optional BYOK; PR16 ROLES table does not route Odin/Thalos to Mistral.',
  };
}

module.exports = {
  validateCapabilityRoute,
  validateMistralOptional,
};
