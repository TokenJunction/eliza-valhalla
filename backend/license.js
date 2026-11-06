import { createHash } from "node:crypto";
import { signBytes, verifyBytes } from "./ed25519.js";

export function canonicalLicense(doc) {
  return Buffer.from(JSON.stringify({
    v: 1,
    customerId: String(doc.customerId || ""),
    edition: doc.edition === "pro" ? "pro" : "core",
    workspaceId: String(doc.workspaceId || ""),
    exp: Number(doc.exp) || 0,
    deviceLimit: Number(doc.deviceLimit) || 1,
    workspaceLimit: Number(doc.workspaceLimit) || 1,
    addons: Array.isArray(doc.addons) ? doc.addons.map(String).sort() : [],
  }));
}

export function signLicense(privateKey, doc) {
  const body = canonicalLicense(doc);
  return {
    ...JSON.parse(body.toString("utf8")),
    sig: signBytes(privateKey, body).toString("base64url"),
  };
}

export function verifyLicense(publicKey, token, now = Date.now()) {
  if (!publicKey || !token || !token.sig) return { ok: false, reason: "missing" };
  const body = canonicalLicense(token);
  const signature = Buffer.from(token.sig, "base64url");
  if (!verifyBytes(publicKey, body, signature)) return { ok: false, reason: "tamper" };
  const parsed = JSON.parse(body.toString("utf8"));
  if (parsed.exp < now) return { ok: false, reason: "expired" };
  if (parsed.edition !== "core" && parsed.edition !== "pro") return { ok: false, reason: "edition" };
  return { ok: true, license: parsed };
}

export function entitlements(license) {
  if (!license) {
    return { edition: "core", cloud: false, deviceLimit: 5, workspaceLimit: 1, addons: [] };
  }
  return {
    edition: license.edition,
    cloud: license.edition === "pro",
    deviceLimit: license.deviceLimit,
    workspaceLimit: license.workspaceLimit,
    addons: license.addons,
  };
}

export function deviceId(raw) {
  return createHash("sha256").update(String(raw || "")).digest("hex");
}
