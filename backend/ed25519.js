import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function generateEd25519() {
  return generateKeyPairSync("ed25519");
}

export function toPem(key, type) {
  return key.export({ type, format: "pem" });
}

export function signBytes(privateKey, bytes) {
  return sign(null, bytes, privateKey);
}

export function verifyBytes(publicKey, bytes, signature) {
  try {
    return verify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}

export function publicKeyFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) return null;
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function decodeBase58(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  const bytes = [0];
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros += 1;
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i];
  return out.length === 32 ? out : null;
}
