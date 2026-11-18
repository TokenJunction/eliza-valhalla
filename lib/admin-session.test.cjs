'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accessUrl, bearer, requireAdmin } = require('./admin-session');

const ENV = { AUTH_URL: 'https://auth.example.test' };

function request(headers = {}) {
  return { headers };
}

function proof(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

test('builds the access endpoint from the configured auth origin', () => {
  assert.equal(accessUrl(ENV), 'https://auth.example.test/auth/access');
  assert.equal(accessUrl({ AUTH_URL: 'https://auth.example.test/' }), 'https://auth.example.test/auth/access');
  assert.equal(accessUrl({ AUTH_URL: 'http://127.0.0.1:4567' }), 'http://127.0.0.1:4567/auth/access');
  assert.equal(accessUrl({ AUTH_URL: 'http://auth.example.test' }), null);
  assert.equal(accessUrl({ AUTH_URL: 'https://user:pass@auth.example.test' }), null);
  assert.equal(accessUrl({}), null);
});

test('parses only a bearer token, never a cookie or email header', async () => {
  assert.equal(bearer(request({ authorization: 'Bearer live-token' })), 'live-token');
  assert.equal(bearer(request({ authorization: 'bearer live-token' })), 'live-token');
  assert.equal(bearer(request({ cookie: 'vh_device=device-token' })), '');
  assert.equal(bearer(request({ 'x-valhalla-email': 'owner@example.test' })), '');

  let called = false;
  const result = await requireAdmin(request({ cookie: 'vh_device=device-token' }), {
    env: ENV,
    fetch: async () => {
      called = true;
      return proof(200, { ok: true, leader: true });
    },
  });
  assert.equal(result.status, 401);
  assert.equal(result.error, 'admin_session_required');
  assert.equal(called, false);
});

test('rejects an invalid session and a signed-in non-leader', async () => {
  const invalid = await requireAdmin(request({ authorization: 'Bearer expired' }), {
    env: ENV,
    fetch: async () => proof(401, { ok: false, error: 'session' }),
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.error, 'admin_session_required');

  const member = await requireAdmin(request({ authorization: 'Bearer member-token' }), {
    env: ENV,
    fetch: async () => proof(200, { ok: true, leader: false, subject: 'hash' }),
  });
  assert.equal(member.status, 403);
  assert.equal(member.error, 'admin_required');
});

test('accepts only a live leader proof and forwards the bearer server-side', async () => {
  let seen;
  const result = await requireAdmin(request({ authorization: 'Bearer owner-token' }), {
    env: ENV,
    fetch: async (url, options) => {
      seen = { url, options };
      return proof(200, {
        ok: true,
        leader: true,
        subject: 'owner-hash',
        sessionId: 'session-id',
      });
    },
  });

  assert.deepEqual(result, {
    ok: true,
    subject: 'owner-hash',
    sessionId: 'session-id',
  });
  assert.equal(seen.url, 'https://auth.example.test/auth/access');
  assert.equal(seen.options.headers.authorization, 'Bearer owner-token');
  assert.equal(seen.options.headers.accept, 'application/json');
  assert.equal(seen.options.redirect, 'error');
});

test('fails closed when auth is unavailable or returns an unusable proof', async () => {
  const unavailable = await requireAdmin(request({ authorization: 'Bearer owner-token' }), {
    env: ENV,
    fetch: async () => {
      throw new Error('network');
    },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.error, 'admin_auth_unavailable');

  const malformed = await requireAdmin(request({ authorization: 'Bearer owner-token' }), {
    env: ENV,
    fetch: async () => proof(200, new Error('not json')),
  });
  assert.equal(malformed.status, 502);
  assert.equal(malformed.error, 'admin_auth_invalid');

  const unconfigured = await requireAdmin(request({ authorization: 'Bearer owner-token' }), {
    env: {},
    fetch: async () => proof(200, { ok: true, leader: true }),
  });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.error, 'admin_auth_unavailable');
});
