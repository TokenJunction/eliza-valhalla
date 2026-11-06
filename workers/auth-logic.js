/** Pure sign-in rules. No secrets and no codes. */

export function needSecondFactor(input) {
  if (input && input.secondFactor === false) return false;
  return !input || input.codeThisLogin !== true;
}

export function codeDecision(record, now) {
  if (!record) return "missing";
  if (Number(record.exp) < now) return "expired";
  if (Number(record.attempts) >= 5) return "locked";
  return "ok";
}

export function browserName(ua) {
  var text = String(ua || "");
  if (text.indexOf("Edg/") >= 0) return "Edge";
  if (text.indexOf("Chrome/") >= 0) return "Chrome";
  if (text.indexOf("Firefox/") >= 0) return "Firefox";
  if (text.indexOf("Safari/") >= 0) return "Safari";
  return "a browser";
}

export function maskEmail(email) {
  var parts = String(email || "").toLowerCase().split("@");
  if (parts.length !== 2 || parts[0].length < 1 || parts[1].indexOf(".") < 0) return "your email";
  return parts[0].slice(0, 1) + "***@" + parts[1];
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").toLowerCase());
}
