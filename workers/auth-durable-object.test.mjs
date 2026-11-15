import assert from "node:assert/strict";
import test from "node:test";
import { AuthDurableObject } from "./auth-durable-object.mjs";
import { memoryCtx, namespace } from "./auth-memory-sql.mjs";

var ehA = "a".repeat(64);
var ehB = "b".repeat(64);
var did = "11111111-1111-4111-8111-111111111111";
var sid = "22222222-2222-4222-8222-222222222222";
var uid = "33333333-3333-4333-8333-333333333333";
var uidB = "44444444-4444-4444-8444-444444444444";

function claims(extra) {
  return Object.assign({
    eh: ehA,
    uid: uid,
    did: did,
    sid: sid,
    sv: 1,
    exp: Date.now() + 60 * 60 * 1000,
    code: true,
    google: true,
    use: "access"
  }, extra || {});
}

function record(extra) {
  var row = claims(extra);
  return {
    eh: row.eh,
    account: { devices: [{ id: row.did, revoked: false }], ips: [], signins: [], alwaysAsk: false },
    sessions: [{
      sid: row.sid,
      eh: row.eh,
      uid: row.uid,
      did: row.did,
      exp: row.exp,
      v: 1,
      code: row.code,
      google: row.google,
      use: row.use
    }]
  };
}

test("RPC stub isolates accounts and rejects a foreign mailbox", async () => {
  var ns = namespace(AuthDurableObject);
  assert.throws(() => ns.putSession(record()), /namespace-method/);
  var stubA = ns.get(ns.idFromName(ehA));
  var stubB = ns.get(ns.idFromName(ehB));
  var saved = record();
  assert.equal((await stubA.putSession(saved)).ok, true);
  assert.equal((await stubA.putSession(record({ eh: ehB, uid: uidB }))).error, "eh");
  assert.equal(await stubA.readSession(claims({ eh: ehB })), null);
  assert.equal((await stubA.getAccount(ehB)), null);
  assert.equal((await stubA.getAccount(ehA)).eh, ehA);
  assert.equal((await stubA.readSession(claims({ exp: saved.sessions[0].exp }))).eh, ehA);
  assert.equal((await stubB.putSession(record({ eh: ehB, uid: uidB, sid: "55555555-5555-4555-8555-555555555555" }))).ok, true);
  var foreign = await stubA.revokeDevice(ehB, did);
  assert.equal(foreign.ok, false);
  assert.equal((await stubA.readSession(claims({ exp: saved.sessions[0].exp }))).sid, saved.sessions[0].sid);
});

test("revoke, expiry, and idle invalidate only the stored account session", async () => {
  var stub = new AuthDurableObject(memoryCtx());
  var exp = Date.now() + 60 * 60 * 1000;
  assert.equal((await stub.putSession(record({ exp: exp }))).ok, true);
  assert.equal((await stub.readSession(claims({ exp: exp }), Date.now() + 31 * 60 * 1000)), null);
  assert.equal((await stub.putSession(record({ exp: exp }))).ok, true);
  assert.ok(await stub.readSession(claims({ exp: exp }), Date.now()));
  assert.equal(await stub.readSession(claims({ exp: Date.now() - 1000 }), Date.now()), null);
  var again = Date.now() + 60 * 60 * 1000;
  assert.equal((await stub.putSession(record({ exp: again }))).ok, true);
  assert.equal((await stub.revokeDevice(ehA, did)).ok, true);
  assert.equal(await stub.readSession(claims({ exp: again })), null);
  assert.equal((await stub.putSession(record({ exp: again }))).error, "revoked");
});

test("one-time nonces and codes survive concurrent consume and then expire", async () => {
  var stub = new AuthDurableObject(memoryCtx());
  var nonce = "c".repeat(64);
  assert.equal(await stub.putCode(nonce), true);
  assert.equal(await stub.putCode(nonce), false);
  var raced = await Promise.all([stub.consumeCode(nonce), stub.consumeCode(nonce)]);
  assert.deepEqual(raced.sort(), [false, true]);
  assert.equal(await stub.consumeCode(nonce), false);

  var email = "ada@valhalla-app.xyz";
  var salt = "salt-1";
  var code = "123456";
  async function hexOf(text) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  var mailbox = await hexOf(email);
  var codeHash = await hexOf(code + ":" + salt + ":" + email);
  assert.equal((await stub.putCode({
    eh: mailbox,
    hash: codeHash,
    salt: salt,
    exp: Date.now() + 10000,
    googleVerified: true,
    uid: uid,
    hint: "a***"
  })).ok, true);
  assert.equal((await stub.consumeCode({ eh: mailbox, email: email, presented: "000000" })).error, "code");
  assert.equal(await stub.consumeCode({ eh: ehB, email: "other@valhalla-app.xyz", presented: code }), false);
  var raced = await Promise.all([
    stub.consumeCode({ eh: mailbox, email: email, presented: code }),
    stub.consumeCode({ eh: mailbox, email: email, presented: code })
  ]);
  var wins = raced.filter(function (row) { return row && row.ok === true; });
  assert.equal(wins.length, 1);
  assert.equal(wins[0].eh, mailbox);
  assert.equal(wins[0].uid, uid);
  assert.equal((await stub.consumeCode({ eh: mailbox, email: email, presented: code })).error, "missing");
  assert.equal((await stub.putCode({
    eh: mailbox,
    hash: codeHash,
    salt: salt,
    exp: Date.now() - 10,
    googleVerified: true,
    uid: uid
  })).error, "code");
});

test("the first code for a new mailbox is stored before any account row exists", async () => {
  var stub = new AuthDurableObject(memoryCtx());
  var email = "new@valhalla-app.xyz";
  async function hexOf(text) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  var mailbox = await hexOf(email);
  var salt = "salt-first";
  var code = "654321";
  var codeHash = await hexOf(code + ":" + salt + ":" + email);
  var saved = await stub.putCode({
    eh: mailbox,
    hash: codeHash,
    salt: salt,
    exp: Date.now() + 10000,
    googleVerified: true,
    uid: uid
  });
  assert.equal(saved.ok, true);
  assert.equal((await stub.getAccount(mailbox)).eh, mailbox);
  assert.equal((await stub.putCode({
    eh: ehB,
    hash: codeHash,
    salt: salt,
    exp: Date.now() + 10000,
    googleVerified: true,
    uid: uidB
  })).error, "eh");
  var opened = await stub.consumeCode({ eh: mailbox, email: email, presented: code });
  assert.equal(opened.ok, true);
  assert.equal(opened.uid, uid);
  var replay = await stub.consumeCode({ eh: mailbox, email: email, presented: code });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "missing");
});

test("a Google user id binds once and is not a random value", async () => {
  var ns = namespace(AuthDurableObject);
  var first = ns.get(ns.idFromName("uid:" + uid));
  var second = ns.get(ns.idFromName("uid:" + uid));
  assert.equal(first, second);
  assert.equal(await first.bindHuman(uid, { eh: ehA, provider: "google" }), true);
  assert.equal(await first.bindHuman(uid, { eh: ehB, provider: "google" }), false);
  assert.equal(await first.bindHuman("not-a-uuid", { eh: ehA, provider: "google" }), false);
  var account = ns.get(ns.idFromName(ehA));
  assert.equal((await account.putSession(record({ uid: "" }))).error, "uid");
});
