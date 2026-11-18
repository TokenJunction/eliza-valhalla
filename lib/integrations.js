'use strict';
// Zero-dependency Supabase (PostgREST/Auth) and Upstash Redis (REST) clients plus health probes.

const executionCapability = require('./execution-capability');
const TIMEOUT_MS = 4000;

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function upstashConfig(env = process.env) {
  const url = (env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url, token } : null;
}

function supabaseConfig(env = process.env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || '';
  return url && key ? { url, key, privileged: Boolean(env.SUPABASE_SERVICE_ROLE_KEY) } : null;
}

async function redisCommand(args, env = process.env) {
  const cfg = upstashConfig(env);
  if (!cfg) throw new Error('upstash_not_configured');
  const res = await timedFetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `upstash_http_${res.status}`);
  return body.result;
}

// Fixed-window rate limiter; fails open when Redis is unavailable.
async function rateLimit(key, limit, windowSec, env = process.env) {
  if (!upstashConfig(env)) return { allowed: true, remaining: limit, enforced: false };
  try {
    const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    const count = Number(await redisCommand(['INCR', bucket], env));
    if (count === 1) await redisCommand(['EXPIRE', bucket, windowSec], env);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), enforced: true };
  } catch {
    return { allowed: true, remaining: limit, enforced: false };
  }
}

async function cacheGet(key, env = process.env) {
  try {
    const raw = await redisCommand(['GET', key], env);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key, value, ttlSec, env = process.env) {
  try {
    await redisCommand(['SET', key, JSON.stringify(value), 'EX', ttlSec], env);
  } catch {
    // cache is best-effort
  }
}

// A cached health snapshot is only valid for the execution config that produced
// it. Scoping the key to the config hash makes a kill-switch flip miss the old
// snapshot immediately instead of serving it until the TTL expires.
function healthCacheKey(execution) {
  return `health:snapshot:${execution.configHash}`;
}

async function supabaseRest(path, { method = 'GET', body, env = process.env } = {}) {
  const cfg = supabaseConfig(env);
  if (!cfg) throw new Error('supabase_not_configured');
  const res = await timedFetch(`${cfg.url}${path}`, {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase_http_${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Append-only audit entry for Cerberus guard decisions.
function logCerberusEvent(entry, env = process.env) {
  return supabaseRest('/rest/v1/cerberus_vault_logs', {
    method: 'POST',
    env,
    body: {
      action: String(entry.action).slice(0, 200),
      outcome: entry.outcome === 'authorized' ? 'authorized' : 'blocked',
      reason: String(entry.reason).slice(0, 500),
      metadata: entry.metadata || {},
    },
  });
}

async function probe(name, configured, fn) {
  if (!configured) return { name, status: 'not_configured', latencyMs: null };
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, status: 'up', latencyMs: Date.now() - started, ...(detail || {}) };
  } catch (err) {
    return { name, status: 'down', latencyMs: Date.now() - started, error: String(err.message || err).slice(0, 120) };
  }
}

function probeRedis(env = process.env) {
  return probe('upstash-redis', upstashConfig(env), async () => {
    const pong = await redisCommand(['PING'], env);
    if (pong !== 'PONG') throw new Error('unexpected_ping_response');
  });
}

function probeSupabase(env = process.env) {
  const cfg = supabaseConfig(env);
  return probe('supabase', cfg, async () => {
    await supabaseRest('/rest/v1/cerberus_vault_logs?select=id&limit=1', { env });
    return { privileged: cfg.privileged };
  });
}

function probeEliza(env = process.env) {
  const base = (env.ELIZA_URL || '').replace(/\/+$/, '');
  return probe('elizaos', base, async () => {
    const res = await timedFetch(`${base}/api/valhalla/health`);
    if (!res.ok) throw new Error(`eliza_http_${res.status}`);
    const body = await res.json();
    return { capabilities: body.capabilities, mode: body.mode };
  });
}

async function collectHealth(env = process.env, execution = executionCapability.describe(env)) {
  const checks = await Promise.all([probeSupabase(env), probeRedis(env), probeEliza(env)]);
  const configured = checks.filter((c) => c.status !== 'not_configured');
  const overall = configured.some((c) => c.status === 'down')
    ? 'degraded'
    : configured.length === checks.length ? 'ok' : 'partial';
  // The client gate and this health response both read this one resolved state.
  // Callers may pass it in so the cache key and payload share the same config hash.
  // Never derive `trading` from a second environment flag here.
  return {
    status: overall,
    checkedAt: new Date().toISOString(),
    mode: execution.mode,
    checks,
    execution,
    safety: {
      trading: execution.liveTrading ? 'enabled' : 'disabled',
      social: env.VALHALLA_SOCIAL_ENABLED === 'true' ? 'enabled' : 'disabled',
      keyStorage: env.VALHALLA_KEY_STORAGE_ENABLED === 'true' ? 'enabled' : 'disabled',
      adminConfigured: Boolean(env.LEADER_EMAIL),
    },
  };
}

module.exports = {
  upstashConfig, supabaseConfig, redisCommand, rateLimit, cacheGet, cacheSet,
  healthCacheKey, supabaseRest, logCerberusEvent, collectHealth,
};
