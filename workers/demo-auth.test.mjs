import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createVerifier, demoConfigured, demoIdentity, normalizeUsername, verifyPassword } from "./demo-auth.mjs";

var sample = "correct-horse-preview";

test("a username matches after case folding and an email is not a username", () => {
  assert.equal(normalizeUsername("  DaisyGrace "), "daisygrace");
  assert.equal(normalizeUsername("daisygrace"), "daisygrace");
  assert.equal(normalizeUsername("Daisy Grace"), "");
  assert.equal(normalizeUsername("ada@valhalla-app.xyz"), "");
});

test("the verifier check is constant length and rejects a weak record", async () => {
  var verifier = await createVerifier(sample);
  assert.equal(await verifyPassword(sample, verifier), true);
  assert.equal(await verifyPassword("wrong-password-value", verifier), false);
  assert.equal(await verifyPassword(sample, "pbkdf2-sha256$1000$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), false);
  assert.equal(demoIdentity("ab".repeat(32)).indexOf("demo:"), 0);
  assert.equal(/^[0-9a-f]{8}-/.test(demoIdentity("ab".repeat(32))), false);
});

test("demo mode stays off unless the preview flags and verifier are set", async () => {
  var verifier = await createVerifier(sample);
  assert.equal(demoConfigured({
    DEMO_AUTH_MODE: "preview",
    AUTH_PREVIEW: "1",
    DEMO_USERNAME: "DaisyGrace",
    DEMO_VERIFIER: verifier
  }), true);
  assert.equal(demoConfigured({
    DEMO_AUTH_MODE: "preview",
    AUTH_PREVIEW: "1",
    DEMO_USERNAME: "DaisyGrace",
    DEMO_VERIFIER: verifier,
    DEMO_PASSWORD: sample
  }), false);
  assert.equal(demoConfigured({ DEMO_VERIFIER: verifier, DEMO_USERNAME: "DaisyGrace" }), false);
});

test("the verifier tool reads stdin and refuses an argument", async () => {
  var refused = await runTool(["secret-on-argv"], "");
  assert.equal(refused.code, 1);
  var made = await runTool([], sample + "\n");
  assert.equal(made.code, 0);
  assert.equal(await verifyPassword(sample, made.out.trim()), true);
  assert.equal(made.out.indexOf(sample), -1);
});

function runTool(args, stdin) {
  return new Promise(function (resolve) {
    var child = spawn(process.execPath, ["workers/demo-verifier.mjs"].concat(args), { stdio: ["pipe", "pipe", "pipe"] });
    var out = "";
    child.stdout.on("data", function (chunk) { out += chunk; });
    child.on("close", function (code) { resolve({ code: code, out: out }); });
    child.stdin.end(stdin);
  });
}
