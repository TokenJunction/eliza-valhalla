// Clerk toolkit for ValhallaOS.
//
// This module is the reverse-engineered, runtime-safe half of Clerk's Cursor
// plugin:
//   - the bundled Agent Skills tree (SKILL.md + references/templates), and
//   - a small Streamable HTTP client for Clerk's remote MCP server.
//
// The MCP client is read-only by construction. A tool must appear in
// READ_ONLY_TOOLS (or an explicitly configured extra allowlist) before a request
// is sent. Known mutating tools can never be enabled by configuration.
//
// Nothing here can approve, apply, commit, push or deploy a change, and no
// token is ever written to a response, log or error message.

import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const CLERK_MCP_DEFAULT_URL = 'https://mcp.clerk.com/mcp';
export const CLERK_MCP_PROTOCOL_VERSION = '2025-06-18';
export const CLERK_TOOLKIT_VERSION = '1.0.0';

export const CLERK_READ_ONLY_TOOLS = Object.freeze([
  'clerk_sdk_snippet',
  'list_clerk_sdk_snippets',
  'whoami',
  'list_applications',
  'get_application',
  'get_instance_config',
  'get_instance_config_schema',
  'list_users',
  'list_domains',
  'get_domain_status',
  'get_deploy_oauth_providers',
  'list_application_feedback',
]);

// These names are blocked even if an operator tries to add them to the extra
// allowlist. The list is intentionally broader than today's documented tools so
// a new write endpoint cannot be enabled by accident.
export const CLERK_MUTATING_TOOLS = Object.freeze([
  'create_application',
  'patch_instance_config',
  'put_instance_config',
  'create_user',
  'update_user',
  'delete_user',
  'check_domain_dns',
  'create_production_instance',
  'set_oauth_provider_credentials',
  'submit_feedback',
  'get_more_tools',
]);

const READ_ONLY = new Set(CLERK_READ_ONLY_TOOLS);
const MUTATING = new Set(CLERK_MUTATING_TOOLS);
const SKILL_NAME = /^clerk(?:-[a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ALLOWED_FILE_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.txt',
  '.yaml',
  '.yml',
  '.toml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.astro',
  '.css',
  '.html',
  '.kt',
  '.swift',
  '.sh',
]);
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_TOOL_TEXT = 64 * 1024;
const MAX_CONTEXT_CHARS = 200;

const catalogCache = new Map();

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bound(value, limit = MAX_TOOL_TEXT) {
  const source = String(value ?? '');
  return source.length > limit
    ? `${source.slice(0, limit)}\n[truncated at ${limit} characters]`
    : source;
}

function redact(value, token) {
  let output = String(value ?? '');
  if (token) output = output.split(token).join('[redacted]');
  return output.replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1[redacted]',
  );
}

function redactObject(value, token) {
  if (typeof value === 'string') return redact(value, token);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, token));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactObject(item, token)]),
    );
  }
  return value;
}

export class ClerkToolkitError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ClerkToolkitError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ClerkToolkitError(code, message);
}

export class ClerkMcpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ClerkMcpError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Agent Skills
// ---------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter reader for the fields the catalog needs. Clerk's
 * skills use `name`, `description`, and folded descriptions (`>-`), so a full
 * YAML dependency is not required.
 */
export function parseSkillFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(markdown ?? ''));
  if (!match) return {};
  const fields = {};
  let current = null;
  let style = null;

  for (const rawLine of match[1].split(/\r?\n/)) {
    const key = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(rawLine);
    if (key) {
      current = key[1];
      const value = key[2].trim();
      style = /^[>|][+-]?$/.test(value) ? value[0] : null;
      fields[current] = style ? '' : value;
      continue;
    }
    if (current && /^[ \t]+/.test(rawLine)) {
      const value = rawLine.trim();
      if (!value) continue;
      if (!fields[current]) {
        fields[current] = value;
      } else {
        fields[current] += (style === '|' ? '\n' : ' ') + value;
      }
      continue;
    }
    if (rawLine.trim() === '') continue;
    current = null;
    style = null;
  }

  for (const key of ['name', 'description', 'license']) {
    if (typeof fields[key] !== 'string') continue;
    let value = fields[key].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value.replace(/[ \t]+/g, ' ').trim();
  }
  return fields;
}

export function resolveClerkSkillsRoot(explicitRoot) {
  const envRoot = text(process.env.CLERK_SKILLS_DIR);
  const candidates = explicitRoot
    ? [explicitRoot]
    : [
        envRoot,
        path.resolve(process.cwd(), 'skills/clerk-toolkit/skills'),
        path.resolve(MODULE_DIR, 'skills'),
        path.resolve(MODULE_DIR, '..', 'skills', 'clerk-toolkit', 'skills'),
        path.resolve(MODULE_DIR, '..', '..', 'skills', 'clerk-toolkit', 'skills'),
      ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, 'clerk', 'SKILL.md'))) return resolved;
  }
  return path.resolve(
    explicitRoot || envRoot || path.join(process.cwd(), 'skills/clerk-toolkit/skills'),
  );
}

async function listRelativeFiles(root, prefix = '') {
  const directory = path.join(root, prefix);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export async function loadClerkCatalog(options = {}) {
  const root = resolveClerkSkillsRoot(options.skillsRoot);
  const cached = catalogCache.get(root);
  if (cached) return cached;

  let entries;
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail('SKILLS_NOT_INSTALLED', 'The Clerk skills directory is unavailable.');
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof ClerkToolkitError) throw error;
    fail('SKILLS_NOT_INSTALLED', 'The Clerk skills directory is unavailable.');
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillRoot = path.join(root, entry.name);
    const skillFile = path.join(skillRoot, 'SKILL.md');
    let markdown;
    try {
      markdown = await readFile(skillFile, 'utf8');
    } catch {
      continue;
    }
    const frontmatter = parseSkillFrontmatter(markdown);
    if (frontmatter.name !== entry.name || !frontmatter.description) continue;
    const files = await listRelativeFiles(skillRoot);
    skills.push({
      name: entry.name,
      description: frontmatter.description,
      license: frontmatter.license || '',
      path: skillRoot,
      files,
      references: files.filter((file) => file !== 'SKILL.md'),
    });
  }

  if (!skills.length) {
    fail('SKILLS_NOT_INSTALLED', 'No valid Clerk skills were found.');
  }
  // The router is the stable first entry; the rest are alphabetical.
  skills.sort((left, right) => {
    if (left.name === 'clerk') return -1;
    if (right.name === 'clerk') return 1;
    return left.name.localeCompare(right.name);
  });
  catalogCache.set(root, skills);
  return skills;
}

export function clearClerkCatalogCache() {
  catalogCache.clear();
}

const SELECTION_RULES = [
  {
    skill: 'clerk-react-router-patterns',
    re: /\bclerk[- ]?react[- ]?router\b|\breact[- ]?router\b|\bremix\b|\broute loaders?\b|\bloaders? and actions?\b/i,
    score: 30,
  },
  {
    skill: 'clerk-nextjs-patterns',
    re: /\bclerk[- ]?nextjs\b|\bnext\.?js\b|\bapp router\b|\bserver actions?\b|\bproxy\.ts\b/i,
    score: 28,
  },
  {
    // Middleware alone is weak evidence: Nuxt, Astro and React Router all use
    // the word. A framework rule above outranks this, while a bare request for
    // "Clerk middleware" still resolves to the Next.js skill.
    skill: 'clerk-nextjs-patterns',
    re: /\bmiddleware\b|\broute protection\b|\bprotected routes?\b/i,
    score: 10,
  },
  {
    skill: 'clerk-expo',
    re: /\bclerk[- ]?expo\b|\bexpo\b|\breact native\b|\bsecurestore\b/i,
    score: 28,
  },
  {
    skill: 'clerk-nuxt-patterns',
    re: /\bclerk[- ]?nuxt\b|\bnuxt\b/i,
    score: 26,
  },
  {
    skill: 'clerk-tanstack-patterns',
    re: /\bclerk[- ]?tanstack\b|\btanstack\b/i,
    score: 26,
  },
  {
    skill: 'clerk-astro-patterns',
    re: /\bclerk[- ]?astro\b|\bastro\b/i,
    score: 26,
  },
  {
    skill: 'clerk-vue-patterns',
    re: /\bclerk[- ]?vue\b|\bvue\b|\bpinia\b/i,
    score: 24,
  },
  {
    skill: 'clerk-chrome-extension-patterns',
    re: /\bchrome extension\b|\bbrowser extension\b|\bsidepanel\b|\bsync host\b/i,
    score: 26,
  },
  {
    skill: 'clerk-android',
    re: /\bclerk[- ]?android\b|\bandroid\b|\bkotlin\b|\bjetpack compose\b/i,
    score: 26,
  },
  {
    skill: 'clerk-swift',
    re: /\bclerk[- ]?swift\b|\bios\b|\bswiftui?\b|\bclerkkit\b/i,
    score: 26,
  },
  {
    skill: 'clerk-orgs',
    re: /\borganizations?\b|\bb2b\b|\brbac\b|\bmulti[- ]?tenant\b|\bpermissions?\b|\broles?\b/i,
    score: 18,
  },
  {
    skill: 'clerk-billing',
    re: /\bbilling\b|\bsubscriptions?\b|\bpricing table\b|\bentitlements?\b|\bseat[- ]?based\b|\bplans?\b/i,
    score: 18,
  },
  {
    skill: 'clerk-webhooks',
    re: /\bwebhooks?\b|\bsvix\b|\buser\.created\b/i,
    score: 18,
  },
  {
    skill: 'clerk-testing',
    re: /\bplaywright\b|\bcypress\b|\be2e tests?\b|\bend[- ]to[- ]end tests?\b|\btesting tokens?\b/i,
    score: 18,
  },
  {
    skill: 'clerk-custom-ui',
    re: /\bcustom (?:clerk )?(?:sign|auth)|\bappearance\b|\buseSignIn\b|\buseSignUp\b|\bsign-in form\b/i,
    score: 16,
  },
  {
    skill: 'clerk-backend-api',
    re: /\bbackend api\b|\brest api\b|\bapi endpoints?\b|\bcurl\b|\bhttp request\b/i,
    score: 16,
  },
  {
    skill: 'clerk-cli',
    re: /\bclerk cli\b|\bclerk (?:auth|link|env|deploy|doctor|api|apps|users|orgs|impersonate|webhooks)\b/i,
    score: 16,
  },
  {
    skill: 'clerk-setup',
    re: /\bset ?up\b|\binstall(?:ing)?\b|\badd clerk\b|\bgetting started\b|\bmigrat(?:e|ion)\b|\bquickstart\b/i,
    score: 12,
  },
  {
    skill: 'clerk-react-patterns',
    re: /\bclerk[- ]?react\b|\breact\b|\buseUser\b|\buseAuth\b|\bprotected route\b/i,
    score: 10,
  },
];

function ruleScore(skillName, haystack) {
  let score = 0;
  for (const rule of SELECTION_RULES) {
    if (rule.skill === skillName && rule.re.test(haystack)) score += rule.score;
  }
  return score;
}

/**
 * Rank bundled skills for a request. The best match is first; the router is the
 * fallback when nothing specific is mentioned.
 */
export function selectClerkSkills(request, catalog, limit = 2) {
  const haystack = String(request ?? '');
  if (!Array.isArray(catalog) || !catalog.length) return [];
  const ranked = catalog.map((skill) => {
    let score = ruleScore(skill.name, haystack);
    // The router is the fallback. Its name is a substring of every skill name,
    // so an exact-name bonus here would always drown out the specific match.
    if (skill.name !== 'clerk' && new RegExp(`\\b${skill.name}\\b`, 'i').test(haystack)) {
      score += 100;
    }
    if (/\bclerk\b/i.test(haystack) && skill.name === 'clerk') score += 1;
    return { skill, score };
  });
  ranked.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  const positive = ranked.filter((entry) => entry.score > 1);
  if (!positive.length) {
    return catalog.filter((skill) => skill.name === 'clerk').slice(0, limit);
  }
  return positive.slice(0, Math.max(1, limit)).map((entry) => entry.skill);
}

export function searchClerkSkills(query, catalog) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !['clerk', 'the', 'and', 'for', 'with'].includes(term));
  if (!terms.length) return catalog.slice();
  return catalog
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const description = skill.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.split('-').includes(term)) score += 8;
        if (name.includes(term)) score += 3;
        if (description.includes(term)) score += 1;
      }
      return { skill, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .map((entry) => entry.skill);
}

function normalizeSkillFile(file) {
  const value = String(file ?? 'SKILL.md').trim().replace(/\\/g, '/');
  if (!value || CONTROL_CHARS.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail('SKILL_FILE_FORBIDDEN', 'The Clerk skill file must be a relative path.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('SKILL_FILE_FORBIDDEN', 'The Clerk skill file path is not allowed.');
  }
  const extension = path.posix.extname(value).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    fail('SKILL_FILE_FORBIDDEN', 'That Clerk skill file type cannot be read.');
  }
  return parts.join('/');
}

export async function readClerkSkill(skillName, options = {}) {
  const catalog = await loadClerkCatalog({ skillsRoot: options.skillsRoot });
  const name = text(skillName);
  if (!SKILL_NAME.test(name)) {
    fail('UNKNOWN_CLERK_SKILL', 'That is not a valid Clerk skill name.');
  }
  const skill = catalog.find((entry) => entry.name === name);
  if (!skill) fail('UNKNOWN_CLERK_SKILL', `Unknown Clerk skill: ${name}`);
  const relative = normalizeSkillFile(options.file || 'SKILL.md');
  const target = path.resolve(skill.path, relative);
  const root = `${path.resolve(skill.path)}${path.sep}`;
  if (!target.startsWith(root)) {
    fail('SKILL_FILE_FORBIDDEN', 'The Clerk skill file is outside the skill directory.');
  }
  const info = await lstat(target).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    fail('SKILL_FILE_NOT_FOUND', `The Clerk skill file was not found: ${relative}`);
  }
  if (info.size > MAX_SKILL_FILE_BYTES) {
    fail('SKILL_FILE_TOO_LARGE', 'That Clerk skill file is too large to load.');
  }
  const realTarget = await realpath(target);
  const realRoot = await realpath(skill.path);
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) {
    fail('SKILL_FILE_FORBIDDEN', 'The Clerk skill file resolves outside the skill directory.');
  }
  const content = await readFile(realTarget, 'utf8');
  return {
    skill: skill.name,
    description: skill.description,
    file: relative,
    content,
    references: skill.references,
  };
}

// ---------------------------------------------------------------------------
// Clerk MCP: configuration
// ---------------------------------------------------------------------------

export function normalizeMcpUrl(rawUrl, options = {}) {
  const value = text(rawUrl) || CLERK_MCP_DEFAULT_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('MCP_CONFIG_INVALID', 'CLERK_MCP_URL must be a valid URL.');
  }
  if (url.username || url.password) {
    fail('MCP_CONFIG_INVALID', 'CLERK_MCP_URL must not contain credentials.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && loopback && options.allowInsecure === true) {
    return url.href;
  }
  fail('MCP_CONFIG_INVALID', 'CLERK_MCP_URL must use HTTPS (HTTP is allowed only for loopback tests).');
}

export async function resolveClerkMcpConfig(options = {}) {
  const env = options.env || process.env;
  const allowInsecure = options.allowInsecure === true ||
    /^(1|true|yes|on)$/i.test(String(env.CLERK_MCP_ALLOW_INSECURE || '').trim());
  const url = normalizeMcpUrl(options.url || env.CLERK_MCP_URL, { allowInsecure });

  let token = text(options.token ?? env.CLERK_MCP_TOKEN);
  let tokenSource = token ? 'environment' : 'none';
  if (!token) {
    const tokenFile = text(options.tokenFile ?? env.CLERK_MCP_TOKEN_FILE);
    if (tokenFile) {
      let raw;
      try {
        const info = await lstat(tokenFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024) {
          fail('MCP_CONFIG_INVALID', 'CLERK_MCP_TOKEN_FILE must be a small regular file.');
        }
        raw = await readFile(tokenFile, 'utf8');
      } catch (error) {
        if (error instanceof ClerkToolkitError) throw error;
        fail('MCP_CONFIG_INVALID', 'CLERK_MCP_TOKEN_FILE could not be read.');
      }
      token = raw.trim();
      tokenSource = 'file';
    }
  }
  if (token && /[\r\n]/.test(token)) {
    fail('MCP_CONFIG_INVALID', 'The Clerk MCP token must be a single line.');
  }
  return {
    url,
    token,
    configured: Boolean(token),
    tokenSource,
    allowInsecure,
  };
}

function extraReadOnlyTools(env = process.env) {
  return String(env.CLERK_MCP_EXTRA_READ_TOOLS || '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => TOOL_NAME.test(name) && !MUTATING.has(name));
}

export function isReadOnlyClerkTool(name, extraTools = []) {
  if (!TOOL_NAME.test(String(name || ''))) return false;
  if (MUTATING.has(name)) return false;
  return READ_ONLY.has(name) || extraTools.includes(name);
}

export function describeClerkMcpTools(extraTools = []) {
  return [...new Set([...CLERK_READ_ONLY_TOOLS, ...extraTools])].sort();
}

// ---------------------------------------------------------------------------
// Clerk MCP: Streamable HTTP client
// ---------------------------------------------------------------------------

function parseJsonRpcResponse(body, id) {
  if (body == null) return null;
  if (Array.isArray(body)) {
    return body.find((message) => message && message.id === id) || body[0] || null;
  }
  return body;
}

function parseSseBody(raw, id) {
  const messages = [];
  for (const event of String(raw ?? '').replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A keepalive or partial event is not a JSON-RPC response.
    }
  }
  return parseJsonRpcResponse(messages, id);
}

export class ClerkMcpClient {
  constructor(options = {}) {
    this.url = normalizeMcpUrl(options.url || CLERK_MCP_DEFAULT_URL, {
      allowInsecure: options.allowInsecure === true,
    });
    this.token = text(options.token);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 30_000;
    this.protocolVersion = options.protocolVersion || CLERK_MCP_PROTOCOL_VERSION;
    this.clientInfo = options.clientInfo || {
      name: 'valhalla-clerk-toolkit',
      version: CLERK_TOOLKIT_VERSION,
    };
    this.sessionId = null;
    this.serverInfo = null;
    this.initialized = false;
    this.nextId = 1;
    this.extraTools = options.extraTools || [];
  }

  _headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.protocolVersion,
      'user-agent': `valhalla-clerk-toolkit/${CLERK_TOOLKIT_VERSION}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async _post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (error && (error.name === 'AbortError' || controller.signal.aborted)) {
        throw new ClerkMcpError('MCP_TIMEOUT', 'The Clerk MCP request timed out.');
      }
      throw new ClerkMcpError('MCP_UNREACHABLE', 'The Clerk MCP server could not be reached.');
    } finally {
      clearTimeout(timer);
    }

    const sessionId = response.headers?.get?.('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 401 || response.status === 403) {
      throw new ClerkMcpError(
        'MCP_AUTH_REQUIRED',
        'Clerk MCP requires a valid OAuth access token. Configure CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE.',
      );
    }
    if (!response.ok) {
      throw new ClerkMcpError(
        'MCP_HTTP_ERROR',
        `The Clerk MCP server returned HTTP ${response.status}.`,
      );
    }
    if (response.status === 202 || response.status === 204) return null;

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      const raw = await response.text();
      return raw.trim() ? parseSseBody(raw, payload.id) : null;
    }

    const raw = await response.text();
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new ClerkMcpError('MCP_INVALID_RESPONSE', 'Clerk MCP returned an invalid response.');
    }
  }

  _unwrap(message, id) {
    const response = parseJsonRpcResponse(message, id);
    if (!response) {
      throw new ClerkMcpError('MCP_EMPTY_RESPONSE', 'Clerk MCP returned no response.');
    }
    if (response.error) {
      const detail = redact(response.error.message || 'Clerk MCP request failed.', this.token);
      throw new ClerkMcpError('MCP_RPC_ERROR', bound(detail, 500));
    }
    return response.result ?? {};
  }

  async _request(method, params, options = {}) {
    if (!this.initialized && method !== 'initialize') {
      throw new ClerkMcpError('MCP_NOT_INITIALIZED', 'The Clerk MCP client is not initialized.');
    }
    const id = this.nextId++;
    const message = await this._post({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (options.notification) return null;
    return this._unwrap(message, id);
  }

  async initialize() {
    if (this.initialized) {
      return { protocolVersion: this.protocolVersion, serverInfo: this.serverInfo };
    }
    const id = this.nextId++;
    const message = await this._post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
    });
    const result = this._unwrap(message, id);
    if (typeof result.protocolVersion === 'string') {
      this.protocolVersion = result.protocolVersion;
    }
    this.serverInfo = result.serverInfo || null;
    this.initialized = true;
    try {
      await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (error) {
      if (error instanceof ClerkMcpError && error.code === 'MCP_AUTH_REQUIRED') throw error;
      // Some servers answer notifications with an empty 405/202. The session is
      // already usable after a successful initialize, so this is not fatal.
    }
    return result;
  }

  async listTools() {
    await this.initialize();
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await this._request('tools/list', cursor ? { cursor } : {});
      if (Array.isArray(result.tools)) tools.push(...result.tools);
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools.map((tool) => ({
      name: String(tool?.name || ''),
      title: typeof tool?.title === 'string' ? tool.title : undefined,
      description: typeof tool?.description === 'string' ? tool.description : '',
      inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : null,
      readOnly: isReadOnlyClerkTool(String(tool?.name || ''), this.extraTools),
    }));
  }

  async callTool(name, args = {}, options = {}) {
    const toolName = String(name || '');
    if (!isReadOnlyClerkTool(toolName, this.extraTools)) {
      throw new ClerkMcpError(
        'MCP_TOOL_NOT_ALLOWED',
        'That Clerk tool is not on the Valkyrie read-only allowlist.',
      );
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ClerkMcpError('MCP_ARGUMENTS_INVALID', 'Clerk tool arguments must be an object.');
    }
    const context = text(options.context) || 'ValhallaOS agent requesting Clerk reference material for a coding task';
    const payload = {
      ...redactObject(args, this.token),
      context: context.replace(/\s+/g, ' ').slice(0, MAX_CONTEXT_CHARS),
    };
    await this.initialize();
    const result = await this._request('tools/call', {
      name: toolName,
      arguments: payload,
    });
    const chunks = Array.isArray(result.content)
      ? result.content
          .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text)
      : [];
    let output = chunks.join('\n\n');
    if (!output && result.structuredContent != null) {
      output = JSON.stringify(result.structuredContent, null, 2);
    }
    output = redact(bound(output), this.token);
    if (result.isError === true) {
      throw new ClerkMcpError(
        'MCP_TOOL_ERROR',
        output || 'The Clerk tool returned an error.',
      );
    }
    return {
      name: toolName,
      text: output,
      structuredContent: redactObject(result.structuredContent ?? null, this.token),
      readOnly: true,
    };
  }
}

export async function createClerkMcpClient(options = {}) {
  const env = options.env || process.env;
  const config = await resolveClerkMcpConfig({
    ...options,
    env,
  });
  return {
    config,
    client: new ClerkMcpClient({
      url: config.url,
      token: config.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      allowInsecure: config.allowInsecure,
      extraTools: extraReadOnlyTools(env),
    }),
  };
}

export async function clerkToolkitDoctor(options = {}) {
  const catalog = await loadClerkCatalog({ skillsRoot: options.skillsRoot });
  let config;
  try {
    config = await resolveClerkMcpConfig(options);
  } catch (error) {
    return {
      version: CLERK_TOOLKIT_VERSION,
      skills: { ok: true, count: catalog.length, names: catalog.map((skill) => skill.name) },
      mcp: {
        configured: false,
        status: 'error',
        code: error instanceof ClerkToolkitError ? error.code : 'MCP_CONFIG_INVALID',
        message: error instanceof Error ? error.message : 'Invalid Clerk MCP configuration.',
      },
    };
  }

  const base = {
    version: CLERK_TOOLKIT_VERSION,
    skills: { ok: true, count: catalog.length, names: catalog.map((skill) => skill.name) },
  };
  if (!config.configured) {
    return {
      ...base,
      mcp: {
        configured: false,
        status: 'not_configured',
        url: config.url,
        message: 'Set CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE to enable live Clerk MCP calls.',
      },
    };
  }

  const client = new ClerkMcpClient({
    url: config.url,
    token: config.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    allowInsecure: config.allowInsecure,
    extraTools: extraReadOnlyTools(options.env || process.env),
  });
  try {
    const initialized = await client.initialize();
    const tools = await client.listTools();
    return {
      ...base,
      mcp: {
        configured: true,
        status: 'ok',
        url: config.url,
        tokenSource: config.tokenSource,
        serverInfo: initialized.serverInfo,
        protocolVersion: initialized.protocolVersion,
        tools: tools.map((tool) => ({
          name: tool.name,
          readOnly: tool.readOnly,
          description: tool.description,
        })),
      },
    };
  } catch (error) {
    return {
      ...base,
      mcp: {
        configured: true,
        status: 'error',
        url: config.url,
        tokenSource: config.tokenSource,
        code: error instanceof ClerkMcpError ? error.code : 'MCP_UNKNOWN',
        message: redact(error instanceof Error ? error.message : 'Clerk MCP check failed.', config.token),
      },
    };
  }
}
