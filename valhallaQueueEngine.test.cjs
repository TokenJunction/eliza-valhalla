'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createValhallaQueueEngine,
  executeSafeTask,
  isAuthorizedDispatch,
  validateDispatch,
  validateQueueConfig,
} = require('./valhallaQueueEngine');

test('accepts only explicitly allow-listed paper and status jobs', () => {
  assert.deepEqual(
    validateDispatch({
      targetEngine: 'gorgo',
      taskName: 'paper-simulation',
      payload: { scenario: 'baseline' },
    }),
    {
      targetEngine: 'gorgo',
      taskName: 'paper-simulation',
      payload: { scenario: 'baseline' },
    },
  );
  assert.deepEqual(executeSafeTask('cerberus', 'vault-check', {}), {
    status: 'blocked',
    vaultLocked: true,
  });
});

test('rejects trading, arbitrary task names, and secret-shaped payload fields', () => {
  assert.throws(
    () => validateDispatch({ targetEngine: 'cerberus', taskName: 'trade' }),
    /unsupported_queue_task/,
  );
  assert.throws(
    () =>
      validateDispatch({
        targetEngine: 'zeus',
        taskName: 'health-check',
        payload: { privateKey: 'must-not-be-queued' },
      }),
    /unsupported_payload_field/,
  );
  assert.throws(
    () =>
      validateDispatch({
        targetEngine: 'gorgo',
        taskName: 'paper-simulation',
        payload: { scenario: 'arbitrary-code' },
      }),
    /unsupported_paper_scenario/,
  );
});

test('requires a bearer service token and compares it safely', () => {
  assert.equal(isAuthorizedDispatch('Bearer correct-token', 'correct-token'), true);
  assert.equal(isAuthorizedDispatch('Bearer wrong-token', 'correct-token'), false);
  assert.equal(isAuthorizedDispatch('Bearer correct-token', ''), false);
  assert.equal(isAuthorizedDispatch(undefined, 'correct-token'), false);
});

test('requires a Redis protocol URL and rejects insecure production Redis', async () => {
  await assert.rejects(
    createValhallaQueueEngine({ redisUrl: 'https://redis.example.test' }),
    /REDIS_URL must use rediss:\/\/ in production/,
  );
});

test('permits plain redis:// only for a Render private-network host in production', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.doesNotThrow(() => validateQueueConfig({ redisUrl: 'redis://red-abc123:6379', role: 'consumer' }));
    assert.throws(
      () => validateQueueConfig({ redisUrl: 'redis://public.example.test:6379', role: 'consumer' }),
      /REDIS_URL must use rediss:\/\/ in production/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
