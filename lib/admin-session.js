'use strict';

// The auth Worker is the only source of admin authority. This module forwards
// the existing access bearer to it and accepts only a live leader session.
// It never trusts a cookie, email header, or client-supplied role.

const AUTH_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function bearer(request) {
  const header = request && request.headers && request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)$/i.exec(String(value || '').trim());
  return match ? match[1] : '';
}

function accessUrl(env = process.env) {
  const raw = String(env.AUTH_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    return null;
  }

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/auth/access`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function requireAdmin(request, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const endpoint = accessUrl(env);
  if (!endpoint) return { ok: false, status: 503, error: 'admin_auth_unavailable' };

  const token = bearer(request);
  if (!token) return { ok: false, status: 401, error: 'admin_session_required' };

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 503, error: 'admin_auth_unavailable' };
  }

  if (response.status === 401) return { ok: false, status: 401, error: 'admin_session_required' };
  if (!response.ok) return { ok: false, status: 503, error: 'admin_auth_unavailable' };

  let proof;
  try {
    proof = await response.json();
  } catch {
    return { ok: false, status: 502, error: 'admin_auth_invalid' };
  }
  if (!proof || proof.ok !== true) {
    return { ok: false, status: 401, error: 'admin_session_required' };
  }
  if (proof.leader !== true) return { ok: false, status: 403, error: 'admin_required' };

  return {
    ok: true,
    subject: typeof proof.subject === 'string' ? proof.subject : '',
    sessionId: typeof proof.sessionId === 'string' ? proof.sessionId : '',
  };
}

module.exports = { accessUrl, bearer, requireAdmin };
