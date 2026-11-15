import assert from "node:assert/strict";
import test from "node:test";
import { browserName, codeDecision, maskEmail, needSecondFactor, validEmail } from "./auth-logic.js";

test("stored alwaysAsk, a new device, and the owner still require the email code", () => {
  var known = { knownDevice: true, alwaysAsk: false, leader: false, revoked: false, baseVerified: true, codeThisLogin: false };
  assert.equal(needSecondFactor(known), false);
  assert.equal(needSecondFactor(Object.assign({}, known, { alwaysAsk: true })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { knownDevice: false })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { leader: true })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { revoked: true })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { baseVerified: false })), true);
  assert.equal(needSecondFactor({ codeThisLogin: true, knownDevice: false, leader: true, alwaysAsk: true }), false);
  assert.equal(needSecondFactor({ googleVerified: true, knownDevice: false, alwaysAsk: true, leader: true }), true);
});

test("a code allows five tries and then locks", () => {
  var now = 1_000;
  assert.equal(codeDecision(null, now), "missing");
  assert.equal(codeDecision({ exp: 999, attempts: 0 }, now), "expired");
  assert.equal(codeDecision({ exp: 2000, attempts: 5 }, now), "locked");
  assert.equal(codeDecision({ exp: 2000, attempts: 4 }, now), "ok");
});

test("email text stays plain", () => {
  assert.equal(maskEmail("ada@valhalla-app.xyz"), "a***@valhalla-app.xyz");
  assert.equal(validEmail("ada@valhalla-app.xyz"), true);
  assert.equal(validEmail("not an email"), false);
  assert.equal(browserName("Mozilla/5.0 Chrome/120"), "Chrome");
});
