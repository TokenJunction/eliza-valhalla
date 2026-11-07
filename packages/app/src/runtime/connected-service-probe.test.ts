import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import {
  classifyHealthPayload,
  probeConnectedService,
} from "./connected-service-probe.js";

it("accepts a real ok payload and drops uptime and free-tier claims", () => {
  const result = classifyHealthPayload({
    httpStatus: 200,
    body: {
      status: "ok",
      uptime: 999_999,
      freeTierAvailable: true,
    },
  });
  expect(result).toEqual({
    state: "ok",
    httpStatus: 200,
    detail: "connected service reported ok",
  });
  expect(result).not.toHaveProperty("uptime");
  expect(result).not.toHaveProperty("freeTierAvailable");
});

it("reports degraded for an explicit degraded body or a failed HTTP status", () => {
  expect(
    classifyHealthPayload({ httpStatus: 200, body: { status: "degraded" } }),
  ).toMatchObject({ state: "degraded" });
  expect(
    classifyHealthPayload({
      httpStatus: 503,
      body: { status: "ok", uptime: 10, freeTierAvailable: true },
    }),
  ).toEqual({
    state: "degraded",
    httpStatus: 503,
    detail: "connected service returned HTTP 503",
  });
});

it("reports unknown when the payload has no known health state", () => {
  expect(
    classifyHealthPayload({ httpStatus: 200, body: { uptime: 12 } }),
  ).toMatchObject({ state: "unknown" });
  expect(classifyHealthPayload({ httpStatus: 200, body: "ok" })).toMatchObject({
    state: "unknown",
  });
});

it("probes a local server and reports unknown when nothing answers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", uptime: 5, freeTierAvailable: true }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const ok = await probeConnectedService(`http://127.0.0.1:${port}/health`, {
      timeoutMs: 1_000,
    });
    expect(ok).toEqual({
      state: "ok",
      httpStatus: 200,
      detail: "connected service reported ok",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const missing = await probeConnectedService(
    `http://127.0.0.1:${port}/health`,
    { timeoutMs: 500 },
  );
  expect(missing).toEqual({
    state: "unknown",
    detail: "health probe could not reach the service",
  });
});
