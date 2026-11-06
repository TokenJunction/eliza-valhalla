'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chatGeminiOpenAI,
  chatDeepSeek,
  chatMistral,
  chatGeminiNative,
  listOpenAIModels,
} = require('../lib/openai-compat');
const { parseOpenAIChatBody } = require('../lib/parse');
const { createFetchMock } = require('../lib/fetch-mock');

const PROMPT = 'Name the checksum token ZED99 and stop.';

const envGemini = { GEMINI_API_KEY: 'test-gemini-key-012345', GEMINI_MODEL: 'gemini-2.5-flash' };
const envDeepseek = { DEEPSEEK_API_KEY: 'test-deepseek-key-012345', DEEPSEEK_MODEL: 'deepseek-flash' };
const envMistral = { MISTRAL_API_KEY: 'test-mistral-key-0123456', MISTRAL_MODEL: 'mistral-small-2603' };

test('gemini OpenAI-compat success parses choices[0].message.content and asserts body', async () => {
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    assert.equal(
      entry.url,
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    assert.equal(entry.headers.authorization, 'Bearer test-gemini-key-012345');
    const body = JSON.parse(entry.body);
    assert.equal(body.model, 'gemini-2.5-flash');
    assert.equal(body.max_tokens, 64);
    assert.equal(body.messages.at(-1).content, PROMPT);
    assert.equal(body.stream, false);
    return jsonResponse({
      id: 'chatcmpl-test',
      model: 'gemini-2.5-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ZED99' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 1 },
    });
  });
  const result = await chatGeminiOpenAI({ fetchImpl, env: envGemini, prompt: PROMPT });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'ZED99');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(JSON.parse(calls[0].body), result.intendedBody);
});

test('deepseek env model is used; missing model/key unavailable; no invented default', async () => {
  let calls = 0;
  const missingModel = await chatDeepSeek({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    },
    env: { DEEPSEEK_API_KEY: 'test-deepseek-key-012345' },
    prompt: PROMPT,
  });
  assert.equal(missingModel.reason, 'model_env_missing');
  assert.equal(calls, 0);

  const missingKey = await chatDeepSeek({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    },
    env: { DEEPSEEK_MODEL: 'deepseek-flash' },
    prompt: PROMPT,
  });
  assert.equal(missingKey.reason, 'provider_missing');
  assert.equal(calls, 0);

  const { fetchImpl } = createFetchMock((entry, jsonResponse) => {
    const body = JSON.parse(entry.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(entry.url, 'https://api.deepseek.com/chat/completions');
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ZED99' }, finish_reason: 'stop' }],
    });
  });
  const ok = await chatDeepSeek({ fetchImpl, env: envDeepseek, prompt: PROMPT });
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'ZED99');
});

test('mistral env route validation and chat success', async () => {
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    assert.equal(entry.url, 'https://api.mistral.ai/v1/chat/completions');
    const body = JSON.parse(entry.body);
    assert.equal(body.model, 'mistral-small-2603');
    return jsonResponse({
      choices: [{ message: { content: 'ZED99' }, finish_reason: 'stop' }],
    });
  });
  const result = await chatMistral({ fetchImpl, env: envMistral, prompt: PROMPT });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'ZED99');
  assert.equal(calls.length, 1);
});

test('openai refusal, empty content, missing choices, content_filter unavailable', () => {
  assert.equal(
    parseOpenAIChatBody(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, refusal: 'declined' }, finish_reason: 'stop' }],
    })).reason,
    'refusal',
  );
  assert.equal(
    parseOpenAIChatBody(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '  ' }, finish_reason: 'stop' }],
    })).reason,
    'empty_content',
  );
  assert.equal(parseOpenAIChatBody(JSON.stringify({ choices: [] })).reason, 'missing_choices');
  assert.equal(
    parseOpenAIChatBody(JSON.stringify({
      choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }],
    })).reason,
    'content_filtered',
  );
});

test('models list shape cannot authorize generation', () => {
  const listing = parseOpenAIChatBody(JSON.stringify({
    object: 'list',
    data: [{ id: 'gemini-2.5-flash' }],
  }));
  assert.equal(listing.ok, false);
  assert.equal(listing.reason, 'listing_not_generation');
});

test('completion_tokens above maxTokens is unavailable', () => {
  const parsed = parseOpenAIChatBody(
    JSON.stringify({
      choices: [{ message: { content: 'ZED99' }, finish_reason: 'length' }],
      usage: { completion_tokens: 200 },
    }),
    { maxTokens: 64 },
  );
  assert.equal(parsed.reason, 'max_tokens_exceeded');
});

test('single-token OpenAI content is valid', () => {
  const parsed = parseOpenAIChatBody(JSON.stringify({
    choices: [{ message: { content: 'Z' }, finish_reason: 'stop' }],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.content, 'Z');
});

test('gemini native generateContent parse still works for PR16 shape', async () => {
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    assert.match(entry.url, /models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(entry.headers['x-goog-api-key'], 'test-gemini-key-012345');
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: 'ZED99' }] } }],
    });
  });
  const result = await chatGeminiNative({ fetchImpl, env: envGemini, prompt: PROMPT });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'ZED99');
  assert.equal(calls.length, 1);
});

test('listOpenAIModels marks generationAuthorized false', async () => {
  const { fetchImpl } = createFetchMock((entry, jsonResponse) => {
    assert.equal(entry.url, 'https://api.deepseek.com/models');
    return jsonResponse({ object: 'list', data: [{ id: 'deepseek-flash' }] });
  });
  const listing = await listOpenAIModels('deepseek', { fetchImpl, env: envDeepseek });
  assert.equal(listing.ok, true);
  assert.equal(listing.generationAuthorized, false);
  assert.deepEqual(listing.models, ['deepseek-flash']);
});

test('timeout and http errors are unavailable', async () => {
  const timed = await chatDeepSeek({
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
    env: envDeepseek,
    prompt: PROMPT,
  });
  assert.equal(timed.reason, 'timeout');

  const { fetchImpl } = createFetchMock((_e, jsonResponse) => jsonResponse({ error: 'nope' }, 401));
  const http = await chatDeepSeek({ fetchImpl, env: envDeepseek, prompt: PROMPT });
  assert.equal(http.reason, 'http_error');
  assert.equal(http.httpStatus, 401);
});
