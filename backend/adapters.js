export const ADAPTER_VERSION = 1;

export const PROVIDER_CATALOG = [
  { id: "ollama", label: "Ollama", local: true, paid: false, pricePer1k: 0, capabilities: ["chat", "local", "free"], defaultBase: "", defaultModel: "llama3.2" },
  { id: "openai", label: "OpenAI-compatible", local: false, paid: true, pricePer1k: 0.15, capabilities: ["chat", "tool-call", "streaming", "cloud", "paid"], defaultBase: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { id: "gemini", label: "Gemini", local: false, paid: true, pricePer1k: 0.1, capabilities: ["chat", "voice", "cloud", "paid"], defaultBase: "https://generativelanguage.googleapis.com", defaultModel: "gemini-2.0-flash" },
  { id: "deepseek", label: "DeepSeek", local: false, paid: true, pricePer1k: 0.07, capabilities: ["chat", "reasoning", "cloud", "paid"], defaultBase: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  { id: "xai", label: "xAI", local: false, paid: true, pricePer1k: 0.2, capabilities: ["chat", "cloud", "paid"], defaultBase: "https://api.x.ai/v1", defaultModel: "grok-2" },
];

export function blankProvider(spec) {
  return {
    id: spec.id,
    version: ADAPTER_VERSION,
    enabled: false,
    tested: false,
    health: "unknown",
    baseUrl: spec.defaultBase,
    model: spec.defaultModel,
    capabilities: spec.capabilities,
    pricePer1k: spec.pricePer1k,
    local: spec.local,
    secretStored: false,
  };
}

export function chooseAdapter(providers, request) {
  const need = request.capability || "chat";
  const budget = Number.isFinite(request.budgetPer1k) ? request.budgetPer1k : Number.POSITIVE_INFINITY;
  const matches = Object.values(providers).filter((item) => item.enabled && item.tested && item.health !== "down" && item.capabilities.includes(need) && item.pricePer1k <= budget);
  matches.sort((a, b) => a.pricePer1k - b.pricePer1k || a.id.localeCompare(b.id));
  return matches[0] || null;
}

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function isAllowedOllamaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return !BLOCKED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function planRoute(providers, request) {
  const capability = request.capability || "chat";
  const ollama = providers.ollama;
  const ollamaReady = Boolean(ollama && ollama.tested && ollama.health === "up" && isAllowedOllamaUrl(ollama.baseUrl) && capability !== "voice" && capability !== "reasoning");
  if (ollamaReady) return { running: true, target: "ollama", missing: [], fallback: false };
  const order = capability === "voice" ? ["gemini"] : capability === "reasoning" ? ["deepseek"] : ["deepseek", "gemini", "xai", "openai"];
  const cloud = order.map((id) => providers[id]).find((item) => item && item.tested && item.secretStored && item.health !== "down" && item.capabilities.includes(capability === "chat" ? "chat" : capability));
  if (cloud) return { running: true, target: cloud.id, missing: [], fallback: true };
  return { running: false, target: null, missing: ollamaReady ? [] : ["ollama", ...order], fallback: false };
}

export async function testProvider(provider, fetchImpl, apiKey) {
  const fetchFn = fetchImpl || fetch;
  try {
    if (provider.id === "ollama") {
      if (!isAllowedOllamaUrl(provider.baseUrl)) return { ok: false, health: "down" };
      const response = await fetchFn(`${provider.baseUrl.replace(/\/$/, "")}/api/tags`);
      return { ok: response.ok, health: response.ok ? "up" : "down" };
    }
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const response = await fetchFn(`${provider.baseUrl.replace(/\/$/, "")}/models`, { headers });
    return { ok: response.ok, health: response.ok ? "up" : "down" };
  } catch {
    return { ok: false, health: "down" };
  }
}
