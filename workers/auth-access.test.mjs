import assert from "node:assert/strict";
import test from "node:test";
import worker from "./auth.js";

var SECRET = "a-test-secret-long-enough-for-hmac";
var EMAIL = "owner@example.test";
var encoder = new TextEncoder();

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

async function request(payload) {
  var token = await issue(Object.assign({ exp: Date.now() + 60000 }, payload));
  return new Request("https://auth.example/auth/access", {
    headers: {
      authorization: "Bearer " + token,
      origin: "https://valhalla-app.xyz"
    }
  });
}

function env(rows) {
  return {
    DEVICE_COOKIE_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "test-client",
    LEADER_EMAIL: EMAIL,
    AUTH_KV: {
      get: async function (key) { return JSON.stringify(rows[key] || null); }
    }
  };
}

test("returns Pro status from the server account record", async () => {
  var emailHash = await hash("member@example.test");
  var response = await worker.fetch(await request({ eh: emailHash, code: true }), env({
    ["acct:" + emailHash]: { plan: "pro" }
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    plan: "pro",
    subscriber: true,
    leader: false
  });
});

test("keeps free accounts locked and requires Google plus a verified code for owner access", async () => {
  var emailHash = await hash(EMAIL);
  var emailOnly = await worker.fetch(await request({ eh: emailHash, code: true }), env({}));
  assert.equal((await emailOnly.json()).leader, false);

  var response = await worker.fetch(await request({ eh: emailHash, code: true, google: true }), env({}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    plan: "free",
    subscriber: false,
    leader: true
  });
});

test("a verified master admin alias is a leader only with Google and a code", async () => {
  var alias = "alias@example.test";
  var emailHash = await hash(alias);
  var settings = env({});
  settings.MASTER_ADMIN_EMAIL = alias;
  var withoutGoogle = await worker.fetch(await request({ eh: emailHash, code: true }), settings);
  assert.equal((await withoutGoogle.json()).leader, false);
  var response = await worker.fetch(await request({ eh: emailHash, code: true, google: true }), settings);
  assert.equal((await response.json()).leader, true);
});

test("rejects missing or invalid sessions", async () => {
  var missing = await worker.fetch(new Request("https://auth.example/auth/access"), env({}));
  assert.equal(missing.status, 401);
  var invalid = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer invalid.token" }
  }), env({}));
  assert.equal(invalid.status, 401);
});
