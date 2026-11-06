/**
 * Google ID-token check and email codes.
 * Secrets stay in the Worker: GOOGLE_CLIENT_ID, DEVICE_COOKIE_SECRET,
 * RESEND_API_KEY and the AUTH_KV id.
 * The code is emailed and stored only as a hash. It is not logged.
 */
import { browserName, codeDecision, needSecondFactor, validEmail } from "./auth-logic.js";

var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"];
var TEXT = new TextEncoder();
var CHAT_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"];
var ENGAGEMENT_EVENTS = [
  "page_view", "paper_start", "paper_pause", "paper_stop", "chat_send",
  "settings_open", "upgrade_open", "load_under_1s", "load_1_3s",
  "load_3_5s", "load_over_5s"
];

function cors(request) {
  var origin = request.headers.get("Origin") || "";
  var allow = ALLOWED.indexOf(origin) >= 0 ? origin : "";
  var headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-credentials": "true",
    vary: "Origin"
  };
  if (allow) headers["access-control-allow-origin"] = allow;
  return headers;
}

function json(body, status, request, extra) {
  var headers = cors(request);
  headers["content-type"] = "application/json";
  if (extra) Object.keys(extra).forEach(function (key) { headers[key] = extra[key]; });
  return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}

function b64url(bytes) {
  var raw = "";
  var list = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (var i = 0; i < list.length; i += 1) raw += String.fromCharCode(list[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(text) {
  var pad = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  while (pad.length % 4) pad += "=";
  var raw = atob(pad);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function sha256(text) {
  var buf = await crypto.subtle.digest("SHA-256", TEXT.encode(String(text)));
  return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, body) {
  var key = await crypto.subtle.importKey("raw", TEXT.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, TEXT.encode(body)));
}

async function issue(secret, payload) {
  var body = b64url(TEXT.encode(JSON.stringify(payload)));
  return body + "." + await hmac(secret, body);
}

async function readToken(secret, token) {
  var parts = String(token || "").split(".");
  if (!secret || parts.length !== 2) return null;
  var expected = await hmac(secret, parts[0]);
  if (!safeEqual(expected, parts[1])) return null;
  try {
    var payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function cookieHeader(request) {
  var raw = request.headers.get("Cookie") || "";
  var hit = raw.split(";").map(function (part) { return part.trim(); }).find(function (part) { return part.indexOf("vh_device=") === 0; });
  return hit ? hit.slice("vh_device=".length) : "";
}

function deviceCookie(token) {
  return "vh_device=" + token + "; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=2592000";
}

async function accountOf(env, emailHash) {
  return JSON.parse((await env.AUTH_KV.get("acct:" + emailHash)) || "null") || { devices: [], ips: [], signins: [], alwaysAsk: false };
}

async function saveAccount(env, emailHash, account) {
  account.devices = (account.devices || []).slice(0, 20);
  account.ips = (account.ips || []).slice(0, 10);
  account.signins = (account.signins || []).slice(0, 20);
  await env.AUTH_KV.put("acct:" + emailHash, JSON.stringify(account));
}

function place(request) {
  var cf = request.cf || {};
  return [cf.city, cf.region, cf.country].filter(Boolean).join(", ") || "an unknown area";
}

function when() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date()) + " ET";
}

function six() {
  var buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
}

async function sendMail(env, to, code, request) {
  var text = [
    "Your Valhalla sign-in code is " + code + ".",
    "",
    "It expires in 10 minutes. You can try 5 times.",
    "Time: " + when(),
    "Place: " + place(request),
    "Browser: " + browserName(request.headers.get("User-Agent")),
    "",
    "If this was not you, secure your account. Valhalla will not ask for a seed phrase."
  ].join("\n");
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    try {
      await env.EMAIL.send({
        to: to,
        from: { email: "noreply@valhalla-app.xyz", name: "Valhalla" },
        subject: "Your Valhalla sign-in code",
        text: text
      });
      return "cloudflare";
    } catch (err) {
      if (!env.RESEND_API_KEY) throw err;
    }
  }
  if (!env.RESEND_API_KEY) return "";
  var response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Valhalla <noreply@valhalla-app.xyz>",
      to: [to],
      subject: "Your Valhalla sign-in code",
      text: text
    })
  });
  if (!response.ok) throw new Error("resend");
  return "resend";
}

async function limited(env, key, max) {
  var count = Number((await env.AUTH_KV.get(key)) || 0);
  if (count >= max) return false;
  await env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

async function startCode(env, email, request, googleVerified) {
  var emailHash = await sha256(email);
  var ip = request.headers.get("CF-Connecting-IP") || "";
  var ipHash = await sha256(ip || "none");
  var hour = new Date().toISOString().slice(0, 13);
  if (!(await limited(env, "rl:e:" + emailHash + ":" + hour, 5))) return { ok: false, error: "rate" };
  if (!(await limited(env, "rl:i:" + ipHash + ":" + hour, 20))) return { ok: false, error: "rate" };
  var code = six();
  var salt = crypto.randomUUID();
  var sent = "";
  try {
    sent = await sendMail(env, email, code, request);
  } catch (err) {
    return { ok: false, error: "email" };
  }
  if (!sent) return { ok: false, error: "email-not-configured" };
  await env.AUTH_KV.put("code:" + emailHash, JSON.stringify({
    salt: salt,
    hash: await sha256(code + ":" + salt + ":" + email),
    attempts: 0,
    googleVerified: googleVerified === true,
    exp: Date.now() + 10 * 60 * 1000
  }), { expirationTtl: 600 });
  return { ok: true };
}

async function checkCode(env, email, code) {
  var emailHash = await sha256(email);
  var key = "code:" + emailHash;
  var record = JSON.parse((await env.AUTH_KV.get(key)) || "null");
  var state = codeDecision(record, Date.now());
  if (state !== "ok") return { ok: false, error: state };
  record.attempts += 1;
  var expected = await sha256(String(code || "") + ":" + record.salt + ":" + email);
  if (!safeEqual(expected, record.hash)) {
    if (record.attempts >= 5) await env.AUTH_KV.delete(key);
    else await env.AUTH_KV.put(key, JSON.stringify(record), { expirationTtl: 600 });
    return { ok: false, error: record.attempts >= 5 ? "locked" : "code" };
  }
  await env.AUTH_KV.delete(key);
  return { ok: true, emailHash: emailHash, googleVerified: record.googleVerified === true };
}

async function sessionFor(env, emailHash, request, codeThisLogin, googleVerified) {
  var account = await accountOf(env, emailHash);
  var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
  var existing = await readToken(env.DEVICE_COOKIE_SECRET, cookieHeader(request));
  var knownDevice = Boolean(existing && existing.eh === emailHash && (account.devices || []).some(function (row) { return row.id === existing.did; }));
  var knownIp = (account.ips || []).indexOf(ipHash) >= 0;
  var need = needSecondFactor({
    knownDevice: knownDevice,
    knownIp: knownIp,
    alwaysAsk: account.alwaysAsk === true,
    leader: false,
    secondFactor: account.secondFactor === false ? false : true,
    codeThisLogin: codeThisLogin === true
  });
  if (need && !codeThisLogin) return { needCode: true, account: account, ipHash: ipHash };
  var did = knownDevice ? existing.did : crypto.randomUUID();
  var now = Date.now();
  var device = (account.devices || []).find(function (row) { return row.id === did; }) || {
    id: did,
    created: now,
    city: place(request),
    browser: browserName(request.headers.get("User-Agent"))
  };
  device.last = now;
  account.devices = [device].concat((account.devices || []).filter(function (row) { return row.id !== did; }));
  if (account.ips.indexOf(ipHash) < 0) account.ips.unshift(ipHash);
  account.signins.unshift({ at: now, city: place(request), browser: device.browser, ok: true });
  await saveAccount(env, emailHash, account);
  var exp = now + 12 * 60 * 60 * 1000;
  var session = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: emailHash,
    did: did,
    exp: exp,
    code: codeThisLogin === true,
    google: googleVerified === true
  });
  var cookie = await issue(env.DEVICE_COOKIE_SECRET, { eh: emailHash, did: did, exp: now + 30 * 24 * 60 * 60 * 1000 });
  return { needCode: false, session: session, cookie: deviceCookie(cookie) };
}

function leaderEmails(env) {
  return [env && env.LEADER_EMAIL, env && env.MASTER_ADMIN_EMAIL]
    .map(function (email) { return String(email || "").trim().toLowerCase(); })
    .filter(function (email, index, emails) { return Boolean(email) && emails.indexOf(email) === index; });
}

async function isLeader(env, session) {
  var emails = leaderEmails(env);
  if (!emails.length || !session || session.code !== true || session.google !== true) return false;
  var hashes = await Promise.all(emails.map(sha256));
  return hashes.some(function (expected) { return safeEqual(String(session.eh || ""), expected); });
}

async function loginRedirect(env, emailHash, googleVerified) {
  var leader = await isLeader(env, { eh: emailHash, code: true, google: googleVerified === true });
  return leader ? "/admin/master-control/" : "/dashboard/analytics/";
}

function bearer(request) {
  var header = request.headers.get("Authorization") || "";
  return header.toLowerCase().indexOf("bearer ") === 0 ? header.slice(7).trim() : "";
}

async function googleInfo(env, credential) {
  var response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!response.ok) return null;
  var info = await response.json();
  var iss = String(info.iss || "");
  var verified = info.email_verified === true || info.email_verified === "true";
  var scope = String(info.scope || "");
  if (info.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return null;
  if (Number(info.exp) * 1000 < Date.now()) return null;
  if (!verified || !validEmail(info.email)) return null;
  if (/gmail|drive/i.test(scope)) return null;
  return { email: String(info.email).toLowerCase(), name: String(info.name || ""), picture: String(info.picture || "") };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (!env.AUTH_KV || !env.DEVICE_COOKIE_SECRET || !env.GOOGLE_CLIENT_ID) {
      return json({ ok: false, error: "auth-not-configured" }, 503, request);
    }
    var url = new URL(request.url);
    var body = request.method === "POST" ? await request.json().catch(function () { return {}; }) : {};
    if (url.pathname === "/auth/google" && request.method === "POST") {
      var info = await googleInfo(env, String(body.credential || ""));
      if (!info) return json({ ok: false, error: "google" }, 401, request);
      var emailHash = await sha256(info.email);
      var account = await accountOf(env, emailHash);
      if (body.alwaysAsk === true) account.alwaysAsk = true;
      await saveAccount(env, emailHash, account);
      var next = await sessionFor(env, emailHash, request, false, true);
      if (next.needCode) {
        var sent = await startCode(env, info.email, request, true);
        if (!sent.ok) return json(sent, sent.error === "rate" ? 429 : 503, request);
        return json({ ok: true, needCode: true, email: info.email, name: info.name, picture: info.picture }, 200, request);
      }
      return json({
        ok: true,
        needCode: false,
        email: info.email,
        name: info.name,
        picture: info.picture,
        session: next.session,
        redirect: await loginRedirect(env, emailHash, true)
      }, 200, request, { "set-cookie": next.cookie });
    }
    if (url.pathname === "/auth/email/start" && request.method === "POST") {
      var email = String(body.email || "").toLowerCase().trim();
      if (!validEmail(email)) return json({ ok: false, error: "email" }, 400, request);
      if (body.alwaysAsk === true) {
        var hash = await sha256(email);
        var existing = await accountOf(env, hash);
        existing.alwaysAsk = true;
        await saveAccount(env, hash, existing);
      }
      var started = await startCode(env, email, request, false);
      return json(started.ok ? { ok: true } : started, started.ok ? 200 : started.error === "rate" ? 429 : 503, request);
    }
    if (url.pathname === "/auth/email/verify" && request.method === "POST") {
      var checkEmail = String(body.email || "").toLowerCase().trim();
      var checked = await checkCode(env, checkEmail, String(body.code || ""));
      if (!checked.ok) return json({ ok: false, error: checked.error }, 401, request);
      var ready = await sessionFor(env, checked.emailHash, request, true, checked.googleVerified);
      return json({
        ok: true,
        needCode: false,
        email: checkEmail,
        session: ready.session,
        redirect: await loginRedirect(env, checked.emailHash, checked.googleVerified)
      }, 200, request, { "set-cookie": ready.cookie });
    }
    if (url.pathname === "/auth/chat-config" && request.method === "GET") {
      var config = JSON.parse((await env.AUTH_KV.get("manager:chat-config")) || "{}");
      var model = CHAT_MODELS.indexOf(config.model) >= 0 ? config.model : CHAT_MODELS[0];
      return json({ provider: "openai", model: model, models: CHAT_MODELS }, 200, request);
    }
    var session = await readToken(env.DEVICE_COOKIE_SECRET, bearer(request));
    if (!session) return json({ ok: false, error: "session" }, 401, request);
    if (url.pathname === "/auth/access" && request.method === "GET") {
      var account = await accountOf(env, session.eh);
      var subscriber = account.plan === "pro";
      var leader = await isLeader(env, session);
      return json({
        ok: true,
        plan: subscriber ? "pro" : "free",
        subscriber: subscriber,
        leader: leader
      }, 200, request);
    }
    if (url.pathname === "/auth/leader" && request.method === "POST") {
      var leader = await isLeader(env, session);
      return json({ ok: true, role: leader ? "leader" : "member" }, 200, request);
    }
    if (url.pathname === "/auth/chat-config" && request.method === "POST") {
      if (!(await isLeader(env, session))) return json({ ok: false, error: "leader-required" }, 403, request);
      var model = String(body.model || "");
      if (CHAT_MODELS.indexOf(model) < 0) return json({ ok: false, error: "unsupported-model" }, 400, request);
      await env.AUTH_KV.put("manager:chat-config", JSON.stringify({
        provider: "openai",
        model: model,
        updatedAt: new Date().toISOString()
      }));
      return json({ ok: true, provider: "openai", model: model }, 200, request);
    }
    if (url.pathname === "/auth/engagement" && request.method === "POST") {
      if (session.code !== true || body.analyticsConsent !== true) {
        return json({ ok: false, error: "analytics-consent-required" }, 403, request);
      }
      var eventName = String(body.event || "");
      if (ENGAGEMENT_EVENTS.indexOf(eventName) < 0) {
        return json({ ok: false, error: "unsupported-event" }, 400, request);
      }
      var day = new Date().toISOString().slice(0, 10);
      var key = "engagement:" + day + ":" + eventName;
      var count = Number(await env.AUTH_KV.get(key)) || 0;
      await env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 691200 });
      return json({ ok: true }, 202, request);
    }
    if (url.pathname === "/auth/engagement" && request.method === "GET") {
      if (!(await isLeader(env, session))) return json({ ok: false, error: "leader-required" }, 403, request);
      var days = [];
      for (var offset = 6; offset >= 0; offset -= 1) {
        var date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
        var row = { date: date };
        for (var i = 0; i < ENGAGEMENT_EVENTS.length; i += 1) {
          var eventName = ENGAGEMENT_EVENTS[i];
          row[eventName] = Number(await env.AUTH_KV.get("engagement:" + date + ":" + eventName)) || 0;
        }
        days.push(row);
      }
      return json({ days: days, approximate: true }, 200, request);
    }
    if (url.pathname === "/auth/devices" && request.method === "GET") {
      var account = await accountOf(env, session.eh);
      return json({
        ok: true,
        alwaysAsk: account.alwaysAsk === true,
        secondFactor: account.secondFactor !== false,
        devices: (account.devices || []).map(function (row) {
          return { id: row.id, city: row.city, browser: row.browser, created: row.created, last: row.last, current: row.id === session.did };
        }),
        signins: account.signins || []
      }, 200, request);
    }
    if (url.pathname === "/auth/devices/revoke" && request.method === "POST") {
      var account = await accountOf(env, session.eh);
      account.devices = (account.devices || []).filter(function (row) { return row.id !== String(body.id || ""); });
      await saveAccount(env, session.eh, account);
      await env.AUTH_KV.delete("device:" + String(body.id || ""));
      return json({ ok: true }, 200, request);
    }
    if (url.pathname === "/auth/security" && request.method === "POST") {
      var account = await accountOf(env, session.eh);
      if (Object.prototype.hasOwnProperty.call(body, "alwaysAsk")) account.alwaysAsk = body.alwaysAsk === true;
      if (typeof body.secondFactor === "boolean") account.secondFactor = body.secondFactor;
      await saveAccount(env, session.eh, account);
      return json({
        ok: true,
        alwaysAsk: account.alwaysAsk === true,
        secondFactor: account.secondFactor !== false
      }, 200, request);
    }
    return json({ ok: false, error: "not-found" }, 404, request);
  }
};
