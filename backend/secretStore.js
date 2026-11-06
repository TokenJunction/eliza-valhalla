import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SECRET_KEY = /key|secret|token|password/i;

export function redact(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|secret|token|password)"?\s*[:=]\s*"?[^"\s,}]*/gi, "$1=[redacted]");
}

export function encryptSecret(master, plaintext) {
  if (!master) throw new Error("SETUP_MASTER_KEY is required");
  const key = createHash("sha256").update(String(master)).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(master, packed) {
  const key = createHash("sha256").update(String(master)).digest();
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function publicConfig(config) {
  return JSON.parse(JSON.stringify(config, (key, value) => {
    if (SECRET_KEY.test(key)) return undefined;
    if (typeof value === "string" && /^(sk-|Bearer )/.test(value)) return undefined;
    return value;
  }));
}

export function secretFlags(ids) {
  const flags = {};
  for (const id of ids) flags[id] = true;
  return flags;
}
