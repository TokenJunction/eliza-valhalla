import { EventEmitter } from "node:events";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { signBytes, verifyBytes } from "./ed25519.js";

function signedBody(envelope) {
  return Buffer.from(JSON.stringify({
    v: 1,
    channel: envelope.channel,
    recipient: envelope.recipient,
    session: envelope.session ?? "",
    serviceState: envelope.serviceState ?? "",
    exp: envelope.exp,
    nonce: envelope.nonce,
    payload: envelope.payload,
  }));
}

function privateKeyFromPem(pem) {
  return createPrivateKey(pem);
}

function publicKeyFromPem(pem) {
  return createPublicKey(pem);
}

export function createBus({ privateKey, publicKey, redis = null } = {}) {
  const local = new EventEmitter();
  const seen = new Set();
  local.setMaxListeners(50);

  function seal(channel, payload, extra = {}) {
    if (!privateKey) return { error: "signing-unavailable" };
    const envelope = {
      v: 1,
      channel,
      recipient: String(extra.recipient || channel),
      session: String(extra.session || ""),
      serviceState: String(extra.serviceState || ""),
      exp: Number(extra.exp) || Date.now() + 30_000,
      nonce: String(extra.nonce || randomUUID()),
      payload,
    };
    const sig = signBytes(privateKey, signedBody(envelope)).toString("base64url");
    return { ...envelope, sig, pqAlg: null, pqSig: null };
  }

  function open(envelope, key = publicKey) {
    if (!envelope || envelope.v !== 1 || !key) return false;
    if (envelope.pqAlg != null || envelope.pqSig != null) return false;
    if (!envelope.recipient || !envelope.nonce || !Number.isFinite(Number(envelope.exp))) return false;
    if (Number(envelope.exp) < Date.now()) return false;
    if (seen.has(envelope.nonce)) return false;
    const ok = verifyBytes(key, signedBody(envelope), Buffer.from(envelope.sig || "", "base64url"));
    if (!ok) return false;
    seen.add(envelope.nonce);
    return true;
  }

  async function publish(channel, payload, extra) {
    const envelope = seal(channel, payload, extra);
    if (envelope.error) return envelope;
    if (redis) await redis.publish(channel, JSON.stringify(envelope));
    else local.emit(channel, envelope);
    return envelope;
  }

  function subscribe(channel, handler) {
    if (redis && redis.subscribe) return redis.subscribe(channel, handler);
    local.on(channel, handler);
    return () => local.off(channel, handler);
  }

  return { publish, subscribe, open, seal, mode: redis ? "redis" : "local" };
}

export { privateKeyFromPem, publicKeyFromPem };
