import assert from "node:assert/strict";
import test from "node:test";
import { generateEd25519 } from "../ed25519.js";
import { createBus } from "../agentCrossTalkBus.js";
import { editionAllows } from "../apps.js";
import { connectorRequest, listConnectors } from "../connectors.js";
import { deskOpenApi } from "../desk-openapi.js";
import { modelRoute } from "../model-route.js";
import { createServer } from "../valhallaMasterEngineV35.js";

test("model routes stay single-provider and do not spend a background call", () => {
  const voice = modelRoute({}, { role: "voice" });
  assert.equal(voice.provider, null);
  assert.equal(voice.available, false);
  assert.equal(voice.mixedWeights, false);
  assert.equal(voice.background, false);
  assert.equal(voice.quota, "Your provider, your quota");
  const local = modelRoute({
    ollama: { tested: true, health: "up", baseUrl: "https://ollama.example", secretStored: false, capabilities: ["chat"] },
  }, { role: "local" });
  assert.equal(local.provider, "ollama");
  assert.equal(local.fallback, false);
});

test("an A2A envelope binds recipient, session, expiry, and replay", async () => {
  const pair = generateEd25519();
  const bus = createBus({ privateKey: pair.privateKey, publicKey: pair.publicKey });
  const envelope = await bus.publish("desk", { kind: "ping" }, {
    recipient: "thalos",
    session: "session-1",
    serviceState: "paper",
  });
  assert.equal(envelope.pqSig, null);
  assert.equal(envelope.recipient, "thalos");
  assert.equal(bus.open(envelope), true);
  assert.equal(bus.open(envelope), false);
  const expired = await bus.publish("desk", { kind: "ping" }, { exp: Date.now() - 1000, nonce: "old" });
  assert.equal(bus.open(expired), false);
});

test("connectors stay unconfigured and S3 requires a prefix", () => {
  assert.equal(listConnectors().every((item) => item.configured === false && item.scraping === false), true);
  assert.equal(connectorRequest("s3", {}).error, "prefix-required");
  const scoped = connectorRequest("s3", { prefix: "reports/" });
  assert.equal(scoped.error, "not-configured");
  assert.equal(scoped.called, false);
  assert.equal(connectorRequest("google-drive", {}).called, false);
});

test("the desk document is paper only and a client plan does not grant a pro app", () => {
  const doc = deskOpenApi();
  assert.equal(doc["x-valhalla"].liveTrading, false);
  assert.equal(doc["x-valhalla"].signTransaction, false);
  assert.equal(doc["x-valhalla"].unlimited, false);
  assert.equal(editionAllows({ license: "pro" }, { edition: "core" }), false);
  assert.equal(editionAllows({ license: "core" }, { edition: "core" }), true);
});

test("compute, catalog, and paper apps do not call a network", async () => {
  const server = createServer({ env: { SESSION_SECRET: "test-secret" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const boot = await fetch(base + "/api/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "root@customer.test", code: server.state.bootstrapCode, deviceId: "d1", plan: "pro", seats: 100 }),
  });
  const token = (await boot.json()).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const compute = await fetch(base + "/api/compute", { headers }).then((res) => res.json());
  assert.equal(compute.enabled, false);
  assert.equal(compute.mining, false);
  assert.equal(compute.payouts, "unavailable");
  const catalog = await fetch(base + "/api/apps/catalog", { headers }).then((res) => res.json());
  assert.equal(catalog.notConfigured.some((item) => item.id === "code-assistant" && item.network === false), true);
  const thalos = await fetch(base + "/api/apps/thalos/analysis", {
    method: "POST",
    headers,
    body: JSON.stringify({ points: [1, 3] }),
  }).then((res) => res.json());
  assert.equal(thalos.trades, false);
  assert.equal(thalos.mean, 2);
  const added = [];
  for (let i = 0; i < 6; i += 1) {
    const response = await fetch(base + "/api/workspace/members", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: `m${i}@customer.test`, role: "admin", seats: 100 }),
    });
    added.push(response.status);
  }
  assert.equal(added[4], 200);
  assert.equal(added[5], 403);
  await new Promise((resolve) => server.close(resolve));
});
