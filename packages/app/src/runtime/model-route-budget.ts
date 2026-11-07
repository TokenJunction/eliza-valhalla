/**
 * Process-local cap for optional model probes and paid route admission.
 *
 * `ELIZA_MODEL_ROUTE_MAX_CALLS` is optional. When it is unset, admission and
 * probes keep their existing behavior. When it is set, each optional model
 * probe consumes one call. A paid provider route is refused once the count
 * reaches the cap, including a cap of zero. Invalid text fails closed at
 * zero so it cannot mean unlimited calls. Values above the hard ceiling are
 * clamped. This module does not price a provider, does not report free-tier
 * availability, and does not start Hive or enable Hive revenue.
 */

const HARD_MAX_CALLS = 8;
let spentCalls = 0;

function parseCap(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, HARD_MAX_CALLS);
}

/** Configured cap, or null when the operator did not set one. */
export function resolveModelRouteCallCap(
  env: Record<string, string | undefined>,
): number | null {
  return parseCap(env.ELIZA_MODEL_ROUTE_MAX_CALLS);
}

export function resetModelRouteBudgetForTests(): void {
  spentCalls = 0;
}

/**
 * True when a configured cap has no calls left. An unset cap does not block.
 */
export function modelRouteBudgetBlocksPaidRoute(
  env: Record<string, string | undefined>,
): boolean {
  const cap = parseCap(env.ELIZA_MODEL_ROUTE_MAX_CALLS);
  if (cap === null) return false;
  return spentCalls >= cap;
}

/**
 * Reserves one optional model probe. An unset cap allows the call and does
 * not count it. A spent cap returns false and does not call a provider.
 */
export function consumeModelRouteCall(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const cap = parseCap(env.ELIZA_MODEL_ROUTE_MAX_CALLS);
  if (cap === null) return true;
  if (spentCalls >= cap) return false;
  spentCalls += 1;
  return true;
}
