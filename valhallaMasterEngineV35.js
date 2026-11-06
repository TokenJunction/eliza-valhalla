const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const express = require('express');
const integrations = require('./lib/integrations');
const providerHealth = require('./lib/provider-health');
const { validateEnv } = require('./scripts/validateEnv');
const {
  createValhallaQueueEngine,
  isAuthorizedDispatch,
  validateDispatch,
} = require('./valhallaQueueEngine');

const root = fs.existsSync(path.join(__dirname, 'site-build', 'index.html'))
  ? path.join(__dirname, 'site-build')
  : __dirname;
const port = Number(process.env.PORT) || 10000;
const publicOrigin = (process.env.PUBLIC_ORIGIN || 'https://valhalla-app.xyz').replace(/\/+$/, '');
const allowedOrigins = [publicOrigin, publicOrigin.replace('://', '://www.')];
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
};
const hidden = /(^|[\\/])(\.[^\\/]*|(node_modules|workers|supabase|scripts|lib|customer|provider-harness|valhalla-elizaos)([\\/]|$))/;

function resolve(urlPath) {
  const rel = path.normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^([\\/]|\.\.)+/, '');
  if (hidden.test(rel)) return null;
  let file = path.join(root, rel);
  if (!file.startsWith(root)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const elizaBase = (process.env.ELIZA_URL || '').replace(/\/+$/, '');
const MAX_PROXY_BODY = 64 * 1024;
const MAX_DISPATCH_BODY = 8 * 1024;
let queueEngine = null;

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

async function proxyToEliza(req, res) {
  if (!elizaBase) return sendJson(res, 503, { error: 'eliza_not_configured' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PROXY_BODY) return sendJson(res, 413, { error: 'payload_too_large' });
    chunks.push(chunk);
  }
  try {
    const upstream = await fetch(`${elizaBase}${req.url}`, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    sendJson(res, 502, { error: 'eliza_unreachable' });
  }
}

async function handleHealth(req, res) {
  const limit = await integrations.rateLimit(`health:${clientIp(req)}`, 60, 60);
  if (!limit.allowed) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  // Redis-backed 15s cache keeps probe load constant regardless of dashboard traffic.
  let health = await integrations.cacheGet('health:snapshot');
  if (!health) {
    health = await integrations.collectHealth();
    await integrations.cacheSet('health:snapshot', health, 15);
  }
  sendJson(res, health.status === 'degraded' ? 503 : 200, { ...health, origin: publicOrigin });
}

async function handleProviderHealth(req, res) {
  const limit = await integrations.rateLimit(`provider-health:${clientIp(req)}`, 60, 60);
  if (!limit.allowed) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  // Readiness only. This does not call a model and does not change the gauge snapshot.
  sendJson(res, 200, providerHealth.collectProviderRoutes(process.env));
}

async function handleDispatch(req, res) {
  if (process.env.VALHALLA_QUEUE_ENABLED !== 'true') {
    return sendJson(res, 503, { error: 'queue_disabled' });
  }
  const expectedToken = process.env.VALHALLA_DISPATCH_TOKEN;
  if (!expectedToken) return sendJson(res, 503, { error: 'dispatch_not_configured' });
  if (!isAuthorizedDispatch(req.headers.authorization, expectedToken)) {
    return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  }
  if (!queueEngine) return sendJson(res, 503, { error: 'queue_unavailable' });

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DISPATCH_BODY) {
      return sendJson(res, 413, { error: 'payload_too_large' });
    }
    chunks.push(chunk);
  }

  let dispatch;
  try {
    dispatch = validateDispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    const invalidRequest = error instanceof SyntaxError || error instanceof TypeError;
    return sendJson(res, invalidRequest ? 400 : 500, {
      error: invalidRequest ? String(error.message || 'invalid_request') : 'dispatch_failed',
    });
  }

  try {
    const job = await queueEngine.enqueue(dispatch);
    return sendJson(res, 202, {
      accepted: true,
      queue: dispatch.targetEngine,
      jobId: job.id,
    });
  } catch {
    return sendJson(res, 503, { error: 'queue_unavailable' });
  }
}

const app = express();
app.disable('x-powered-by');
app.use(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const pathname = req.url.split('?')[0];
  if (pathname === '/health') {
    return sendJson(res, 200, {
      status: 'UP',
      engine: 'Valhalla V35',
      uptime: process.uptime(),
    });
  }
  if (pathname === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      origin: publicOrigin,
      redis: Boolean(integrations.upstashConfig()),
      supabase: Boolean(integrations.supabaseConfig()),
      eliza: Boolean(elizaBase),
      queueWorkers: queueEngine !== null,
      adminConfigured: Boolean(process.env.LEADER_EMAIL),
    });
  }
  if (pathname === '/api/valhalla/dispatch') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    return handleDispatch(req, res).catch(() =>
      sendJson(res, 500, { error: 'dispatch_failed' }),
    );
  }
  if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleHealth(req, res).catch(() => sendJson(res, 500, { error: 'health_failed' }));
  }
  if (pathname === '/api/provider/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleProviderHealth(req, res).catch(() => sendJson(res, 500, { error: 'provider_health_failed' }));
  }
  if (pathname.startsWith('/api/valhalla/') && (req.method === 'GET' || req.method === 'POST')) {
    return proxyToEliza(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let file;
  try { file = resolve(req.url); } catch { file = null; }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

const server = http.createServer(app);

async function start() {
  if (process.env.VALHALLA_STRICT_ENV === 'true') validateEnv();
  // Queues are on by default; set VALHALLA_QUEUE_ENABLED=false to opt out.
  if (process.env.VALHALLA_QUEUE_ENABLED !== 'false') {
    const token = process.env.VALHALLA_DISPATCH_TOKEN || '';
    if (!process.env.REDIS_URL || Buffer.byteLength(token) < 32) {
      // Misconfiguration must not take the site down; dispatch stays closed until fixed.
      console.error('[Valhalla queues] Not started: set REDIS_URL (rediss://) and a VALHALLA_DISPATCH_TOKEN of 32+ bytes.');
    } else {
      try {
        queueEngine = await createValhallaQueueEngine();
      } catch (error) {
        console.error('[Valhalla queues] Not started:', error.message);
      }
    }
  }
  server.listen(port, '0.0.0.0', () =>
    console.log(`Valhalla serving ${root} on :${port} (queues ${queueEngine ? 'active' : 'inactive'})`),
  );
}

start().catch((error) => {
  console.error('[Valhalla startup] Queue runtime could not start:', error.message);
  process.exitCode = 1;
});

async function shutdown() {
  server.close();
  if (queueEngine) await queueEngine.close();
}

process.once('SIGINT', () => {
  void shutdown().catch(() => {
    console.error('[Valhalla shutdown] Queue cleanup failed');
    process.exitCode = 1;
  });
});
process.once('SIGTERM', () => {
  void shutdown().catch(() => {
    console.error('[Valhalla shutdown] Queue cleanup failed');
    process.exitCode = 1;
  });
});
