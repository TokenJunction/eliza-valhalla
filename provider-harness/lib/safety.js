'use strict';

const { LOOPBACK_HOSTS, OLLAMA_DIRECT_PORT, GATEWAY_GENERATE_PATH, MAX_FALLBACK_ATTEMPTS } = require('./contracts');
const { isIP } = require('node:net');

/**
 * Safety boundaries:
 * - Customer-PC server/browser: loopback gateway only (127.0.0.1/localhost/::1), never public 11434.
 * - Cloud-to-PC: authenticated HTTPS allow-listed relay / named tunnel only.
 * - Bounded fallback: at most one cloud attempt after local/relay failure.
 */

function normalizeHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function classifyTarget(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { class: 'invalid', reason: 'url_parse_failed' };
  }
  const host = normalizeHost(url.hostname);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  if (LOOPBACK_HOSTS.includes(host)) {
    if (port === OLLAMA_DIRECT_PORT) {
      return {
        class: 'blocked_direct_ollama',
        reason: 'ollama_port_blocked',
        detail: 'Router/cloud must not dial :11434; customer relay may, on loopback only.',
      };
    }
    if (url.protocol !== 'http:') {
      return { class: 'invalid', reason: 'loopback_requires_http' };
    }
    return {
      class: 'customer_pc_loopback',
      reason: null,
      generateUrl: `${url.origin}${GATEWAY_GENERATE_PATH}`,
    };
  }

  if (url.protocol !== 'https:') {
    return { class: 'invalid', reason: 'remote_requires_https' };
  }
  if (port === OLLAMA_DIRECT_PORT) {
    return { class: 'blocked_direct_ollama', reason: 'remote_ollama_port_blocked' };
  }
  if (isIP(host) || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost') {
    return { class: 'blocked_internal', reason: 'remote_internal_url' };
  }
  if (host.endsWith('.onrender.com') || host === 'onrender.com' || host.endsWith('.workers.dev')) {
    return { class: 'blocked_website_or_platform', reason: 'website_or_platform_host' };
  }
  return {
    class: 'cloud_to_pc_relay_candidate',
    reason: null,
    requires: ['https', 'allowlist_host', 'auth_bearer_or_cloudflare_access'],
    generateUrl: `https://${host}${GATEWAY_GENERATE_PATH}`,
  };
}

function authorizeRelay({ baseUrl, allowHosts = [], token = '', guard = 'bearer', accessJwt = '' }) {
  const classified = classifyTarget(baseUrl);
  if (classified.class !== 'cloud_to_pc_relay_candidate') {
    return { ok: false, reason: classified.reason || classified.class };
  }
  let host;
  try {
    host = normalizeHost(new URL(baseUrl).hostname);
  } catch {
    return { ok: false, reason: 'url_parse_failed' };
  }
  const allow = allowHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  if (!allow.includes(host)) return { ok: false, reason: 'remote_host_not_allowed' };

  if (guard === 'cloudflare-access') {
    if (typeof accessJwt !== 'string' || accessJwt.trim().length < 16) {
      return { ok: false, reason: 'tunnel_guard_missing' };
    }
    return {
      ok: true,
      url: classified.generateUrl,
      headers: { 'cf-access-jwt-assertion': accessJwt.trim() },
    };
  }
  if (typeof token !== 'string' || token.trim().length < 16) {
    return { ok: false, reason: 'remote_token_missing' };
  }
  return {
    ok: true,
    url: classified.generateUrl,
    headers: { authorization: `Bearer ${token.trim()}` },
  };
}

function boundFallbackPlan(primaryOk, cloudConfigured) {
  if (primaryOk) return { attempts: 1, fallback: false };
  if (!cloudConfigured) return { attempts: 1, fallback: false, result: 'unavailable' };
  return { attempts: 1 + MAX_FALLBACK_ATTEMPTS, fallback: true, maxCloudAttempts: MAX_FALLBACK_ATTEMPTS };
}

module.exports = {
  classifyTarget,
  authorizeRelay,
  boundFallbackPlan,
  normalizeHost,
};
