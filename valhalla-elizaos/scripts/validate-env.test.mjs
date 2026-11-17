import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolvePort } from './start.js';
import { validateEnvironment } from './validate-env.js';

test('allows optional integrations outside production', () => {
  assert.equal(validateEnvironment({ NODE_ENV: 'development' }), true);
});

test('requires a model provider in production', () => {
  assert.throws(
    () => validateEnvironment({ NODE_ENV: 'production' }),
    /Production requires at least one model provider key/,
  );
});

test('accepts a configured production model provider', () => {
  assert.equal(
    validateEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'configured' }),
    true,
  );
});

test('rejects partially configured Supabase and Upstash REST credentials', () => {
  assert.throws(
    () => validateEnvironment({ SUPABASE_URL: 'https://db.example.test' }),
    /SUPABASE_URL and SUPABASE_ANON_KEY must be configured together/,
  );
  assert.throws(
    () => validateEnvironment({ UPSTASH_REDIS_REST_TOKEN: 'configured' }),
    /UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together/,
  );
});

test('validates integration URL protocols', () => {
  assert.throws(
    () => validateEnvironment({ REDIS_URL: 'https://redis.example.test' }),
    /REDIS_URL must be a valid URL using redis: or rediss:/,
  );
  assert.throws(
    () =>
      validateEnvironment({
        UPSTASH_REDIS_REST_URL: 'http://redis.example.test',
        UPSTASH_REDIS_REST_TOKEN: 'configured',
      }),
    /UPSTASH_REDIS_REST_URL must be a valid URL using https:/,
  );
});

test('requires the Clerk MCP endpoint to use HTTPS', () => {
  assert.throws(
    () => validateEnvironment({ CLERK_MCP_URL: 'http://mcp.clerk.com/mcp' }),
    /CLERK_MCP_URL must be a valid URL using https:/,
  );
  assert.equal(
    validateEnvironment({ CLERK_MCP_URL: 'https://mcp.clerk.com/mcp' }),
    true,
  );
});

test('requires encrypted Supabase and Redis URLs in production', () => {
  assert.throws(
    () =>
      validateEnvironment({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'configured',
        SUPABASE_URL: 'http://db.example.test',
        SUPABASE_ANON_KEY: 'configured',
        REDIS_URL: 'redis://cache.example.test',
      }),
    /SUPABASE_URL must be a valid URL using https:/,
  );
  assert.throws(
    () =>
      validateEnvironment({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'configured',
        REDIS_URL: 'redis://cache.example.test',
      }),
    /REDIS_URL must be a valid URL using rediss:/,
  );
});

test('refuses to enable execution capabilities that are not implemented', () => {
  assert.throws(
    () => validateEnvironment({ VALHALLA_TRADING_ENABLED: 'true' }),
    /VALHALLA_TRADING_ENABLED must remain false/,
  );
});

test('start command resolves SERVER_PORT, then Render PORT', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.match(manifest.scripts.start, /node scripts\/start\.js/);
  assert.deepEqual(resolvePort({ SERVER_PORT: '4100', PORT: '3000' }), {
    port: '4100',
    source: 'SERVER_PORT',
  });
  assert.deepEqual(resolvePort({ PORT: '4100' }), { port: '4100', source: 'PORT' });
  assert.deepEqual(resolvePort({ SERVER_PORT: '', PORT: '4100' }), {
    port: '4100',
    source: 'PORT',
  });
  assert.deepEqual(resolvePort({}), { port: '3000', source: 'default' });
});
