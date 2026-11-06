const assert = require("node:assert/strict");
const test = require("node:test");
const { isServerVerifiedAdmin } = require("./admin-auth.js");

test("admin access needs a server-verified session and ignores a client role", () => {
  const env = { CUSTOMER_ADMIN_EMAIL: "root@customer.test", MASTER_ADMIN_EMAIL: "owner@factory.test" };
  assert.equal(isServerVerifiedAdmin(env, { email: "root@customer.test", google: true, code: true, role: "member" }), true);
  assert.equal(isServerVerifiedAdmin(env, { email: "owner@factory.test", google: true, code: true, role: "admin" }), false);
  assert.equal(isServerVerifiedAdmin(env, { email: "root@customer.test", google: true, code: false, plan: "pro" }), false);
});

test("factory mode uses the external master admin email", () => {
  const env = { VALHALLA_FACTORY: "1", MASTER_ADMIN_EMAIL: "owner@factory.test", CUSTOMER_ADMIN_EMAIL: "root@customer.test" };
  assert.equal(isServerVerifiedAdmin(env, { email: "owner@factory.test", google: true, code: true }), true);
  assert.equal(isServerVerifiedAdmin(env, { email: "root@customer.test", google: true, code: true }), false);
});
