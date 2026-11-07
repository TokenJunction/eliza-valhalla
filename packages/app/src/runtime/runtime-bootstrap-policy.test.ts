import { expect, it } from "vitest";
import {
  nextRuntimeBootRetryDelayMs,
  RUNTIME_BOOT_DEFAULT_MAX_ATTEMPTS,
  RUNTIME_BOOT_DEFAULT_MAX_ELAPSED_MS,
  RUNTIME_BOOT_HARD_MAX_ATTEMPTS,
  RUNTIME_BOOT_HARD_MAX_ELAPSED_MS,
  resolveRuntimeBootRecoveryBudget,
  resolveRuntimeBootstrapFailure,
} from "./runtime-bootstrap-policy.js";

it("keeps the existing backoff while the recovery budget remains", () => {
  const budget = resolveRuntimeBootRecoveryBudget({});
  expect(budget).toEqual({
    maxAttempts: RUNTIME_BOOT_DEFAULT_MAX_ATTEMPTS,
    maxElapsedMs: RUNTIME_BOOT_DEFAULT_MAX_ELAPSED_MS,
  });
  for (const attempt of [1, 2, 3, 4, 5]) {
    const failure = resolveRuntimeBootstrapFailure({
      attempt,
      budget,
      err: new Error("temporary provider outage"),
      firstFailureAt: 0,
      now: 1_000,
    });
    expect(failure.shouldRetry).toBe(true);
    expect(failure.delayMs).toBe(nextRuntimeBootRetryDelayMs(attempt));
    expect(failure.nextRetryAt).toBe(1_000 + (failure.delayMs ?? 0));
    expect(failure.state).toBe(attempt >= 3 ? "error" : "starting");
  }
});

it("stops scheduling work when the configured attempt budget is spent", () => {
  const failure = resolveRuntimeBootstrapFailure({
    attempt: 4,
    budget: { maxAttempts: 4, maxElapsedMs: 60_000 },
    err: new Error("temporary provider outage"),
    firstFailureAt: 0,
    now: 1_000,
  });
  expect(failure).toEqual({
    lastError:
      "temporary provider outage (runtime boot recovery budget exceeded)",
    phase: "runtime-error",
    shouldRetry: false,
    state: "error",
  });
});

it("stops scheduling work when the elapsed budget is spent", () => {
  const failure = resolveRuntimeBootstrapFailure({
    attempt: 1,
    budget: { maxAttempts: 8, maxElapsedMs: 5_000 },
    err: "boot still failing",
    firstFailureAt: 10_000,
    now: 15_000,
  });
  expect(failure.shouldRetry).toBe(false);
  expect(failure.delayMs).toBeUndefined();
  expect(failure.lastError).toContain("recovery budget exceeded");
});

it("clamps an oversized operator budget and ignores invalid text", () => {
  expect(
    resolveRuntimeBootRecoveryBudget({
      ELIZA_RUNTIME_BOOT_MAX_ATTEMPTS: "1000",
      ELIZA_RUNTIME_BOOT_MAX_ELAPSED_MS: "999999999",
    }),
  ).toEqual({
    maxAttempts: RUNTIME_BOOT_HARD_MAX_ATTEMPTS,
    maxElapsedMs: RUNTIME_BOOT_HARD_MAX_ELAPSED_MS,
  });
  expect(
    resolveRuntimeBootRecoveryBudget({
      ELIZA_RUNTIME_BOOT_MAX_ATTEMPTS: "forever",
      ELIZA_RUNTIME_BOOT_MAX_ELAPSED_MS: "0",
    }),
  ).toEqual({
    maxAttempts: RUNTIME_BOOT_DEFAULT_MAX_ATTEMPTS,
    maxElapsedMs: 1_000,
  });
});

it("still refuses a fatal database failure before the budget can retry it", () => {
  const failure = resolveRuntimeBootstrapFailure({
    attempt: 1,
    budget: { maxAttempts: 8, maxElapsedMs: 60_000 },
    err: Object.assign(new Error("database is in use"), {
      code: "ELIZA_PGLITE_DATA_DIR_IN_USE",
    }),
    firstFailureAt: 0,
    now: 1,
  });
  expect(failure).toMatchObject({
    lastError: "database is in use",
    phase: "runtime-error",
    shouldRetry: false,
    state: "error",
  });
});
