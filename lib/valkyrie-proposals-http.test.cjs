'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ENV_KEYS = ['PORT', 'PUBLIC_ORIGIN', 'AUTH_URL', 'VALKYRIE_PROJECT_ROOT', 'VALHALLA_QUEUE_ENABLED', 'VALHALLA_STRICT_ENV'];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function getJson(base, pathname, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { Connection: 'close', ...headers },
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    authenticate: response.headers.get('www-authenticate'),
    body: await response.json(),
  };
}

function startAuthStub() {
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/auth/access') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not-found' }));
      return;
    }

    const authorization = String(req.headers.authorization || '');
    if (authorization === 'Bearer owner-token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, leader: true, subject: 'owner-hash', sessionId: 'owner-session' }));
      return;
    }
    if (authorization === 'Bearer member-token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, leader: false, subject: 'member-hash', sessionId: 'member-session' }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'session' }));
  });
  return listen(server).then((port) => ({ server, url: `http://127.0.0.1:${port}` }));
}

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test('proposal metadata is private until the auth worker returns a leader session', async () => {
  const savedEnv = snapshotEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valkyrie-http-test-'));
  const proposalDir = path.join(root, '.coding-skill', 'proposals');
  fs.mkdirSync(proposalDir, { recursive: true });
  fs.writeFileSync(
    path.join(proposalDir, '409a3f976bc834d6.json'),
    JSON.stringify({
      id: '409a3f976bc834d6',
      status: 'pending_approval',
      createdAt: '2026-11-18T00:00:00Z',
      files: ['private/secret-file.js'],
      tests: { ok: true },
      syntax: [{ ok: true }],
      patchSha256: 'a'.repeat(64),
    }),
  );

  const auth = await startAuthStub();
  const port = await freePort();
  let server;

  try {
    Object.assign(process.env, {
      PORT: String(port),
      PUBLIC_ORIGIN: 'https://app.example',
      AUTH_URL: auth.url,
      VALKYRIE_PROJECT_ROOT: root,
      VALHALLA_QUEUE_ENABLED: 'false',
      VALHALLA_STRICT_ENV: 'false',
    });

    ({ server } = require('../valhallaMasterEngineV35'));
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    const base = `http://127.0.0.1:${port}`;

    const anonymous = await getJson(base, '/api/valkyrie/proposals');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.cacheControl, 'no-store');
    assert.equal(anonymous.authenticate, 'Bearer');
    assert.deepEqual(anonymous.body, { error: 'admin_session_required' });
    assert.equal(JSON.stringify(anonymous).includes('409a3f976bc834d6'), false);
    assert.equal(JSON.stringify(anonymous).includes('private/secret-file.js'), false);

    const invalid = await getJson(base, '/api/valkyrie/proposals', { authorization: 'Bearer expired' });
    assert.equal(invalid.status, 401);
    assert.deepEqual(invalid.body, { error: 'admin_session_required' });

    const member = await getJson(base, '/api/valkyrie/proposals', { authorization: 'Bearer member-token' });
    assert.equal(member.status, 403);
    assert.deepEqual(member.body, { error: 'admin_required' });

    const owner = await getJson(base, '/api/valkyrie/proposals', { authorization: 'Bearer owner-token' });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.configured, true);
    assert.equal(owner.body.pendingCount, 1);
    assert.equal(owner.body.proposals[0].id, '409a3f976bc834d6');
    assert.deepEqual(owner.body.proposals[0].files, ['private/secret-file.js']);
  } finally {
    await closeServer(server);
    await closeServer(auth.server);
    fs.rmSync(root, { recursive: true, force: true });
    restoreEnv(savedEnv);
  }
});
