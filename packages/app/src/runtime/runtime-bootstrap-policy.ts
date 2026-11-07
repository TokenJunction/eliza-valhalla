/**
 * Pure decision helpers for runtime bootstrap failures — no I/O, no runtime
 * dependency. Classifies a boot error as retryable or terminal: fatal PGlite
 * conditions (data-dir in use, corrupt data, manual-reset-required) stop retries
 * immediately, otherwise callers back off via `nextRuntimeBootRetryDelayMs`
 * (exponential, capped at 30s) and expose an error state while retrying once the
 * attempt-count or elapsed-duration threshold is crossed.
 *
 * Recovery is also capped. After the configured attempt or elapsed budget,
 * the helper stops scheduling work. A missing or invalid budget uses the
 * built-in ceiling. A value above the hard ceiling is clamped. Healthy boots
 * do not call this helper.
 */

const FATAL_PGLITE_CODES = new Set([
  "ELIZA_PGLITE_DATA_DIR_IN_USE",
  "ELIZA_PGLITE_CORRUPT_DATA",
  "ELIZA_PGLITE_MANUAL_RESET_REQUIRED",
]);

export const RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD = 3;
export const RUNTIME_BOOT_ERROR_DURATION_MS = 2 * 60_000;
/** Attempts kept when the operator does not set a boot recovery budget. */
export const RUNTIME_BOOT_DEFAULT_MAX_ATTEMPTS = 8;
/** Wall-clock budget kept when the operator does not set one. */
export const RUNTIME_BOOT_DEFAULT_MAX_ELAPSED_MS = 5 * 60_000;
/** Highest attempt count an operator config can request. */
export const RUNTIME_BOOT_HARD_MAX_ATTEMPTS = 12;
/** Highest elapsed budget an operator config can request. */
export const RUNTIME_BOOT_HARD_MAX_ELAPSED_MS = 10 * 60_000;

export interface RuntimeBootRecoveryBudget {
  maxAttempts: number;
  maxElapsedMs: number;
}

const DEFAULT_BOOT_RECOVERY_BUDGET: RuntimeBootRecoveryBudget = {
  maxAttempts: RUNTIME_BOOT_DEFAULT_MAX_ATTEMPTS,
  maxElapsedMs: RUNTIME_BOOT_DEFAULT_MAX_ELAPSED_MS,
};

function readBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Operator boot-recovery caps. `ELIZA_RUNTIME_BOOT_MAX_ATTEMPTS` and
 * `ELIZA_RUNTIME_BOOT_MAX_ELAPSED_MS` tighten or loosen the ceiling inside
 * the hard limits. Invalid text keeps the built-in ceiling so a typo cannot
 * remove the stop.
 */
export function resolveRuntimeBootRecoveryBudget(
  env: Record<string, string | undefined>,
): RuntimeBootRecoveryBudget {
  return {
    maxAttempts: readBoundedInt(
      env.ELIZA_RUNTIME_BOOT_MAX_ATTEMPTS,
      RUNTIME_BOOT_DEFAULT_MAX_ATTEMPTS,
      1,
      RUNTIME_BOOT_HARD_MAX_ATTEMPTS,
    ),
    maxElapsedMs: readBoundedInt(
      env.ELIZA_RUNTIME_BOOT_MAX_ELAPSED_MS,
      RUNTIME_BOOT_DEFAULT_MAX_ELAPSED_MS,
      1_000,
      RUNTIME_BOOT_HARD_MAX_ELAPSED_MS,
    ),
  };
}

export function nextRuntimeBootRetryDelayMs(attempt: number): number {
  const raw = 1000 * 2 ** Math.max(0, Math.min(attempt - 1, 5));
  return Math.min(30_000, raw);
}

function getRuntimeBootErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function resolveRuntimeBootstrapFailure(params: {
  attempt: number;
  err: unknown;
  firstFailureAt: number;
  now: number;
  budget?: RuntimeBootRecoveryBudget;
}): {
  delayMs?: number;
  lastError: string;
  nextRetryAt?: number;
  phase: "runtime-error" | "runtime-retry";
  shouldRetry: boolean;
  state: "error" | "starting";
} {
  const lastError = getRuntimeBootErrorMessage(params.err);
  // A blocked destructive migration cannot succeed on retry: the schema on
  // disk is older than the database. Retrying for five minutes hid the real
  // cause behind "Runtime bootstrap failed" (live 2026-09-12, ~12 min outage).
  if (
    /Destructive migration blocked/i.test(lastError) ||
    (typeof params.err === "object" &&
      params.err !== null &&
      "code" in params.err &&
      FATAL_PGLITE_CODES.has(String(params.err.code)))
  ) {
    return {
      lastError,
      phase: "runtime-error",
      shouldRetry: false,
      state: "error",
    };
  }

  const budget = params.budget ?? DEFAULT_BOOT_RECOVERY_BUDGET;
  const elapsedMs = params.now - params.firstFailureAt;
  if (
    params.attempt >= budget.maxAttempts ||
    elapsedMs >= budget.maxElapsedMs
  ) {
    return {
      lastError: `${lastError} (runtime boot recovery budget exceeded)`,
      phase: "runtime-error",
      shouldRetry: false,
      state: "error",
    };
  }

  const delayMs = nextRuntimeBootRetryDelayMs(params.attempt);
  const shouldMarkError =
    params.attempt >= RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD ||
    elapsedMs >= RUNTIME_BOOT_ERROR_DURATION_MS;

  return {
    delayMs,
    lastError,
    nextRetryAt: params.now + delayMs,
    phase: shouldMarkError ? "runtime-error" : "runtime-retry",
    shouldRetry: true,
    state: shouldMarkError ? "error" : "starting",
  };
}
