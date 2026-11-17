import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core";
import project from "../index.ts";
import {
  createSolanaMintPlugin,
  SOLANA_MINT_ACTION,
  SOLANA_MINT_PLUGIN,
  type FetchLike,
} from "../solana-mint.ts";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const METAPLEX_METADATA_ADDRESS =
  "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq";
const USDC_MINT_BYTES = Buffer.from(
  "c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61",
  "hex",
);

function mintAccount(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      program: "spl-token",
      parsed: {
        type: "mint",
        info: {
          decimals: 6,
          supply: "1234567890",
          mintAuthority: null,
          freezeAuthority: null,
          isInitialized: true,
        },
      },
      space: 82,
    },
    executable: false,
    lamports: 1461600,
    owner: TOKEN_PROGRAM,
    rentEpoch: 0,
    space: 82,
    ...overrides,
  };
}

function rpcResult(value: unknown, slot = 321) {
  return { jsonrpc: "2.0", id: 1, result: { context: { slot }, value } };
}

function isBase64AccountRequest(params: unknown): boolean {
  if (!Array.isArray(params)) return false;
  const options = params[1];
  return (
    options !== null &&
    typeof options === "object" &&
    (options as { encoding?: unknown }).encoding === "base64"
  );
}

function fetchMock(
  body: unknown,
  status = 200,
  assetBody: unknown = {},
  metadataAccount: unknown = null,
) {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    let request: { method?: unknown; params?: unknown } = {};
    try {
      request = JSON.parse(String(init?.body)) as {
        method?: unknown;
        params?: unknown;
      };
    } catch {
      request = {};
    }
    const method = typeof request.method === "string" ? request.method : "";
    let responseBody = body;
    if (method === "getAsset") {
      responseBody = assetBody;
    } else if (
      method === "getAccountInfo" &&
      isBase64AccountRequest(request.params)
    ) {
      responseBody = metadataAccount ?? rpcResult(null);
    }
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function redisRateLimitMock(startAt = 1_000) {
  let clock = startAt;
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const calls: Array<{
    url: string;
    body: unknown;
    authorization: string | null;
  }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as unknown[];
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body,
      authorization: headers.get("authorization"),
    });

    if (
      !Array.isArray(body) ||
      body[0] !== "EVAL" ||
      body[2] !== "1" ||
      typeof body[3] !== "string" ||
      typeof body[4] !== "string"
    ) {
      return new Response(JSON.stringify({ error: "bad command" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const key = body[3];
    const windowMs = Number(body[4]);
    let row = windows.get(key);
    if (!row || clock >= row.expiresAt) {
      row = { count: 0, expiresAt: clock + windowMs };
    }
    row.count += 1;
    windows.set(key, row);

    return new Response(
      JSON.stringify({
        result: [row.count, Math.max(0, row.expiresAt - clock)],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  return {
    fetchImpl,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function metaplexAccount(
  overrides: {
    name?: string;
    symbol?: string;
    mintBytes?: Buffer;
    owner?: string;
    key?: number;
  } = {},
) {
  const data = Buffer.concat([
    Buffer.from([overrides.key ?? 4]),
    Buffer.alloc(32),
    overrides.mintBytes ?? USDC_MINT_BYTES,
    borshString(overrides.name ?? "USD Coin"),
    borshString(overrides.symbol ?? "USDC"),
    borshString(""),
  ]);
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      context: { slot: 321 },
      value: {
        data: [data.toString("base64"), "base64"],
        executable: false,
        lamports: 5616720,
        owner: overrides.owner ?? METAPLEX_PROGRAM_ID,
      },
    },
  };
}

function assetResult(
  overrides: {
    name?: string;
    symbol?: string;
    logo?: string;
    files?: unknown[];
  } = {},
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: {
        metadata: {
          name: overrides.name ?? "USD Coin",
          symbol: overrides.symbol ?? "USDC",
        },
        links: { image: overrides.logo ?? "https://example.com/usdc.png" },
        files: overrides.files ?? [],
      },
    },
  };
}

function buildPlugin(fetchImpl: FetchLike, rpcUrl = "https://rpc.example") {
  return createSolanaMintPlugin({
    fetch: fetchImpl,
    rpcUrl,
    timeoutMs: 250,
    rateLimitRedis: null,
  });
}

function actionOf(plugin: Plugin): Action {
  const action = plugin.actions?.find(
    (entry) => entry.name === SOLANA_MINT_ACTION,
  );
  if (!action) throw new Error("Solana mint action not registered");
  return action;
}

function userMessage(text: string): Memory {
  return { content: { text, source: "test" } } as Memory;
}

async function run(
  action: Action,
  text: string,
  options: HandlerOptions = {},
  runtime: IAgentRuntime = {} as IAgentRuntime,
): Promise<{ result: ActionResult; callback: Content | undefined }> {
  let callbackContent: Content | undefined;
  const callback: HandlerCallback = async (content) => {
    callbackContent = content;
    return [];
  };
  const result = await action.handler(
    runtime,
    userMessage(text),
    undefined,
    options,
    callback,
  );
  return { result: result as ActionResult, callback: callbackContent };
}

describe("Solana mint snapshot plugin", () => {
  it("returns a read-only snapshot from getAccountInfo", async () => {
    const { calls, fetchImpl } = fetchMock(rpcResult(mintAccount()));
    const action = actionOf(buildPlugin(fetchImpl));

    const { result, callback } = await run(
      action,
      `Fetch a mint snapshot for ${MINT}.`,
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data.mint).toBe(MINT);
    expect(data.program).toBe(TOKEN_PROGRAM);
    expect(data.decimals).toBe(6);
    expect(data.supplyRaw).toBe("1234567890");
    expect(data.supplyUi).toBe("1234.56789");
    expect(data.mintAuthority).toBeNull();
    expect(data.freezeAuthority).toBeNull();
    expect(data.isInitialized).toBe(true);
    expect(data.slot).toBe(321);
    expect(data.readOnly).toBe(true);
    expect(data.name).toBeNull();
    expect(data.symbol).toBeNull();
    expect(data.logo).toBeNull();
    expect(result.text ?? "").toContain("No transaction was signed or sent.");
    expect(callback?.actions).toContain(SOLANA_MINT_ACTION);

    expect(calls).toHaveLength(3);
    const body = JSON.parse(String(calls[0].init?.body)) as {
      method: string;
      params: [string, { encoding: string }];
    };
    expect(body.method).toBe("getAccountInfo");
    expect(body.params[0]).toBe(MINT);
    expect(body.params[1].encoding).toBe("jsonParsed");
    expect(String(calls[0].init?.body)).not.toContain("sendTransaction");

    const assetBody = JSON.parse(String(calls[1].init?.body)) as {
      method: string;
      params: unknown;
    };
    expect(assetBody.method).toBe("getAsset");
    expect(assetBody.params).toEqual({ id: MINT });

    const fallbackBody = JSON.parse(String(calls[2].init?.body)) as {
      method: string;
      params: [string, { encoding: string; commitment: string }];
    };
    expect(fallbackBody.method).toBe("getAccountInfo");
    expect(fallbackBody.params[0]).toBe(METAPLEX_METADATA_ADDRESS);
    expect(fallbackBody.params[1]).toEqual({
      encoding: "base64",
      commitment: "confirmed",
    });
  });

  it("uses on-chain Metaplex metadata when DAS is unavailable", async () => {
    const { calls, fetchImpl } = fetchMock(
      rpcResult(mintAccount()),
      200,
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no DAS" } },
      metaplexAccount(),
    );
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: "USD Coin",
      symbol: "USDC",
      logo: null,
    });
    expect(calls).toHaveLength(3);
    const fallbackBody = JSON.parse(String(calls[2].init?.body)) as {
      method: string;
      params: [string, { encoding: string }];
    };
    expect(fallbackBody.method).toBe("getAccountInfo");
    expect(fallbackBody.params[0]).toBe(METAPLEX_METADATA_ADDRESS);
  });

  it("ignores Metaplex metadata from the wrong program", async () => {
    const { fetchImpl } = fetchMock(
      rpcResult(mintAccount()),
      200,
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no DAS" } },
      metaplexAccount({ owner: TOKEN_PROGRAM }),
    );
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: null,
      symbol: null,
      logo: null,
    });
  });

  it("includes available token name, symbol and logo", async () => {
    const { fetchImpl } = fetchMock(
      rpcResult(mintAccount()),
      200,
      assetResult({ logo: "https://example.com/usdc-logo.png" }),
    );
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: "USD Coin",
      symbol: "USDC",
      logo: "https://example.com/usdc-logo.png",
    });
    expect(result.text).toContain("Name: USD Coin");
    expect(result.text).toContain("Symbol: USDC");
    expect(result.text).toContain("Logo: https://example.com/usdc-logo.png");
  });

  it("reuses cached mint metadata across repeated snapshots", async () => {
    let clock = 1_000;
    const { calls, fetchImpl } = fetchMock(
      rpcResult(mintAccount()),
      200,
      assetResult(),
    );
    const plugin = createSolanaMintPlugin({
      fetch: fetchImpl,
      rpcUrl: "https://rpc.example",
      timeoutMs: 250,
      rateLimitRedis: null,
      now: () => clock,
    });
    const action = actionOf(plugin);
    const text = `Fetch a mint snapshot for ${MINT}.`;

    const first = await run(action, text);
    expect(first.result.success).toBe(true);
    expect(calls).toHaveLength(2); // mint account + DAS lookup

    const second = await run(action, text);
    expect(second.result.success).toBe(true);
    expect(second.result.data).toMatchObject({
      name: "USD Coin",
      symbol: "USDC",
    });
    expect(calls).toHaveLength(3); // only the mint-account lookup
    const secondBody = JSON.parse(String(calls[2].init?.body)) as {
      method: string;
      params: [string, { encoding: string }];
    };
    expect(secondBody.method).toBe("getAccountInfo");
    expect(secondBody.params[1].encoding).toBe("jsonParsed");

    clock += 60_000;
    const third = await run(action, text);
    expect(third.result.success).toBe(true);
    expect(calls).toHaveLength(5); // cache expired; mint + DAS again
  });

  it("keeps the snapshot when metadata is unavailable or unsafe", async () => {
    const unavailable = fetchMock(rpcResult(mintAccount()), 200, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "no DAS" },
    });
    const unavailableResult = await run(
      actionOf(buildPlugin(unavailable.fetchImpl)),
      `Fetch a mint snapshot for ${MINT}.`,
    );
    expect(unavailableResult.result.success).toBe(true);
    expect(unavailableResult.result.data).toMatchObject({
      name: null,
      symbol: null,
      logo: null,
    });

    const unsafe = fetchMock(
      rpcResult(mintAccount()),
      200,
      assetResult({ logo: "javascript:alert(1)" }),
    );
    const unsafeResult = await run(
      actionOf(buildPlugin(unsafe.fetchImpl)),
      `Fetch a mint snapshot for ${MINT}.`,
    );
    expect(unsafeResult.result.success).toBe(true);
    expect(
      (unsafeResult.result.data as Record<string, unknown>).logo,
    ).toBeNull();
  });

  it("rate limits each agent independently and stops RPC once exhausted", async () => {
    let clock = 1_000;
    const { calls, fetchImpl } = fetchMock(rpcResult(mintAccount()));
    const plugin = createSolanaMintPlugin({
      fetch: fetchImpl,
      rpcUrl: "https://rpc.example",
      timeoutMs: 250,
      rateLimit: { limit: 2, windowMs: 60_000 },
      rateLimitRedis: null,
      now: () => clock,
    });
    const action = actionOf(plugin);
    const zeus = {
      agentId: "agent-zeus",
      character: { username: "zeus" },
    } as IAgentRuntime;
    const cerberus = {
      agentId: "agent-cerberus",
      character: { username: "cerberus" },
    } as IAgentRuntime;
    const text = `Fetch a mint snapshot for ${MINT}.`;

    expect((await run(action, text, {}, zeus)).result.success).toBe(true);
    expect((await run(action, text, {}, zeus)).result.success).toBe(true);

    const blocked = await run(action, text, {}, zeus);
    expect(blocked.result.success).toBe(false);
    expect(blocked.result.error).toBe("rate_limited");
    expect(blocked.result.data).toMatchObject({
      rateLimited: true,
      limit: 2,
      retryAfter: 60,
    });
    expect(blocked.result.text).toContain("Try again in 60 seconds");
    expect(calls).toHaveLength(4);

    // A different agent has its own rate window; metadata is shared cache.
    expect((await run(action, text, {}, cerberus)).result.success).toBe(true);
    expect(calls).toHaveLength(5);

    clock += 60_000;
    expect((await run(action, text, {}, zeus)).result.success).toBe(true);
    expect(calls).toHaveLength(8);
  });

  it("logs rate-limit denials with the agent and retry delay", async () => {
    const warnings: Array<{
      fields: Record<string, unknown>;
      message?: string;
    }> = [];
    const { fetchImpl } = fetchMock(rpcResult(mintAccount()));
    const plugin = createSolanaMintPlugin({
      fetch: fetchImpl,
      rpcUrl: "https://rpc.example",
      timeoutMs: 250,
      rateLimit: { limit: 1, windowMs: 60_000 },
      rateLimitRedis: null,
      now: () => 1_000,
    });
    const runtime = {
      agentId: "agent-zeus",
      character: { username: "zeus", name: "Zeus" },
      logger: {
        warn: (fields: Record<string, unknown>, message?: string) => {
          warnings.push({ fields, message });
        },
      },
    } as unknown as IAgentRuntime;
    const action = actionOf(plugin);
    const text = `Fetch a mint snapshot for ${MINT}.`;

    expect((await run(action, text, {}, runtime)).result.success).toBe(true);
    expect(warnings).toHaveLength(0);

    const blocked = await run(action, text, {}, runtime);
    expect(blocked.result.error).toBe("rate_limited");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe("Solana mint snapshot rate limited");
    expect(warnings[0].fields).toMatchObject({
      src: "solana-mint",
      event: "mint_snapshot_rate_limited",
      agent: "agent-zeus",
      agentName: "Zeus",
      retryAfter: 60,
      limit: 1,
      windowMs: 60_000,
      backend: "memory",
    });
  });

  it("shares Redis rate budgets across plugin instances", async () => {
    const redis = redisRateLimitMock();
    const firstRpc = fetchMock(rpcResult(mintAccount()));
    const secondRpc = fetchMock(rpcResult(mintAccount()));
    const redisOptions = {
      url: "https://redis.example/",
      token: "test-token",
      fetch: redis.fetchImpl,
    };
    const makeAction = (fetchImpl: FetchLike) =>
      actionOf(
        createSolanaMintPlugin({
          fetch: fetchImpl,
          rpcUrl: "https://rpc.example",
          timeoutMs: 250,
          rateLimit: { limit: 2, windowMs: 60_000 },
          rateLimitRedis: redisOptions,
          now: () => 1_000,
        }),
      );
    const first = makeAction(firstRpc.fetchImpl);
    const second = makeAction(secondRpc.fetchImpl);
    const runtime = { agentId: "agent-zeus" } as IAgentRuntime;
    const text = `Fetch a mint snapshot for ${MINT}.`;

    expect((await run(first, text, {}, runtime)).result.success).toBe(true);
    expect((await run(second, text, {}, runtime)).result.success).toBe(true);

    const blocked = await run(first, text, {}, runtime);
    expect(blocked.result.success).toBe(false);
    expect(blocked.result.error).toBe("rate_limited");
    expect(blocked.result.data).toMatchObject({
      rateLimited: true,
      limit: 2,
      retryAfter: 60,
    });
    expect(redis.calls).toHaveLength(3);
    const firstCall = redis.calls[0];
    expect(firstCall.url).toBe("https://redis.example");
    expect(firstCall.authorization).toBe("Bearer test-token");
    const command = firstCall.body as unknown[];
    expect(command[0]).toBe("EVAL");
    expect(command[2]).toBe("1");
    expect(String(command[3])).toContain("agent-zeus");
    expect(command[4]).toBe("60000");

    const cerberus = { agentId: "agent-cerberus" } as IAgentRuntime;
    expect((await run(second, text, {}, cerberus)).result.success).toBe(true);

    redis.advance(60_000);
    expect((await run(second, text, {}, runtime)).result.success).toBe(true);
    expect(redis.calls).toHaveLength(5);
  });

  it("fails closed when the Redis rate-limit store is unavailable", async () => {
    const rpc = fetchMock(rpcResult(mintAccount()));
    const redisFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const plugin = createSolanaMintPlugin({
      fetch: rpc.fetchImpl,
      rpcUrl: "https://rpc.example",
      timeoutMs: 250,
      rateLimit: { limit: 2, windowMs: 60_000 },
      rateLimitRedis: {
        url: "https://redis.example",
        token: "test-token",
        fetch: redisFetch,
      },
    });

    const errors: Array<{
      fields: Record<string, unknown>;
      message?: string;
    }> = [];
    const runtime = {
      agentId: "agent-zeus",
      character: { username: "zeus", name: "Zeus" },
      logger: {
        error: (fields: Record<string, unknown>, message?: string) => {
          errors.push({ fields, message });
        },
      },
    } as unknown as IAgentRuntime;
    const { result } = await run(
      actionOf(plugin),
      `Fetch a mint snapshot for ${MINT}.`,
      {},
      runtime,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("rate_limit_unavailable");
    expect(result.data).toMatchObject({
      rateLimitUnavailable: true,
      retryAfter: 5,
    });
    expect(result.text).toContain("temporarily unavailable");
    expect(rpc.calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].fields).toMatchObject({
      src: "solana-mint",
      event: "mint_snapshot_rate_limit_unavailable",
      agent: "agent-zeus",
      agentName: "Zeus",
      retryAfter: 5,
      backend: "redis",
    });
  });

  it("rejects invalid rate-limit configuration", () => {
    expect(() => createSolanaMintPlugin({ rateLimit: { limit: 0 } })).toThrow(
      "invalid_rate_limit",
    );
    expect(() =>
      createSolanaMintPlugin({ rateLimit: { windowMs: 0 } }),
    ).toThrow("invalid_rate_window");
    expect(() =>
      createSolanaMintPlugin({
        rateLimitRedis: { url: "http://redis.example", token: "token" },
      }),
    ).toThrow("invalid_rate_limit_redis");
    expect(() =>
      createSolanaMintPlugin({
        rateLimitRedis: { url: "https://redis.example", token: "" },
      }),
    ).toThrow("invalid_rate_limit_redis");
  });

  it("accepts a structured mint parameter", async () => {
    const { calls, fetchImpl } = fetchMock(rpcResult(mintAccount()));
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, "snapshot this", { mint: MINT });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("supports Token-2022 mints", async () => {
    const { fetchImpl } = fetchMock(
      rpcResult(mintAccount({ owner: TOKEN_2022_PROGRAM })),
    );
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).program).toBe(
      TOKEN_2022_PROGRAM,
    );
  });

  it("rejects an account that is not a mint", async () => {
    const { fetchImpl } = fetchMock(
      rpcResult(
        mintAccount({
          data: {
            program: "spl-token",
            parsed: { type: "account", info: {} },
            space: 165,
          },
        }),
      ),
    );
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);

    expect(result.success).toBe(false);
    expect(result.error).toBe("not_a_mint");
  });

  it("rejects a missing or malformed mint without calling RPC", async () => {
    const { calls, fetchImpl } = fetchMock(rpcResult(mintAccount()));
    const action = actionOf(buildPlugin(fetchImpl));

    const missing = await run(action, "Fetch a mint snapshot.");
    expect(missing.result.success).toBe(false);
    expect(missing.result.error).toBe("mint_address_required");

    const malformed = await run(action, "Fetch a mint snapshot.", {
      mint: "not-a-mint",
    });
    expect(malformed.result.success).toBe(false);
    expect(malformed.result.error).toBe("invalid_mint_address");
    expect(calls).toHaveLength(0);
  });

  it("returns a safe error when the RPC fails", async () => {
    const { fetchImpl } = fetchMock({ error: "provider-secret" }, 500);
    const action = actionOf(buildPlugin(fetchImpl));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);
    const text = result.text ?? "";

    expect(result.success).toBe(false);
    expect(result.error).toBe("mint_lookup_failed");
    expect(text).not.toContain("rpc.example");
    expect(text).not.toContain("provider-secret");
  });

  it("refuses a non-HTTPS RPC URL", async () => {
    const { calls, fetchImpl } = fetchMock(rpcResult(mintAccount()));
    const action = actionOf(buildPlugin(fetchImpl, "http://rpc.example"));

    const { result } = await run(action, `Fetch a mint snapshot for ${MINT}.`);

    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_rpc_url");
    expect(calls).toHaveLength(0);
  });

  it("validates only mint-snapshot intent", async () => {
    const action = actionOf(buildPlugin(fetchMock({}).fetchImpl));
    const runtime = {} as IAgentRuntime;

    expect(
      await action.validate(
        runtime,
        userMessage(`Fetch a mint snapshot for ${MINT}.`),
      ),
    ).toBe(true);
    expect(await action.validate(runtime, userMessage("hello"))).toBe(false);
    expect(await action.validate(runtime, userMessage("What is a mint?"))).toBe(
      false,
    );
  });

  it("is registered only for Zeus, Cerberus and Gorgo", () => {
    const byRole = new Map(
      project.agents.map((agent) => [agent.character.username, agent]),
    );

    for (const role of ["zeus", "cerberus", "gorgo"]) {
      const names =
        byRole.get(role)?.plugins?.map((plugin) => plugin.name) ?? [];
      expect(names).toContain(SOLANA_MINT_PLUGIN);
    }

    for (const role of [
      "odin",
      "wren",
      "valkyrie",
      "sentinel",
      "forge",
      "ahti",
      "hermod",
      "norns",
      "gwen",
      "merlin",
    ]) {
      const names =
        byRole.get(role)?.plugins?.map((plugin) => plugin.name) ?? [];
      expect(names).not.toContain(SOLANA_MINT_PLUGIN);
    }
  });

  it("contains no signing or transaction-submission imports", () => {
    const source = readFileSync(
      new URL("../solana-mint.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /sendTransaction|signTransaction|Keypair|VersionedTransaction|@solana\/web3\.js/,
    );
  });
});
