'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCapabilityRoute, validateMistralOptional } = require('../lib/route-validate');
const { LOCAL_OLLAMA_MODEL_DEFAULT } = require('../lib/contracts');

test('odin voice routes to gemini when cloud env complete; model must be env-defined', () => {
  const missing = validateCapabilityRoute({
    role: 'odin',
    capability: 'voice',
    runtime: 'render',
    env: { GEMINI_API_KEY: 'test-gemini-key-012345' },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'model_env_missing');
  assert.equal(missing.envVar, 'GEMINI_MODEL');

  const ok = validateCapabilityRoute({
    role: 'odin',
    capability: 'voice',
    runtime: 'render',
    env: { GEMINI_API_KEY: 'test-gemini-key-012345', GEMINI_MODEL: 'gemini-2.5-flash' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, 'gemini_openai');
  assert.equal(ok.model, 'gemini-2.5-flash');
});

test('odin reasoning routes to deepseek; no invented deepseek-chat default', () => {
  const missing = validateCapabilityRoute({
    role: 'odin',
    capability: 'reasoning',
    runtime: 'render',
    env: { DEEPSEEK_API_KEY: 'test-deepseek-key-012345' },
  });
  assert.equal(missing.reason, 'model_env_missing');
  assert.equal(missing.envVar, 'DEEPSEEK_MODEL');

  const ok = validateCapabilityRoute({
    role: 'odin',
    capability: 'reasoning',
    runtime: 'render',
    env: { DEEPSEEK_API_KEY: 'test-deepseek-key-012345', DEEPSEEK_MODEL: 'deepseek-flash' },
  });
  assert.equal(ok.provider, 'deepseek');
  assert.equal(ok.model, 'deepseek-flash');
});

test('local awake PC prefers ollama qwen2.5-coder:14b default', () => {
  const ok = validateCapabilityRoute({
    role: 'odin',
    capability: 'reasoning',
    runtime: 'local-pc',
    localPcAwake: true,
    env: {},
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, 'ollama_local');
  assert.equal(ok.model, LOCAL_OLLAMA_MODEL_DEFAULT);
});

test('asleep PC without cloud key is unavailable', () => {
  const r = validateCapabilityRoute({
    role: 'odin',
    capability: 'voice',
    runtime: 'local-pc',
    localPcAwake: false,
    env: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'provider_missing');
});

test('thalos live capabilities unavailable', () => {
  for (const capability of ['trade', 'live', 'sign']) {
    const r = validateCapabilityRoute({ role: 'thalos', capability, env: {} });
    assert.equal(r.reason, 'capability_unavailable');
  }
});

test('mistral optional BYOK requires key and model env', () => {
  assert.equal(validateMistralOptional({}).reason, 'provider_missing');
  assert.equal(
    validateMistralOptional({ MISTRAL_API_KEY: 'test-mistral-key-0123456' }).reason,
    'model_env_missing',
  );
  const ok = validateMistralOptional({
    MISTRAL_API_KEY: 'test-mistral-key-0123456',
    MISTRAL_MODEL: 'mistral-small-2603',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.inPr16Roles, false);
});
