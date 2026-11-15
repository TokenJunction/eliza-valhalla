import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import worker from "./auth.js";
import { AuthDurableObject } from "./auth-durable-object.mjs";
import { createVerifier } from "./demo-auth.mjs";
import { namespace } from "./auth-memory-sql.mjs";

var secret = "test-device-cookie-secret";
var leaderEmail = "leader@example.test";
var leaderHash = createHash("sha256").update(leaderEmail).digest("hex");
var customerEmail = "ada@valhalla-app.xyz";
var userId = "33333333-3333-4333-8333-333333333333";
var callback = "https://valhalla-app.xyz/app/";

function token(payload) {
  var encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  var signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

function request(path, method, body, session, cookie) {
  var headers = {
    origin: "https://valhalla-app.xyz",
    "content-type": "application/json",
    authorization: session ? "Bearer " + session : ""
  };
  if (cookie) headers.cookie = cookie;
  return new Request("https://auth.test" + path, {
    method: method || "GET",
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function setup() {
  var values = new Map();
  var env = {
    AUTH_KV: {
      get: async (key) => values.get(key) || null,
      put: async (key, value) => values.set(key, String(value)),
      delete: async (key) => values.delete(key)
    },
    AUTH_DO: namespace(AuthDurableObject),
    DEVICE_COOKIE_SECRET: secret,
    GOOGLE_CLIENT_ID: "test-client",
    LEADER_EMAIL: leaderEmail,
    SUPABASE_URL: "https://girltjnrrwlyeufrcors.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_example_public_key_000"
  };
  env.sent = [];
  env.EMAIL = {
    send: async function (message) {
      env.sent.push(message);
      return { messageId: "mail-" + env.sent.length };
    }
  };
  return { env: env, values: values };
}

async function grant(env, fields) {
  var exp = Date.now() + 60 * 60 * 1000;
  var did = fields.did || "11111111-1111-4111-8111-111111111111";
  var sid = fields.sid || "22222222-2222-4222-8222-222222222222";
  var uid = fields.google === true ? (fields.uid || userId) : "";
  var payload = {
    eh: fields.eh,
    uid: uid,
    did: did,
    sid: sid,
    sv: 1,
    exp: exp,
    code: fields.code === true,
    google: fields.google === true,
    use: "access"
  };
  var stub = env.AUTH_DO.get(env.AUTH_DO.idFromName(fields.eh));
  var saved = await stub.putSession({
    eh: fields.eh,
    account: {
      devices: [{ id: did, revoked: false }],
      ips: [],
      signins: [],
      alwaysAsk: false,
      plan: fields.plan || ""
    },
    sessions: [{
      sid: sid,
      eh: fields.eh,
      uid: uid,
      did: did,
      exp: exp,
      v: 1,
      code: payload.code,
      google: payload.google,
      use: "access"
    }]
  });
  if (!saved.ok) throw new Error(saved.error || "grant");
  return token(payload);
}

function codeFrom(message) {
  var match = String(message && message.text || "").match(/code is (\d{6})/);
  return match ? match[1] : "";
}

function userPayload(email, id) {
  return {
    id: id || userId,
    email: email,
    app_metadata: { provider: "google", providers: ["google"] },
    identities: [{ provider: "google", identity_data: { email_verified: true } }],
    user_metadata: { full_name: "Ada", avatar_url: "https://example.test/a.png" }
  };
}

async function withUser(env, email, fn) {
  var previous = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    assert.equal(String(url), "https://girltjnrrwlyeufrcors.supabase.co/auth/v1/user");
    assert.equal(options.headers.apikey, env.SUPABASE_ANON_KEY);
    assert.equal(options.signal instanceof AbortSignal, true);
    return new Response(JSON.stringify(userPayload(email)), { status: 200 });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

async function nonceFor(env) {
  var opened = await worker.fetch(request("/auth/supabase"), env);
  var body = await opened.json();
  assert.equal(opened.status, 200);
  assert.equal(body.callback, callback);
  assert.equal(body.stateSupported, false);
  assert.equal(body.nonce.length, 64);
  return body;
}

test("chat configuration is public but restricted to approved OpenAI models", async () => {
  var state = setup();
  var response = await worker.fetch(request("/auth/chat-config"), state.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    provider: "openai",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"]
  });
});

test("only a stored Google and code session for the owner gets manager access", async () => {
  var state = setup();
  var forged = token({ eh: leaderHash, did: "x", exp: Date.now() + 60000, code: true, google: true });
  var unsigned = await worker.fetch(request("/auth/leader", "POST", {}, forged), state.env);
  assert.equal(unsigned.status, 401);

  var other = await grant(state.env, { eh: "ab".repeat(32), code: true, google: true, sid: "55555555-5555-4555-8555-555555555555" });
  assert.equal((await (await worker.fetch(request("/auth/leader", "POST", {}, other), state.env)).json()).role, "member");

  var unverified = await grant(state.env, { eh: leaderHash, code: false, google: true, sid: "66666666-6666-4666-8666-666666666666" });
  assert.equal((await (await worker.fetch(request("/auth/leader", "POST", {}, unverified), state.env)).json()).role, "member");

  var emailOnly = await grant(state.env, { eh: leaderHash, code: true, google: false, sid: "77777777-7777-4777-8777-777777777777" });
  assert.equal((await (await worker.fetch(request("/auth/leader", "POST", {}, emailOnly), state.env)).json()).role, "member");

  var owner = await grant(state.env, { eh: leaderHash, code: true, google: true, sid: "88888888-8888-4888-8888-888888888888" });
  assert.equal((await (await worker.fetch(request("/auth/leader", "POST", {}, owner), state.env)).json()).role, "leader");
});

test("model changes require the verified owner session and an approved model", async () => {
  var state = setup();
  var other = await grant(state.env, { eh: "cd".repeat(32), code: true, google: true });
  var unauthorized = await worker.fetch(request("/auth/chat-config", "POST", { model: "gpt-4.1-mini" }, other), state.env);
  assert.equal(unauthorized.status, 403);

  var owner = await grant(state.env, { eh: leaderHash, code: true, google: true, sid: "99999999-9999-4999-8999-999999999999" });
  var unsupported = await worker.fetch(request("/auth/chat-config", "POST", { model: "meta-llama" }, owner), state.env);
  assert.equal(unsupported.status, 400);
  var accepted = await worker.fetch(request("/auth/chat-config", "POST", { model: "gpt-4.1-mini" }, owner), state.env);
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(await state.values.get("manager:chat-config")).model, "gpt-4.1-mini");
});

test("engagement collection requires analytics consent and stores aggregate event counts", async () => {
  var state = setup();
  var owner = await grant(state.env, { eh: leaderHash, code: true, google: true });
  var denied = await worker.fetch(request("/auth/engagement", "POST", { event: "page_view", analyticsConsent: false }, owner), state.env);
  assert.equal(denied.status, 403);
  var accepted = await worker.fetch(request("/auth/engagement", "POST", { event: "page_view", analyticsConsent: true }, owner), state.env);
  assert.equal(accepted.status, 202);
  var report = await worker.fetch(request("/auth/engagement", "GET", undefined, owner), state.env);
  var body = await report.json();
  assert.equal(body.approximate, true);
  assert.equal(body.days[6].page_view, 1);
});

test("a direct Google token is not a session", async () => {
  var state = setup();
  var response = await worker.fetch(request("/auth/google", "POST", { credential: "gis-token" }), state.env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "incomplete");
  assert.equal(state.env.sent.length, 0);
});

test("the owner still receives an email code, and a sender rejection stores nothing", async () => {
  var state = setup();
  var opened = await nonceFor(state.env);
  await withUser(state.env, leaderEmail, async function () {
    var accepted = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: opened.callback,
      nonce: opened.nonce
    }), state.env);
    var body = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(body.needCode, true);
    assert.equal(body.session, undefined);
    assert.equal(state.env.sent.length, 1);
    var verified = await worker.fetch(request("/auth/email/verify", "POST", {
      email: leaderEmail,
      code: codeFrom(state.env.sent[0])
    }), state.env);
    var done = await verified.json();
    assert.equal(verified.status, 200);
    assert.equal(done.redirect, "/admin/master-control/");
    var role = await worker.fetch(request("/auth/leader", "POST", {}, done.session), state.env);
    assert.equal((await role.json()).role, "leader");
  });

  var rejected = setup();
  rejected.env.AUTH_EMAIL = {
    send: async function () {
      var err = new Error("sender domain");
      err.code = "E_SENDER_NOT_VERIFIED";
      throw err;
    }
  };
  var again = await nonceFor(rejected.env);
  await withUser(rejected.env, leaderEmail, async function () {
    var failed = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: again.callback,
      nonce: again.nonce
    }), rejected.env);
    var body = await failed.json();
    assert.equal(failed.status, 503);
    assert.equal(body.error, "email-sender-rejected");
    assert.equal(body.reason, "E_SENDER_NOT_VERIFIED");
  });
  var reused = await worker.fetch(request("/auth/email/verify", "POST", { email: leaderEmail, code: "000000" }), rejected.env);
  assert.equal((await reused.json()).error, "missing");
});

test("a first customer gets a code from Supabase and can verify it once", async () => {
  var state = setup();
  var opened = await nonceFor(state.env);
  await withUser(state.env, customerEmail, async function () {
    var started = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: opened.callback,
      nonce: opened.nonce
    }), state.env);
    var body = await started.json();
    assert.equal(started.status, 200);
    assert.equal(body.needCode, true);
    assert.equal(body.session, undefined);
    assert.equal(state.env.sent.length, 1);
    var code = codeFrom(state.env.sent[0]);
    assert.match(code, /^\d{6}$/);
    var verified = await worker.fetch(request("/auth/email/verify", "POST", {
      email: customerEmail,
      code: code
    }), state.env);
    var done = await verified.json();
    assert.equal(verified.status, 200);
    assert.equal(typeof done.session, "string");
    assert.equal(done.redirect, "/dashboard/analytics/");
    var replay = await worker.fetch(request("/auth/email/verify", "POST", {
      email: customerEmail,
      code: code
    }), state.env);
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error, "missing");
  });
});

test("alwaysAsk and a new device still require the customer email code", async () => {
  var state = setup();
  var started = await worker.fetch(request("/auth/email/start", "POST", { email: customerEmail, alwaysAsk: true }), state.env);
  assert.equal(started.status, 200);
  var verified = await worker.fetch(request("/auth/email/verify", "POST", {
    email: customerEmail,
    code: codeFrom(state.env.sent[0])
  }), state.env);
  var done = await verified.json();
  assert.equal(done.redirect, "/dashboard/analytics/");
  var cookie = verified.headers.get("set-cookie");
  var opened = await nonceFor(state.env);
  await withUser(state.env, customerEmail, async function () {
    var again = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: opened.callback,
      nonce: opened.nonce
    }, "", cookie), state.env);
    var body = await again.json();
    assert.equal(body.needCode, true);
    assert.equal(body.session, undefined);
  });
});

test("a known customer device can finish Google without a second code", async () => {
  var state = setup();
  var started = await worker.fetch(request("/auth/email/start", "POST", { email: customerEmail }), state.env);
  assert.equal(started.status, 200);
  var verified = await worker.fetch(request("/auth/email/verify", "POST", {
    email: customerEmail,
    code: codeFrom(state.env.sent[0])
  }), state.env);
  var cookie = verified.headers.get("set-cookie");
  var opened = await nonceFor(state.env);
  await withUser(state.env, customerEmail, async function () {
    var again = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: opened.callback,
      nonce: opened.nonce
    }, "", cookie), state.env);
    var body = await again.json();
    assert.equal(again.status, 200);
    assert.equal(body.needCode, false);
    assert.equal(typeof body.session, "string");
    var role = await worker.fetch(request("/auth/leader", "POST", {}, body.session), state.env);
    assert.equal((await role.json()).role, "member");
  });
});

test("Supabase checks the fixed host, the user id, the callback, and the nonce", async () => {
  var state = setup();
  var incomplete = await worker.fetch(request("/auth/supabase", "POST", { provider: "google" }), state.env);
  assert.equal(incomplete.status, 400);
  assert.equal((await incomplete.json()).error, "incomplete");

  var wrongHost = setup();
  wrongHost.env.SUPABASE_URL = "https://evil.supabase.co";
  var calls = 0;
  var previous = globalThis.fetch;
  globalThis.fetch = async function () { calls += 1; return new Response("no"); };
  var opened = await worker.fetch(request("/auth/supabase"), wrongHost.env);
  assert.equal(opened.status, 200);
  var posted = await worker.fetch(request("/auth/supabase", "POST", {
    accessToken: "supabase-user-access-token",
    callback: callback,
    nonce: (await opened.json()).nonce
  }), wrongHost.env);
  assert.equal(posted.status, 503);
  assert.equal(calls, 0);
  globalThis.fetch = previous;

  var missing = setup();
  var issued = await nonceFor(missing.env);
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ email: customerEmail, app_metadata: { provider: "google" } }), { status: 200 });
  };
  var noId = await worker.fetch(request("/auth/supabase", "POST", {
    accessToken: "supabase-user-access-token",
    callback: issued.callback,
    nonce: issued.nonce
  }), missing.env);
  assert.equal(noId.status, 401);
  globalThis.fetch = previous;

  var badCallback = setup();
  var nonce = await nonceFor(badCallback.env);
  var mismatched = await worker.fetch(request("/auth/supabase", "POST", {
    accessToken: "supabase-user-access-token",
    callback: "https://evil.example/app/",
    nonce: nonce.nonce
  }), badCallback.env);
  assert.equal(mismatched.status, 400);

  var timed = setup();
  timed.env.SUPABASE_TIMEOUT_MS = 50;
  var ticket = await nonceFor(timed.env);
  globalThis.fetch = function (_url, options) {
    return new Promise(function (_resolve, reject) {
      options.signal.addEventListener("abort", function () {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };
  var slow = await worker.fetch(request("/auth/supabase", "POST", {
    accessToken: "supabase-user-access-token",
    callback: ticket.callback,
    nonce: ticket.nonce
  }), timed.env);
  assert.equal(slow.status, 503);
  assert.equal((await slow.json()).error, "supabase");
  globalThis.fetch = previous;

  var once = setup();
  var first = await nonceFor(once.env);
  await withUser(once.env, customerEmail, async function () {
    var burned = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: first.callback,
      nonce: first.nonce
    }), once.env);
    assert.equal((await burned.json()).needCode, true);
    var replay = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
      callback: first.callback,
      nonce: first.nonce
    }), once.env);
    assert.equal(replay.status, 401);
  });
});

var demoPassword = "correct-horse-preview";

async function armDemo(env) {
  env.DEMO_AUTH_MODE = "preview";
  env.AUTH_PREVIEW = "1";
  env.DEMO_USERNAME = "DaisyGrace";
  env.DEMO_VERIFIER = await createVerifier(demoPassword);
}

function demoRequest(body, ip) {
  return new Request("https://auth.test/auth/demo", {
    method: "POST",
    headers: {
      origin: "https://valhalla-app.xyz",
      "content-type": "application/json",
      "cf-connecting-ip": ip
    },
    body: JSON.stringify(body)
  });
}

test("preview demo login is hidden until the preview flags are set", async () => {
  var state = setup();
  var hidden = await worker.fetch(demoRequest({ username: "DaisyGrace", password: demoPassword }, "203.0.113.8"), state.env);
  assert.equal(hidden.status, 404);
});

test("preview demo login accepts the username in any case and grants no owner rights", async () => {
  var state = setup();
  await armDemo(state.env);
  var customer = await grant(state.env, {
    eh: leaderHash,
    code: true,
    google: true,
    plan: "pro",
    sid: "12121212-1212-4121-8121-121212121212",
    did: "13131313-1313-4131-8131-131313131313"
  });
  var wrong = await worker.fetch(demoRequest({
    username: "DaisyGrace",
    password: "not-the-preview-secret",
    email: leaderEmail
  }, "203.0.113.9"), state.env);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "denied");
  var signed = await worker.fetch(demoRequest({
    username: "daisygrace",
    password: demoPassword,
    email: leaderEmail
  }, "203.0.113.9"), state.env);
  var body = await signed.json();
  assert.equal(signed.status, 200);
  assert.equal(body.role, "demo");
  assert.equal(body.email, undefined);
  assert.equal(body.redirect, "/dashboard/analytics/");
  var access = await worker.fetch(request("/auth/access", "GET", undefined, body.session), state.env);
  var view = await access.json();
  assert.equal(view.leader, false);
  assert.equal(view.subscriber, false);
  assert.equal(view.plan, "free");
  var role = await worker.fetch(request("/auth/leader", "POST", {}, body.session), state.env);
  assert.equal((await role.json()).role, "member");
  var chat = await worker.fetch(request("/auth/chat-config", "POST", { model: "gpt-4.1-mini" }, body.session), state.env);
  assert.equal(chat.status, 403);
  var revoke = await worker.fetch(request("/auth/devices/revoke", "POST", {
    id: "13131313-1313-4131-8131-131313131313"
  }, body.session), state.env);
  assert.equal(revoke.status, 403);
  var owner = await worker.fetch(request("/auth/leader", "POST", {}, customer), state.env);
  assert.equal((await owner.json()).role, "leader");
  var ownerAccess = await worker.fetch(request("/auth/access", "GET", undefined, customer), state.env);
  assert.equal((await ownerAccess.json()).subscriber, true);
});

test("preview demo locks the username and the IP after repeated failures", async () => {
  var byName = setup();
  await armDemo(byName.env);
  for (var i = 0; i < 5; i += 1) {
    var failed = await worker.fetch(demoRequest({
      username: "DaisyGrace",
      password: "not-the-preview-secret"
    }, "203.0.113." + (20 + i)), byName.env);
    assert.equal(failed.status, 401);
  }
  var named = await worker.fetch(demoRequest({
    username: "DaisyGrace",
    password: demoPassword
  }, "203.0.113.50"), byName.env);
  assert.equal(named.status, 401);
  assert.equal((await named.json()).error, "denied");

  var byIp = setup();
  await armDemo(byIp.env);
  for (var j = 0; j < 5; j += 1) {
    var spray = await worker.fetch(demoRequest({
      username: "othername" + j,
      password: "not-the-preview-secret"
    }, "198.51.100.20"), byIp.env);
    assert.equal(spray.status, 401);
  }
  var blocked = await worker.fetch(demoRequest({
    username: "DaisyGrace",
    password: demoPassword
  }, "198.51.100.20"), byIp.env);
  assert.equal(blocked.status, 401);
  var otherIp = await worker.fetch(demoRequest({
    username: "DaisyGrace",
    password: demoPassword
  }, "198.51.100.21"), byIp.env);
  assert.equal(otherIp.status, 200);
  assert.equal((await otherIp.json()).role, "demo");
});
