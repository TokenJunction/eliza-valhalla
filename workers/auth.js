/**
 * Sign-in worker.
 * AUTH_KV stays. Chat configuration, engagement counts, and rate limits use it.
 * Do not remove AUTH_KV from the current deployment.
 * Sessions, login codes, nonces, and the account record use AUTH_DO.
 * Call env.AUTH_DO.get(id), then call the method on that stub.
 * The class has no fetch route.
 */
import { browserName, needSecondFactor, validEmail } from "./auth-logic.js";
import { AuthDurableObject } from "./auth-durable-object.mjs";
import { demoConfigured, demoIdentity, demoMailbox, normalizeUsername, verifyPassword } from "./demo-auth.mjs";

export { AuthDurableObject };

var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"];
var CALLBACKS = {
  "https://valhalla-app.xyz": "https://valhalla-app.xyz/app/",
  "https://www.valhalla-app.xyz": "https://www.valhalla-app.xyz/app/"
};
var SUPABASE_ORIGIN = "https://girltjnrrwlyeufrcors.supabase.co";
var USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var TEXT = new TextEncoder();
var CHAT_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"];
var ENGAGEMENT_EVENTS = [
  "page_view", "paper_start", "paper_pause", "paper_stop", "chat_send",
  "settings_open", "upgrade_open", "load_under_1s", "load_1_3s",
  "load_3_5s", "load_over_5s"
];
var SENDER_CODES = {
  E_SENDER_NOT_VERIFIED: true,
  E_SENDER_DOMAIN_NOT_AVAILABLE: true,
  E_RECIPIENT_NOT_ALLOWED: true,
  E_VALIDATION_ERROR: true,
  E_HEADER_VALUE_INVALID: true
};

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

function randomHex(bytes) {
  var buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  var out = "";
  for (var i = 0; i < buf.length; i += 1) out += buf[i].toString(16).padStart(2, "0");
  return out;
}

async function readClaims(secret, token) {
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

function storeReady(env) {
  return Boolean(env && env.AUTH_DO && typeof env.AUTH_DO.get === "function" && typeof env.AUTH_DO.idFromName === "function");
}

function accountStub(env, name) {
  if (!storeReady(env) || !name) return null;
  return env.AUTH_DO.get(env.AUTH_DO.idFromName(String(name)));
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

function mailer(env) {
  if (env.AUTH_EMAIL && typeof env.AUTH_EMAIL.send === "function") return env.AUTH_EMAIL;
  if (env.EMAIL && typeof env.EMAIL.send === "function") return env.EMAIL;
  return null;
}

function senderCode(err, result) {
  var code = String((err && err.code) || (result && result.code) || "");
  if (SENDER_CODES[code]) return code;
  var status = String((result && result.status) || "");
  if (status === "rejected") return "rejected";
  var message = String((err && err.message) || (result && result.error) || "");
  if (/sender|domain|not verified|not allowed/i.test(message)) return code || "rejected";
  return "";
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
  var binding = mailer(env);
  if (binding) {
    try {
      var result = await binding.send({
        to: to,
        from: { email: "noreply@valhalla-app.xyz", name: "Valhalla" },
        subject: "Your Valhalla sign-in code",
        text: text
      });
      var rejected = senderCode(null, result);
      if (rejected) return { ok: false, error: "email-sender-rejected", reason: rejected };
      if (result && result.messageId) return { ok: true, via: "cloudflare" };
      if (result == null) return { ok: true, via: "cloudflare" };
      return { ok: false, error: "email-sender-rejected", reason: "empty" };
    } catch (err) {
      var reason = senderCode(err, null);
      if (reason) return { ok: false, error: "email-sender-rejected", reason: reason };
      if (!env.RESEND_API_KEY) return { ok: false, error: "email", reason: "send" };
    }
  }
  if (!env.RESEND_API_KEY) return { ok: false, error: "email-not-configured" };
  try {
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
    if (!response.ok) return { ok: false, error: "email" };
    return { ok: true, via: "resend" };
  } catch (err) {
    return { ok: false, error: "email" };
  }
}

async function limited(env, key, max) {
  var count = Number((await env.AUTH_KV.get(key)) || 0);
  if (count >= max) return false;
  await env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

async function bindGoogleUser(env, uid, emailHash) {
  var lock = accountStub(env, "uid:" + uid);
  if (!lock) return false;
  return (await lock.bindHuman(uid, { eh: emailHash, provider: "google" })) === true;
}

async function startCode(env, email, request, googleVerified, uid) {
  var emailHash = await sha256(email);
  var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
  var hour = new Date().toISOString().slice(0, 13);
  if (!(await limited(env, "rl:e:" + emailHash + ":" + hour, 5))) return { ok: false, error: "rate" };
  if (!(await limited(env, "rl:i:" + ipHash + ":" + hour, 20))) return { ok: false, error: "rate" };
  var stub = accountStub(env, emailHash);
  if (!stub) return { ok: false, error: "auth-store-disabled" };
  if (googleVerified === true && !(await bindGoogleUser(env, uid, emailHash))) return { ok: false, error: "google" };
  var code = six();
  var salt = crypto.randomUUID();
  var saved = await stub.putCode({
    eh: emailHash,
    hash: await sha256(code + ":" + salt + ":" + email),
    salt: salt,
    exp: Date.now() + 10 * 60 * 1000,
    googleVerified: googleVerified === true,
    uid: uid || "",
    hint: ""
  });
  if (!saved || saved.ok !== true) return { ok: false, error: (saved && saved.error) || "auth-store-disabled" };
  var mailed = await sendMail(env, email, code, request);
  if (!mailed.ok) {
    await stub.consumeCode({ eh: emailHash, drop: true });
    return mailed;
  }
  return { ok: true };
}

async function checkCode(env, email, presented) {
  var emailHash = await sha256(String(email || "").toLowerCase().trim());
  var stub = accountStub(env, emailHash);
  if (!stub) return { ok: false, error: "auth-store-disabled" };
  var result = await stub.consumeCode({ eh: emailHash, email: email, presented: presented });
  if (result === false) return { ok: false, error: "eh" };
  return result || { ok: false, error: "missing" };
}

async function storedSession(env, claims) {
  if (!claims || !claims.eh) return null;
  var stub = accountStub(env, claims.eh);
  if (!stub) return null;
  try {
    var row = await stub.readSession(claims);
    if (!row || row.eh !== claims.eh) return null;
    return row;
  } catch (err) {
    return null;
  }
}

async function accessSession(env, request) {
  var claims = await readClaims(env.DEVICE_COOKIE_SECRET, bearer(request));
  var row = await storedSession(env, claims);
  if (!row || row.use !== "access") return null;
  return row;
}

async function sessionFor(env, emailHash, request, codeThisLogin, googleVerified, uid) {
  var stub = accountStub(env, emailHash);
  if (!stub) return { disabled: true, error: "auth-store-disabled" };
  var account = await stub.getAccount(emailHash);
  if (!account || account.eh !== emailHash) return { disabled: true, error: "eh" };
  var deviceClaims = await readClaims(env.DEVICE_COOKIE_SECRET, cookieHeader(request));
  var deviceRow = deviceClaims && deviceClaims.eh === emailHash ? await storedSession(env, deviceClaims) : null;
  var known = null;
  var revoked = false;
  (account.devices || []).forEach(function (device) {
    if (!deviceClaims || device.id !== deviceClaims.did) return;
    if (device.revoked === true) revoked = true;
    else known = device;
  });
  var knownDevice = Boolean(known && deviceRow && deviceRow.use === "device" && deviceRow.did === known.id);
  var configured = leaderEmail(env);
  var leader = Boolean(configured) && safeEqual(emailHash, await sha256(configured));
  var need = needSecondFactor({
    knownDevice: knownDevice,
    alwaysAsk: account.alwaysAsk === true,
    leader: leader,
    revoked: revoked,
    baseVerified: googleVerified === true || codeThisLogin === true,
    codeThisLogin: codeThisLogin === true
  });
  if (need && codeThisLogin !== true) return { needCode: true };
  if (googleVerified === true && !USER_ID.test(String(uid || ""))) return { disabled: true, error: "uid" };
  if (googleVerified === true && !(await bindGoogleUser(env, uid, emailHash))) return { disabled: true, error: "google" };
  var did = knownDevice ? known.id : crypto.randomUUID();
  var now = Date.now();
  var device = known || {
    id: did,
    created: now,
    city: place(request),
    browser: browserName(request.headers.get("User-Agent")),
    revoked: false
  };
  device.last = now;
  device.revoked = false;
  device.accessSid = crypto.randomUUID();
  device.cookieSid = crypto.randomUUID();
  account.devices = [device].concat((account.devices || []).filter(function (row) { return row.id !== did; }));
  var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
  if ((account.ips || []).indexOf(ipHash) < 0) account.ips.unshift(ipHash);
  account.signins.unshift({ at: now, city: place(request), browser: device.browser, ok: true });
  var accessExp = now + 12 * 60 * 60 * 1000;
  var cookieExp = now + 30 * 24 * 60 * 60 * 1000;
  var accessUid = googleVerified === true ? uid : "";
  var saved = await stub.putSession({
    eh: emailHash,
    account: account,
    sessions: [
      {
        sid: device.accessSid,
        eh: emailHash,
        uid: accessUid,
        did: did,
        exp: accessExp,
        v: 1,
        code: codeThisLogin === true,
        google: googleVerified === true,
        use: "access"
      },
      {
        sid: device.cookieSid,
        eh: emailHash,
        uid: "",
        did: did,
        exp: cookieExp,
        v: 1,
        code: false,
        google: false,
        use: "device"
      }
    ]
  });
  if (!saved || saved.ok !== true) return { disabled: true, error: (saved && saved.error) || "auth-store-disabled" };
  var session = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: emailHash,
    uid: accessUid,
    did: did,
    exp: accessExp,
    code: codeThisLogin === true,
    google: googleVerified === true,
    sid: device.accessSid,
    sv: 1,
    use: "access"
  });
  var cookie = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: emailHash,
    uid: "",
    did: did,
    exp: cookieExp,
    code: false,
    google: false,
    sid: device.cookieSid,
    sv: 1,
    use: "device"
  });
  return { needCode: false, session: session, cookie: deviceCookie(cookie) };
}

function leaderEmail(env) {
  return String(env && env.LEADER_EMAIL ? env.LEADER_EMAIL : "").trim().toLowerCase();
}

async function isLeader(env, session) {
  if (!session || session.role === "demo") return false;
  var email = leaderEmail(env);
  if (!email || session.code !== true || session.google !== true) return false;
  var expected = await sha256(email);
  return safeEqual(String(session.eh || ""), expected);
}

async function loginRedirect(env, emailHash, googleVerified, codeVerified) {
  var leader = await isLeader(env, { eh: emailHash, code: codeVerified === true, google: googleVerified === true });
  return leader ? "/admin/master-control/" : "/dashboard/analytics/";
}

function bearer(request) {
  var header = request.headers.get("Authorization") || "";
  return header.toLowerCase().indexOf("bearer ") === 0 ? header.slice(7).trim() : "";
}

function callbackFor(request) {
  return CALLBACKS[request.headers.get("Origin") || ""] || "";
}

function supabaseOrigin(env) {
  var configured = String(env && env.SUPABASE_URL || "").replace(/\/$/, "");
  if (configured !== SUPABASE_ORIGIN) return "";
  return SUPABASE_ORIGIN;
}

function googleAccount(user) {
  if (!user || typeof user !== "object") return null;
  var id = String(user.id || "");
  if (!USER_ID.test(id)) return null;
  var email = String(user.email || "").toLowerCase().trim();
  if (!validEmail(email)) return null;
  var meta = user.app_metadata || {};
  var identities = Array.isArray(user.identities) ? user.identities : [];
  var googleIdentity = identities.find(function (row) { return row && row.provider === "google"; });
  var providers = Array.isArray(meta.providers) ? meta.providers : [];
  var google = meta.provider === "google" || providers.indexOf("google") >= 0 || Boolean(googleIdentity);
  if (!google) return null;
  if (identities.length && !googleIdentity) return null;
  if (googleIdentity && googleIdentity.identity_data && googleIdentity.identity_data.email_verified === false) return null;
  var profile = user.user_metadata || {};
  return {
    id: id,
    email: email,
    name: String(profile.full_name || profile.name || ""),
    picture: String(profile.avatar_url || profile.picture || "")
  };
}

async function supabaseUser(env, accessToken) {
  var origin = supabaseOrigin(env);
  if (!origin || !env.SUPABASE_ANON_KEY || !accessToken) return { ok: false, error: "auth-not-configured", status: 503 };
  var timeout = Number(env.SUPABASE_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout < 50 || timeout > 5000) timeout = 4000;
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeout);
  try {
    var response = await fetch(origin + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, authorization: "Bearer " + accessToken },
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, error: "google", status: 401 };
    var account = googleAccount(await response.json());
    if (!account) return { ok: false, error: "google", status: 401 };
    return { ok: true, user: account };
  } catch (err) {
    return { ok: false, error: "supabase", status: 503 };
  } finally {
    clearTimeout(timer);
  }
}

async function issueNonce(env) {
  var nonce = randomHex(32);
  var stub = accountStub(env, "nonce:" + nonce);
  if (!stub) return "";
  var saved = await stub.putCode(nonce);
  return saved === true ? nonce : "";
}

async function takeNonce(env, nonce) {
  var value = String(nonce || "");
  if (!/^[0-9a-f]{64}$/.test(value)) return false;
  var stub = accountStub(env, "nonce:" + value);
  if (!stub) return false;
  return (await stub.consumeCode(value)) === true;
}

function mailStatus(error) {
  if (error === "rate") return 429;
  return 503;
}

async function demoLogin(request, env, body) {
  var username = normalizeUsername(body && body.username);
  var password = String(body && body.password || "");
  var configured = normalizeUsername(env.DEMO_USERNAME);
  var now = Date.now();
  var ip = request.headers.get("CF-Connecting-IP") || "none";
  var ipStub = accountStub(env, "demo-ip:" + await sha256(ip));
  var userStub = accountStub(env, "demo-user:" + await sha256(username || "invalid"));
  if (!ipStub || !userStub) return json({ ok: false, error: "denied" }, 401, request);
  var ipState = await ipStub.demoStrike("check", now);
  var userState = await userStub.demoStrike("check", now);
  var passwordOk = false;
  try {
    passwordOk = await verifyPassword(password, env.DEMO_VERIFIER);
  } catch (err) {
    passwordOk = false;
  }
  var nameOk = Boolean(username) && username.length === configured.length && safeEqual(username, configured);
  if (!passwordOk || !nameOk || ipState.locked || userState.locked) {
    if (!ipState.locked) await ipStub.demoStrike("fail", now);
    if (!userState.locked) await userStub.demoStrike("fail", now);
    return json({ ok: false, error: "denied" }, 401, request);
  }
  await ipStub.demoStrike("clear", now);
  await userStub.demoStrike("clear", now);
  var eh = await sha256(demoMailbox(configured));
  var stub = accountStub(env, eh);
  if (!stub) return json({ ok: false, error: "denied" }, 401, request);
  var did = crypto.randomUUID();
  var accessSid = crypto.randomUUID();
  var cookieSid = crypto.randomUUID();
  var browser = browserName(request.headers.get("User-Agent"));
  var city = place(request);
  var accessExp = now + 12 * 60 * 60 * 1000;
  var cookieExp = now + 30 * 24 * 60 * 60 * 1000;
  var saved = await stub.putSession({
    eh: eh,
    single: true,
    account: {
      devices: [{ id: did, created: now, last: now, city: city, browser: browser, revoked: false }],
      ips: [],
      signins: [{ at: now, city: city, browser: browser, ok: true }],
      alwaysAsk: false,
      role: "demo",
      demoId: demoIdentity(eh),
      plan: "pro"
    },
    sessions: [
      { sid: accessSid, eh: eh, uid: "", did: did, exp: accessExp, v: 1, code: false, google: false, use: "access" },
      { sid: cookieSid, eh: eh, uid: "", did: did, exp: cookieExp, v: 1, code: false, google: false, use: "device" }
    ]
  });
  if (!saved || saved.ok !== true) return json({ ok: false, error: "denied" }, 401, request);
  var session = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: eh, uid: "", did: did, exp: accessExp, code: false, google: false, sid: accessSid, sv: 1, use: "access", role: "demo"
  });
  var cookie = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: eh, uid: "", did: did, exp: cookieExp, code: false, google: false, sid: cookieSid, sv: 1, use: "device", role: "demo"
  });
  return json({
    ok: true,
    needCode: false,
    role: "demo",
    username: configured,
    session: session,
    redirect: "/dashboard/analytics/"
  }, 200, request, { "set-cookie": deviceCookie(cookie) });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (!env.AUTH_KV || !env.DEVICE_COOKIE_SECRET || !env.GOOGLE_CLIENT_ID) {
      return json({ ok: false, error: "auth-not-configured" }, 503, request);
    }
    var url = new URL(request.url);
    var body = request.method === "POST" ? await request.json().catch(function () { return {}; }) : {};
    if (url.pathname === "/auth/supabase" && request.method === "GET") {
      if (!storeReady(env)) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      var callback = callbackFor(request);
      if (!callback) return json({ ok: false, error: "callback" }, 403, request);
      var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
      var hour = new Date().toISOString().slice(0, 13);
      if (!(await limited(env, "rl:n:" + ipHash + ":" + hour, 30))) return json({ ok: false, error: "rate" }, 429, request);
      var nonce = await issueNonce(env);
      if (!nonce) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      return json({ ok: true, callback: callback, nonce: nonce, stateSupported: false }, 200, request);
    }
    if (url.pathname === "/auth/supabase" && request.method === "POST") {
      if (!storeReady(env)) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      if (body.email && !body.accessToken) return json({ ok: false, error: "incomplete" }, 400, request);
      if (body.provider === "google" && !body.accessToken) return json({ ok: false, error: "incomplete" }, 400, request);
      var postedCallback = callbackFor(request);
      if (!postedCallback || body.callback !== postedCallback) return json({ ok: false, error: "callback" }, 400, request);
      if (!(await takeNonce(env, body.nonce))) return json({ ok: false, error: "nonce" }, 401, request);
      var looked = await supabaseUser(env, String(body.accessToken || ""));
      if (!looked.ok) return json({ ok: false, error: looked.error }, looked.status || 401, request);
      var user = looked.user;
      var supabaseHash = await sha256(user.email);
      var supabaseNext = await sessionFor(env, supabaseHash, request, false, true, user.id);
      if (supabaseNext.disabled) return json({ ok: false, error: supabaseNext.error || "auth-store-disabled" }, 503, request);
      if (supabaseNext.needCode) {
        var mailed = await startCode(env, user.email, request, true, user.id);
        if (!mailed.ok) return json(mailed, mailStatus(mailed.error), request);
        return json({
          ok: true,
          needCode: true,
          email: user.email,
          name: user.name,
          picture: user.picture
        }, 200, request);
      }
      return json({
        ok: true,
        needCode: false,
        email: user.email,
        name: user.name,
        picture: user.picture,
        session: supabaseNext.session,
        redirect: await loginRedirect(env, supabaseHash, true, false)
      }, 200, request, { "set-cookie": supabaseNext.cookie });
    }
    if (url.pathname === "/auth/google" && request.method === "POST") {
      return json({ ok: false, error: "incomplete" }, 400, request);
    }
    if (url.pathname === "/auth/demo" && request.method === "POST") {
      if (!demoConfigured(env) || !storeReady(env)) return json({ ok: false, error: "not-found" }, 404, request);
      return demoLogin(request, env, body);
    }
    if (url.pathname === "/auth/email/start" && request.method === "POST") {
      if (!storeReady(env)) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      var email = String(body.email || "").toLowerCase().trim();
      if (!validEmail(email)) return json({ ok: false, error: "email" }, 400, request);
      if (body.alwaysAsk === true) {
        var hash = await sha256(email);
        var stub = accountStub(env, hash);
        var existing = stub ? await stub.getAccount(hash) : null;
        if (!existing) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
        existing.alwaysAsk = true;
        var kept = await stub.saveAccount(hash, existing);
        if (!kept || kept.ok !== true) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      }
      var started = await startCode(env, email, request, false, "");
      return json(started.ok ? { ok: true } : started, started.ok ? 200 : mailStatus(started.error), request);
    }
    if (url.pathname === "/auth/email/verify" && request.method === "POST") {
      if (!storeReady(env)) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      var checkEmail = String(body.email || "").toLowerCase().trim();
      var checked = await checkCode(env, checkEmail, String(body.code || ""));
      if (!checked.ok) return json({ ok: false, error: checked.error }, 401, request);
      var ready = await sessionFor(env, checked.eh, request, true, checked.googleVerified === true, checked.uid || "");
      if (ready.disabled) return json({ ok: false, error: ready.error || "auth-store-disabled" }, 503, request);
      if (ready.needCode) return json({ ok: false, error: "incomplete" }, 409, request);
      return json({
        ok: true,
        needCode: false,
        email: checkEmail,
        session: ready.session,
        redirect: await loginRedirect(env, checked.eh, checked.googleVerified === true, true)
      }, 200, request, { "set-cookie": ready.cookie });
    }
    if (url.pathname === "/auth/chat-config" && request.method === "GET") {
      var config = JSON.parse((await env.AUTH_KV.get("manager:chat-config")) || "{}");
      var model = CHAT_MODELS.indexOf(config.model) >= 0 ? config.model : CHAT_MODELS[0];
      return json({ provider: "openai", model: model, models: CHAT_MODELS }, 200, request);
    }
    var session = await accessSession(env, request);
    if (!session) return json({ ok: false, error: "session" }, 401, request);
    if (url.pathname === "/auth/access" && request.method === "GET") {
      var accessStub = accountStub(env, session.eh);
      var accessAccount = accessStub ? await accessStub.getAccount(session.eh) : null;
      if (!accessAccount || accessAccount.eh !== session.eh) return json({ ok: false, error: "session" }, 401, request);
      var demoAccount = session.role === "demo" || accessAccount.role === "demo";
      var subscriber = demoAccount ? false : accessAccount.plan === "pro";
      var accessLeader = demoAccount ? false : await isLeader(env, session);
      return json({
        ok: true,
        plan: subscriber ? "pro" : "free",
        subscriber: subscriber,
        leader: accessLeader
      }, 200, request);
    }
    if (url.pathname === "/auth/leader" && request.method === "POST") {
      var leader = await isLeader(env, session);
      return json({ ok: true, role: leader ? "leader" : "member" }, 200, request);
    }
    if (url.pathname === "/auth/chat-config" && request.method === "POST") {
      if (!(await isLeader(env, session))) return json({ ok: false, error: "leader-required" }, 403, request);
      var chosen = String(body.model || "");
      if (CHAT_MODELS.indexOf(chosen) < 0) return json({ ok: false, error: "unsupported-model" }, 400, request);
      await env.AUTH_KV.put("manager:chat-config", JSON.stringify({
        provider: "openai",
        model: chosen,
        updatedAt: new Date().toISOString()
      }));
      return json({ ok: true, provider: "openai", model: chosen }, 200, request);
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
          var name = ENGAGEMENT_EVENTS[i];
          row[name] = Number(await env.AUTH_KV.get("engagement:" + date + ":" + name)) || 0;
        }
        days.push(row);
      }
      return json({ days: days, approximate: true }, 200, request);
    }
    if (url.pathname === "/auth/devices" && request.method === "GET") {
      var deviceStub = accountStub(env, session.eh);
      var deviceAccount = deviceStub ? await deviceStub.getAccount(session.eh) : null;
      if (!deviceAccount || deviceAccount.eh !== session.eh) return json({ ok: false, error: "session" }, 401, request);
      return json({
        ok: true,
        alwaysAsk: deviceAccount.alwaysAsk === true,
        devices: (deviceAccount.devices || []).filter(function (row) { return row.revoked !== true; }).map(function (row) {
          return { id: row.id, city: row.city, browser: row.browser, created: row.created, last: row.last, current: row.id === session.did };
        }),
        signins: deviceAccount.signins || []
      }, 200, request);
    }
    if (url.pathname === "/auth/devices/revoke" && request.method === "POST") {
      var revokeStub = accountStub(env, session.eh);
      if (!revokeStub) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      var revoked = await revokeStub.revokeDevice(session.eh, String(body.id || ""));
      if (!revoked || revoked.ok !== true || revoked.eh !== session.eh) return json({ ok: false, error: "eh" }, 403, request);
      return json({ ok: true }, 200, request);
    }
    if (url.pathname === "/auth/security" && request.method === "POST") {
      var securityStub = accountStub(env, session.eh);
      var securityAccount = securityStub ? await securityStub.getAccount(session.eh) : null;
      if (!securityAccount || securityAccount.eh !== session.eh) return json({ ok: false, error: "session" }, 401, request);
      securityAccount.alwaysAsk = body.alwaysAsk === true;
      var stored = await securityStub.saveAccount(session.eh, securityAccount);
      if (!stored || stored.ok !== true) return json({ ok: false, error: "auth-store-disabled" }, 503, request);
      return json({ ok: true, alwaysAsk: securityAccount.alwaysAsk === true }, 200, request);
    }
    return json({ ok: false, error: "not-found" }, 404, request);
  }
};
