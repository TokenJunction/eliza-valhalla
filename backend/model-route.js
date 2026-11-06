import { isAllowedOllamaUrl, planRoute } from "./adapters.js";

export const ROUTE_TIMEOUT_MS = 15000;
export const QUOTA_LABEL = "Your provider, your quota";

function contract(fields) {
  return {
    role: fields.role,
    capability: fields.capability,
    provider: fields.provider,
    health: fields.health,
    byok: fields.byok,
    local: fields.local,
    available: fields.available,
    fallback: fields.fallback,
    reason: fields.reason,
    timeoutMs: ROUTE_TIMEOUT_MS,
    mixedWeights: false,
    offline: false,
    completed: false,
    background: false,
    quota: QUOTA_LABEL,
  };
}

function readyCloud(item) {
  return Boolean(item && item.tested && item.secretStored && item.health !== "down");
}

export function modelRoute(providers, request) {
  const source = providers && typeof providers === "object" ? providers : {};
  const role = ["voice", "reasoning", "local", "chat"].includes(request && request.role)
    ? request.role
    : "chat";
  if (role === "local") {
    const ollama = source.ollama;
    const available = Boolean(ollama && ollama.tested && ollama.health === "up" && isAllowedOllamaUrl(ollama.baseUrl));
    return contract({
      role,
      capability: "chat",
      provider: available ? "ollama" : null,
      health: ollama ? ollama.health : "unconfigured",
      byok: false,
      local: true,
      available,
      fallback: false,
      reason: available ? "ok" : "unavailable",
    });
  }
  if (role === "voice" || role === "reasoning") {
    const id = role === "voice" ? "gemini" : "deepseek";
    const item = source[id];
    const available = readyCloud(item);
    return contract({
      role,
      capability: role,
      provider: available ? id : null,
      health: item ? item.health : "unconfigured",
      byok: Boolean(item && item.secretStored),
      local: false,
      available,
      fallback: false,
      reason: available ? "ok" : item && !item.secretStored ? "byok-required" : "unavailable",
    });
  }
  const decision = planRoute(source, { capability: "chat" });
  const item = decision.target ? source[decision.target] : null;
  return contract({
    role: "chat",
    capability: "chat",
    provider: decision.target,
    health: item ? item.health : "unconfigured",
    byok: Boolean(item && item.secretStored),
    local: decision.target === "ollama",
    available: decision.running,
    fallback: decision.fallback,
    reason: decision.running ? "ok" : "unavailable",
  });
}
