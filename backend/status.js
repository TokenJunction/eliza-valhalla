import { modelRoute, QUOTA_LABEL } from "./model-route.js";
import { listConnectors } from "./connectors.js";

const REVIEW = ["Ledger", "Forge", "Tinker", "Droid", "Sentinel", "Gauge"];

export function substrateStatus(pathname, method, providers) {
  if (method !== "GET" && method !== "HEAD") return null;
  const source = providers && typeof providers === "object" ? providers : {};
  if (pathname === "/api/odin") {
    const route = modelRoute(source, { role: "chat" });
    return {
      status: 200,
      body: { ok: true, name: "Odin", model: false, ...route },
    };
  }
  if (pathname === "/api/substrate") {
    return {
      status: 200,
      body: {
        ok: true,
        quota: QUOTA_LABEL,
        trading: { liveTrading: false, mode: "paper" },
        thalos: { mode: "paper", trades: false },
        payouts: "unavailable",
        hiveRewards: "unavailable",
        custody: "unavailable",
        compute: { enabled: false, mining: false, reputation: "off", hiddenJobs: false },
        connectors: listConnectors(),
        review: REVIEW.map((name) => ({ name, status: "unavailable" })),
        ollama: "https-only",
        motoko: "experiment-only",
        hosting: "github-pages-and-render",
      },
    };
  }
  return null;
}
