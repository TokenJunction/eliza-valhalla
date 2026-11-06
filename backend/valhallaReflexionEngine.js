let seq = 0;

export function createReflexion(store) {
  async function onFailure(event) {
    const rule = {
      id: `rule-${Date.now()}-${seq += 1}`,
      pattern: String(event.errorCode || "unknown").slice(0, 120),
      correction: String(event.safeHint || "Review the failed step.").slice(0, 500),
      active: false,
      embedding: null,
      createdAt: new Date().toISOString(),
    };
    await store.insertRule(rule);
    return rule;
  }

  async function activate(id, body) {
    if (!body || body.activate !== true) {
      return { ok: false, status: 400, error: "explicit-activation-required" };
    }
    const rule = await store.setRuleActive(id, true);
    if (!rule) return { ok: false, status: 404, error: "missing" };
    return { ok: true, rule };
  }

  return { onFailure, activate };
}
