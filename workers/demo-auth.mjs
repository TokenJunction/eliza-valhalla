/**
 * Preview demo password check.
 * The verifier is PBKDF2-SHA-256. Workers WebCrypto provides PBKDF2.
 * It does not provide scrypt or a PAKE. This file has no password.
 */
export var PBKDF2_ITERATIONS = 310000;
export var SALT_BYTES = 16;
export var DEMO_FAILS = 5;
export var DEMO_LOCK_MS = 15 * 60 * 1000;

var USERNAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export function normalizeUsername(value) {
  var text = String(value || "").trim().toLowerCase();
  if (text.indexOf("@") >= 0) return "";
  return USERNAME.test(text) ? text : "";
}

export function demoMailbox(username) {
  return "demo-auth:" + normalizeUsername(username);
}

export function demoIdentity(emailHash) {
  return "demo:" + String(emailHash || "");
}

export function demoConfigured(env) {
  if (!env || env.DEMO_PASSWORD) return false;
  if (env.DEMO_AUTH_MODE !== "preview" || env.AUTH_PREVIEW !== "1") return false;
  var username = normalizeUsername(env.DEMO_USERNAME);
  if (!username) return false;
  return parseVerifier(env.DEMO_VERIFIER) !== null;
}

function bytesToB64(bytes) {
  var raw = "";
  for (var i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64ToBytes(text) {
  var pad = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+$/.test(pad)) return null;
  while (pad.length % 4) pad += "=";
  var raw = atob(pad);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function safeEqualBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function parseVerifier(verifier) {
  var parts = String(verifier || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  var rounds = Number(parts[1]);
  if (!Number.isInteger(rounds) || rounds < PBKDF2_ITERATIONS || rounds > 2000000) return null;
  var salt = b64ToBytes(parts[2]);
  var expect = b64ToBytes(parts[3]);
  if (!salt || salt.length < SALT_BYTES || !expect || expect.length !== 32) return null;
  return { rounds: rounds, salt: salt, expect: expect };
}

async function pbkdf2(password, salt, rounds) {
  var key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  var bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: salt,
    iterations: rounds
  }, key, 256);
  return new Uint8Array(bits);
}

export async function createVerifier(password, iterations) {
  var rounds = Number(iterations || PBKDF2_ITERATIONS);
  if (!Number.isInteger(rounds) || rounds < PBKDF2_ITERATIONS) throw new Error("iterations");
  if (String(password || "").length < 10) throw new Error("password");
  var salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  var hash = await pbkdf2(password, salt, rounds);
  return "pbkdf2-sha256$" + rounds + "$" + bytesToB64(salt) + "$" + bytesToB64(hash);
}

export async function verifyPassword(password, verifier) {
  var parsed = parseVerifier(verifier);
  if (!parsed) return false;
  var actual = await pbkdf2(password, parsed.salt, parsed.rounds);
  return safeEqualBytes(actual, parsed.expect);
}
