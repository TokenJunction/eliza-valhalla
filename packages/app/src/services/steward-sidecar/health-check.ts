/**
 * Steward Sidecar - health check polling.
 *
 * Readiness follows a real HTTP probe of the sidecar `/health` route.
 * Success is only `status: "ok"`. Any other completed response is degraded.
 * A timeout, transport failure, or unreadable body is unknown. The probe
 * result does not copy uptime or free-tier fields.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "@elizaos/core";
import {
  type ConnectedServiceProbeResult,
  probeConnectedService,
} from "../../runtime/connected-service-probe";
import { HEALTH_CHECK_INTERVAL_MS, HEALTH_CHECK_TIMEOUT_MS } from "./types";

export interface WaitForHealthyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
}

/**
 * Poll the steward /health endpoint until it returns { status: "ok" }
 * or the timeout is exceeded.
 */
export async function waitForHealthy(
  apiBase: string,
  abort: AbortController,
  options: WaitForHealthyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const startTime = Date.now();
  let last: ConnectedServiceProbeResult = {
    state: "unknown",
    detail: "health probe has not completed",
  };

  while (Date.now() - startTime < timeoutMs) {
    abort.signal.throwIfAborted();
    last = await probeConnectedService(`${apiBase}/health`, {
      fetchImpl: options.fetchImpl,
      signal: abort.signal,
      timeoutMs: options.probeTimeoutMs ?? 2_000,
    });
    if (last.state === "ok") {
      logger.info(`[StewardSidecar] Healthy after ${Date.now() - startTime}ms`);
      return;
    }
    await sleep(intervalMs, undefined, { signal: abort.signal });
  }

  throw new Error(
    `Steward health probe did not report ok within ${timeoutMs}ms (${last.state}: ${last.detail})`,
  );
}
