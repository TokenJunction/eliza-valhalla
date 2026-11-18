'use strict';

// One source of truth for whether this deployment may start live execution.
//
// The server resolves the requested mode from the environment, signs a
// short-lived capability with Ed25519, and both the browser gate and the health
// endpoint read that same resolved state. The browser never trusts a mutable
// global flag; it verifies the signed payload with the pinned public key.

const crypto = require('node:crypto');

const VERSION = 1;
const CAPABILITY_TTL_MS = 90_000;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MODES = new Set(['disabled', 'paper', 'live']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function parseBool(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'true';
}

function normalizeMode(value) {
  const mode = String(value == null || value === '' ? 'paper' : value).trim().toLowerCase();
  return MODES.has(mode) ? mode : 'disabled';
}

function normalizeAudience(value) {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch {
    return null;
  }
}

function canonicalConfig(config) {
  return JSON.stringify({
    version: config.version,
    mode: config.mode,
    liveTrading: config.liveTrading,
    canStartAgent: config.canStartAgent,
    canStartPaper: config.canStartPaper,
    audience: config.audience,
  });
}

function loadSigningKey(env) {
  const raw = String(env.VALHALLA_EXECUTION_SIGNING_KEY || '').trim();
  if (!raw) return null;
  try {
    let privateKey;
    if (raw.includes('-----BEGIN')) {
      privateKey = crypto.createPrivateKey(raw);
    } else {
      const seed = Buffer.from(raw, 'base64');
      if (seed.length !== 32 && seed.length !== 64) return null;
      privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed.subarray(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      });
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;

    const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const rawPublic = publicDer.subarray(publicDer.length - 32);
    if (rawPublic.length !== 32) return null;

    const expected = String(env.VALHALLA_EXECUTION_PUBLIC_KEY || '').trim();
    if (expected) {
      const expectedBytes = Buffer.from(expected, 'base64');
      if (expectedBytes.length !== 32 || !crypto.timingSafeEqual(expectedBytes, rawPublic)) {
        return null;
      }
    }

    return {
      privateKey,
      publicKey: rawPublic.toString('base64'),
      keyId: sha256(rawPublic).toString('hex').slice(0, 16),
    };
  } catch {
    return null;
  }
}

function resolveState(env = process.env) {
  const requestedMode = normalizeMode(env.VALHALLA_EXECUTION_MODE || 'paper');
  const tradingRequested = parseBool(env.VALHALLA_TRADING_ENABLED);
  const key = loadSigningKey(env);
  let mode = requestedMode;
  let reason = null;

  if (mode === 'live') {
    if (!tradingRequested) {
      mode = 'disabled';
      reason = 'trading_flag_required';
    } else if (!key) {
      mode = 'disabled';
      reason = 'signing_unavailable';
    }
  } else if (mode === 'paper' && tradingRequested) {
    // A live flag with a paper mode is a contradiction. Refuse to guess.
    mode = 'disabled';
    reason = 'mode_conflict';
  }

  const audience = normalizeAudience(
    env.PUBLIC_ORIGIN || env.VALHALLA_PUBLIC_ORIGIN || 'https://valhalla-app.xyz',
  );
  if (!audience) {
    mode = 'disabled';
    reason = 'audience_invalid';
  }

  const config = {
    version: VERSION,
    mode,
    liveTrading: mode === 'live',
    canStartAgent: mode === 'live',
    canStartPaper: mode === 'paper',
    audience,
  };
  config.configHash = sha256(canonicalConfig(config)).toString('hex');

  return {
    config,
    requestedMode,
    tradingRequested,
    reason,
    key,
  };
}

function issueState(state, options = {}) {
  if (!state.key) {
    return {
      available: false,
      config: state.config,
      reason: state.reason || 'signing_unavailable',
    };
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const nonce = options.nonce || crypto.randomBytes(16).toString('hex');
  const capability = {
    version: VERSION,
    mode: state.config.mode,
    liveTrading: state.config.liveTrading,
    canStartAgent: state.config.canStartAgent,
    canStartPaper: state.config.canStartPaper,
    audience: state.config.audience,
    configHash: state.config.configHash,
    keyId: state.key.keyId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CAPABILITY_TTL_MS).toISOString(),
    nonce,
  };
  const payloadBytes = Buffer.from(JSON.stringify(capability), 'utf8');
  const signature = crypto.sign(null, payloadBytes, state.key.privateKey).toString('base64');

  return {
    available: true,
    payload: payloadBytes.toString('base64'),
    signature,
    publicKey: state.key.publicKey,
    keyId: state.key.keyId,
    capability,
  };
}

/**
 * Resolve the effective execution mode and issue one signed capability.
 * Callers must never infer live mode from the environment themselves.
 */
function issue(env = process.env, options = {}) {
  return issueState(resolveState(env), options);
}

/**
 * Public, non-secret execution state for health responses. The `capability`
 * field is the same signed payload the browser gate receives.
 */
function describe(env = process.env, options = {}) {
  const state = resolveState(env);
  const issued = issueState(state, options);
  return {
    mode: state.config.mode,
    requestedMode: state.requestedMode,
    liveTrading: state.config.liveTrading,
    canStartAgent: state.config.canStartAgent,
    canStartPaper: state.config.canStartPaper,
    audience: state.config.audience,
    configHash: state.config.configHash,
    signing: issued.available ? 'available' : 'unavailable',
    publicKey: issued.available ? issued.publicKey : null,
    reason: state.reason || (issued.available ? null : 'signing_unavailable'),
    capability: issued.available
      ? { payload: issued.payload, signature: issued.signature }
      : null,
  };
}

function resolveExecutionConfig(env = process.env) {
  const state = resolveState(env);
  return {
    ...state.config,
    requestedMode: state.requestedMode,
    tradingRequested: state.tradingRequested,
    signing: state.key ? 'available' : 'unavailable',
    reason: state.reason || (state.key ? null : 'signing_unavailable'),
  };
}

module.exports = {
  VERSION,
  CAPABILITY_TTL_MS,
  normalizeMode,
  resolveExecutionConfig,
  resolveState,
  issue,
  describe,
};
