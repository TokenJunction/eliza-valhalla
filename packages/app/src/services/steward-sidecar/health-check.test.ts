import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { waitForHealthy } from "./health-check";

function listen(
  respond: () => { status: number; body: unknown },
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    const { status, body } = respond();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          ),
      });
    });
  });
}

it("returns only after a connected health probe reports ok", async () => {
  let calls = 0;
  const server = await listen(() => {
    calls += 1;
    return calls === 1
      ? { status: 200, body: { status: "degraded" } }
      : { status: 200, body: { status: "ok", uptime: 50 } };
  });
  try {
    await waitForHealthy(
      `http://127.0.0.1:${server.port}`,
      new AbortController(),
      {
        timeoutMs: 1_000,
        intervalMs: 10,
        probeTimeoutMs: 500,
      },
    );
    expect(calls).toBe(2);
  } finally {
    await server.close();
  }
});

it("fails with the last degraded probe and does not claim the service is healthy", async () => {
  const server = await listen(() => ({
    status: 200,
    body: { status: "degraded", uptime: 10, freeTierAvailable: true },
  }));
  try {
    await expect(
      waitForHealthy(`http://127.0.0.1:${server.port}`, new AbortController(), {
        timeoutMs: 40,
        intervalMs: 5,
        probeTimeoutMs: 200,
      }),
    ).rejects.toThrow(/degraded: connected service reported degraded/);
  } finally {
    await server.close();
  }
});

it("reports unknown when the probe cannot reach the service", async () => {
  const server = await listen(() => ({ status: 200, body: { status: "ok" } }));
  const { port } = server;
  await server.close();
  await expect(
    waitForHealthy(`http://127.0.0.1:${port}`, new AbortController(), {
      timeoutMs: 30,
      intervalMs: 5,
      probeTimeoutMs: 100,
    }),
  ).rejects.toThrow(/unknown: health probe could not reach the service/);
});
