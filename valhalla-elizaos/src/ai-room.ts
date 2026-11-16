import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Plugin, RouteRequest, RouteResponse } from "@elizaos/core";
import type { ValhallaRoleId } from "./character.ts";

export const AI_ROOM_ID = "valhalla:private:zeus-cerberus-gorgo";
export const AI_ROOM_MEMBERS = [
  "zeus",
  "cerberus",
  "gorgo",
] as const satisfies readonly ValhallaRoleId[];

export type AiRoomRole = (typeof AI_ROOM_MEMBERS)[number];
export type RoomEnv = Record<string, string | undefined>;

export const AI_ROOM_TOKEN_ENV: Record<AiRoomRole, string> = {
  zeus: "VALHALLA_ROOM_KEY_ZEUS",
  cerberus: "VALHALLA_ROOM_KEY_CERBERUS",
  gorgo: "VALHALLA_ROOM_KEY_GORGO",
};

const MEMBERS = new Set<string>(AI_ROOM_MEMBERS);
const MAX_TEXT = 2_000;
const MAX_MESSAGES = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_AUDIT_ENTRIES = 2_000;
const DEFAULT_AUDIT_FILE = ".eliza/valhalla-room-audit.jsonl";
const DEFAULT_HISTORY_FILE = ".eliza/valhalla-room-messages.jsonl";
const MIN_KEY_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const FORBIDDEN_FIELDS = new Set([
  "from",
  "sender",
  "member",
  "to",
  "recipient",
  "agent",
  "room",
  "roomId",
  "action",
  "actions",
  "tool",
  "tools",
  "command",
  "execute",
]);

export type AiRoomMessage = {
  id: string;
  seq: number;
  from: AiRoomRole;
  text: string;
  at: string;
  replyTo?: string;
};

export const AI_ROOM_RATE_LIMITS = {
  info: { limit: 60, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
  audit: { limit: 30, windowMs: 60_000 },
  send: { limit: 30, windowMs: 60_000 },
} as const;

export type AiRoomRateLimitBucket = keyof typeof AI_ROOM_RATE_LIMITS;
export type AiRoomRateLimitConfig = {
  limit: number;
  windowMs: number;
};
export type AiRoomRateLimits = Record<
  AiRoomRateLimitBucket,
  AiRoomRateLimitConfig
>;

export type AiRoomAuditEvent =
  | "message_sent"
  | "message_rejected"
  | "messages_read"
  | "audit_read"
  | "rate_limited";
export type AiRoomAuditOutcome = "allowed" | "rejected";
export type AiRoomAuditDetail = string | number | boolean | null;

export type AiRoomAuditEntry = {
  id: string;
  seq: number;
  at: string;
  roomId: string;
  member: AiRoomRole;
  event: AiRoomAuditEvent;
  outcome: AiRoomAuditOutcome;
  reason?: string;
  field?: string;
  messageId?: string;
  messageSeq?: number;
  details?: Record<string, AiRoomAuditDetail>;
};

type AiRoomAuditInput = Omit<AiRoomAuditEntry, "id" | "seq" | "at" | "roomId">;

const AUDIT_EVENTS = new Set<AiRoomAuditEvent>([
  "message_sent",
  "message_rejected",
  "messages_read",
  "audit_read",
  "rate_limited",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a private append-only JSONL file. A partial final line is the expected
 * result of a process stopping during an append; an unreadable or malformed
 * interior line is corruption and must not be silently discarded.
 */
function readJsonLines(file: string, label: string): unknown[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  if (!raw) return [];
  const lines = raw.split("\n");
  const records: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      const partialFinalLine =
        index === lines.length - 1 && !raw.endsWith("\n");
      if (partialFinalLine) break;
      throw new Error(`invalid_${label}_file`);
    }
  }
  return records;
}

function parseStoredMessage(value: unknown): AiRoomMessage {
  if (!isRecord(value)) throw new Error("invalid_history_file");
  const { id, seq, from, text, at, replyTo } = value;
  if (typeof id !== "string" || !MESSAGE_ID.test(id)) {
    throw new Error("invalid_history_file");
  }
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("invalid_history_file");
  }
  if (typeof from !== "string" || !MEMBERS.has(from)) {
    throw new Error("invalid_history_file");
  }
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_TEXT ||
    CONTROL_CHARS.test(text)
  ) {
    throw new Error("invalid_history_file");
  }
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
    throw new Error("invalid_history_file");
  }
  if (
    replyTo !== undefined &&
    (typeof replyTo !== "string" || !MESSAGE_ID.test(replyTo))
  ) {
    throw new Error("invalid_history_file");
  }
  return {
    id,
    seq,
    from: from as AiRoomRole,
    text,
    at,
    ...(replyTo ? { replyTo } : {}),
  };
}

function parseStoredAudit(value: unknown): AiRoomAuditEntry {
  if (!isRecord(value)) throw new Error("invalid_audit_file");
  const { id, seq, at, roomId, member, event, outcome } = value;
  if (typeof id !== "string" || !MESSAGE_ID.test(id)) {
    throw new Error("invalid_audit_file");
  }
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("invalid_audit_file");
  }
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
    throw new Error("invalid_audit_file");
  }
  if (roomId !== AI_ROOM_ID) throw new Error("invalid_audit_file");
  if (typeof member !== "string" || !MEMBERS.has(member)) {
    throw new Error("invalid_audit_file");
  }
  if (
    typeof event !== "string" ||
    !AUDIT_EVENTS.has(event as AiRoomAuditEvent)
  ) {
    throw new Error("invalid_audit_file");
  }
  if (outcome !== "allowed" && outcome !== "rejected") {
    throw new Error("invalid_audit_file");
  }
  for (const key of ["reason", "field"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error("invalid_audit_file");
    }
  }
  if (
    value.messageId !== undefined &&
    (typeof value.messageId !== "string" || !MESSAGE_ID.test(value.messageId))
  ) {
    throw new Error("invalid_audit_file");
  }
  if (
    value.messageSeq !== undefined &&
    (typeof value.messageSeq !== "number" ||
      !Number.isSafeInteger(value.messageSeq) ||
      value.messageSeq < 1)
  ) {
    throw new Error("invalid_audit_file");
  }
  if (value.details !== undefined) {
    if (!isRecord(value.details)) throw new Error("invalid_audit_file");
    for (const detail of Object.values(value.details)) {
      if (
        detail !== null &&
        typeof detail !== "string" &&
        typeof detail !== "number" &&
        typeof detail !== "boolean"
      ) {
        throw new Error("invalid_audit_file");
      }
    }
  }
  return value as AiRoomAuditEntry;
}

export type AiRoomAuditLogOptions = {
  capacity?: number;
  file?: string | null;
};

export class AiRoomAuditLog {
  private readonly entries: AiRoomAuditEntry[] = [];
  private readonly capacity: number;
  private readonly file: string | null;
  private nextSeq = 1;
  private persistenceErrorReported = false;

  constructor(options: AiRoomAuditLogOptions = {}) {
    const capacity = options.capacity ?? MAX_AUDIT_ENTRIES;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("invalid_audit_capacity");
    }
    this.capacity = capacity;
    this.file = options.file?.trim() ? options.file.trim() : null;
    if (this.file) this.load();
  }

  private load(): void {
    if (!this.file) return;
    const records = readJsonLines(this.file, "audit").map(parseStoredAudit);
    const seenIds = new Set<string>();
    const seenSeqs = new Set<number>();
    for (const record of records) {
      if (seenIds.has(record.id) || seenSeqs.has(record.seq)) {
        throw new Error("invalid_audit_file");
      }
      seenIds.add(record.id);
      seenSeqs.add(record.seq);
    }
    records.sort((left, right) => left.seq - right.seq);
    this.entries.push(...records.slice(-this.capacity));
    const last = records[records.length - 1];
    this.nextSeq = last ? last.seq + 1 : 1;
  }

  append(input: AiRoomAuditInput, at = new Date()): AiRoomAuditEntry {
    const entry: AiRoomAuditEntry = {
      id: randomUUID(),
      seq: this.nextSeq++,
      at: at.toISOString(),
      roomId: AI_ROOM_ID,
      ...input,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.persist(entry);
    return entry;
  }

  list(after = 0, limit = DEFAULT_LIMIT): AiRoomAuditEntry[] {
    return this.entries.filter((entry) => entry.seq > after).slice(0, limit);
  }

  get size(): number {
    return this.entries.length;
  }

  private persist(entry: AiRoomAuditEntry): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      if (!this.persistenceErrorReported) {
        this.persistenceErrorReported = true;
        console.error(
          "valhalla-ai-room audit persistence failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

function resolveRateLimits(
  overrides: Partial<
    Record<AiRoomRateLimitBucket, Partial<AiRoomRateLimitConfig>>
  > = {},
): AiRoomRateLimits {
  const limits = {} as AiRoomRateLimits;
  for (const bucket of Object.keys(
    AI_ROOM_RATE_LIMITS,
  ) as AiRoomRateLimitBucket[]) {
    const base = AI_ROOM_RATE_LIMITS[bucket];
    const override = overrides[bucket];
    const limit = override?.limit ?? base.limit;
    const windowMs = override?.windowMs ?? base.windowMs;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`invalid_rate_limit_${bucket}`);
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error(`invalid_rate_window_${bucket}`);
    }
    limits[bucket] = { limit, windowMs };
  }
  return limits;
}

export type AiRoomRateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfter: number;
  retryAfter: number;
};

export class AiRoomRateLimiter {
  private readonly limits: AiRoomRateLimits;
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();

  constructor(
    overrides: Partial<
      Record<AiRoomRateLimitBucket, Partial<AiRoomRateLimitConfig>>
    > = {},
  ) {
    this.limits = resolveRateLimits(overrides);
  }

  consume(
    member: AiRoomRole,
    bucket: AiRoomRateLimitBucket,
    at = Date.now(),
  ): AiRoomRateLimitDecision {
    const config = this.limits[bucket];
    const key = `${bucket}:${member}`;
    const current = this.windows.get(key);
    const reset =
      !current ||
      at < current.startedAt ||
      at >= current.startedAt + config.windowMs;
    const startedAt = reset ? at : current.startedAt;
    const count = reset ? 1 : current.count + 1;
    this.windows.set(key, { startedAt, count });

    const resetAfter = Math.max(
      1,
      Math.ceil((startedAt + config.windowMs - at) / 1000),
    );
    const allowed = count <= config.limit;
    return {
      allowed,
      limit: config.limit,
      remaining: Math.max(0, config.limit - count),
      resetAfter,
      retryAfter: allowed ? 0 : resetAfter,
    };
  }
}

export type AiRoomStoreOptions = {
  capacity?: number;
  file?: string | null;
};

export class AiRoomStore {
  private readonly messages: AiRoomMessage[] = [];
  private readonly capacity: number;
  private readonly file: string | null;
  private nextSeq = 1;
  private persistenceErrorReported = false;

  constructor(
    capacityOrOptions: number | AiRoomStoreOptions = MAX_MESSAGES,
    options: Omit<AiRoomStoreOptions, "capacity"> = {},
  ) {
    const resolved =
      typeof capacityOrOptions === "number"
        ? { ...options, capacity: capacityOrOptions }
        : capacityOrOptions;
    const capacity = resolved.capacity ?? MAX_MESSAGES;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("invalid_capacity");
    }
    this.capacity = capacity;
    this.file = resolved.file?.trim() ? resolved.file.trim() : null;
    if (this.file) this.load();
  }

  private load(): void {
    if (!this.file) return;
    const records = readJsonLines(this.file, "history").map(parseStoredMessage);
    const seenIds = new Set<string>();
    const seenSeqs = new Set<number>();
    for (const record of records) {
      if (seenIds.has(record.id) || seenSeqs.has(record.seq)) {
        throw new Error("invalid_history_file");
      }
      seenIds.add(record.id);
      seenSeqs.add(record.seq);
    }
    records.sort((left, right) => left.seq - right.seq);
    this.messages.push(...records.slice(-this.capacity));
    const last = records[records.length - 1];
    this.nextSeq = last ? last.seq + 1 : 1;
  }

  private persist(message: AiRoomMessage): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = openSync(this.file, "a", 0o600);
      try {
        // openSync's mode only applies when creating the file. Make sure a
        // pre-existing history file cannot remain readable by other users.
        fchmodSync(fd, 0o600);
        writeSync(fd, `${JSON.stringify(message)}\n`, undefined, "utf8");
        // A process restart keeps page-cache writes, but fsync also makes the
        // record durable if the host itself restarts immediately afterwards.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (!this.persistenceErrorReported) {
        this.persistenceErrorReported = true;
        console.error(
          "valhalla-ai-room history persistence failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      const failure = new Error("history_unavailable");
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
  }

  append(
    from: AiRoomRole,
    text: string,
    replyTo?: string,
    at = new Date(),
  ): AiRoomMessage {
    if (!MEMBERS.has(from)) throw new Error("not_a_member");
    if (typeof text !== "string" || !text.trim())
      throw new Error("invalid_text");
    const message: AiRoomMessage = {
      id: randomUUID(),
      seq: this.nextSeq,
      from,
      text,
      at: at.toISOString(),
      ...(replyTo ? { replyTo } : {}),
    };
    // Persist before acknowledging. If the append fails, the caller must not
    // return a message that would disappear on the next restart.
    this.persist(message);
    this.nextSeq += 1;
    this.messages.push(message);
    if (this.messages.length > this.capacity) {
      this.messages.splice(0, this.messages.length - this.capacity);
    }
    return message;
  }

  has(id: string): boolean {
    return this.messages.some((message) => message.id === id);
  }

  list(after = 0, limit = DEFAULT_LIMIT): AiRoomMessage[] {
    return this.messages
      .filter((message) => message.seq > after)
      .slice(0, limit);
  }

  get size(): number {
    return this.messages.length;
  }
}

function envValue(env: RoomEnv, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

export function roomConfigured(env: RoomEnv = process.env): boolean {
  const keys = AI_ROOM_MEMBERS.map((role) =>
    envValue(env, AI_ROOM_TOKEN_ENV[role]),
  );
  return (
    keys.every((key) => key.length >= MIN_KEY_LENGTH) &&
    new Set(keys).size === keys.length
  );
}

function authorizationHeader(request: RouteRequest): string {
  const headers = request.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") {
      return typeof value === "string" ? value : "";
    }
  }
  return "";
}

function bearerToken(request: RouteRequest): string {
  const match = /^Bearer[ \t]+(\S+)$/i.exec(
    authorizationHeader(request).trim(),
  );
  return match?.[1] ?? "";
}

export function authenticateRoomRequest(
  request: RouteRequest,
  env: RoomEnv = process.env,
): AiRoomRole | null {
  if (!roomConfigured(env)) return null;
  const token = bearerToken(request);
  if (token.length < MIN_KEY_LENGTH || token.length > MAX_TOKEN_LENGTH)
    return null;

  const digest = createHash("sha256").update(token, "utf8").digest();
  let matched: AiRoomRole | null = null;
  for (const role of AI_ROOM_MEMBERS) {
    const expected = createHash("sha256")
      .update(envValue(env, AI_ROOM_TOKEN_ENV[role]), "utf8")
      .digest();
    if (timingSafeEqual(digest, expected)) matched = role;
  }
  return matched;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function privateHeaders(response: RouteResponse): void {
  response.setHeader?.("Cache-Control", "no-store");
  response.setHeader?.("Vary", "Authorization");
}

function reject(
  response: RouteResponse,
  status: number,
  error: string,
  field?: string,
  extra?: Record<string, unknown>,
): void {
  if (status === 401) {
    response.setHeader?.("WWW-Authenticate", 'Bearer realm="valhalla-ai-room"');
  }
  response
    .status(status)
    .json({ ok: false, error, ...(field ? { field } : {}), ...(extra ?? {}) });
}

function requireMember(
  request: RouteRequest,
  response: RouteResponse,
  env: RoomEnv,
): AiRoomRole | null {
  if (!roomConfigured(env)) {
    reject(response, 503, "room_not_configured");
    return null;
  }
  const member = authenticateRoomRequest(request, env);
  if (!member) {
    reject(response, 401, "unauthorized");
    return null;
  }
  return member;
}

function applyRateLimitHeaders(
  response: RouteResponse,
  decision: AiRoomRateLimitDecision,
): void {
  response.setHeader?.("RateLimit-Limit", String(decision.limit));
  response.setHeader?.("RateLimit-Remaining", String(decision.remaining));
  response.setHeader?.("RateLimit-Reset", String(decision.resetAfter));
}

function enforceRateLimit(
  limiter: AiRoomRateLimiter,
  member: AiRoomRole,
  bucket: AiRoomRateLimitBucket,
  at: Date,
  response: RouteResponse,
): AiRoomRateLimitDecision {
  const decision = limiter.consume(member, bucket, at.getTime());
  applyRateLimitHeaders(response, decision);
  if (!decision.allowed) {
    response.setHeader?.("Retry-After", String(decision.retryAfter));
    reject(response, 429, "rate_limited", undefined, {
      bucket,
      retryAfter: decision.retryAfter,
      actions: "disabled",
      autonomous: false,
    });
  }
  return decision;
}

function recordRateLimit(
  audit: AiRoomAuditLog,
  member: AiRoomRole,
  bucket: AiRoomRateLimitBucket,
  at: Date,
  decision: AiRoomRateLimitDecision,
): void {
  audit.append(
    {
      member,
      event: "rate_limited",
      outcome: "rejected",
      reason: "rate_limited",
      details: { bucket, retryAfter: decision.retryAfter },
    },
    at,
  );
}

function rejectSend(
  audit: AiRoomAuditLog,
  member: AiRoomRole,
  at: Date,
  response: RouteResponse,
  status: number,
  reason: string,
  field?: string,
): void {
  audit.append(
    {
      member,
      event: "message_rejected",
      outcome: "rejected",
      reason,
      ...(field ? { field } : {}),
    },
    at,
  );
  reject(response, status, reason, field);
}

function roomInfo(member: AiRoomRole, count: number) {
  return {
    ok: true,
    room: {
      id: AI_ROOM_ID,
      members: [...AI_ROOM_MEMBERS],
      membership: "server_enforced",
      mode: "relay_only",
    },
    member,
    messageCount: count,
    actions: "disabled",
    autonomous: false,
  };
}

function readText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim();
}

function parseCursor(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT)
    return null;
  return parsed;
}

export type AiRoomPluginOptions = {
  env?: RoomEnv;
  store?: AiRoomStore;
  auditLog?: AiRoomAuditLog;
  auditFile?: string | null;
  historyFile?: string | null;
  rateLimits?: Partial<
    Record<AiRoomRateLimitBucket, Partial<AiRoomRateLimitConfig>>
  >;
  now?: () => Date;
};

export function createAiRoomPlugin(options: AiRoomPluginOptions = {}): Plugin {
  const env = options.env ?? process.env;
  const configuredHistoryFile = envValue(env, "VALHALLA_ROOM_HISTORY_FILE");
  const historyFile =
    options.historyFile === null
      ? null
      : (options.historyFile ??
        (configuredHistoryFile || DEFAULT_HISTORY_FILE));
  const store =
    options.store ?? new AiRoomStore(MAX_MESSAGES, { file: historyFile });
  const now = options.now ?? (() => new Date());
  const rateLimiter = new AiRoomRateLimiter(options.rateLimits);
  const configuredAuditFile = envValue(env, "VALHALLA_ROOM_AUDIT_FILE");
  const auditFile =
    options.auditFile === null
      ? null
      : (options.auditFile ?? (configuredAuditFile || DEFAULT_AUDIT_FILE));
  const audit = options.auditLog ?? new AiRoomAuditLog({ file: auditFile });

  return {
    name: "valhalla-ai-room",
    description:
      "Authenticated relay-only room for Zeus, Cerberus and Gorgo. Membership is fixed server-side, with per-member rate limits and an append-only audit trail; the room cannot invoke agents, actions or public cross-talk.",
    routes: [
      {
        name: "valhalla-ai-room-info",
        path: "/valhalla/room",
        type: "GET",
        public: true,
        handler: async (request, response) => {
          privateHeaders(response);
          const member = requireMember(request, response, env);
          if (!member) return;

          const at = now();
          const rate = enforceRateLimit(
            rateLimiter,
            member,
            "info",
            at,
            response,
          );
          if (!rate.allowed) {
            recordRateLimit(audit, member, "info", at, rate);
            return;
          }
          response.status(200).json(roomInfo(member, store.size));
        },
      },
      {
        name: "valhalla-ai-room-send",
        path: "/valhalla/room/messages",
        type: "POST",
        public: true,
        handler: async (request, response) => {
          privateHeaders(response);
          const member = requireMember(request, response, env);
          if (!member) return;

          const at = now();
          const rate = enforceRateLimit(
            rateLimiter,
            member,
            "send",
            at,
            response,
          );
          if (!rate.allowed) {
            recordRateLimit(audit, member, "send", at, rate);
            return;
          }

          const body = asRecord(request.body);
          if (!body) {
            rejectSend(audit, member, at, response, 400, "body_required");
            return;
          }
          for (const field of FORBIDDEN_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(body, field)) {
              rejectSend(
                audit,
                member,
                at,
                response,
                400,
                "unsupported_field",
                field,
              );
              return;
            }
          }

          const text = readText(body.text);
          if (!text) {
            rejectSend(audit, member, at, response, 400, "text_required");
            return;
          }
          if (text.length > MAX_TEXT) {
            rejectSend(audit, member, at, response, 413, "text_too_long");
            return;
          }
          if (CONTROL_CHARS.test(text)) {
            rejectSend(audit, member, at, response, 400, "invalid_text");
            return;
          }

          if (body.replyTo !== undefined && typeof body.replyTo !== "string") {
            rejectSend(audit, member, at, response, 400, "invalid_reply_to");
            return;
          }
          const replyTo = readText(body.replyTo);
          if (replyTo && !MESSAGE_ID.test(replyTo)) {
            rejectSend(audit, member, at, response, 400, "invalid_reply_to");
            return;
          }
          if (replyTo && !store.has(replyTo)) {
            rejectSend(audit, member, at, response, 400, "reply_to_not_found");
            return;
          }

          let message: AiRoomMessage;
          try {
            message = store.append(member, text, replyTo || undefined, at);
          } catch (error) {
            audit.append(
              {
                member,
                event: "message_rejected",
                outcome: "rejected",
                reason: "history_unavailable",
              },
              at,
            );
            reject(response, 503, "history_unavailable");
            return;
          }
          audit.append(
            {
              member,
              event: "message_sent",
              outcome: "allowed",
              messageId: message.id,
              messageSeq: message.seq,
              ...(replyTo ? { details: { replyTo } } : {}),
            },
            at,
          );
          response.status(201).json({
            ok: true,
            roomId: AI_ROOM_ID,
            member,
            message,
            actions: "disabled",
            autonomous: false,
          });
        },
      },
      {
        name: "valhalla-ai-room-read",
        path: "/valhalla/room/messages",
        type: "GET",
        public: true,
        handler: async (request, response) => {
          privateHeaders(response);
          const member = requireMember(request, response, env);
          if (!member) return;

          const at = now();
          const rate = enforceRateLimit(
            rateLimiter,
            member,
            "read",
            at,
            response,
          );
          if (!rate.allowed) {
            recordRateLimit(audit, member, "read", at, rate);
            return;
          }

          const after = parseCursor(request.query?.after);
          if (after === null) {
            audit.append(
              {
                member,
                event: "messages_read",
                outcome: "rejected",
                reason: "invalid_cursor",
              },
              at,
            );
            reject(response, 400, "invalid_cursor");
            return;
          }
          const limit = parseLimit(request.query?.limit);
          if (limit === null) {
            audit.append(
              {
                member,
                event: "messages_read",
                outcome: "rejected",
                reason: "invalid_limit",
              },
              at,
            );
            reject(response, 400, "invalid_limit");
            return;
          }

          const messages = store.list(after, limit);
          const next = messages.length
            ? messages[messages.length - 1].seq
            : after;
          audit.append(
            {
              member,
              event: "messages_read",
              outcome: "allowed",
              details: { after, limit, returned: messages.length, next },
            },
            at,
          );
          response.status(200).json({
            ok: true,
            roomId: AI_ROOM_ID,
            member,
            messages,
            next,
            actions: "disabled",
            autonomous: false,
          });
        },
      },
      {
        name: "valhalla-ai-room-audit",
        path: "/valhalla/room/audit",
        type: "GET",
        public: true,
        handler: async (request, response) => {
          privateHeaders(response);
          const member = requireMember(request, response, env);
          if (!member) return;

          const at = now();
          const rate = enforceRateLimit(
            rateLimiter,
            member,
            "audit",
            at,
            response,
          );
          if (!rate.allowed) {
            recordRateLimit(audit, member, "audit", at, rate);
            return;
          }

          const after = parseCursor(request.query?.after);
          if (after === null) {
            audit.append(
              {
                member,
                event: "audit_read",
                outcome: "rejected",
                reason: "invalid_cursor",
              },
              at,
            );
            reject(response, 400, "invalid_cursor");
            return;
          }
          const limit = parseLimit(request.query?.limit);
          if (limit === null) {
            audit.append(
              {
                member,
                event: "audit_read",
                outcome: "rejected",
                reason: "invalid_limit",
              },
              at,
            );
            reject(response, 400, "invalid_limit");
            return;
          }

          const entries = audit.list(after, limit);
          const next = entries.length ? entries[entries.length - 1].seq : after;
          audit.append(
            {
              member,
              event: "audit_read",
              outcome: "allowed",
              details: { after, limit, returned: entries.length, next },
            },
            at,
          );
          response.status(200).json({
            ok: true,
            roomId: AI_ROOM_ID,
            member,
            entries,
            next,
            auditCount: audit.size,
            actions: "disabled",
            autonomous: false,
          });
        },
      },
    ],
  };
}

export const aiRoomPlugin = createAiRoomPlugin();
