import assert from "node:assert/strict";
import test from "node:test";
import { generateEd25519, signBytes, toPem } from "../ed25519.js";
import { signLicense } from "../license.js";
import { createServer } from "../valhallaMasterEngineV35.js";

async function boot(env = {}, options = {}) {
  const server = createServer({
    env: { SESSION_SECRET: "test-secret", ...env },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    code: server.state.bootstrapCode,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function api(base, path, { method = "GET", token, body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

test("customer bootstrap uses the configured admin and ignores a client plan", async () => {
  const app = await boot({
    CUSTOMER_ADMIN_EMAIL: "root@customer.test",
    MASTER_ADMIN_EMAIL: "owner@factory.test",
  });
  const denied = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "owner@factory.test", code: app.code, deviceId: "d1", role: "admin", plan: "pro" },
  });
  assert.equal(denied.status, 403);
  const ok = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "Root@Customer.test", code: app.code, deviceId: "d1", role: "admin", plan: "pro" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.email, "root@customer.test");
  const rights = await api(app.base, "/api/setup/status", { token: ok.json.token });
  assert.equal(rights.json.setup.edition, "core");
  const me = await api(app.base, "/api/me", { token: ok.json.token });
  assert.equal(me.json.root, true);
  const forged = await api(app.base, "/api/admin/metrics", { token: ok.json.token });
  assert.equal(forged.status, 200);
  await app.stop();
});

test("a non-admin token cannot open admin metrics", async () => {
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const { issueSession } = await import("../authz.js");
  const other = issueSession("test-secret", "member@customer.test");
  const denied = await api(app.base, "/api/admin/metrics", { token: other });
  assert.equal(denied.status, 403);
  const allowed = await api(app.base, "/api/admin/metrics", { token: admin.json.token });
  assert.equal(allowed.status, 200);
  assert.equal(typeof allowed.json.rss, "number");
  await app.stop();
});

test("factory mode only accepts MASTER_ADMIN_EMAIL", async () => {
  const closed = await boot({ VALHALLA_FACTORY: "1" });
  const missing = await api(closed.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "owner@factory.test", code: closed.code, deviceId: "d1" },
  });
  assert.equal(missing.status, 403);
  await closed.stop();
  const app = await boot({ VALHALLA_FACTORY: "1", MASTER_ADMIN_EMAIL: "owner@factory.test" });
  const denied = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "other@customer.test", code: app.code, deviceId: "d1" },
  });
  assert.equal(denied.status, 403);
  const ok = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "Owner@Factory.test", code: app.code, deviceId: "d1" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.email, "owner@factory.test");
  await app.stop();
});

test("provider secrets are not returned and cloud adapters need a pro license", async () => {
  const app = await boot({ SETUP_MASTER_KEY: "master-key" });
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const token = admin.json.token;
  const secret = "sk-SUPERSECRET987654";
  const saved = await api(app.base, "/api/setup/provider", {
    method: "POST",
    token,
    body: { id: "openai", baseUrl: "https://example.test/v1", model: "demo", apiKey: secret },
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.json).includes(secret), false);
  const tested = await api(app.base, "/api/setup/provider/test", {
    method: "POST",
    token,
    body: { id: "ollama" },
  });
  assert.equal(tested.json.ok, false);
  const enable = await api(app.base, "/api/adapters/openai/enable", {
    method: "POST",
    token,
    body: { enabled: true },
  });
  assert.equal(enable.status, 400);
  await app.stop();
});

test("pro license is rejected when tampered or expired", async () => {
  const pair = generateEd25519();
  const app = await boot({}, { licensePublicKey: pair.publicKey });
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const token = admin.json.token;
  const license = signLicense(pair.privateKey, {
    customerId: "cust",
    edition: "pro",
    workspaceId: "ws",
    exp: Date.now() + 60_000,
    deviceLimit: 2,
    workspaceLimit: 1,
    addons: [],
  });
  license.edition = "core";
  const tamper = await api(app.base, "/api/setup/edition", {
    method: "POST",
    token,
    body: { edition: "pro", license },
  });
  assert.equal(tamper.status, 403);
  const expired = signLicense(pair.privateKey, {
    customerId: "cust",
    edition: "pro",
    workspaceId: "ws",
    exp: Date.now() - 1000,
    deviceLimit: 2,
    workspaceLimit: 1,
    addons: [],
  });
  const old = await api(app.base, "/api/setup/edition", {
    method: "POST",
    token,
    body: { edition: "pro", license: expired },
  });
  assert.equal(old.status, 403);
  await app.stop();
});

test("workspace config round-trips without secrets", async () => {
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const token = admin.json.token;
  await api(app.base, "/api/setup/branding", {
    method: "POST",
    token,
    body: { name: "Northwind", accent: "#112233", logoUrl: "" },
  });
  const exported = await api(app.base, "/api/setup/export", { token });
  assert.equal(exported.json.config.branding.name, "Northwind");
  assert.equal(JSON.stringify(exported.json).includes("SESSION_SECRET"), false);
  const other = await boot();
  const admin2 = await api(other.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@other.test", code: other.code, deviceId: "d2" },
  });
  const imported = await api(other.base, "/api/setup/import", {
    method: "POST",
    token: admin2.json.token,
    body: { config: { ...exported.json.config, apiKey: "sk-SHOULDNOTSTICK" } },
  });
  assert.equal(imported.json.config.branding.name, "Northwind");
  assert.equal(JSON.stringify(imported.json).includes("SHOULDNOTSTICK"), false);
  await app.stop();
  await other.stop();
});

test("rules stay inactive until an admin explicitly activates them", async () => {
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const token = admin.json.token;
  const created = await api(app.base, "/api/reflexion/failure", {
    method: "POST",
    token,
    body: { errorCode: "timeout", safeHint: "Retry the local model." },
  });
  assert.equal(created.json.rule.active, false);
  const denied = await api(app.base, `/api/rules/${created.json.rule.id}/activate`, {
    method: "POST",
    token,
    body: { activate: false },
  });
  assert.equal(denied.status, 400);
  const ok = await api(app.base, `/api/rules/${created.json.rule.id}/activate`, {
    method: "POST",
    token,
    body: { activate: true },
  });
  assert.equal(ok.json.rule.active, true);
  await app.stop();
});

test("unsigned apps cannot launch and storage stays inside the app", async () => {
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const token = admin.json.token;
  const apps = await api(app.base, "/api/apps", { token });
  assert.deepEqual(apps.json.apps.map((item) => item.id).sort(), ["ai-workspace", "data-explorer", "thalos", "trading"]);
  await api(app.base, "/api/apps/trading/storage", {
    method: "POST",
    token,
    body: { key: "note", value: "desk" },
  });
  const other = await api(app.base, "/api/apps/ai-workspace/storage", { token });
  assert.equal(other.json.entries.length, 0);
  app.server.state.apps.push({ id: "evil", name: "Evil", version: "1.0.0", integrity: "nope", entry: "evil" });
  const installed = await api(app.base, "/api/apps/evil/install", { method: "POST", token, body: {} });
  assert.equal(installed.status, 403);
  const trading = await api(app.base, "/api/apps/trading/capabilities", { token });
  assert.equal(trading.json.liveTrading, false);
  await app.stop();
});

test("payment claims are denied and replayed webhooks are rejected", async () => {
  const app = await boot({ LEMON_WEBHOOK_SECRET: "lemon-secret" });
  const claim = await api(app.base, "/api/billing/claim", { method: "POST", body: { plan: "pro" } });
  assert.equal(claim.status, 403);
  const { hmacHex } = await import("../commerce.js");
  const payload = { id: "evt-1", at: Date.now(), plan: "pro" };
  const raw = JSON.stringify(payload);
  const signature = hmacHex("lemon-secret", raw, "sha256");
  const first = await fetch(`${app.base}/api/billing/webhook/lemonsqueezy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: raw,
  });
  assert.equal(first.status, 200);
  const replay = await fetch(`${app.base}/api/billing/webhook/lemonsqueezy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: raw,
  });
  assert.equal(replay.status, 409);
  const checkout = await api(app.base, "/api/billing/checkout", {
    method: "POST",
    body: { provider: "nowpayments" },
  });
  assert.equal(checkout.status, 401);
  await app.stop();
});

test("bus signatures fail when the payload is changed", async () => {
  const pair = generateEd25519();
  const { createBus } = await import("../agentCrossTalkBus.js");
  const bus = createBus({ privateKey: pair.privateKey, publicKey: pair.publicKey });
  const envelope = await bus.publish("valhalla.events", { kind: "ping" });
  assert.equal(envelope.pqSig, null);
  assert.equal(bus.open(envelope), true);
  envelope.payload.kind = "tamper";
  assert.equal(bus.open(envelope), false);
  assert.equal(toPem(pair.publicKey, "spki").includes("BEGIN PUBLIC KEY"), true);
  assert.equal(signBytes(pair.privateKey, Buffer.from("a")).length, 64);
});

test("cloud chat is refused when the sanitizer flags the prompt", async () => {
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const echo = await api(app.base, "/api/ai/chat", {
    method: "POST",
    token: admin.json.token,
    body: { text: "hello desk", demo: true },
  });
  assert.equal(echo.json.mode, "echo");
  assert.match(echo.json.text, /Not a model response/);
  const unavailable = await api(app.base, "/api/ai/chat", {
    method: "POST",
    token: admin.json.token,
    body: { text: "hello desk" },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.offline, false);
  const flagged = await api(app.base, "/api/privarun/cloud", {
    method: "POST",
    token: admin.json.token,
    body: { text: "my key is sk-SUPERSECRET987654" },
  });
  assert.equal(flagged.status, 400);
  await app.stop();
});

test("the site process can report Odin without a workspace key", async () => {
  const { substrateStatus } = await import("../status.js");
  const odin = substrateStatus("/api/odin", "GET", {});
  assert.equal(odin.body.model, false);
  assert.equal(odin.body.available, false);
  assert.equal(odin.body.mixedWeights, false);
  assert.equal(odin.body.offline, false);
  assert.equal(odin.body.quota, "Your provider, your quota");
  const board = substrateStatus("/api/substrate", "GET", {});
  assert.equal(board.body.trading.liveTrading, false);
  assert.equal(board.body.thalos.trades, false);
  assert.equal(board.body.payouts, "unavailable");
  assert.equal(board.body.connectors.find((item) => item.id === "google-drive").scraping, false);
  assert.equal(board.body.compute.mining, false);
  assert.equal(substrateStatus("/api/odin", "POST", {}), null);
});

test("localhost Ollama is rejected and payouts stay unavailable", async () => {
  const { isAllowedOllamaUrl } = await import("../adapters.js");
  assert.equal(isAllowedOllamaUrl("http://127.0.0.1:11434"), false);
  assert.equal(isAllowedOllamaUrl("https://127.0.0.1:11434"), false);
  assert.equal(isAllowedOllamaUrl("https://ollama.example.com"), true);
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const odin = await api(app.base, "/api/odin", { token: admin.json.token });
  assert.equal(odin.json.model, false);
  assert.equal(odin.json.available, false);
  assert.equal(odin.json.mixedWeights, false);
  assert.equal(odin.json.offline, false);
  assert.equal(odin.json.quota, "Your provider, your quota");
  const payout = await api(app.base, "/api/billing/payouts", { method: "POST", token: admin.json.token, body: {} });
  assert.equal(payout.status, 503);
  const hive = await api(app.base, "/api/hive/rewards", { method: "POST", token: admin.json.token, body: {} });
  assert.equal(hive.status, 503);
  const drive = await api(app.base, "/api/connectors/google-drive", { token: admin.json.token });
  assert.equal(drive.json.configured, false);
  assert.equal(drive.json.scraping, false);
  await app.stop();
});

test("local relay stays closed unless this process is the local relay", async () => {
  const app = await boot();
  const admin = await api(app.base, "/api/bootstrap", {
    method: "POST",
    body: { email: "root@customer.test", code: app.code, deviceId: "d1" },
  });
  const closed = await api(app.base, "/api/privarun/local", {
    method: "POST",
    token: admin.json.token,
    body: { text: "hello" },
  });
  assert.equal(closed.status, 409);
  await app.stop();
});
