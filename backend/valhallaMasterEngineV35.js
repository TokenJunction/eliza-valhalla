import { createServer as createHttp, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { bearer, isRoot, issueSession, normalizeEmail, readSession, resolveRoot } from "./authz.js";
import { ADAPTER_VERSION, PROVIDER_CATALOG, blankProvider, testProvider } from "./adapters.js";
import { NOT_CONFIGURED_APPS, builtinManifests, canLaunch, editionAllows, scopeKey } from "./apps.js";
import { connectorRequest, listConnectors } from "./connectors.js";
import { deskOpenApi } from "./desk-openapi.js";
import { modelRoute } from "./model-route.js";
import { createBus, privateKeyFromPem, publicKeyFromPem } from "./agentCrossTalkBus.js";
import { acceptEvent, verifyWebhook } from "./commerce.js";
import { decodeBase58, publicKeyFromRaw, verifyBytes } from "./ed25519.js";
import { deviceId, entitlements, verifyLicense } from "./license.js";
import { publicConfig, redact, encryptSecret } from "./secretStore.js";
import { inspectPrompt } from "./sanitize.js";
import { createReflexion } from "./valhallaReflexionEngine.js";

const APPS = builtinManifests();

function json(res, status, body, origin) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
  });
  res.end(text);
}

function allowOrigin(req, env) {
  const origin = req.headers.origin || "";
  return origin && origin === env.VALHALLA_SITE_ORIGIN ? origin : "";
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw: "", json: {} };
  return { raw, json: JSON.parse(raw) };
}

function createState(env) {
  const providers = {};
  for (const spec of PROVIDER_CATALOG) providers[spec.id] = blankProvider(spec);
  return {
    env,
    startedAt: Date.now(),
    bootstrapCode: randomBytes(16).toString("hex"),
    supabase: false,
    redis: false,
    setup: {
      complete: false,
      step: "brand",
      branding: { name: "ValhallaOS", logoUrl: "", accent: "#000080" },
      rootEmail: null,
      edition: "core",
      license: null,
      providers,
      connectors: {},
      payments: {},
      members: [],
      installed: ["trading", "ai-workspace", "thalos", "data-explorer"],
      progress: ["start"],
    },
    secrets: new Map(),
    rules: [],
    storage: new Map(),
    ledger: [],
    seenEvents: new Map(),
    devices: new Set(),
    apps: APPS,
  };
}

function actor(req, state) {
  return readSession(state.env.SESSION_SECRET, bearer(req));
}

function admin(req, state) {
  const email = actor(req, state);
  if (!email) return { status: 401, email: null };
  if (!isRoot(email, state.env, state.setup)) return { status: 403, email };
  return { status: 200, email };
}

function cloudAllowed(state) {
  return Boolean(state.setup.license && state.setup.license.edition === "pro");
}

export function createServer(options = {}) {
  const env = options.env || process.env;
  const state = options.state || createState(env);
  const fetchImpl = options.fetchImpl || fetch;
  const bus = createBus({
    privateKey: env.VALHALLA_SIGNING_PRIVATE_KEY ? privateKeyFromPem(env.VALHALLA_SIGNING_PRIVATE_KEY) : null,
    publicKey: env.VALHALLA_SIGNING_PUBLIC_KEY ? publicKeyFromPem(env.VALHALLA_SIGNING_PUBLIC_KEY) : null,
    redis: options.redis || null,
  });
  state.redis = Boolean(options.redis);
  const rules = {
    async insertRule(rule) {
      state.rules.push(rule);
      return rule;
    },
    async setRuleActive(id, active) {
      const rule = state.rules.find((item) => item.id === id);
      if (!rule) return null;
      rule.active = active;
      return rule;
    },
  };
  const reflexion = createReflexion(rules);

  const server = createHttp(async (req, res) => {
    const origin = allowOrigin(req, env);
    if (req.method === "OPTIONS") {
      res.writeHead(204, origin ? {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "Origin",
      } : {});
      res.end();
      return;
    }
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          version: "35.0.0",
          uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
          port: Number(env.PORT) || 8080,
          edition: state.setup.edition,
          supabase: state.supabase,
          redis: state.redis,
          signing: Boolean(env.VALHALLA_SIGNING_PRIVATE_KEY),
          factory: String(env.VALHALLA_FACTORY) === "1",
        }, origin);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/bootstrap") {
        const { json: body } = await readJson(req);
        const email = normalizeSafe(body.email);
        if (!env.SESSION_SECRET) return json(res, 503, { ok: false, error: "unavailable", code: "V-AUTH" }, origin);
        if (body.code !== state.bootstrapCode) return json(res, 403, { ok: false, error: "denied", code: "V-AUTH" }, origin);
        const root = resolveRoot(env, { rootEmail: email });
        if (!root || email !== root) return json(res, 403, { ok: false, error: "denied", code: "V-AUTH" }, origin);
        const device = deviceId(body.deviceId || "local");
        const rights = entitlements(state.setup.license);
        if (state.devices.size >= rights.deviceLimit && !state.devices.has(device)) {
          return json(res, 403, { ok: false, error: "device-limit", code: "V-LIC" }, origin);
        }
        state.devices.add(device);
        if (String(env.VALHALLA_FACTORY) !== "1") state.setup.rootEmail = root;
        return json(res, 200, { ok: true, token: issueSession(env.SESSION_SECRET, root), email: root }, origin);
      }

      const who = admin(req, state);
      const authed = actor(req, state);

      if (req.method === "GET" && url.pathname === "/api/me") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, email: authed, root: isRoot(authed, env, state.setup) }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/admin/metrics") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
          rss: process.memoryUsage().rss,
          rules: state.rules.length,
          activeRules: state.rules.filter((rule) => rule.active).length,
          adaptersEnabled: Object.values(state.setup.providers).filter((item) => item.enabled).length,
          edition: state.setup.edition,
          redis: state.redis,
          supabase: state.supabase,
          ledgerEvents: state.ledger.length,
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/setup/status") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, setup: publicConfig(state.setup), secrets: [...state.secrets.keys()] }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/branding") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        state.setup.branding = {
          name: String(body.name || "ValhallaOS").slice(0, 60),
          logoUrl: String(body.logoUrl || "").slice(0, 300),
          accent: /^#[0-9a-fA-F]{6}$/.test(body.accent || "") ? body.accent : "#000080",
        };
        state.setup.progress = [...new Set([...state.setup.progress, "brand"])];
        return json(res, 200, { ok: true, branding: state.setup.branding }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/provider") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const provider = state.setup.providers[body.id];
        if (!provider) return json(res, 404, { ok: false, code: "V-ADP" }, origin);
        if (body.baseUrl) provider.baseUrl = String(body.baseUrl).slice(0, 300);
        if (body.model) provider.model = String(body.model).slice(0, 80);
        provider.tested = false;
        provider.enabled = false;
        provider.health = "unknown";
        if (body.apiKey) {
          if (!env.SETUP_MASTER_KEY) return json(res, 400, { ok: false, error: "use-env", code: "V-SEC" }, origin);
          state.secrets.set(provider.id, encryptSecret(env.SETUP_MASTER_KEY, body.apiKey));
          provider.secretStored = true;
          console.debug("valhalla", "V-SEC", redact(`stored ${provider.id}`));
        }
        return json(res, 200, { ok: true, provider: publicConfig(provider) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/provider/test") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const provider = state.setup.providers[body.id];
        if (!provider) return json(res, 404, { ok: false, code: "V-ADP" }, origin);
        const result = await testProvider(provider, fetchImpl, body.apiKey || "");
        provider.tested = result.ok;
        provider.health = result.health;
        provider.enabled = false;
        console.debug("valhalla", "V-ADP", redact(`${provider.id} ${result.health}`));
        return json(res, 200, { ok: result.ok, provider: publicConfig(provider) }, origin);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/adapters/") && url.pathname.endsWith("/enable")) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = url.pathname.split("/")[3];
        const provider = state.setup.providers[id];
        const { json: body } = await readJson(req);
        if (!provider) return json(res, 404, { ok: false, code: "V-ADP" }, origin);
        if (body.enabled === true && !provider.tested) return json(res, 400, { ok: false, error: "untested", code: "V-ADP" }, origin);
        if (body.enabled === true && !provider.local && !cloudAllowed(state)) return json(res, 403, { ok: false, error: "license", code: "V-LIC" }, origin);
        provider.enabled = body.enabled === true && provider.tested;
        return json(res, 200, { ok: true, provider: publicConfig(provider), version: ADAPTER_VERSION }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/adapters") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, adapters: publicConfig(state.setup.providers) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/edition") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        if (body.edition === "core") {
          state.setup.edition = "core";
          state.setup.license = null;
          return json(res, 200, { ok: true, edition: "core" }, origin);
        }
        if (body.edition !== "pro") return json(res, 400, { ok: false, error: "edition", code: "V-LIC" }, origin);
        const publicKey = options.licensePublicKey || null;
        const checked = verifyLicense(publicKey, body.license);
        if (!checked.ok || checked.license.edition !== "pro") return json(res, 403, { ok: false, error: checked.reason || "license", code: "V-LIC" }, origin);
        state.setup.license = checked.license;
        state.setup.edition = "pro";
        return json(res, 200, { ok: true, edition: "pro" }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/setup/export") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, config: publicConfig(state.setup) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/import") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const config = publicConfig(body.config || {});
        if (config.branding) state.setup.branding = { ...state.setup.branding, ...config.branding };
        if (config.edition === "core") state.setup.edition = "core";
        state.setup.progress = [...new Set([...(state.setup.progress || []), "import"])];
        return json(res, 200, { ok: true, config: publicConfig(state.setup) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/complete") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        state.setup.complete = true;
        state.setup.progress = [...new Set([...state.setup.progress, "complete"])];
        return json(res, 200, { ok: true }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/members") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const email = normalizeSafe(body.email);
        const limit = entitlements(state.setup.license).deviceLimit;
        if (!email || email === resolveRoot(env, state.setup)) return json(res, 400, { ok: false, code: "V-AUTH" }, origin);
        if (state.setup.members.length >= limit) return json(res, 403, { ok: false, error: "member-limit", code: "V-LIC" }, origin);
        state.setup.members.push({ email, role: "member" });
        return json(res, 200, { ok: true, members: state.setup.members }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/ai/chat") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const inspected = inspectPrompt(body.text || "");
        const target = body.target === "cloud" ? "cloud" : "local";
        if (!inspected.ok && target === "cloud") return json(res, 400, { ok: false, error: "flagged", flags: inspected.flags, code: "V-AI" }, origin);
        if (target === "cloud" && !cloudAllowed(state)) return json(res, 403, { ok: false, error: "license", code: "V-LIC" }, origin);
        if (body.demo === true) {
          return json(res, 200, { ok: true, mode: "echo", text: `Local echo. Not a model response. ${inspected.text}` }, origin);
        }
        const route = modelRoute(state.setup.providers, { role: body.role || body.capability || "chat" });
        if (!route.available) {
          return json(res, 503, { ok: false, error: route.reason, ...route, code: "V-AI" }, origin);
        }
        return json(res, 200, { ok: true, ...route }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/privarun/local") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        if (String(env.VALHALLA_LOCAL_RELAY) !== "1") return json(res, 409, { ok: false, error: "local-only", code: "V-AI" }, origin);
        const { json: body } = await readJson(req);
        const inspected = inspectPrompt(body.text || "");
        if (!inspected.ok) return json(res, 400, { ok: false, error: "flagged", flags: inspected.flags, code: "V-AI" }, origin);
        return json(res, 200, { ok: true, mode: "local-relay", text: inspected.text }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/privarun/cloud") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const inspected = inspectPrompt(body.text || "");
        if (!inspected.ok) return json(res, 400, { ok: false, error: "flagged", code: "V-AI" }, origin);
        if (!cloudAllowed(state)) return json(res, 403, { ok: false, error: "license", code: "V-LIC" }, origin);
        return json(res, 200, { ok: true, mode: "cloud", text: inspected.text }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/rules") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, rules: state.rules }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/reflexion/failure") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const rule = await reflexion.onFailure(body);
        return json(res, 200, { ok: true, rule }, origin);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/rules/") && url.pathname.endsWith("/activate")) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        const { json: body } = await readJson(req);
        const result = await reflexion.activate(id, body);
        return json(res, result.ok ? 200 : result.status, result, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/apps") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const apps = state.apps.filter((app) => canLaunch(state.setup.installed, app, options.appPublicKey || null));
        return json(res, 200, { ok: true, apps }, origin);
      }
      if (req.method === "POST" && /^\/api\/apps\/[^/]+\/revoke$/.test(url.pathname)) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = url.pathname.split("/")[3];
        state.setup.installed = state.setup.installed.filter((item) => item !== id);
        return json(res, 200, { ok: true, installed: state.setup.installed }, origin);
      }
      if (req.method === "POST" && /^\/api\/apps\/[^/]+\/install$/.test(url.pathname)) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = url.pathname.split("/")[3];
        const app = state.apps.find((item) => item.id === id);
        if (!app || !canLaunch([id], app, options.appPublicKey || null)) return json(res, 403, { ok: false, code: "V-APP" }, origin);
        if (!editionAllows(app, entitlements(state.setup.license))) return json(res, 403, { ok: false, code: "V-LIC" }, origin);
        if (!state.setup.installed.includes(id)) state.setup.installed.push(id);
        return json(res, 200, { ok: true, installed: state.setup.installed }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/apps/trading/capabilities") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, liveTrading: false, paper: true, reason: "Live trading is disabled." }, origin);
      }
      if (/^\/api\/apps\/[^/]+\/storage$/.test(url.pathname)) {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const appId = url.pathname.split("/")[3];
        if (req.method === "GET") {
          const prefix = scopeKey(state.setup.branding.name, appId, authed, "");
          const entries = [...state.storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }));
          return json(res, 200, { ok: true, entries }, origin);
        }
        if (req.method === "POST") {
          const { json: body } = await readJson(req);
          state.storage.set(scopeKey(state.setup.branding.name, appId, authed, body.key || "note"), publicConfig(body.value ?? null));
          return json(res, 200, { ok: true }, origin);
        }
      }
      if (req.method === "POST" && url.pathname === "/api/a2a/verify") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const message = String(body.message || "");
        if (!message.startsWith("ValhallaOS A2A v1")) return json(res, 400, { ok: false, code: "V-A2A" }, origin);
        const exp = Date.parse((message.match(/Expires: (.+)/) || [])[1] || "");
        if (!Number.isFinite(exp) || exp < Date.now()) return json(res, 400, { ok: false, code: "V-A2A" }, origin);
        const raw = decodeBase58(String(body.pubkey || ""));
        const key = raw && publicKeyFromRaw(raw);
        const signature = Buffer.from(String(body.signature || ""), "base64");
        if (!key || signature.length !== 64 || !verifyBytes(key, Buffer.from(message), signature)) {
          return json(res, 400, { ok: false, code: "V-A2A" }, origin);
        }
        return json(res, 200, { ok: true, last4: String(body.pubkey).slice(-4) }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/odin") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const role = url.searchParams.get("role") || "chat";
        const route = modelRoute(state.setup.providers, { role });
        return json(res, 200, { ok: true, name: "Odin", model: false, ...route }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/desk/openapi") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, deskOpenApi(), origin);
      }
      if (req.method === "GET" && url.pathname === "/api/connectors") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, connectors: listConnectors() }, origin);
      }
      if (req.method === "POST" && /^\/api\/connectors\/[^/]+$/.test(url.pathname)) {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const result = connectorRequest(url.pathname.split("/")[3], body);
        return json(res, result.status, result, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/compute") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          enabled: false,
          mining: false,
          payouts: "unavailable",
          reputation: "off",
          hiddenJobs: false,
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/apps/catalog") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          mvp: state.apps.map((app) => ({ id: app.id, network: app.networkScopes.length === 0, liveTrading: false })),
          notConfigured: NOT_CONFIGURED_APPS,
        }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/apps/thalos/analysis") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const points = Array.isArray(body.points) ? body.points.filter((item) => Number.isFinite(Number(item))).map(Number) : [];
        const mean = points.length ? points.reduce((sum, item) => sum + item, 0) / points.length : null;
        return json(res, 200, { ok: true, mode: "paper", trades: false, liveTrading: false, count: points.length, mean }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/apps/data-explorer/inspect") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const rows = Array.isArray(body.rows) ? body.rows : [];
        return json(res, 200, { ok: true, remote: false, count: rows.length }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/review") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          agents: ["Ledger", "Forge", "Tinker", "Droid", "Sentinel", "Gauge"].map((name) => ({
            name,
            status: "unavailable",
            note: "This review seat has no connected worker.",
          })),
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/connectors/google-drive") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          configured: state.secrets.has("google-drive"),
          api: "https://www.googleapis.com/drive/v3",
          mode: "official-api",
          scraping: false,
        }, origin);
      }
      if (req.method === "POST" && (url.pathname === "/api/billing/payouts" || url.pathname === "/api/hive/rewards" || url.pathname === "/api/custody")) {
        return json(res, 503, { ok: false, error: "unavailable", code: "V-PAY" }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/billing/claim") {
        return json(res, 403, { ok: false, error: "denied", code: "V-PAY" }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const provider = String(body.provider || "");
        const secretName = provider === "lemonsqueezy" ? "LEMON_WEBHOOK_SECRET" : provider === "nowpayments" ? "NOWPAYMENTS_API_KEY" : provider === "coinbase" ? "COINBASE_COMMERCE_API_KEY" : "";
        if (!secretName || !env[secretName] || !env.CHECKOUT_URL) return json(res, 503, { ok: false, error: "not_configured", code: "V-PAY" }, origin);
        return json(res, 200, { ok: true, url: env.CHECKOUT_URL }, origin);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/billing/webhook/")) {
        const provider = url.pathname.split("/").pop();
        const secret = provider === "lemonsqueezy" ? env.LEMON_WEBHOOK_SECRET : provider === "nowpayments" ? env.NOWPAYMENTS_IPN_SECRET : provider === "coinbase" ? env.COINBASE_COMMERCE_WEBHOOK_SECRET : "";
        if (!secret) return json(res, 503, { ok: false, error: "not_configured", code: "V-PAY" }, origin);
        const { raw, json: body } = await readJson(req);
        const header = req.headers["x-signature"] || req.headers["x-nowpayments-sig"] || req.headers["x-cc-webhook-signature"] || "";
        if (!verifyWebhook(provider, secret, raw, header)) return json(res, 401, { ok: false, code: "V-PAY" }, origin);
        const gate = acceptEvent(state.seenEvents, body, Date.now());
        if (!gate.ok) return json(res, 409, { ok: false, error: gate.reason, code: "V-PAY" }, origin);
        state.ledger.push({ id: body.id, provider, at: body.at, status: "recorded" });
        return json(res, 200, { ok: true }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/bus/publish") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const envelope = await bus.publish(String(body.channel || "valhalla.events"), body.payload || {});
        if (envelope.error) return json(res, 503, { ok: false, error: envelope.error, code: "V-BUS" }, origin);
        return json(res, 200, { ok: true, envelope }, origin);
      }
      json(res, 404, { ok: false, code: "V-404" }, origin);
    } catch (err) {
      console.debug("valhalla", "V-500", redact(err instanceof Error ? err.message : "error"));
      json(res, 500, { ok: false, code: "V-500" }, origin);
    }
  });

  server.state = state;
  server.bus = bus;
  return server;
}

function normalizeSafe(email) {
  return String(email || "").trim().toLowerCase();
}

function listen(server, port) {
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve(server.address()));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  const host = process.env.VALHALLA_LOCAL_RELAY === "1" ? "127.0.0.1" : "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`ValhallaOS backend health on ${host}:${port}/health`);
  });
}

export { httpRequest };
