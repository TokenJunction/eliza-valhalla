import { createHmac, timingSafeEqual } from "node:crypto";

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function envEmail(env, name) {
  return normalizeEmail(env && env[name]);
}

export function resolveRoot(env, setup) {
  const factory = String(env && env.VALHALLA_FACTORY) === "1";
  const factoryEmail = envEmail(env, "MASTER_ADMIN_EMAIL");
  if (factory) return factoryEmail || null;
  const customer = envEmail(env, "CUSTOMER_ADMIN_EMAIL");
  if (customer) return customer === factoryEmail ? null : customer;
  const captured = normalizeEmail(setup && setup.rootEmail);
  if (!captured || captured === factoryEmail) return null;
  return captured;
}

export function isRoot(email, env, setup) {
  const root = resolveRoot(env, setup);
  if (!root) return false;
  return normalizeEmail(email) === root;
}

export function issueSession(secret, email, now = Date.now()) {
  if (!secret) throw new Error("SESSION_SECRET is required");
  const body = Buffer.from(JSON.stringify({
    email: normalizeEmail(email),
    exp: now + 12 * 60 * 60 * 1000,
  })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readSession(secret, token, now = Date.now()) {
  if (!secret || !token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.email || Number(payload.exp) < now) return null;
    return normalizeEmail(payload.email);
  } catch {
    return null;
  }
}

export function bearer(req) {
  const header = req.headers.authorization || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}
