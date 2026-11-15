import assert from "node:assert/strict";
import test from "node:test";
import worker from "./auth.js";
import { AuthDurableObject } from "./auth-durable-object.mjs";
import { namespace } from "./auth-memory-sql.mjs";

var SECRET = "a-test-secret-long-enough-for-hmac";
var EMAIL = "owner@example.test";
var encoder = new TextEncoder();
var userId = "33333333-3333-4333-8333-333333333333";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function hash(text) {
  var bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

async function issue(payload) {
  var body = base64url(encoder.encode(JSON.stringify(payload)));
  var key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return body + "." + base64url(signature);
}

function box() {
  return {
    DEVICE_COOKIE_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "test-client",
    LEADER_EMAIL: EMAIL,
    AUTH_KV: { get: async function () { return null; }, put: async function () {}, delete: async function () {} },
    AUTH_DO: namespace(AuthDurableObject)
  };
}

async function session(env, fields) {
  var exp = Date.now() + 60000;
  var did = fields.did || "11111111-1111-4111-8111-111111111111";
  var sid = fields.sid || crypto.randomUUID();
  var uid = fields.google === true ? userId : "";
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
    account: { devices: [{ id: did }], ips: [], signins: [], alwaysAsk: false, plan: fields.plan || "" },
    sessions: [{ sid: sid, eh: fields.eh, uid: uid, did: did, exp: exp, v: 1, code: payload.code, google: payload.google, use: "access" }]
  });
  if (!saved.ok) throw new Error(saved.error || "session");
  var token = await issue(payload);
  return new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + token, origin: "https://valhalla-app.xyz" }
  });
}

test("returns Pro status from the account record on that mailbox", async () => {
  var env = box();
  var emailHash = await hash("member@example.test");
  var response = await worker.fetch(await session(env, { eh: emailHash, code: true, plan: "pro" }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    plan: "pro",
    subscriber: true,
    leader: false
  });
});

test("keeps free accounts locked and requires Google plus a verified code for owner access", async () => {
  var env = box();
  var emailHash = await hash(EMAIL);
  var emailOnly = await worker.fetch(await session(env, {
    eh: emailHash,
    code: true,
    sid: "22222222-2222-4222-8222-222222222222"
  }), env);
  assert.equal((await emailOnly.json()).leader, false);

  var response = await worker.fetch(await session(env, {
    eh: emailHash,
    code: true,
    google: true,
    sid: "33333333-3333-4333-8333-333333333333",
    did: "44444444-4444-4444-8444-444444444444"
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    plan: "free",
    subscriber: false,
    leader: true
  });
});

test("rejects missing or invalid sessions", async () => {
  var env = box();
  var missing = await worker.fetch(new Request("https://auth.example/auth/access"), env);
  assert.equal(missing.status, 401);
  var invalid = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer invalid.token" }
  }), env);
  assert.equal(invalid.status, 401);
  var unsigned = await issue({ eh: await hash(EMAIL), exp: Date.now() + 60000, code: true, google: true });
  var forged = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + unsigned, origin: "https://valhalla-app.xyz" }
  }), env);
  assert.equal(forged.status, 401);
});
