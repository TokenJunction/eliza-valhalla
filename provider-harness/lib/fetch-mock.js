'use strict';

/**
 * Injected fetch recorder. No network. Handlers return Response-like objects.
 */

function jsonResponse(payload, status = 200, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        const map = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
        );
        return map[key] ?? (key === 'content-type' ? 'application/json' : null);
      },
    },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}

function textResponse(body, status = 200, contentType = 'application/x-ndjson') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async text() {
      return String(body);
    },
    async json() {
      return JSON.parse(String(body).split(/\r?\n/).filter(Boolean).pop());
    },
  };
}

function createFetchMock(routerFn) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const entry = {
      url: String(url),
      method: (options.method || 'GET').toUpperCase(),
      headers: { ...(options.headers || {}) },
      body: options.body == null ? null : String(options.body),
      redirect: options.redirect,
      signal: options.signal || null,
    };
    calls.push(entry);
    return routerFn(entry, jsonResponse, textResponse);
  };
  return { fetchImpl, calls, jsonResponse, textResponse };
}

module.exports = {
  jsonResponse,
  textResponse,
  createFetchMock,
};
