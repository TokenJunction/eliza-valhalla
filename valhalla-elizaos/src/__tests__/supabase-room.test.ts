import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Plugin, RouteRequest, RouteResponse } from "@elizaos/core";
import {
  AI_ROOM_ID,
  AI_ROOM_TOKEN_ENV,
  SupabaseAiRoomAuditLog,
  SupabaseAiRoomStore,
  createAiRoomPlugin,
} from "../ai-room.ts";

const SUPABASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

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

type Row = Record<string, unknown>;

function messageRow(seq: number): Row {
  return {
    id: randomUUID(),
    seq,
    room_id: AI_ROOM_ID,
    member: ["zeus", "cerberus", "gorgo"][seq % 3],
    text: `message-${seq}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    reply_to: null,
  };
}

function auditRow(seq: number): Row {
  return {
    id: randomUUID(),
    seq,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    room_id: AI_ROOM_ID,
    member: "zeus",
    event: "messages_read",
    outcome: "allowed",
    reason: null,
    field: null,
    message_id: null,
    message_seq: null,
    details: { seed: seq },
  };
}

function fakeSupabase(
  options: {
    messages?: Row[];
    audit?: Row[];
  } = {},
) {
  const messages = [...(options.messages ?? [])];
  const audit = [...(options.audit ?? [])];
  let nextMessageSeq =
    messages.reduce((max, row) => Math.max(max, Number(row.seq)), 0) + 1;
  let nextAuditSeq =
    audit.reduce((max, row) => Math.max(max, Number(row.seq)), 0) + 1;
  let failInserts = false;
  let lastInsertBody: Row | null = null;

  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const table = url.pathname.split("/").pop();
    const rows =
      table === "valhalla_room_messages"
        ? messages
        : table === "valhalla_room_audit"
          ? audit
          : null;
    if (!rows) return new Response("not found", { status: 404 });
    if (init?.method === "POST") {
      if (failInserts) return new Response("insert failed", { status: 500 });
      const body = JSON.parse(String(init.body)) as Row;
      lastInsertBody = body;
      const seq =
        table === "valhalla_room_messages" ? nextMessageSeq++ : nextAuditSeq++;
      const row = { ...body, seq };
      rows.push(row);
      return new Response(JSON.stringify([row]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const pageSize = Math.min(limit, 1_000);
    const ordered = [...rows].sort((left, right) =>
      url.searchParams.get("order") === "seq.desc"
        ? Number(right.seq) - Number(left.seq)
        : Number(left.seq) - Number(right.seq),
    );
    return new Response(
      JSON.stringify(ordered.slice(offset, offset + pageSize)),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  return {
    fetcher,
    messages,
    audit,
    get lastInsertBody() {
      return lastInsertBody;
    },
    failInserts(value: boolean) {
      failInserts = value;
    },
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

function request(body: unknown): RouteRequest {
  return {
    headers: { authorization: `Bearer ${TOKENS.zeus}` },
    body,
  };
}

async function invoke(plugin: Plugin, name: string, req: RouteRequest) {
  const route = plugin.routes?.find((entry) => entry.name === name);
  if (!route?.handler) throw new Error(`missing route ${name}`);
  const harness = responseHarness();
  await route.handler(req, harness.response, {} as never);
  return harness.result();
}

describe("Valhalla AI room Supabase backend", () => {
  it("loads the latest 200 messages and lets the database allocate sequence numbers", async () => {
    const fake = fakeSupabase({
      messages: Array.from({ length: 205 }, (_, index) =>
        messageRow(index + 1),
      ),
    });
    const store = new SupabaseAiRoomStore({
      env: SUPABASE_ENV,
      fetcher: fake.fetcher,
    });

    await store.ready();
    expect(store.size).toBe(200);
    expect(store.list(0, 5).map((message) => message.seq)).toEqual([
      6, 7, 8, 9, 10,
    ]);

    const appended = await store.append("zeus", "from Supabase");
    expect(appended.seq).toBe(206);
    expect(appended.text).toBe("from Supabase");
    expect(fake.lastInsertBody).not.toHaveProperty("seq");
    expect(fake.lastInsertBody).toMatchObject({
      room_id: AI_ROOM_ID,
      member: "zeus",
      text: "from Supabase",
    });

    const restarted = new SupabaseAiRoomStore({
      env: SUPABASE_ENV,
      fetcher: fake.fetcher,
    });
    await restarted.ready();
    expect(restarted.size).toBe(200);
    expect(restarted.list(0, 1)[0].seq).toBe(7);
    expect(restarted.has(appended.id)).toBe(true);
    expect((await restarted.append("cerberus", "after restart")).seq).toBe(207);
  });

  it("loads the latest 2,000 audit entries and appends without message text", async () => {
    const fake = fakeSupabase({
      audit: Array.from({ length: 2_005 }, (_, index) => auditRow(index + 1)),
    });
    const audit = new SupabaseAiRoomAuditLog({
      env: SUPABASE_ENV,
      fetcher: fake.fetcher,
    });

    await audit.ready();
    expect(audit.size).toBe(2_000);
    expect(audit.list(0, 1)[0].seq).toBe(6);

    const entry = await audit.append({
      member: "zeus",
      event: "message_sent",
      outcome: "allowed",
      messageId: randomUUID(),
      messageSeq: 206,
    });
    expect(entry.seq).toBe(2_006);
    expect(audit.size).toBe(2_000);
    expect(audit.list(2_005, 10).map((record) => record.seq)).toEqual([2_006]);
    expect(fake.lastInsertBody).not.toHaveProperty("text");
    expect(JSON.stringify(fake.lastInsertBody)).not.toContain(
      "sensitive room text",
    );
  });

  it("relays through the async Supabase stores and keeps the audit endpoint bounded", async () => {
    const fake = fakeSupabase();
    const store = new SupabaseAiRoomStore({
      env: SUPABASE_ENV,
      fetcher: fake.fetcher,
    });
    const audit = new SupabaseAiRoomAuditLog({
      env: SUPABASE_ENV,
      fetcher: fake.fetcher,
    });
    const plugin = createAiRoomPlugin({
      env: roomEnv(),
      store,
      auditLog: audit,
    });

    const sent = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ text: "stored in postgres" }),
    );
    expect(sent.statusCode).toBe(201);
    expect((sent.body as { message: { seq: number } }).message.seq).toBe(1);

    const read = await invoke(
      plugin,
      "valhalla-ai-room-read",
      request(undefined),
    );
    expect(read.statusCode).toBe(200);
    expect(
      (read.body as { messages: Array<{ text: string }> }).messages[0].text,
    ).toBe("stored in postgres");

    const auditResult = await invoke(
      plugin,
      "valhalla-ai-room-audit",
      request(undefined),
    );
    expect(auditResult.statusCode).toBe(200);
    expect(
      (auditResult.body as { entries: Array<{ event: string }> }).entries.map(
        (entry) => entry.event,
      ),
    ).toContain("message_sent");
  });

  it("fails closed when the Supabase insert fails", async () => {
    const fake = fakeSupabase();
    fake.failInserts(true);
    const store = new SupabaseAiRoomStore({
      env: SUPABASE_ENV,
      fetcher: fake.fetcher,
    });
    const plugin = createAiRoomPlugin({
      env: roomEnv(),
      store,
      auditLog: new SupabaseAiRoomAuditLog({
        env: SUPABASE_ENV,
        fetcher: fake.fetcher,
      }),
    });

    const result = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ text: "must not be acknowledged" }),
    );
    expect(result.statusCode).toBe(503);
    expect(result.body).toEqual({
      ok: false,
      error: "history_unavailable",
    });
    expect(fake.messages).toHaveLength(0);
  });

  it("fails closed when the Supabase service-role key is missing", async () => {
    const plugin = createAiRoomPlugin({
      env: roomEnv({ VALHALLA_ROOM_STORAGE: "supabase" }),
      historyFile: null,
      auditFile: null,
    });

    const result = await invoke(
      plugin,
      "valhalla-ai-room-send",
      request({ text: "no credentials" }),
    );
    expect(result.statusCode).toBe(503);
    expect(result.body).toEqual({
      ok: false,
      error: "history_unavailable",
    });
  });
});
