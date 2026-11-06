import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(secret, raw, alg) {
  return createHmac(alg, secret).update(raw).digest("hex");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function acceptEvent(seen, event, now) {
  if (!event || !event.id || !Number.isFinite(Number(event.at))) return { ok: false, reason: "missing" };
  if (seen.has(event.id)) return { ok: false, reason: "replay" };
  if (Math.abs(now - Number(event.at)) > 5 * 60 * 1000) return { ok: false, reason: "stale" };
  seen.set(event.id, now);
  return { ok: true };
}

export function verifyWebhook(provider, secret, raw, header) {
  if (!secret) return false;
  if (provider === "lemonsqueezy") return safeEqual(header, hmacHex(secret, raw, "sha256"));
  if (provider === "nowpayments") return safeEqual(header, hmacHex(secret, raw, "sha512"));
  if (provider === "coinbase") return safeEqual(header, hmacHex(secret, raw, "sha256"));
  return false;
}
