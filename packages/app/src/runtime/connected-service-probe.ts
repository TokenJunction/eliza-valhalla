/**
 * Classifies one HTTP health probe of a connected service.
 *
 * `ok` requires an HTTP success response whose JSON body sets `status` to
 * `ok`. `degraded` is an HTTP response that is not that success. `unknown`
 * means this process did not receive a readable health payload. The result
 * never copies uptime, free-tier availability, or any other field from the
 * payload. This module does not call Vercel, Render, Upstash, Supabase, or
 * a model provider, and it does not start Hive.
 */

export type ConnectedServiceProbeState = "ok" | "degraded" | "unknown";

export interface ConnectedServiceProbeResult {
  readonly state: ConnectedServiceProbeState;
  readonly httpStatus?: number;
  readonly detail: string;
}

export function classifyHealthPayload(input: {
  httpStatus: number;
  body: unknown;
}): ConnectedServiceProbeResult {
  if (input.httpStatus < 200 || input.httpStatus >= 300) {
    return {
      state: "degraded",
      httpStatus: input.httpStatus,
      detail: `connected service returned HTTP ${input.httpStatus}`,
    };
  }
  if (
    input.body === null ||
    typeof input.body !== "object" ||
    Array.isArray(input.body)
  ) {
    return {
      state: "unknown",
      httpStatus: input.httpStatus,
      detail: "connected service returned an unreadable health payload",
    };
  }
  const status = (input.body as { status?: unknown }).status;
  if (status === "ok") {
    return {
      state: "ok",
      httpStatus: input.httpStatus,
      detail: "connected service reported ok",
    };
  }
  if (status === "degraded") {
    return {
      state: "degraded",
      httpStatus: input.httpStatus,
      detail: "connected service reported degraded",
    };
  }
  return {
    state: "unknown",
    httpStatus: input.httpStatus,
    detail: "connected service did not report a known health state",
  };
}

export async function probeConnectedService(
  url: string,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<ConnectedServiceProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const response = await fetchImpl(url, { signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return {
        state: "unknown",
        httpStatus: response.status,
        detail: "connected service returned an unreadable health payload",
      };
    }
    return classifyHealthPayload({ httpStatus: response.status, body });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) {
      return {
        state: "unknown",
        detail: "health probe timed out before a response",
      };
    }
    return {
      state: "unknown",
      detail: "health probe could not reach the service",
    };
  }
}
