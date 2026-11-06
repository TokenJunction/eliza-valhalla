'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenAIChatBody, parseModelsListing } = require('../lib/parse');

test('/models and /api/tags are metadata only', () => {
  const tags = parseModelsListing(JSON.stringify({
    models: [{ name: 'qwen2.5-coder:14b' }],
  }), 'ollama_tags');
  assert.equal(tags.generationAuthorized, false);

  const models = parseModelsListing(JSON.stringify({
    object: 'list',
    data: [{ id: 'deepseek-flash' }],
  }), 'openai');
  assert.equal(models.generationAuthorized, false);

  // Feeding a listing body to the chat parser must not look like success
  const asChat = parseOpenAIChatBody(JSON.stringify({
    object: 'list',
    data: [{ id: 'deepseek-flash' }],
  }));
  assert.equal(asChat.ok, false);
  assert.equal(asChat.reason, 'listing_not_generation');
});
