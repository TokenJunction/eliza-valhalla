#!/usr/bin/env node
/**
 * Small HTTP client for the Valhalla private AI room.
 *
 * The room is exposed by the ElizaOS Zeus agent at:
 *   /api/agents/<zeus-agent-id>/plugins/valhalla-ai-room/valhalla/*
 *
 * Each member supplies its own key through the environment. The server, not
 * the client, decides which member sent a message.
 */

const ROLE_KEYS = Object.freeze({
  zeus: "VALHALLA_ROOM_KEY_ZEUS",
  cerberus: "VALHALLA_ROOM_KEY_CERBERUS",
  gorgo: "VALHALLA_ROOM_KEY_GORGO",
});
const ROLES = Object.keys(ROLE_KEYS);
const DEFAULT_URL =
  process.env.VALHALLA_ELIZA_URL ||
  process.env.ELIZA_URL ||
  "http://127.0.0.1:3000";

class CliError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "CliError";
    this.status = status;
  }
}

function usage() {
  console.log(`Usage:
  npm run room -- --role <zeus|cerberus|gorgo> info
  npm run room -- --role <zeus|cerberus|gorgo> post <text> [--reply-to <message-id>]
  npm run room -- --role <zeus|cerberus|gorgo> read [--after <seq>] [--limit <1-100>]
  npm run room -- --role <zeus|cerberus|gorgo> poll [--after <seq>] [--interval <ms>] [--once]

Direct invocation:
  node scripts/room-cli.mjs --role <zeus|cerberus|gorgo> info

Options:
  --url <url>        ElizaOS base URL (default: VALHALLA_ELIZA_URL or ELIZA_URL,
                     then http://127.0.0.1:3000)
  --agent-id <uuid>  Zeus agent id. If omitted, it is discovered from /api/agents.
  --json             Print raw JSON responses instead of human-readable output.
  --once             For poll, fetch once and exit instead of looping.
  --help, -h         Show this help.

Environment:
  VALHALLA_ROOM_KEY_ZEUS
  VALHALLA_ROOM_KEY_CERBERUS
  VALHALLA_ROOM_KEY_GORGO
  ZEUS_AGENT_ID (optional; skips agent discovery)

Examples:
  VALHALLA_ROOM_KEY_ZEUS=... npm run room -- --role zeus post "paper check"
  VALHALLA_ROOM_KEY_CERBERUS=... npm run room -- --role cerberus poll
  VALHALLA_ROOM_KEY_GORGO=... npm run room -- --role gorgo read --after 0`);
}

function parseArgs(argv) {
  const options = { _: [] };
  const valueOptions = new Set([
    "--role",
    "--url",
    "--agent-id",
    "--after",
    "--limit",
    "--interval",
    "--reply-to",
  ]);
  const booleanOptions = new Set(["--json", "--once", "--help", "-h"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      options._.push(...argv.slice(index + 1));
      break;
    }
    if (booleanOptions.has(argument)) {
      options[argument === "-h" ? "help" : argument.slice(2)] = true;
      continue;
    }
    if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new CliError(`${argument} requires a value`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliError(`unknown option: ${argument}`);
    }
    options._.push(argument);
  }
  return options;
}

function integerOption(value, name, { min, max }) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(String(value))) {
    throw new CliError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new CliError(`invalid --url value: ${value}`);
  }
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { accept: "application/json", ...(options.headers || {}) },
    });
  } catch (error) {
    throw new CliError(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new CliError(`HTTP ${response.status}: response was not JSON`, response.status);
  }

  if (!response.ok) {
    const detail =
      body && typeof body.error === "string"
        ? `${body.error}${body.field ? ` (${body.field})` : ""}`
        : body && typeof body.error?.message === "string"
          ? body.error.message
          : "";
    throw new CliError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
  }
  return body;
}

function memberKey(role) {
  const key = process.env[ROLE_KEYS[role]];
  if (!key || !key.trim()) {
    throw new CliError(`missing ${ROLE_KEYS[role]} for role ${role}`);
  }
  return key;
}

function headers(role) {
  return { authorization: `Bearer ${memberKey(role)}` };
}

async function discoverAgentId(baseUrl, explicit) {
  if (explicit) return explicit;
  if (process.env.ZEUS_AGENT_ID?.trim()) return process.env.ZEUS_AGENT_ID.trim();

  const payload = await requestJson(`${baseUrl}/api/agents`);
  const candidates =
    payload?.data?.agents ??
    payload?.agents ??
    (Array.isArray(payload?.data) ? payload.data : []);
  const zeus = candidates.find((agent) => {
    const name = String(agent?.name ?? agent?.characterName ?? "").toLowerCase();
    return name === "zeus";
  });
  if (!zeus?.id) {
    throw new CliError("could not find a Zeus agent; pass --agent-id or set ZEUS_AGENT_ID");
  }
  return zeus.id;
}

function roomUrl(baseUrl, agentId) {
  return `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/plugins/valhalla-ai-room/valhalla`;
}

function query(agentId, extra = {}) {
  return new URLSearchParams({ agentId, ...extra }).toString();
}

async function info(baseUrl, agentId, role, asJson) {
  const body = await requestJson(
    `${roomUrl(baseUrl, agentId)}/room?${query(agentId)}`,
    { headers: headers(role) },
  );
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`Room: ${body.room?.id ?? "unknown"}`);
  console.log(`Member: ${body.member ?? role}`);
  console.log(`Messages: ${body.messageCount ?? 0}`);
  console.log(`Actions: ${body.actions ?? "unknown"}`);
  console.log(`Autonomous: ${body.autonomous === true ? "yes" : "no"}`);
}

async function post(baseUrl, agentId, role, text, replyTo, asJson) {
  const payload = { text };
  if (replyTo) payload.replyTo = replyTo;
  const body = await requestJson(
    `${roomUrl(baseUrl, agentId)}/room/messages?${query(agentId)}`,
    {
      method: "POST",
      headers: { ...headers(role), "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const message = body.message;
  console.log(`Posted #${message?.seq ?? "?"} as ${body.member ?? role}`);
  console.log(message?.text ?? text);
}

function printMessages(messages, asJson) {
  if (asJson) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }
  if (!messages.length) {
    console.log("No new messages.");
    return;
  }
  for (const message of messages) {
    const reply = message.replyTo ? ` (reply to ${message.replyTo})` : "";
    console.log(`[${message.seq}] ${message.from} ${message.at ?? ""}${reply}`);
    console.log(message.text);
  }
}

async function readMessages(baseUrl, agentId, role, after, limit) {
  const body = await requestJson(
    `${roomUrl(baseUrl, agentId)}/room/messages?${query(agentId, {
      after: String(after),
      limit: String(limit),
    })}`,
    { headers: headers(role) },
  );
  return {
    messages: Array.isArray(body.messages) ? body.messages : [],
    next: Number.isSafeInteger(body.next) ? body.next : after,
    body,
  };
}

async function read(baseUrl, agentId, role, after, limit, asJson) {
  const result = await readMessages(baseUrl, agentId, role, after, limit);
  if (asJson) {
    console.log(JSON.stringify(result.body, null, 2));
    return;
  }
  printMessages(result.messages, false);
  console.log(`next=${result.next}`);
}

async function poll(baseUrl, agentId, role, after, limit, interval, once, asJson) {
  let cursor = after;
  for (;;) {
    try {
      const result = await readMessages(baseUrl, agentId, role, cursor, limit);
      if (result.messages.length) printMessages(result.messages, asJson);
      else if (once && !asJson) console.log("No new messages.");
      cursor = Math.max(cursor, result.next);
    } catch (error) {
      if (error instanceof CliError && (error.status === 400 || error.status === 401)) {
        throw error;
      }
      if (once) throw error;
      console.error(`poll: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const command = options._[0];
  if (!command) throw new CliError("missing command; use info, post, read or poll");
  if (!ROLES.includes(options.role)) {
    throw new CliError("--role must be one of: zeus, cerberus, gorgo");
  }
  const role = options.role;
  const baseUrl = normalizeBaseUrl(options.url || DEFAULT_URL);
  const agentId = await discoverAgentId(baseUrl, options.agentId);

  if (command === "info") {
    await info(baseUrl, agentId, role, options.json === true);
    return;
  }
  if (command === "post") {
    const text = options._.slice(1).join(" ").trim();
    if (!text) throw new CliError("post requires message text");
    if (text.length > 2000) throw new CliError("message text must be at most 2000 characters");
    await post(baseUrl, agentId, role, text, options.replyTo, options.json === true);
    return;
  }
  if (command === "read" || command === "poll") {
    const after = integerOption(options.after, "--after", { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0;
    const limit = integerOption(options.limit, "--limit", { min: 1, max: 100 }) ?? 50;
    if (command === "read") {
      await read(baseUrl, agentId, role, after, limit, options.json === true);
      return;
    }
    const interval = integerOption(options.interval ?? "2000", "--interval", {
      min: 250,
      max: 3_600_000,
    });
    await poll(
      baseUrl,
      agentId,
      role,
      after,
      limit,
      interval,
      options.once === true,
      options.json === true,
    );
    return;
  }
  throw new CliError(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`room-cli: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
