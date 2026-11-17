import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core";

export const SOLANA_MINT_ACTION = "SOLANA_MINT_SNAPSHOT";
export const SOLANA_MINT_PLUGIN = "valhalla-solana-mint";
export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_SOLANA_MINT_RATE_LIMIT = 10;
export const DEFAULT_SOLANA_MINT_RATE_WINDOW_MS = 60_000;
export const DEFAULT_SOLANA_MINT_METADATA_CACHE_MS = 60_000;
const MAX_SOLANA_MINT_METADATA_CACHE_ENTRIES = 256;
const DEFAULT_RATE_LIMIT_REDIS_TIMEOUT_MS = 2_000;
const MAX_RATE_LIMIT_REDIS_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_REDIS_RESPONSE_BYTES = 16 * 1024;
const RATE_LIMIT_REDIS_KEY_PREFIX = "valos:rl:solana-mint";
const RATE_LIMIT_REDIS_LUA = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`.trim();

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_IN_TEXT = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const MAX_RPC_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_TIMEOUT_MS = 15_000;
const METAPLEX_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const METAPLEX_METADATA_KEY = 4;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_FIELD_PRIME = 2n ** 255n - 19n;
const ED25519_D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MintMetadata = {
  name: string | null;
  symbol: string | null;
  logo: string | null;
};

export type MintSnapshot = MintMetadata & {
  mint: string;
  program: string;
  decimals: number;
  supplyRaw: string;
  supplyUi: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
  slot: number | null;
  readOnly: true;
};

const EMPTY_METADATA: MintMetadata = {
  name: null,
  symbol: null,
  logo: null,
};

export type SolanaMintRateLimit = {
  limit?: number;
  windowMs?: number;
};

export type SolanaMintRedisRateLimitOptions = {
  url: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export type SolanaMintPluginOptions = {
  fetch?: FetchLike;
  rpcUrl?: string;
  timeoutMs?: number;
  rateLimit?: SolanaMintRateLimit;
  /** Set to null to force the in-process limiter; omit to use Upstash when configured. */
  rateLimitRedis?: SolanaMintRedisRateLimitOptions | null;
  now?: () => number;
};

type ResolvedRateLimit = {
  limit: number;
  windowMs: number;
};

type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
  windowMs: number;
};

type RateLimitStore = {
  readonly backend: "redis" | "memory";
  consume(agent: string, now: number): Promise<RateLimitDecision>;
};

type ResolvedRedisRateLimit = {
  url: string;
  token: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function messageText(message: Memory): string {
  const content = record(message?.content) ?? {};
  return [content.text, content.mint, content.address, content.tokenMint]
    .map(stringValue)
    .filter(Boolean)
    .join(" ")
    .trim();
}

function findMint(text: string): string {
  const matches = text.match(BASE58_IN_TEXT) ?? [];
  return matches.find((candidate) => BASE58_MINT.test(candidate)) ?? "";
}

function wantsSnapshot(text: string): boolean {
  const hasMint = Boolean(findMint(text));
  const tokenWord =
    /\b(mint|token|supply|decimals|authority|freeze|spl)\b/i.test(text);
  return (
    /\bmint\s+snapshot\b/i.test(text) ||
    (hasMint &&
      (tokenWord ||
        /\b(snapshot|lookup|inspect|fetch|read|check)\b/i.test(text)))
  );
}

function resolveRpcUrl(explicit?: string): string {
  const raw =
    stringValue(explicit) ||
    stringValue(process.env.SOLANA_RPC_URL) ||
    DEFAULT_SOLANA_RPC_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_rpc_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("invalid_rpc_url");
  }
  return url.toString();
}

type MintMetadataCacheEntry = {
  metadata: MintMetadata;
  expiresAt: number;
};

class MintMetadataCache {
  private readonly entries = new Map<string, MintMetadataCacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, now: number): MintMetadata | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return { ...entry.metadata };
  }

  set(key: string, metadata: MintMetadata, now: number): void {
    if (
      !this.entries.has(key) &&
      this.entries.size >= MAX_SOLANA_MINT_METADATA_CACHE_ENTRIES
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      metadata: { ...metadata },
      expiresAt: now + this.ttlMs,
    });
  }
}

function mintMetadataCacheKey(url: string, mint: string): string {
  return `${url}\n${mint}`;
}

class MemorySolanaMintRateLimiter implements RateLimitStore {
  readonly backend = "memory" as const;
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();

  constructor(private readonly config: ResolvedRateLimit) {}

  async consume(agent: string, now: number): Promise<RateLimitDecision> {
    const current = this.windows.get(agent);
    const window =
      current && now - current.startedAt < this.config.windowMs
        ? current
        : { startedAt: now, count: 0 };
    this.windows.set(agent, window);

    if (window.count >= this.config.limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((window.startedAt + this.config.windowMs - now) / 1000),
      );
      return {
        allowed: false,
        limit: this.config.limit,
        remaining: 0,
        retryAfter,
        windowMs: this.config.windowMs,
      };
    }

    window.count += 1;
    return {
      allowed: true,
      limit: this.config.limit,
      remaining: this.config.limit - window.count,
      retryAfter: 0,
      windowMs: this.config.windowMs,
    };
  }
}

async function redisRateLimitCounter(
  redis: ResolvedRedisRateLimit,
  key: string,
  windowMs: number,
): Promise<{ count: number; ttlMs: number }> {
  let response: Response;
  try {
    response = await redis.fetchImpl(redis.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${redis.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([
        "EVAL",
        RATE_LIMIT_REDIS_LUA,
        "1",
        key,
        String(windowMs),
      ]),
      signal: AbortSignal.timeout(redis.timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new Error("rate_limit_store_unavailable");
  }
  if (!response || !response.ok) {
    throw new Error("rate_limit_store_unavailable");
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new Error("rate_limit_store_unavailable");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_RATE_LIMIT_REDIS_RESPONSE_BYTES) {
    throw new Error("rate_limit_store_unavailable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("rate_limit_store_unavailable");
  }
  const payload = record(parsed);
  if (!payload || payload.error != null) {
    throw new Error("rate_limit_store_unavailable");
  }
  const result = payload.result;
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("rate_limit_store_unavailable");
  }
  const count = Number(result[0]);
  const ttl = Number(result[1]);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl)) {
    throw new Error("rate_limit_store_unavailable");
  }
  return {
    count,
    ttlMs: ttl >= 0 ? Math.floor(ttl) : windowMs,
  };
}

class RedisSolanaMintRateLimiter implements RateLimitStore {
  readonly backend = "redis" as const;

  constructor(
    private readonly config: ResolvedRateLimit,
    private readonly redis: ResolvedRedisRateLimit,
  ) {}

  async consume(agent: string, _now: number): Promise<RateLimitDecision> {
    const key = `${RATE_LIMIT_REDIS_KEY_PREFIX}:${encodeURIComponent(agent)}`;
    const { count, ttlMs } = await redisRateLimitCounter(
      this.redis,
      key,
      this.config.windowMs,
    );
    const allowed = count <= this.config.limit;
    return {
      allowed,
      limit: this.config.limit,
      remaining: Math.max(0, this.config.limit - count),
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1000)),
      windowMs: this.config.windowMs,
    };
  }
}

function resolveRateLimitRedis(
  options: SolanaMintRedisRateLimitOptions | null | undefined,
  fallbackFetch: FetchLike,
): ResolvedRedisRateLimit | null {
  if (options === null) return null;

  const rawUrl = options
    ? stringValue(options.url)
    : stringValue(process.env.UPSTASH_REDIS_REST_URL);
  const token = options
    ? stringValue(options.token)
    : stringValue(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) throw new Error("invalid_rate_limit_redis");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_rate_limit_redis");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error("invalid_rate_limit_redis");
  }

  const requestedTimeout = Number(options?.timeoutMs);
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_RATE_LIMIT_REDIS_TIMEOUT_MS)
      : DEFAULT_RATE_LIMIT_REDIS_TIMEOUT_MS;
  return {
    url: url.toString().replace(/\/+$/, ""),
    token,
    fetchImpl: options?.fetch ?? fallbackFetch,
    timeoutMs,
  };
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  return raw ? (positiveInteger(raw) ?? fallback) : fallback;
}

function resolveRateLimit(options?: SolanaMintRateLimit): ResolvedRateLimit {
  const limit =
    positiveInteger(options?.limit) ??
    envPositiveInteger(
      "SOLANA_MINT_RATE_LIMIT",
      DEFAULT_SOLANA_MINT_RATE_LIMIT,
    );
  const windowMs =
    positiveInteger(options?.windowMs) ??
    envPositiveInteger(
      "SOLANA_MINT_RATE_WINDOW_MS",
      DEFAULT_SOLANA_MINT_RATE_WINDOW_MS,
    );
  if (options?.limit !== undefined && positiveInteger(options.limit) === null) {
    throw new Error("invalid_rate_limit");
  }
  if (
    options?.windowMs !== undefined &&
    positiveInteger(options.windowMs) === null
  ) {
    throw new Error("invalid_rate_window");
  }
  return { limit, windowMs };
}

function agentRateKey(runtime: IAgentRuntime): string {
  const agentId = stringValue((runtime as { agentId?: unknown }).agentId);
  if (agentId) return agentId;
  const username = stringValue(runtime.character?.username);
  return username || "unknown";
}

function formatSupply(raw: string, decimals: number): string {
  const normalized = raw.replace(/^0+(?=\d)/, "");
  if (decimals === 0) return normalized;
  const padded = normalized.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function authority(value: unknown): string | null {
  return typeof value === "string" && BASE58_MINT.test(value) ? value : null;
}

export function parseMintSnapshot(
  mint: string,
  result: unknown,
): MintSnapshot | null {
  const root = record(result);
  const context = record(root?.context);
  const value = record(root?.value);
  if (!value) return null;

  const program = stringValue(value.owner);
  if (!TOKEN_PROGRAMS.has(program)) return null;

  const data = record(value.data);
  const parsed = record(data?.parsed);
  const info = record(parsed?.info);
  if (!parsed || parsed.type !== "mint" || !info) return null;

  const decimals = Number(info.decimals);
  const supply = typeof info.supply === "string" ? info.supply : "";
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !/^\d+$/.test(supply)
  ) {
    return null;
  }

  const slot = Number(context?.slot);
  return {
    mint,
    program,
    decimals,
    supplyRaw: supply,
    supplyUi: formatSupply(supply, decimals),
    mintAuthority: authority(info.mintAuthority),
    freezeAuthority: authority(info.freezeAuthority),
    isInitialized: info.isInitialized === true,
    slot: Number.isInteger(slot) && slot >= 0 ? slot : null,
    ...EMPTY_METADATA,
    readOnly: true,
  };
}

function metadataText(value: unknown, maxLength: number): string | null {
  const text = stringValue(value).replace(/\s+/g, " ");
  return text && text.length <= maxLength ? text : null;
}

function httpsUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function decodeBase58(value: string): Uint8Array | null {
  if (!value) return null;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    decoded = decoded * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded % 256n));
    decoded /= 256n;
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") {
    leadingZeros += 1;
  }
  return Uint8Array.from([
    ...new Array<number>(leadingZeros).fill(0),
    ...bytes,
  ]);
}

function encodeBase58(bytes: Uint8Array): string {
  let decoded = 0n;
  for (const byte of bytes) decoded = decoded * 256n + BigInt(byte);

  let encoded = "";
  while (decoded > 0n) {
    encoded = BASE58_ALPHABET[Number(decoded % 58n)] + encoded;
    decoded /= 58n;
  }
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }
  return "1".repeat(leadingZeros) + encoded;
}

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("crypto_unavailable");
  const bytes = new Uint8Array(input.length);
  bytes.set(input);
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

function modField(value: bigint): bigint {
  const reduced = value % ED25519_FIELD_PRIME;
  return reduced >= 0n ? reduced : reduced + ED25519_FIELD_PRIME;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = modField(base);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = modField(result * factor);
    factor = modField(factor * factor);
    power >>= 1n;
  }
  return result;
}

function isEd25519Point(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) {
    const byte = index === 31 ? bytes[index] & 0x7f : bytes[index];
    y = (y << 8n) | BigInt(byte);
  }
  if (y >= ED25519_FIELD_PRIME) return false;

  const ySquared = modField(y * y);
  const numerator = modField(ySquared - 1n);
  const denominator = modField(ED25519_D * ySquared + 1n);
  if (denominator === 0n) return false;

  const xSquared = modField(
    numerator * modPow(denominator, ED25519_FIELD_PRIME - 2n),
  );
  let x = modPow(xSquared, (ED25519_FIELD_PRIME + 3n) / 8n);
  if (modField(x * x - xSquared) !== 0n) {
    x = modField(x * modPow(2n, (ED25519_FIELD_PRIME - 1n) / 4n));
  }
  return modField(x * x - xSquared) === 0n;
}

/**
 * Derive the Metaplex Token Metadata PDA for an SPL mint. This mirrors the
 * on-chain `find_program_address(["metadata", metadataProgram, mint])` call
 * without importing a wallet or transaction library.
 */
export async function findMetaplexMetadataAddress(
  mint: string,
): Promise<string | null> {
  const programId = decodeBase58(METAPLEX_PROGRAM_ID);
  const mintBytes = decodeBase58(mint);
  if (
    !programId ||
    programId.length !== 32 ||
    !mintBytes ||
    mintBytes.length !== 32
  ) {
    return null;
  }

  const seed = new TextEncoder().encode("metadata");
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump -= 1) {
    const preimage = new Uint8Array(
      seed.length +
        programId.length +
        mintBytes.length +
        1 +
        programId.length +
        marker.length,
    );
    let offset = 0;
    preimage.set(seed, offset);
    offset += seed.length;
    preimage.set(programId, offset);
    offset += programId.length;
    preimage.set(mintBytes, offset);
    offset += mintBytes.length;
    preimage[offset] = bump;
    offset += 1;
    preimage.set(programId, offset);
    offset += programId.length;
    preimage.set(marker, offset);

    const hashed = await sha256(preimage);
    if (!isEd25519Point(hashed)) return encodeBase58(hashed);
  }
  return null;
}

function readU32LE(data: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > data.length) return null;
  return (
    data[offset] +
    data[offset + 1] * 0x100 +
    data[offset + 2] * 0x10000 +
    data[offset + 3] * 0x1000000
  );
}

function readMetaplexString(
  data: Uint8Array,
  offset: number,
  maxBytes: number,
): { value: string; next: number } | null {
  const length = readU32LE(data, offset);
  if (
    length === null ||
    length > maxBytes ||
    offset + 4 + length > data.length
  ) {
    return null;
  }
  const raw = Buffer.from(
    data.subarray(offset + 4, offset + 4 + length),
  ).toString("utf8");
  return {
    value: raw.replace(/\0.*$/s, "").trim(),
    next: offset + 4 + length,
  };
}

/**
 * Parse a base64 Metaplex Token Metadata account returned by getAccountInfo.
 * The on-chain record contains name and symbol; the image is referenced by an
 * off-chain URI and is deliberately not fetched here.
 */
export function parseMetaplexMetadata(
  result: unknown,
  mint: string,
): MintMetadata | null {
  const root = record(result);
  const value = record(root?.value);
  if (!value || stringValue(value.owner) !== METAPLEX_PROGRAM_ID) return null;

  const dataField = value.data;
  let encoded = "";
  if (Array.isArray(dataField) && typeof dataField[0] === "string") {
    encoded = dataField[0];
  } else if (typeof dataField === "string") {
    encoded = dataField;
  }
  if (!encoded) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
  if (bytes.length < 69 || bytes[0] !== METAPLEX_METADATA_KEY) return null;

  const mintBytes = decodeBase58(mint);
  if (!mintBytes || mintBytes.length !== 32) return null;
  for (let index = 0; index < 32; index += 1) {
    if (bytes[33 + index] !== mintBytes[index]) return null;
  }

  const name = readMetaplexString(bytes, 65, 256);
  const symbol = name ? readMetaplexString(bytes, name.next, 64) : null;
  if (!name || !symbol) return null;

  return {
    name: metadataText(name.value, 120),
    symbol: metadataText(symbol.value, 32),
    logo: null,
  };
}

async function fetchMetaplexMetadata(
  mint: string,
  options: { fetchImpl: FetchLike; url: string; timeoutMs: number },
): Promise<MintMetadata> {
  try {
    const address = await findMetaplexMetadataAddress(mint);
    if (!address) return { ...EMPTY_METADATA };
    const result = await rpcCall(
      "getAccountInfo",
      [address, { encoding: "base64", commitment: "confirmed" }],
      options,
    );
    return parseMetaplexMetadata(result, mint) ?? { ...EMPTY_METADATA };
  } catch {
    return { ...EMPTY_METADATA };
  }
}

/**
 * DAS getAsset returns token metadata when the configured RPC supports the
 * Digital Asset Standard. If it is unavailable or empty, fall back to the
 * mint's on-chain Metaplex Token Metadata account before returning an empty
 * metadata object.
 */
export function parseMintMetadata(result: unknown): MintMetadata {
  const root = record(result);
  const content = record(root?.content);
  const metadata = record(content?.metadata);
  const links = record(content?.links);
  const name = metadataText(metadata?.name, 120);
  const symbol = metadataText(metadata?.symbol, 32);
  let logo = httpsUrl(links?.image);

  if (!logo && Array.isArray(content?.files)) {
    for (const file of content.files) {
      const candidate = record(file);
      if (candidate && stringValue(candidate.mime).startsWith("image/")) {
        logo = httpsUrl(candidate.uri);
        if (logo) break;
      }
    }
  }

  return { name, symbol, logo };
}

async function rpcCall(
  method: string,
  params: unknown,
  options: { fetchImpl: FetchLike; url: string; timeoutMs: number },
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new Error("rpc_unavailable");
  }
  if (!response || !response.ok) throw new Error("rpc_unavailable");

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new Error("rpc_unavailable");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_RPC_RESPONSE_BYTES) {
    throw new Error("rpc_response_too_large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("rpc_invalid_response");
  }
  const payload = record(parsed);
  if (!payload || payload.error != null) throw new Error("rpc_error");
  return payload.result;
}

async function fetchMintMetadata(
  mint: string,
  options: { fetchImpl: FetchLike; url: string; timeoutMs: number },
): Promise<MintMetadata> {
  let das: MintMetadata = { ...EMPTY_METADATA };
  try {
    das = parseMintMetadata(await rpcCall("getAsset", { id: mint }, options));
  } catch {
    das = { ...EMPTY_METADATA };
  }
  if (das.name && das.symbol) return das;
  const metaplex = await fetchMetaplexMetadata(mint, options);
  return {
    name: das.name ?? metaplex.name,
    symbol: das.symbol ?? metaplex.symbol,
    logo: das.logo ?? metaplex.logo,
  };
}

function formatSnapshot(snapshot: MintSnapshot): string {
  return [
    `Read-only mint snapshot for ${snapshot.mint}`,
    snapshot.name ? `Name: ${snapshot.name}` : "",
    snapshot.symbol ? `Symbol: ${snapshot.symbol}` : "",
    snapshot.logo ? `Logo: ${snapshot.logo}` : "",
    `Token program: ${snapshot.program}`,
    `Decimals: ${snapshot.decimals}`,
    `Supply: ${snapshot.supplyUi} (raw ${snapshot.supplyRaw})`,
    `Mint authority: ${snapshot.mintAuthority ?? "none"}`,
    `Freeze authority: ${snapshot.freezeAuthority ?? "none"}`,
    `Initialized: ${snapshot.isInitialized ? "yes" : "no"}`,
    snapshot.slot === null ? "" : `RPC slot: ${snapshot.slot}`,
    "No transaction was signed or sent.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function respond(
  callback: HandlerCallback | undefined,
  text: string,
  success: boolean,
  error?: string,
  data?: Record<string, unknown>,
): Promise<ActionResult> {
  if (callback) {
    const content: Content = {
      text,
      actions: [SOLANA_MINT_ACTION],
      source: "solana",
    };
    await callback(content);
  }
  return {
    success,
    text,
    ...(data ? { data } : {}),
    ...(error ? { error } : {}),
  };
}

function createHandler(options: {
  fetchImpl: FetchLike;
  rpcUrl?: string;
  timeoutMs: number;
  rateLimiter: RateLimitStore;
  metadataCache: MintMetadataCache;
  now: () => number;
}): Action["handler"] {
  return async (runtime, message, _state, handlerOptions, callback) => {
    const requestAt = options.now();
    const agent = agentRateKey(runtime);
    let rate: RateLimitDecision;
    try {
      rate = await options.rateLimiter.consume(agent, requestAt);
    } catch {
      const retryAfter = 5;
      runtime.logger?.error?.(
        {
          src: "solana-mint",
          event: "mint_snapshot_rate_limit_unavailable",
          agent,
          agentName: runtime.character?.name,
          retryAfter,
          backend: options.rateLimiter.backend,
        },
        "Solana mint rate limit store unavailable",
      );
      return respond(
        callback,
        "Mint snapshot rate limiting is temporarily unavailable. Try again shortly.",
        false,
        "rate_limit_unavailable",
        { rateLimitUnavailable: true, retryAfter },
      );
    }
    if (!rate.allowed) {
      runtime.logger?.warn?.(
        {
          src: "solana-mint",
          event: "mint_snapshot_rate_limited",
          agent,
          agentName: runtime.character?.name,
          retryAfter: rate.retryAfter,
          limit: rate.limit,
          windowMs: rate.windowMs,
          backend: options.rateLimiter.backend,
        },
        "Solana mint snapshot rate limited",
      );
      return respond(
        callback,
        `Too many mint snapshot requests for this agent. Try again in ${rate.retryAfter} seconds.`,
        false,
        "rate_limited",
        {
          rateLimited: true,
          retryAfter: rate.retryAfter,
          limit: rate.limit,
          windowMs: rate.windowMs,
        },
      );
    }

    const supplied = record(handlerOptions);
    const explicit =
      stringValue(supplied?.mint) ||
      stringValue(supplied?.address) ||
      stringValue(supplied?.tokenMint);
    const mint = explicit || findMint(messageText(message));

    if (!mint) {
      return respond(
        callback,
        "Send the SPL token mint address you want a snapshot of.",
        false,
        "mint_address_required",
      );
    }
    if (!BASE58_MINT.test(mint)) {
      return respond(
        callback,
        "That does not look like a Solana mint address.",
        false,
        "invalid_mint_address",
      );
    }

    let url: string;
    try {
      url = resolveRpcUrl(options.rpcUrl);
    } catch {
      return respond(
        callback,
        "Solana RPC is not configured correctly.",
        false,
        "invalid_rpc_url",
      );
    }

    try {
      const result = await rpcCall(
        "getAccountInfo",
        [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
        { fetchImpl: options.fetchImpl, url, timeoutMs: options.timeoutMs },
      );
      const root = record(result);
      if (!root || root.value == null) {
        return respond(
          callback,
          `No Solana account found for ${mint}.`,
          false,
          "mint_not_found",
        );
      }

      const snapshot = parseMintSnapshot(mint, result);
      if (!snapshot) {
        return respond(
          callback,
          `${mint} is not an initialized SPL token mint.`,
          false,
          "not_a_mint",
        );
      }

      const cacheKey = mintMetadataCacheKey(url, mint);
      let metadata = options.metadataCache.get(cacheKey, requestAt);
      if (!metadata) {
        metadata = await fetchMintMetadata(mint, {
          fetchImpl: options.fetchImpl,
          url,
          timeoutMs: options.timeoutMs,
        });
        options.metadataCache.set(cacheKey, metadata, options.now());
      }
      const enriched = { ...snapshot, ...metadata };
      return respond(callback, formatSnapshot(enriched), true, undefined, {
        ...enriched,
      });
    } catch {
      return respond(
        callback,
        "I could not fetch that mint snapshot. The Solana RPC may be unavailable.",
        false,
        "mint_lookup_failed",
      );
    }
  };
}

export function createSolanaMintPlugin(
  options: SolanaMintPluginOptions = {},
): Plugin {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const rateLimit = resolveRateLimit(options.rateLimit);
  const redisRateLimit = resolveRateLimitRedis(
    options.rateLimitRedis,
    fetchImpl,
  );
  const rateLimiter: RateLimitStore = redisRateLimit
    ? new RedisSolanaMintRateLimiter(rateLimit, redisRateLimit)
    : new MemorySolanaMintRateLimiter(rateLimit);
  const metadataCache = new MintMetadataCache(
    DEFAULT_SOLANA_MINT_METADATA_CACHE_MS,
  );
  const now = options.now ?? (() => Date.now());

  return {
    name: SOLANA_MINT_PLUGIN,
    description:
      "Read-only Solana SPL token mint snapshots. No signing, sending, swapping, transfers, or wallet access.",
    actions: [
      {
        name: SOLANA_MINT_ACTION,
        similes: [
          "FETCH_MINT_SNAPSHOT",
          "GET_MINT_INFO",
          "SOLANA_MINT_INFO",
          "READ_MINT",
        ],
        description:
          "Fetch a read-only snapshot of an SPL token mint on Solana: name, symbol, logo when available, decimals, supply, mint authority, freeze authority, initialization state, and RPC slot. Use when the user supplies a mint address or asks for a mint snapshot. This action never signs or sends a transaction.",
        validate: async (_runtime: IAgentRuntime, message: Memory) =>
          wantsSnapshot(messageText(message)),
        handler: createHandler({
          fetchImpl,
          rpcUrl: options.rpcUrl,
          timeoutMs,
          rateLimiter,
          metadataCache,
          now,
        }),
        examples: [
          [
            {
              name: "User",
              content: {
                text: "Fetch a mint snapshot for EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.",
              },
            },
            {
              name: "Zeus",
              content: {
                text: "Fetched the read-only mint snapshot. It reports the current supply, decimals, mint authority and freeze authority; no transaction was signed or sent.",
                actions: [SOLANA_MINT_ACTION],
              },
            },
          ],
          [
            {
              name: "User",
              content: {
                text: "What is the supply and mint authority of EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v?",
              },
            },
            {
              name: "Gorgo",
              content: {
                text: "I can fetch that read-only mint snapshot now.",
                actions: [SOLANA_MINT_ACTION],
              },
            },
          ],
        ],
      },
    ],
  };
}

export const solanaMintPlugin = createSolanaMintPlugin();
