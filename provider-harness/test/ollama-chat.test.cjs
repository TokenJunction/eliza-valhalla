'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chat, listModels, buildChatRequest } = require('../lib/ollama-adapter');
const { parseOllamaChatBody } = require('../lib/parse');
const { createFetchMock } = require('../lib/fetch-mock');
const { LOCAL_OLLAMA_MODEL_DEFAULT } = require('../lib/contracts');

const PROMPT = 'Return the token ALPHA7 only, then stop.';

test('ollama /api/chat success parses message.content and matches request body', async () => {
  const intended = buildChatRequest({
    prompt: PROMPT,
    model: LOCAL_OLLAMA_MODEL_DEFAULT,
    maxTokens: 64,
    system: null,
  });
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    assert.equal(entry.url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(entry.method, 'POST');
    const body = JSON.parse(entry.body);
    assert.deepEqual(body, intended);
    return jsonResponse({
      model: 'qwen2.5-coder:14b',
      message: { role: 'assistant', content: 'ALPHA7' },
      done: true,
      done_reason: 'stop',
      eval_count: 1,
    });
  });

  const result = await chat({ fetchImpl, prompt: PROMPT, env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'ALPHA7'); // single-token valid
  assert.equal(result.doneReason, 'stop');
  assert.equal(calls.length, 1);
  assert.deepEqual(result.intendedBody, intended);
  assert.equal(JSON.stringify(result.intendedBody), calls[0].body);
});

test('ollama whitespace-only and empty content are unavailable', () => {
  assert.equal(parseOllamaChatBody(JSON.stringify({
    message: { role: 'assistant', content: '   ' },
    done: true,
    done_reason: 'stop',
  })).reason, 'empty_content');
  assert.equal(parseOllamaChatBody(JSON.stringify({
    message: { role: 'assistant', content: '' },
    done: true,
  })).reason, 'empty_content');
});

test('ollama provider error field and parse errors are unavailable', () => {
  assert.equal(parseOllamaChatBody(JSON.stringify({ error: 'model not found' })).reason, 'provider_error');
  assert.equal(parseOllamaChatBody('not-json{').reason, 'parse_error');
});

test('ollama NDJSON stream requires final done:true and concatenates chunks', () => {
  const ndjson = [
    JSON.stringify({ message: { role: 'assistant', content: 'AL' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: 'PHA7' }, done: true, done_reason: 'stop', eval_count: 2 }),
  ].join('\n');
  const ok = parseOllamaChatBody(ndjson);
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'ALPHA7');
  assert.equal(ok.doneReason, 'stop');

  const missingDone = [
    JSON.stringify({ message: { role: 'assistant', content: 'AL' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: 'PHA7' }, done: false }),
  ].join('\n');
  assert.equal(parseOllamaChatBody(missingDone).reason, 'incomplete_stream');
});

test('ollama final-only chunk with done true is accepted; single not-done is not', () => {
  const finalOnly = JSON.stringify({
    message: { role: 'assistant', content: 'OK' },
    done: true,
    done_reason: 'stop',
  });
  assert.equal(parseOllamaChatBody(finalOnly).ok, true);

  const notDone = JSON.stringify({
    message: { role: 'assistant', content: 'OK' },
    done: false,
  });
  assert.equal(parseOllamaChatBody(notDone).reason, 'incomplete_stream');
});

test('openai choices shape on ollama chat path is shape_mismatch', () => {
  const body = JSON.stringify({
    choices: [{ message: { content: 'nope' }, finish_reason: 'stop' }],
  });
  assert.equal(parseOllamaChatBody(body).reason, 'shape_mismatch');
});

test('ollama max token bound uses eval_count when present', () => {
  const body = JSON.stringify({
    message: { role: 'assistant', content: 'ALPHA7' },
    done: true,
    done_reason: 'stop',
    eval_count: 99,
  });
  assert.equal(parseOllamaChatBody(body, { maxTokens: 8 }).reason, 'max_tokens_exceeded');
});

test('ollama unreachable and timeout map to unavailable', async () => {
  const unreachable = await chat({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    prompt: PROMPT,
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.reason, 'unreachable');

  const timed = await chat({
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    },
    prompt: PROMPT,
  });
  assert.equal(timed.reason, 'timeout');
});

test('ollama loopback adapter rejects any port other than 11434', async () => {
  const result = await chat({
    fetchImpl: async () => {
      throw new Error('should not call');
    },
    prompt: PROMPT,
    origin: 'http://127.0.0.1:8788',
  });
  assert.equal(result.reason, 'ollama_port_blocked');
});

test('ollama rejects non-loopback origins (no public 11434)', async () => {
  const result = await chat({
    fetchImpl: async () => {
      throw new Error('should not call');
    },
    prompt: PROMPT,
    origin: 'http://192.168.1.10:11434',
  });
  assert.equal(result.reason, 'ollama_not_loopback');
});

test('models list via /api/tags never authorizes generation', async () => {
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    assert.equal(entry.url, 'http://127.0.0.1:11434/api/tags');
    return jsonResponse({
      models: [{ name: 'qwen2.5-coder:14b' }, { name: 'llama3.2' }],
    });
  });
  const listing = await listModels({ fetchImpl });
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.models, ['qwen2.5-coder:14b', 'llama3.2']);
  assert.equal(listing.generationAuthorized, false);
  assert.equal(calls.length, 1);
});

test('echo equality alone does not fail; request/response still asserted', async () => {
  // Legitimate model may return the same short token the user asked for.
  const { fetchImpl, calls } = createFetchMock((entry, jsonResponse) => {
    const body = JSON.parse(entry.body);
    assert.equal(body.messages[0].content, PROMPT);
    return jsonResponse({
      model: 'qwen2.5-coder:14b',
      message: { role: 'assistant', content: PROMPT },
      done: true,
      done_reason: 'stop',
      eval_count: 12,
    });
  });
  const result = await chat({ fetchImpl, prompt: PROMPT });
  assert.equal(result.ok, true);
  assert.equal(result.content, PROMPT);
  assert.equal(calls.length, 1);
});
