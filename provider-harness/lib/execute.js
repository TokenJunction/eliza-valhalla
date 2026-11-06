'use strict';

/**
 * Bounded execute helper: local/relay first, then at most one cloud fallback.
 * Listing calls are never treated as generation success.
 */

const ollama = require('./ollama-adapter');
const openai = require('./openai-compat');
const { validateCapabilityRoute } = require('./route-validate');
const { boundFallbackPlan } = require('./safety');
const { MAX_FALLBACK_ATTEMPTS } = require('./contracts');

async function executeCapability(input = {}, deps = {}) {
  const { fetchImpl, env = {} } = deps;
  const decision = validateCapabilityRoute({ ...input, env });
  if (!decision.ok) {
    return {
      available: false,
      status: 'unavailable',
      reason: decision.reason,
      route: null,
      content: null,
      calls: [],
      decision,
    };
  }

  const calls = [];
  const prompt = input.prompt;
  const nontrivial =
    typeof prompt === 'string' &&
    prompt.trim().length > 0;

  if (!nontrivial) {
    return {
      available: false,
      status: 'unavailable',
      reason: 'prompt_missing',
      route: null,
      content: null,
      calls,
    };
  }

  // Prefer local ollama chat when routed there
  if (decision.provider === 'ollama_local') {
    const local = await ollama.chat({
      fetchImpl,
      env,
      prompt,
      system: input.system || null,
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
      origin: input.ollamaOrigin,
    });
    calls.push({ provider: 'ollama_local', request: local.request, ok: local.ok, reason: local.reason });
    if (local.ok) {
      return {
        available: true,
        status: 'responded',
        reason: null,
        route: 'ollama_local',
        model: local.model || decision.model,
        content: local.content,
        calls,
        requestMatched: JSON.stringify(local.intendedBody) === JSON.stringify(local.request.body),
      };
    }

    const plan = boundFallbackPlan(false, Boolean(decision.cloudFallback));
    if (!plan.fallback || !decision.cloudFallback) {
      return {
        available: false,
        status: 'unavailable',
        reason: local.reason || 'provider_unavailable',
        route: null,
        content: null,
        calls,
      };
    }

    const cloudId = decision.cloudFallback.provider;
    const cloud = await openai.chatOpenAICompat(cloudId, {
      fetchImpl,
      env,
      prompt,
      system: input.system || null,
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
    });
    calls.push({ provider: cloudId, request: cloud.request, ok: cloud.ok, reason: cloud.reason });
    if (!cloud.ok) {
      return {
        available: false,
        status: 'unavailable',
        reason: cloud.reason || 'provider_unavailable',
        route: null,
        content: null,
        calls,
        fallbackAttempts: MAX_FALLBACK_ATTEMPTS,
      };
    }
    return {
      available: true,
      status: 'responded',
      reason: null,
      route: cloudId,
      model: cloud.model || decision.cloudFallback.model,
      content: cloud.content,
      fallbackFrom: 'local_ollama_unavailable',
      calls,
    };
  }

  // Cloud direct
  const cloud = await openai.chatOpenAICompat(decision.provider, {
    fetchImpl,
    env,
    prompt,
    system: input.system || null,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
  });
  calls.push({ provider: decision.provider, request: cloud.request, ok: cloud.ok, reason: cloud.reason });
  if (!cloud.ok) {
    return {
      available: false,
      status: 'unavailable',
      reason: cloud.reason || 'provider_unavailable',
      route: null,
      content: null,
      calls,
    };
  }
  return {
    available: true,
    status: 'responded',
    reason: null,
    route: decision.provider,
    model: cloud.model || decision.model,
    content: cloud.content,
    calls,
  };
}

module.exports = { executeCapability };
