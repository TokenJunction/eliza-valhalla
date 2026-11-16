import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IAgentRuntime,
  Plugin,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import project from "../index.ts";
import {
  AI_ROOM_ID,
  AI_ROOM_MEMBERS,
  AI_ROOM_TOKEN_ENV,
  AiRoomAuditLog,
  AiRoomStore,
  createAiRoomPlugin,
  roomConfigured,
  type AiRoomAuditEntry,
  type AiRoomMessage,
} from "../ai-room.ts";

const TOKENS = {
  zeus: "z".repeat(48),
  cerberus: "c".repeat(48),
  gorgo: "g".repeat(48),
};

function roomEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [AI_ROOM_TOKEN_ENV.zeus]: TOKENS.zeus,
    [AI_ROOM_TOKEN_ENV.cerberus]: TOKENS.cerberus,
    [AI_ROOM_TOKEN_ENV.gorgo]: TOKENS.gorgo,
    ...overrides,
  };
}

function responseHarness() {
  let statusCode = 0;
  const headers: Record<string, string> = {};
  let body: unknown;
  const response: RouteResponse = {
    setHeader(name, value) {
      headers[name] = Array.isArray(value) ? value.join(",") : value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      body = data;
      return this;
    },
    send(data) {
      body = data;
      return this;
    },
    end() {
      return this;
    },
  };
  return { response, result: () => ({ statusCode, headers, body }) };
}

function request(
  options: {
    token?: string;
    body?: unknown;
    query?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
  } = {},
): RouteRequest {
  const headers: Record<string, string | string[] | undefined> = {
    ...(options.headers ?? {}),
  };
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  return {
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.query ? { query: options.query } : {}),
  };
}

function routeOf(plugin: Plugin, name: string) {
  const route = plugin.routes?.find((entry) => entry.name === name);
  if (!route?.handler) throw new Error(`missing route ${name}`);
  return route;
}

async function invoke(
  plugin: Plugin,
  name: string,
  req: RouteRequest,
  runtime: IAgentRuntime = {} as IAgentRuntime,
) {
  const route = routeOf(plugin, name);
  const harness = responseHarness();
  await route.handler(req, harness.response, runtime);
  return harness.result();
}

function freshPlugin(store = new AiRoomStore()) {
  const auditLog = new AiRoomAuditLog({ file: null });
  return {
    plugin: createAiRoomPlugin({ env: roomEnv(), store, auditLog }),
    store,
    auditLog,
  };
}

type RoomInfoBody = {
  ok: boolean;
  room: {
    id: string;
    members: string[];
    membership: string;
    mode: string;
  };
  member: string;
  messageCount: number;
  actions: string;
  autonomous: boolean;
};

type SendBody = {
  ok: boolean;
  roomId: string;
  member: string;
  message: AiRoomMessage;
  actions: string;
  autonomous: boolean;
};

type ReadBody = {
  ok: boolean;
  roomId: string;
  member: string;
  messages: AiRoomMessage[];
  next: number;
  actions: string;
  autonomous: boolean;
};

type AuditBody = {
  ok: boolean;
  roomId: string;
  member: string;
  entries: AiRoomAuditEntry[];
  next: number;
  auditCount: number;
  actions: string;
  autonomous: boolean;
};

describe("Valhalla AI room", () => {
  it("requires a distinct strong key for every fixed member", () => {
    expect(roomConfigured(roomEnv())).toBe(true);
    expect(roomConfigured(roomEnv({ [AI_ROOM_TOKEN_ENV.gorgo]: "" }))).toBe(
      false,
    );
    expect(
      roomConfigured(roomEnv({ [AI_ROOM_TOKEN_ENV.gorgo]: "short" })),
    ).toBe(false);
    expect(
      roomConfigured(roomEnv({ [AI_ROOM_TOKEN_ENV.gorgo]: TOKENS.zeus })),
    ).toBe(false);
  });

  it("rejects missing, malformed and unknown bearer tokens", async () => {
    const { plugin } = freshPlugin();
    for (const req of [
      request(),
      request({ token: "short" }),
      request({ token: "x".repeat(48) }),
      request({ headers: { authorization: "Basic abc" } }),
    ]) {
      const result = await invoke(plugin, "valhalla-ai-room-info", req);
      expect(result.statusCode).toBe(401);
      expect(result.body).toEqual({ ok: false, error: "unauthorized" });
      expect(result.headers["WWW-Authenticate"]).toContain("Bearer");
    }
  });

  it("protects every room route with the same membership check", async () => {
    const { plugin } = freshPlugin();
    for (const [name, req] of [
      ["valhalla-ai-room-info", request()],
      ["valhalla-ai-room-send", request({ body: { text: "hello" } })],
      ["valhalla-ai-room-read", request()],
      ["valhalla-ai-room-audit", request()],
    ] as const) {
      const result = await invoke(plugin, name, req);
      expect(result.statusCode).toBe(401);
      expect(result.body).toEqual({ ok: false, error: "unauthorized" });
    }
  });

  it("derives each member identity from its own key", async () => {
    const { plugin, store } = freshPlugin();
    store.append("zeus", "existing");

    for (const role of AI_ROOM_MEMBERS) {
      const result = await invoke(
        plugin,
        "valhalla-ai-room-info",
        request({ token: TOKENS[role] }),
      );
      expect(result.statusCode).toBe(200);
      const body = result.body as RoomInfoBody;
      expect(body.member).toBe(role);
      expect(body.room).toEqual({
        id: AI_ROOM_ID,
        members: [...AI_ROOM_MEMBERS],
        membership: "server_enforced",
        mode: "relay_only",
      });
      expect(body.messageCount).toBe(1);
      expect(body.actions).toBe("disabled");
      expect(result.headers["Cache-Control"]).toBe("no-store");
      expect(result.headers.Vary).toBe("Authorization");
      expect(body.autonomous).toBe(false);
    }
  });

  it("relays messages in one room and supports a read cursor", async () => {
    const { plugin } = freshPlugin();

    const firstResult = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.zeus,
        body: { text: "Zeus: paper mode is active." },
      }),
    );
    expect(firstResult.statusCode).toBe(201);
    const first = firstResult.body as SendBody;
    expect(first.message.from).toBe("zeus");
    expect(first.message.seq).toBe(1);
    expect(first.message).not.toHaveProperty("to");
    expect(first.actions).toBe("disabled");
    expect(first.autonomous).toBe(false);

    const secondResult = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.cerberus,
        body: {
          text: "Cerberus: no privileged action was requested.",
          replyTo: first.message.id,
        },
      }),
    );
    expect(secondResult.statusCode).toBe(201);
    const second = secondResult.body as SendBody;
    expect(second.message.from).toBe("cerberus");
    expect(second.message.seq).toBe(2);
    expect(second.message.replyTo).toBe(first.message.id);

    const readResult = await invoke(
      plugin,
      "valhalla-ai-room-read",
      request({ token: TOKENS.gorgo }),
    );
    expect(readResult.statusCode).toBe(200);
    const read = readResult.body as ReadBody;
    expect(read.roomId).toBe(AI_ROOM_ID);
    expect(read.member).toBe("gorgo");
    expect(read.messages.map((message) => message.from)).toEqual([
      "zeus",
      "cerberus",
    ]);
    expect(read.next).toBe(2);

    const tailResult = await invoke(
      plugin,
      "valhalla-ai-room-read",
      request({ token: TOKENS.zeus, query: { after: "1", limit: "1" } }),
    );
    expect(tailResult.statusCode).toBe(200);
    const tail = tailResult.body as ReadBody;
    expect(tail.messages).toHaveLength(1);
    expect(tail.messages[0].from).toBe("cerberus");
    expect(tail.next).toBe(2);
  });

  it("server-assigns the sender and rejects addressing or action fields", async () => {
    const { plugin, store } = freshPlugin();
    const forbiddenBodies = [
      { text: "hello", from: "cerberus" },
      { text: "hello", sender: "cerberus" },
      { text: "hello", member: "cerberus" },
      { text: "hello", to: "odin" },
      { text: "hello", recipient: "odin" },
      { text: "hello", agent: "odin" },
      { text: "hello", roomId: "other-room" },
      { text: "hello", action: "trade" },
      { text: "hello", command: "withdraw" },
    ];

    for (const body of forbiddenBodies) {
      const result = await invoke(
        plugin,
        "valhalla-ai-room-send",
        request({ token: TOKENS.zeus, body }),
      );
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({
        ok: false,
        error: "unsupported_field",
      });
    }
    expect(store.size).toBe(0);
  });

  it("never invokes an agent or an action while relaying", async () => {
    const { plugin } = freshPlugin();
    let modelCalled = false;
    const runtime = {
      messageService: {
        handleMessage: async () => {
          modelCalled = true;
          throw new Error("the room must not invoke an agent");
        },
      },
    } as unknown as IAgentRuntime;

    const result = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.zeus,
        body: { text: "Please execute a trade." },
      }),
      runtime,
    );

    expect(result.statusCode).toBe(201);
    expect(modelCalled).toBe(false);
    expect(plugin.actions).toBeUndefined();
    expect(plugin.events).toBeUndefined();
    expect(plugin.providers).toBeUndefined();
    expect(plugin.services).toBeUndefined();
  });

  it("validates message text, reply targets and read cursors", async () => {
    const { plugin } = freshPlugin();

    const empty = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ token: TOKENS.zeus, body: { text: "   " } }),
    );
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toMatchObject({ error: "text_required" });

    const tooLong = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ token: TOKENS.zeus, body: { text: "x".repeat(2_001) } }),
    );
    expect(tooLong.statusCode).toBe(413);
    expect(tooLong.body).toMatchObject({ error: "text_too_long" });

    const control = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ token: TOKENS.zeus, body: { text: "hello\u0000" } }),
    );
    expect(control.statusCode).toBe(400);
    expect(control.body).toMatchObject({ error: "invalid_text" });

    const badReply = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.zeus,
        body: { text: "hello", replyTo: "not-a-uuid" },
      }),
    );
    expect(badReply.statusCode).toBe(400);
    expect(badReply.body).toMatchObject({ error: "invalid_reply_to" });

    const nonStringReply = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ token: TOKENS.zeus, body: { text: "hello", replyTo: 123 } }),
    );
    expect(nonStringReply.statusCode).toBe(400);
    expect(nonStringReply.body).toMatchObject({ error: "invalid_reply_to" });

    const missingReply = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.zeus,
        body: {
          text: "hello",
          replyTo: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );
    expect(missingReply.statusCode).toBe(400);
    expect(missingReply.body).toMatchObject({ error: "reply_to_not_found" });

    for (const query of [{ after: "abc" }, { limit: "0" }, { limit: "101" }]) {
      const result = await invoke(
        plugin,
        "valhalla-ai-room-read",
        request({ token: TOKENS.zeus, query }),
      );
      expect(result.statusCode).toBe(400);
    }
  });

  it("fails closed when the room keys are incomplete or reused", async () => {
    for (const env of [
      roomEnv({ [AI_ROOM_TOKEN_ENV.gorgo]: "" }),
      roomEnv({ [AI_ROOM_TOKEN_ENV.gorgo]: TOKENS.zeus }),
    ]) {
      const plugin = createAiRoomPlugin({ env, store: new AiRoomStore() });
      const result = await invoke(
        plugin,
        "valhalla-ai-room-info",
        request({ token: TOKENS.zeus }),
      );
      expect(result.statusCode).toBe(503);
      expect(result.body).toEqual({ ok: false, error: "room_not_configured" });
    }
  });

  it("keeps the in-memory relay bounded", () => {
    const store = new AiRoomStore(2);
    store.append("zeus", "one");
    const first = store.append("cerberus", "two");
    store.append("gorgo", "three");

    expect(store.size).toBe(2);
    expect(store.list(0, 10).map((message) => message.seq)).toEqual([2, 3]);
    expect(store.has(first.id)).toBe(true);
    expect(store.list(0, 10).map((message) => message.text)).toEqual([
      "two",
      "three",
    ]);
  });

  it("replays history through a fresh room plugin instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-history-"));
    try {
      const file = join(dir, "messages.jsonl");
      const env = roomEnv({ VALHALLA_ROOM_HISTORY_FILE: file });
      const firstPlugin = createAiRoomPlugin({
        env,
        auditFile: null,
      });
      const sent = await invoke(
        firstPlugin,
        "valhalla-ai-room-send",
        request({ token: TOKENS.zeus, body: { text: "survives restart" } }),
      );
      expect(sent.statusCode).toBe(201);
      const sentBody = sent.body as SendBody;

      const secondPlugin = createAiRoomPlugin({
        env,
        auditFile: null,
      });
      const read = await invoke(
        secondPlugin,
        "valhalla-ai-room-read",
        request({ token: TOKENS.gorgo }),
      );
      expect(read.statusCode).toBe(200);
      const readBody = read.body as ReadBody;
      expect(readBody.messages).toEqual([sentBody.message]);
      expect(readBody.next).toBe(1);

      const next = await invoke(
        secondPlugin,
        "valhalla-ai-room-send",
        request({ token: TOKENS.cerberus, body: { text: "next sequence" } }),
      );
      expect((next.body as SendBody).message.seq).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores message history and sequence after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-history-"));
    try {
      const file = join(dir, "messages.jsonl");
      const firstStore = new AiRoomStore(200, { file });
      const first = firstStore.append("zeus", "one");
      const second = firstStore.append("cerberus", "two", first.id);

      const secondStore = new AiRoomStore(200, { file });
      expect(secondStore.size).toBe(2);
      expect(secondStore.list(0, 10)).toEqual([first, second]);
      expect(secondStore.has(first.id)).toBe(true);

      const third = secondStore.append("gorgo", "three");
      expect(third.seq).toBe(3);
      const thirdStore = new AiRoomStore(200, { file });
      expect(thirdStore.list(0, 10).map((message) => message.text)).toEqual([
        "one",
        "two",
        "three",
      ]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the history bounded and ignores only a partial final line", () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-history-"));
    try {
      const file = join(dir, "messages.jsonl");
      const store = new AiRoomStore(2, { file });
      store.append("zeus", "one");
      store.append("cerberus", "two");
      store.append("gorgo", "three");

      const replayed = new AiRoomStore(2, { file });
      expect(replayed.size).toBe(2);
      expect(replayed.list(0, 10).map((message) => message.seq)).toEqual([
        2, 3,
      ]);
      expect(replayed.append("zeus", "four").seq).toBe(4);

      appendFileSync(file, '{"id":');
      const afterPartial = new AiRoomStore(2, { file });
      expect(afterPartial.size).toBe(2);
      expect(afterPartial.list(0, 10).map((message) => message.text)).toEqual([
        "three",
        "four",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when durable history is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-history-"));
    try {
      const file = join(dir, "messages.jsonl");
      writeFileSync(file, "not-json\n");
      expect(() => new AiRoomStore(200, { file })).toThrow(
        "invalid_history_file",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 503 and does not acknowledge a message when persistence fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-history-"));
    try {
      const blocker = join(dir, "not-a-directory");
      writeFileSync(blocker, "x");
      const store = new AiRoomStore(200, {
        file: join(blocker, "messages.jsonl"),
      });
      const plugin = createAiRoomPlugin({
        env: roomEnv(),
        store,
        auditLog: new AiRoomAuditLog({ file: null }),
      });
      const result = await invoke(
        plugin,
        "valhalla-ai-room-send",
        request({ token: TOKENS.zeus, body: { text: "cannot persist" } }),
      );
      expect(result.statusCode).toBe(503);
      expect(result.body).toEqual({
        ok: false,
        error: "history_unavailable",
      });
      expect(store.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the audit trail after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-audit-"));
    try {
      const file = join(dir, "audit.jsonl");
      const first = new AiRoomAuditLog({ file });
      const sent = first.append({
        member: "zeus",
        event: "message_sent",
        outcome: "allowed",
        messageSeq: 1,
      });
      first.append({
        member: "cerberus",
        event: "message_rejected",
        outcome: "rejected",
        reason: "history_unavailable",
      });

      const replayed = new AiRoomAuditLog({ file });
      expect(replayed.size).toBe(2);
      expect(replayed.list(0, 10)).toEqual([
        sent,
        expect.objectContaining({ seq: 2, member: "cerberus" }),
      ]);
      expect(
        replayed.append({
          member: "gorgo",
          event: "audit_read",
          outcome: "allowed",
        }).seq,
      ).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rate-limits each member independently and records the denial", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const auditLog = new AiRoomAuditLog({ file: null });
    const plugin = createAiRoomPlugin({
      env: roomEnv(),
      auditLog,
      historyFile: null,
      now: () => clock,
      rateLimits: { send: { limit: 2, windowMs: 60_000 } },
    });

    const send = (role: keyof typeof TOKENS, text: string) =>
      invoke(
        plugin,
        "valhalla-ai-room-send",
        request({ token: TOKENS[role], body: { text } }),
      );

    expect((await send("zeus", "one")).statusCode).toBe(201);
    expect((await send("zeus", "two")).statusCode).toBe(201);

    const blocked = await send("zeus", "three");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toMatchObject({
      ok: false,
      error: "rate_limited",
      bucket: "send",
      actions: "disabled",
      autonomous: false,
    });
    expect(blocked.headers["Retry-After"]).toBe("60");
    expect(blocked.headers["RateLimit-Remaining"]).toBe("0");

    // The limiter is per member, not global.
    expect((await send("cerberus", "still allowed")).statusCode).toBe(201);

    clock = new Date(clock.getTime() + 60_001);
    expect((await send("zeus", "new window")).statusCode).toBe(201);

    const limited = auditLog
      .list(0, 100)
      .filter((entry) => entry.event === "rate_limited");
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      member: "zeus",
      outcome: "rejected",
      reason: "rate_limited",
    });
    expect(limited[0].details).toMatchObject({
      bucket: "send",
      retryAfter: 60,
    });
  });

  it("rate-limits reads and audit queries independently", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const auditLog = new AiRoomAuditLog({ file: null });
    const plugin = createAiRoomPlugin({
      env: roomEnv(),
      auditLog,
      historyFile: null,
      now: () => clock,
      rateLimits: {
        read: { limit: 1, windowMs: 60_000 },
        audit: { limit: 1, windowMs: 60_000 },
      },
    });

    const read = (role: keyof typeof TOKENS) =>
      invoke(plugin, "valhalla-ai-room-read", request({ token: TOKENS[role] }));
    const audit = (role: keyof typeof TOKENS) =>
      invoke(
        plugin,
        "valhalla-ai-room-audit",
        request({ token: TOKENS[role] }),
      );

    expect((await read("zeus")).statusCode).toBe(200);
    const readBlocked = await read("zeus");
    expect(readBlocked.statusCode).toBe(429);
    expect(readBlocked.body).toMatchObject({
      error: "rate_limited",
      bucket: "read",
    });
    expect((await read("cerberus")).statusCode).toBe(200);

    expect((await audit("zeus")).statusCode).toBe(200);
    const auditBlocked = await audit("zeus");
    expect(auditBlocked.statusCode).toBe(429);
    expect(auditBlocked.body).toMatchObject({
      error: "rate_limited",
      bucket: "audit",
    });
    expect((await audit("gorgo")).statusCode).toBe(200);

    // Sends use their own bucket and remain available.
    const sent = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ token: TOKENS.zeus, body: { text: "send still works" } }),
    );
    expect(sent.statusCode).toBe(201);

    clock = new Date(clock.getTime() + 60_001);
    expect((await read("zeus")).statusCode).toBe(200);
    expect((await audit("zeus")).statusCode).toBe(200);
  });

  it("records an audit trail without message text or action authority", async () => {
    const auditLog = new AiRoomAuditLog({ file: null });
    const plugin = createAiRoomPlugin({
      env: roomEnv(),
      auditLog,
      historyFile: null,
    });

    const sent = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.zeus,
        body: { text: "sensitive room text" },
      }),
    );
    expect(sent.statusCode).toBe(201);

    const rejected = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({
        token: TOKENS.cerberus,
        body: { text: "spoof", from: "zeus" },
      }),
    );
    expect(rejected.statusCode).toBe(400);

    const read = await invoke(
      plugin,
      "valhalla-ai-room-read",
      request({ token: TOKENS.gorgo }),
    );
    expect(read.statusCode).toBe(200);

    const auditResult = await invoke(
      plugin,
      "valhalla-ai-room-audit",
      request({ token: TOKENS.gorgo, query: { after: "0", limit: "100" } }),
    );
    expect(auditResult.statusCode).toBe(200);
    const auditBody = auditResult.body as AuditBody;
    expect(auditBody.member).toBe("gorgo");
    expect(auditBody.actions).toBe("disabled");
    expect(auditBody.autonomous).toBe(false);
    expect(auditBody.entries.map((entry) => entry.event)).toEqual([
      "message_sent",
      "message_rejected",
      "messages_read",
    ]);
    expect(auditBody.entries[0]).toMatchObject({
      member: "zeus",
      outcome: "allowed",
      messageSeq: 1,
    });
    expect(auditBody.entries[1]).toMatchObject({
      member: "cerberus",
      outcome: "rejected",
      reason: "unsupported_field",
      field: "from",
    });
    expect(auditBody.auditCount).toBeGreaterThanOrEqual(4);

    const serialized = JSON.stringify(auditLog.list(0, 100));
    expect(serialized).not.toContain("sensitive room text");
    expect(serialized).not.toContain(TOKENS.zeus);
    expect(auditLog.list(0, 100).some((entry) => "text" in entry)).toBe(false);
  });

  it("writes append-only JSONL audit entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "valhalla-room-audit-"));
    try {
      const file = join(dir, "audit.jsonl");
      const auditLog = new AiRoomAuditLog({ file });
      auditLog.append({
        member: "zeus",
        event: "message_sent",
        outcome: "allowed",
        messageId: "message-id",
        messageSeq: 1,
      });
      auditLog.append({
        member: "cerberus",
        event: "rate_limited",
        outcome: "rejected",
        reason: "rate_limited",
        details: { bucket: "send", retryAfter: 1 },
      });

      const raw = readFileSync(file, "utf8");
      const lines = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as AiRoomAuditEntry);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        seq: 1,
        roomId: AI_ROOM_ID,
        member: "zeus",
        event: "message_sent",
      });
      expect(lines[1]).toMatchObject({
        seq: 2,
        member: "cerberus",
        event: "rate_limited",
      });
      expect(raw).not.toContain("sensitive room text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the shared room route once, on the Zeus project agent", () => {
    const byRole = new Map(
      project.agents.map((agent) => [agent.character.username, agent]),
    );
    const roomPlugins = (role: string) =>
      (byRole.get(role)?.plugins ?? []).filter(
        (plugin) => plugin.name === "valhalla-ai-room",
      );

    expect(roomPlugins("zeus")).toHaveLength(1);
    expect(roomPlugins("cerberus")).toHaveLength(0);
    expect(roomPlugins("gorgo")).toHaveLength(0);
  });
});
