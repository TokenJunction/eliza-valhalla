import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  ProviderResult,
} from '@elizaos/core';
import { VALHALLA_ROLE_IDS, type ValhallaRoleId } from './character.ts';
import {
  CLERK_MUTATING_TOOLS,
  ClerkMcpClient,
  ClerkToolkitError,
  describeClerkMcpTools,
  isReadOnlyClerkTool,
  loadClerkCatalog,
  readClerkSkill,
  resolveClerkMcpConfig,
  selectClerkSkills,
} from '../skills/clerk-toolkit/lib.mjs';

export const CLERK_TOOLKIT_PLUGIN = 'valhalla-clerk-toolkit';
export const CLERK_SKILL_LOOKUP_ACTION = 'CLERK_SKILL_LOOKUP';
export const CLERK_SNIPPET_ACTION = 'CLERK_SNIPPET';
export const CLERK_MCP_READ_ACTION = 'CLERK_MCP_READ';

export const DEFAULT_ALLOWED_CLERK_ROLES: readonly ValhallaRoleId[] = [
  'zeus',
  'odin',
  'wren',
  'valkyrie',
  'forge',
  'hermod',
];

const DEFAULT_MAX_CHARS = 24_000;
const MIN_MAX_CHARS = 4_000;
const MAX_MAX_CHARS = 60_000;
const MAX_ACTION_TEXT = 48_000;
const MAX_DESCRIPTION = 220;

const SNIPPET_BUNDLES = [
  'b2b-saas',
  'waitlist',
  'auth-basics',
  'custom-flows',
  'organizations',
  'server-side',
];

type RecordValue = Record<string, unknown>;

export type ClerkToolkitPluginOptions = {
  /** Override the vendored skills directory (tests or a packaged deployment). */
  skillsRoot?: string;
  /** Roles allowed to read skills or call Clerk. */
  allowedRoles?: readonly string[];
  /** Maximum characters of skill context injected into one model turn. */
  maxChars?: number | string;
  /** Override the MCP endpoint. HTTPS is required outside tests. */
  mcpUrl?: string;
  /** OAuth bearer token; normally supplied through the environment. */
  token?: string;
  /** File containing the OAuth bearer token. */
  tokenFile?: string;
  /** Test seam for the MCP transport. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecure?: boolean;
  /** Environment map used for token and role resolution. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Additional read-only MCP tool names; known mutating names are still blocked. */
  extraTools?: readonly string[];
};

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function messageText(message: Memory | undefined): string {
  const content = asRecord(message?.content) ?? {};
  return [content.text, content.query, content.message]
    .map(textValue)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function roleOf(runtime: IAgentRuntime | undefined): string {
  const settings = asRecord(runtime?.character?.settings);
  return textValue(settings?.valhallaRole).toLowerCase();
}

function normalizeRoles(
  value: readonly string[] | string | undefined,
): Set<string> {
  const source =
    value === undefined || value === ''
      ? DEFAULT_ALLOWED_CLERK_ROLES
      : typeof value === 'string'
        ? value.split(',')
        : value;
  const known = new Set<string>(VALHALLA_ROLE_IDS);
  return new Set(
    source
      .map((role) => String(role).trim().toLowerCase())
      .filter((role) => known.has(role)),
  );
}

function normalizeMaxChars(value: number | string | undefined): number {
  const parsed = value === undefined ? DEFAULT_MAX_CHARS : Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_MAX_CHARS;
  return Math.min(Math.max(parsed, MIN_MAX_CHARS), MAX_MAX_CHARS);
}

function normalizeExtraTools(options: ClerkToolkitPluginOptions): string[] {
  const source = [
    ...(options.extraTools ?? []),
    ...String(
      options.env?.CLERK_MCP_EXTRA_READ_TOOLS ??
        process.env.CLERK_MCP_EXTRA_READ_TOOLS ??
        '',
    ).split(','),
  ];
  return Array.from(
    new Set(
      source
        .map((name) => String(name).trim())
        // A name is admitted only if the allowlist accepts it with itself as
        // the extra entry. Known mutating tools therefore stay blocked.
        .filter((name) => name && isReadOnlyClerkTool(name, [name])),
    ),
  );
}

function hasClerkMention(message: Memory | undefined): boolean {
  const content = asRecord(message?.content) ?? {};
  return (
    /\bclerk\b/i.test(messageText(message)) ||
    content.clerk === true ||
    typeof content.clerkSkill === 'string'
  );
}

function bound(text: string, limit = MAX_ACTION_TEXT): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[truncated at ${limit} characters]`
    : text;
}

function catalogLines(skills: { name: string; description: string }[]): string {
  return skills
    .map((skill) => {
      const description =
        skill.description.length > MAX_DESCRIPTION
          ? `${skill.description.slice(0, MAX_DESCRIPTION - 1)}…`
          : skill.description;
      return `- \`${skill.name}\` — ${description}`;
    })
    .join('\n');
}

function referenceCandidates(skill: { references: string[] }): string[] {
  return skill.references.filter(
    (file) => file.startsWith('references/') && file.endsWith('.md'),
  );
}

function pickReference(
  skill: { references: string[] },
  request: string,
): string | null {
  const explicit = request.match(
    /(?:references?|file)\s+`?([a-z0-9._/-]+\.md)`?/i,
  )?.[1];
  const references = referenceCandidates(skill);
  if (explicit) {
    const normalized = explicit.replace(/^\.?\//, '');
    return (
      references.find(
        (file) => file === normalized || file.endsWith(`/${normalized}`),
      ) ?? null
    );
  }

  const words = new Set(
    request
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  let best: { file: string; score: number } | null = null;
  for (const file of references) {
    const name = file
      .replace(/^references\//, '')
      .replace(/\.md$/, '')
      .toLowerCase();
    const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    for (const token of tokens) {
      if (words.has(token)) score += 2;
      if (token.length > 4 && request.toLowerCase().includes(token)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { file, score };
  }
  return best && best.score >= 2 ? best.file : null;
}

function mcpStatusText(
  configured: boolean,
  extraTools: readonly string[] = [],
): string {
  const tools = describeClerkMcpTools([...extraTools]);
  if (!configured) {
    return [
      'Status: not configured. Local Clerk skills work normally; live Clerk account and snippet tools are disabled.',
      `Read-only tools available once CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE is set: ${tools.join(', ')}.`,
      'Use the CLERK_MCP_READ action for a live read. It fails closed without a token.',
    ].join('\n');
  }
  return [
    'Status: configured for read-only calls.',
    `Allowed tools: ${tools.join(', ')}.`,
    'Use CLERK_SNIPPET for SDK snippets and CLERK_MCP_READ for account reads.',
    `Mutating tools are refused before any request: ${CLERK_MUTATING_TOOLS.join(', ')}.`,
  ].join('\n');
}

async function buildProviderText(options: {
  message: Memory;
  maxChars: number;
  skillsRoot?: string;
  mcpConfigured: boolean;
  extraTools: readonly string[];
}): Promise<ProviderResult> {
  const catalog = await loadClerkCatalog({ skillsRoot: options.skillsRoot });
  const request = messageText(options.message);
  const selected = selectClerkSkills(request, catalog, 2);
  const primary = selected[0];
  if (!primary) return { text: '' };

  let skillContent = '';
  let selectedFile = 'SKILL.md';
  let referenceContent = '';
  let selectedReference: string | null = null;
  try {
    const skill = await readClerkSkill(primary.name, {
      skillsRoot: options.skillsRoot,
    });
    skillContent = skill.content;
    selectedFile = skill.file;
    selectedReference = pickReference(skill, request);
    if (selectedReference) {
      const reference = await readClerkSkill(primary.name, {
        file: selectedReference,
        skillsRoot: options.skillsRoot,
      });
      referenceContent = reference.content;
    }
  } catch (error) {
    skillContent = `[The selected Clerk skill could not be loaded: ${
      error instanceof Error ? error.message : 'unknown error'
    }]`;
  }

  const related = selected
    .slice(1)
    .map((skill) => skill.name)
    .filter((name) => name !== primary.name);

  const sections = [
    '# Clerk toolkit (read-only)',
    [
      'The ValhallaOS Clerk toolkit ports the official Clerk Cursor plugin: 20 bundled Clerk skills plus a read-only Streamable HTTP MCP client.',
      'Use the selected skill below as the source of truth for code, commands and setup steps. Never invent Clerk API names or claim a live account action succeeded without tool output.',
      'Clerk MCP calls are limited to read-only tools. You cannot create or change Clerk applications, users, domains, instance settings or production instances. Coding is still proposal-only: use VALKYRIE_PROPOSE_PATCH and leave approval to a human.',
      'Never ask for a Clerk secret key, password or token in chat. The MCP server does not return secret keys.',
    ].join(' '),
    `## Available Clerk skills\n${catalogLines(catalog)}${
      related.length ? `\n\nOther relevant skills: ${related.join(', ')}` : ''
    }`,
    `## Live Clerk MCP\n${mcpStatusText(options.mcpConfigured, options.extraTools)}`,
    '## Commands\n- List or read a skill: `CLERK_SKILL_LOOKUP`\n- Fetch an SDK snippet: `CLERK_SNIPPET`\n- Call a read-only account tool: `CLERK_MCP_READ` (for example `clerk mcp whoami`)',
    `## Selected skill: \`${primary.name}\` (${selectedFile})\n${skillContent}`,
    selectedReference
      ? `## Selected reference: \`${selectedReference}\`\n${referenceContent}`
      : '',
  ].filter(Boolean);

  let output = sections.join('\n\n');
  if (output.length > options.maxChars) {
    output = `${output.slice(0, options.maxChars)}\n[truncated at ${options.maxChars} characters]`;
  }

  return {
    text: output,
    values: {
      clerkSkill: primary.name,
      clerkSkillFile: selectedFile,
      clerkReferences: primary.references.length,
      clerkMcpConfigured: options.mcpConfigured,
    },
    data: {
      clerkSkill: primary.name,
      clerkSkillFile: selectedFile,
      clerkSelectedReference: selectedReference,
      clerkRelatedSkills: related,
      clerkMcpConfigured: options.mcpConfigured,
    },
  };
}

function createClerkProvider(options: {
  allowedRoles: ReadonlySet<string>;
  maxChars: number;
  skillsRoot?: string;
  token?: string;
  tokenFile?: string;
  mcpUrl?: string;
  allowInsecure?: boolean;
  env?: Record<string, string | undefined>;
  extraTools: readonly string[];
}) {
  return {
    name: 'CLERK_TOOLKIT',
    description:
      'Bundled Clerk Agent Skills and a read-only Clerk MCP tool catalog',
    dynamic: true,
    position: 40,
    get: async (
      runtime: IAgentRuntime,
      message: Memory,
    ): Promise<ProviderResult> => {
      if (
        !options.allowedRoles.has(roleOf(runtime)) ||
        !hasClerkMention(message)
      ) {
        return { text: '', data: { clerkToolkit: 'not_selected' } };
      }

      let mcpConfigured = false;
      try {
        const config = await resolveClerkMcpConfig({
          url: options.mcpUrl,
          token: options.token,
          tokenFile: options.tokenFile,
          allowInsecure: options.allowInsecure,
          env: options.env,
        });
        mcpConfigured = config.configured;
      } catch {
        mcpConfigured = false;
      }

      try {
        return await buildProviderText({
          message,
          maxChars: options.maxChars,
          skillsRoot: options.skillsRoot,
          mcpConfigured,
          extraTools: options.extraTools,
        });
      } catch (error) {
        return {
          text: `# Clerk toolkit\nThe bundled Clerk skills could not be loaded: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
          data: { clerkToolkit: 'error' },
        };
      }
    },
  };
}

async function respond(
  callback: HandlerCallback | undefined,
  text: string,
  success: boolean,
  error?: string,
  data?: RecordValue,
): Promise<ActionResult> {
  if (callback) {
    const content: Content = {
      text,
      source: 'clerk-toolkit',
    };
    await callback(content);
  }
  return {
    success,
    text,
    ...(error ? { error } : {}),
    ...(data ? { data } : {}),
  };
}

function optionsOf(
  message: Memory,
  handlerOptions?: RecordValue | null,
): RecordValue {
  const content = asRecord(message.content) ?? {};
  return { ...content, ...(handlerOptions ?? {}) };
}

function createSkillLookupAction(options: {
  allowedRoles: ReadonlySet<string>;
  skillsRoot?: string;
}): Action {
  return {
    name: CLERK_SKILL_LOOKUP_ACTION,
    similes: ['CLERK_SKILLS', 'READ_CLERK_SKILL', 'CLERK_DOCS'],
    description:
      'List, search or read one of the 20 bundled Clerk Agent Skills and its references. Read-only and local; no Clerk account is required. This action cannot change a Clerk application or any project file.',
    validate: async (runtime: IAgentRuntime, message: Memory) => {
      if (
        !options.allowedRoles.has(roleOf(runtime)) ||
        !hasClerkMention(message)
      ) {
        return false;
      }
      const text = messageText(message);
      return (
        /\bclerk\s+(?:skill|skills)\b/i.test(text) ||
        /\b(?:show|read|open|load|list)\b[\s\S]{0,80}\bclerk\b[\s\S]{0,80}\b(?:skill|skills|reference|docs?)\b/i.test(
          text,
        ) ||
        /\b(?:clerk\s+)?skills?\s+(?:list|catalog)\b/i.test(text)
      );
    },
    handler: async (runtime, message, _state, handlerOptions, callback) => {
      if (!options.allowedRoles.has(roleOf(runtime))) {
        return respond(
          callback,
          'The Clerk toolkit is not granted to this agent role.',
          false,
          'role_not_allowed',
          { canApprove: false, canDeploy: false },
        );
      }
      const input = optionsOf(message, asRecord(handlerOptions));
      const text = messageText(message);
      const catalog = await loadClerkCatalog({
        skillsRoot: options.skillsRoot,
      });

      if (
        !textValue(input.skill) &&
        /\b(?:list|catalog)\b/i.test(text) &&
        !/\bclerk\s+skills?\s+[a-z0-9-]+/i.test(text)
      ) {
        return respond(
          callback,
          `Bundled Clerk skills (${catalog.length}):\n${catalogLines(catalog)}`,
          true,
          undefined,
          { skills: catalog.map((skill) => skill.name), readOnly: true },
        );
      }

      const parsed = text.match(
        /\bclerk\s+skills?\s+([a-z0-9-]+)(?:\s+([a-z0-9._/-]+))?/i,
      );
      const backtick = text.match(/`(clerk(?:-[a-z0-9]+)*)`/i);
      const requested =
        textValue(input.skill) ||
        textValue(input.name) ||
        parsed?.[1] ||
        backtick?.[1] ||
        selectClerkSkills(text, catalog, 1)[0]?.name;
      const file =
        textValue(input.file) ||
        textValue(input.reference) ||
        parsed?.[2] ||
        'SKILL.md';

      if (!requested) {
        return respond(
          callback,
          'Name a Clerk skill to read, for example `clerk-nextjs-patterns`.',
          false,
          'clerk_skill_required',
          { canApprove: false, canDeploy: false },
        );
      }

      try {
        let skill = await readClerkSkill(requested, {
          file,
          skillsRoot: options.skillsRoot,
        });
        if (file === 'SKILL.md') {
          const reference = pickReference(skill, text);
          if (reference) {
            skill = await readClerkSkill(requested, {
              file: reference,
              skillsRoot: options.skillsRoot,
            });
          }
        }
        const header = `# Clerk skill: ${skill.skill}\nFile: ${skill.file}\nReferences: ${skill.references.length}\n\n`;
        return respond(
          callback,
          bound(`${header}${skill.content}`),
          true,
          undefined,
          {
            skill: skill.skill,
            file: skill.file,
            references: skill.references,
            chars: skill.content.length,
            readOnly: true,
            canApprove: false,
            canDeploy: false,
          },
        );
      } catch (error) {
        const code =
          error instanceof ClerkToolkitError
            ? error.code
            : 'clerk_skill_failed';
        return respond(
          callback,
          error instanceof Error
            ? error.message
            : 'The Clerk skill could not be read.',
          false,
          code,
          { canApprove: false, canDeploy: false },
        );
      }
    },
    examples: [
      [
        {
          name: 'User',
          content: { text: 'Read the Clerk Next.js middleware reference.' },
        },
        {
          name: 'Valkyrie',
          content: {
            text: 'I loaded clerk-nextjs-patterns and its middleware-strategies reference. I can use it to write a proposal, but I cannot apply or deploy the change.',
            actions: [CLERK_SKILL_LOOKUP_ACTION],
          },
        },
      ],
    ],
  };
}

function parseSnippetSlug(text: string): string {
  const lower = text.toLowerCase();
  const bundle = SNIPPET_BUNDLES.find((name) => lower.includes(name));
  if (bundle) return bundle;
  if (/\buse[- ]?user\b/i.test(text)) return 'use-user';
  if (/\buse[- ]?auth\b/i.test(text)) return 'use-auth';
  if (/\bsign[- ]?in\b/i.test(text) && /\bform|flow|ui\b/i.test(text)) {
    return 'custom-flows';
  }
  const explicit = text.match(
    /\b(?:snippet|bundle)\s+(?:for\s+|of\s+)?`?([a-z0-9][a-z0-9-]{2,40})`?/i,
  )?.[1];
  return explicit && !['list', 'all', 'the'].includes(explicit.toLowerCase())
    ? explicit.toLowerCase()
    : '';
}

async function localSnippetFallback(
  text: string,
  slug: string,
  skillsRoot: string | undefined,
  reason: string,
): Promise<{ text: string; skill: string; file: string }> {
  const catalog = await loadClerkCatalog({ skillsRoot });
  const selected =
    selectClerkSkills(`${slug} ${text}`, catalog, 1)[0] ??
    catalog.find((skill) => skill.name === 'clerk');
  if (!selected) {
    throw new ClerkToolkitError(
      'SKILLS_NOT_INSTALLED',
      'No bundled Clerk skill is available.',
    );
  }
  const skill = await readClerkSkill(selected.name, { skillsRoot });
  return {
    text: `Live Clerk MCP was unavailable (${reason}). I used the bundled Clerk skill instead.\n\n# ${skill.skill}\n\n${skill.content}`,
    skill: skill.skill,
    file: skill.file,
  };
}

function createSnippetAction(options: {
  allowedRoles: ReadonlySet<string>;
  skillsRoot?: string;
  mcpUrl?: string;
  token?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecure?: boolean;
  env?: Record<string, string | undefined>;
  extraTools: readonly string[];
}): Action {
  return {
    name: CLERK_SNIPPET_ACTION,
    similes: ['CLERK_SDK_SNIPPET', 'CLERK_CODE_SNIPPET', 'CLERK_CODE_EXAMPLE'],
    description:
      'List Clerk SDK snippets/bundles or fetch one by slug from the read-only Clerk MCP server. Falls back to the matching bundled Clerk skill when MCP is not configured, so coding can continue without an account.',
    validate: async (runtime: IAgentRuntime, message: Memory) => {
      if (
        !options.allowedRoles.has(roleOf(runtime)) ||
        !hasClerkMention(message)
      ) {
        return false;
      }
      return /\b(?:snippets?|code samples?|code examples?|sdk snippets?|bundles?)\b/i.test(
        messageText(message),
      );
    },
    handler: async (runtime, message, _state, handlerOptions, callback) => {
      if (!options.allowedRoles.has(roleOf(runtime))) {
        return respond(
          callback,
          'The Clerk toolkit is not granted to this agent role.',
          false,
          'role_not_allowed',
          { canApprove: false, canDeploy: false },
        );
      }
      const input = optionsOf(message, asRecord(handlerOptions));
      const text = messageText(message);
      const wantsList =
        input.list === true || /\bsnippets?\s+list\b/i.test(text);
      const slug =
        textValue(input.slug) ||
        textValue(input.bundle) ||
        parseSnippetSlug(text);
      const tag = textValue(input.tag);
      const reasonBase = 'no read-only Clerk MCP token is configured';

      let config;
      try {
        config = await resolveClerkMcpConfig({
          url: options.mcpUrl,
          token: options.token,
          tokenFile: options.tokenFile,
          allowInsecure: options.allowInsecure,
          env: options.env,
        });
      } catch (error) {
        const fallback = await localSnippetFallback(
          text,
          slug,
          options.skillsRoot,
          'invalid MCP configuration',
        );
        return respond(callback, bound(fallback.text), true, undefined, {
          source: 'local_skill',
          skill: fallback.skill,
          file: fallback.file,
          mcp: 'invalid_configuration',
          degraded: true,
          canApprove: false,
          canDeploy: false,
        });
      }

      if (!config.configured) {
        const fallback = await localSnippetFallback(
          text,
          slug,
          options.skillsRoot,
          reasonBase,
        );
        return respond(callback, bound(fallback.text), true, undefined, {
          source: 'local_skill',
          skill: fallback.skill,
          file: fallback.file,
          slug: slug || null,
          mcp: 'not_configured',
          degraded: true,
          canApprove: false,
          canDeploy: false,
        });
      }

      const client = new ClerkMcpClient({
        url: config.url,
        token: config.token,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        allowInsecure: config.allowInsecure,
        extraTools: [...options.extraTools],
      });

      try {
        const tool =
          wantsList || !slug ? 'list_clerk_sdk_snippets' : 'clerk_sdk_snippet';
        const args: RecordValue = {};
        if (tool === 'list_clerk_sdk_snippets') {
          if (tag) args.tag = tag;
        } else {
          args.slug = slug;
        }
        const result = await client.callTool(tool, args, {
          context:
            'ValhallaOS agent fetching a Clerk SDK snippet for a coding task',
        });
        if (!result.text) {
          throw new ClerkToolkitError(
            'MCP_EMPTY_RESPONSE',
            'The Clerk MCP server returned an empty snippet.',
          );
        }
        return respond(callback, bound(result.text), true, undefined, {
          source: 'clerk_mcp',
          tool,
          slug: slug || null,
          tag: tag || null,
          readOnly: true,
          degraded: false,
          canApprove: false,
          canDeploy: false,
        });
      } catch (error) {
        const code =
          error instanceof ClerkToolkitError || error instanceof Error
            ? (error as { code?: string }).code || 'clerk_snippet_failed'
            : 'clerk_snippet_failed';
        if (
          code === 'MCP_AUTH_REQUIRED' ||
          code === 'MCP_UNREACHABLE' ||
          code === 'MCP_TIMEOUT' ||
          code === 'MCP_HTTP_ERROR' ||
          code === 'MCP_EMPTY_RESPONSE' ||
          code === 'MCP_RPC_ERROR'
        ) {
          const fallback = await localSnippetFallback(
            text,
            slug,
            options.skillsRoot,
            `live Clerk MCP failed with ${code}`,
          );
          return respond(callback, bound(fallback.text), true, undefined, {
            source: 'local_skill',
            skill: fallback.skill,
            file: fallback.file,
            slug: slug || null,
            mcp: 'degraded',
            mcpError: code,
            degraded: true,
            canApprove: false,
            canDeploy: false,
          });
        }
        return respond(
          callback,
          error instanceof Error
            ? error.message
            : 'The Clerk snippet could not be fetched.',
          false,
          code,
          { canApprove: false, canDeploy: false },
        );
      }
    },
    examples: [
      [
        {
          name: 'User',
          content: { text: 'Show me the Clerk SDK snippet for organizations.' },
        },
        {
          name: 'Valkyrie',
          content: {
            text: 'I fetched the Clerk organizations snippet. I can use it in a patch proposal, but I cannot apply or deploy it.',
            actions: [CLERK_SNIPPET_ACTION],
          },
        },
      ],
    ],
  };
}

function parseMcpCommand(
  text: string,
  input: RecordValue,
): { tool: string; args: RecordValue; list: boolean } | null {
  const direct = textValue(input.tool) || textValue(input.mcpTool);
  if (direct) {
    const args = asRecord(input.arguments) ?? asRecord(input.args) ?? {};
    return { tool: direct, args, list: false };
  }
  if (/\bclerk\s+mcp\s+tools\b/i.test(text)) {
    return { tool: '', args: {}, list: true };
  }
  const match = text.match(
    /\bclerk\s+mcp\s+([a-z][a-z0-9_]{2,63})\b([\s\S]*)$/i,
  );
  if (!match) return null;
  const remainder = match[2].trim();
  let args: RecordValue = {};
  if (remainder) {
    const fenced = remainder.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = fenced || remainder;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as RecordValue;
      }
    } catch {
      // A missing argument object means "call with defaults".
    }
  }
  return { tool: match[1].toLowerCase(), args, list: false };
}

function createMcpReadAction(options: {
  allowedRoles: ReadonlySet<string>;
  mcpUrl?: string;
  token?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecure?: boolean;
  env?: Record<string, string | undefined>;
  extraTools: readonly string[];
}): Action {
  return {
    name: CLERK_MCP_READ_ACTION,
    similes: ['CLERK_MCP', 'CLERK_ACCOUNT_READ', 'CLERK_WHOAMI'],
    description:
      "Call one read-only tool on Clerk's remote MCP server (whoami, applications, instance config, users, domains, deployment OAuth providers, SDK snippets). Mutating Clerk tools are refused before any request. Requires CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
      if (
        !options.allowedRoles.has(roleOf(runtime)) ||
        !hasClerkMention(message)
      ) {
        return false;
      }
      const text = messageText(message);
      return (
        /\bclerk\b[\s\S]{0,80}\bmcp\b/i.test(text) ||
        /\bclerk\s+mcp\b/i.test(text) ||
        typeof asRecord(message.content)?.mcpTool === 'string'
      );
    },
    handler: async (runtime, message, _state, handlerOptions, callback) => {
      if (!options.allowedRoles.has(roleOf(runtime))) {
        return respond(
          callback,
          'The Clerk toolkit is not granted to this agent role.',
          false,
          'role_not_allowed',
          { canApprove: false, canDeploy: false },
        );
      }
      const input = optionsOf(message, asRecord(handlerOptions));
      const text = messageText(message);
      const command = parseMcpCommand(text, input);
      if (!command) {
        return respond(
          callback,
          'Use `clerk mcp tools`, `clerk mcp whoami`, or `clerk mcp <tool> {json}`.',
          false,
          'clerk_mcp_command_required',
          { canApprove: false, canDeploy: false },
        );
      }
      if (
        !command.list &&
        !isReadOnlyClerkTool(command.tool, [...options.extraTools])
      ) {
        return respond(
          callback,
          'That Clerk tool is not read-only. The Valkyries cannot change Clerk applications, users, domains, instance settings or production instances.',
          false,
          'clerk_tool_not_read_only',
          {
            readOnly: true,
            blockedTool: command.tool,
            canApprove: false,
            canDeploy: false,
          },
        );
      }

      let config;
      try {
        config = await resolveClerkMcpConfig({
          url: options.mcpUrl,
          token: options.token,
          tokenFile: options.tokenFile,
          allowInsecure: options.allowInsecure,
          env: options.env,
        });
      } catch (error) {
        return respond(
          callback,
          error instanceof Error
            ? error.message
            : 'The Clerk MCP configuration is invalid.',
          false,
          'clerk_mcp_config_invalid',
          { canApprove: false, canDeploy: false },
        );
      }
      if (!config.configured) {
        return respond(
          callback,
          'Clerk MCP is not configured. Set CLERK_MCP_TOKEN or CLERK_MCP_TOKEN_FILE. Local Clerk skills still work without it.',
          false,
          'clerk_mcp_not_configured',
          { canApprove: false, canDeploy: false },
        );
      }

      const client = new ClerkMcpClient({
        url: config.url,
        token: config.token,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        allowInsecure: config.allowInsecure,
        extraTools: [...options.extraTools],
      });

      try {
        if (command.list) {
          const initialized = await client.initialize();
          const tools = await client.listTools();
          const allowed = tools.filter((tool) => tool.readOnly);
          const blocked = tools.length - allowed.length;
          const lines = allowed.map(
            (tool) => `- \`${tool.name}\` — ${tool.description || 'read-only'}`,
          );
          return respond(
            callback,
            bound(
              `# Clerk MCP read-only tools\nServer: ${
                (initialized.serverInfo as { name?: string } | null)?.name ||
                'clerk'
              }\nProtocol: ${initialized.protocolVersion || 'unknown'}\n\n${lines.join(
                '\n',
              )}\n\n${blocked} mutating tool(s) blocked.`,
            ),
            true,
            undefined,
            {
              tools: allowed.map((tool) => tool.name),
              blockedCount: blocked,
              readOnly: true,
              canApprove: false,
              canDeploy: false,
            },
          );
        }

        const result = await client.callTool(command.tool, command.args, {
          context:
            'ValhallaOS agent reading Clerk account information for a coding task',
        });
        return respond(
          callback,
          bound(
            `# Clerk MCP: ${result.name}\n\n${
              result.text || JSON.stringify(result.structuredContent, null, 2)
            }`,
          ),
          true,
          undefined,
          {
            tool: result.name,
            readOnly: true,
            canApprove: false,
            canDeploy: false,
          },
        );
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || 'clerk_mcp_failed')
            : 'clerk_mcp_failed';
        return respond(
          callback,
          error instanceof Error
            ? error.message
            : 'The Clerk MCP request failed.',
          false,
          code,
          { readOnly: true, canApprove: false, canDeploy: false },
        );
      }
    },
    examples: [
      [
        {
          name: 'User',
          content: { text: 'clerk mcp whoami' },
        },
        {
          name: 'Valkyrie',
          content: {
            text: 'I checked the connected Clerk workspace with the read-only whoami tool.',
            actions: [CLERK_MCP_READ_ACTION],
          },
        },
      ],
    ],
  };
}

export function createClerkToolkitPlugin(
  options: ClerkToolkitPluginOptions = {},
): Plugin {
  const allowedRoles = normalizeRoles(
    options.allowedRoles ??
      options.env?.CLERK_ALLOWED_ROLES ??
      process.env.CLERK_ALLOWED_ROLES,
  );
  const maxChars = normalizeMaxChars(
    options.maxChars ??
      options.env?.CLERK_TOOLKIT_MAX_CHARS ??
      process.env.CLERK_TOOLKIT_MAX_CHARS,
  );
  const extraTools = normalizeExtraTools(options);

  return {
    name: CLERK_TOOLKIT_PLUGIN,
    description:
      'Clerk Agent Skills and a read-only Clerk MCP client for ValhallaOS. Provides official Clerk setup/framework/RBAC/billing/webhooks/testing knowledge and read-only account tools. It has no mutating Clerk tool and no approval, apply, commit, push or deploy action.',
    providers: [
      createClerkProvider({
        allowedRoles,
        maxChars,
        skillsRoot: options.skillsRoot,
        token: options.token,
        tokenFile: options.tokenFile,
        mcpUrl: options.mcpUrl,
        allowInsecure: options.allowInsecure,
        env: options.env,
        extraTools,
      }),
    ],
    actions: [
      createSkillLookupAction({
        allowedRoles,
        skillsRoot: options.skillsRoot,
      }),
      createSnippetAction({
        allowedRoles,
        skillsRoot: options.skillsRoot,
        mcpUrl: options.mcpUrl,
        token: options.token,
        tokenFile: options.tokenFile,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        allowInsecure: options.allowInsecure,
        env: options.env,
        extraTools,
      }),
      createMcpReadAction({
        allowedRoles,
        mcpUrl: options.mcpUrl,
        token: options.token,
        tokenFile: options.tokenFile,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        allowInsecure: options.allowInsecure,
        env: options.env,
        extraTools,
      }),
    ],
  };
}

export const clerkToolkitPlugin = createClerkToolkitPlugin();
