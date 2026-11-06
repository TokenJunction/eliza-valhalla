const SECRET = /sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key\s*[:=]\s*\S+/i;
const KEY_LABEL = /private key|seed phrase|secret key/i;
const LONG_KEY = /[1-9A-HJ-NP-Za-km-z]{64,}/;

export function inspectPrompt(text) {
  const value = String(text || "");
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const seed = words.length >= 12 && words.length <= 24 && words.every((word) => /^[a-z]+$/.test(word));
  const flags = [];
  if (SECRET.test(value)) flags.push("credential");
  if (KEY_LABEL.test(value)) flags.push("key-label");
  if (LONG_KEY.test(value)) flags.push("long-key");
  if (seed) flags.push("seed-phrase");
  return { ok: flags.length === 0, flags, text: value.slice(0, 4000) };
}
