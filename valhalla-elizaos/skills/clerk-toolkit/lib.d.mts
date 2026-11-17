export type ClerkSkill = {
  name: string;
  description: string;
  license: string;
  path: string;
  files: string[];
  references: string[];
};

export type ClerkMcpConfig = {
  url: string;
  token: string;
  configured: boolean;
  tokenSource: string;
  allowInsecure: boolean;
};

export type ClerkMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  readOnly: boolean;
};

export type ClerkMcpToolResult = {
  name: string;
  text: string;
  structuredContent: unknown;
  readOnly: true;
};

export type ClerkSkillRead = {
  skill: string;
  description: string;
  file: string;
  content: string;
  references: string[];
};

export const CLERK_MCP_DEFAULT_URL: string;
export const CLERK_MCP_PROTOCOL_VERSION: string;
export const CLERK_TOOLKIT_VERSION: string;
export const CLERK_READ_ONLY_TOOLS: readonly string[];
export const CLERK_MUTATING_TOOLS: readonly string[];

export class ClerkToolkitError extends Error {
  constructor(code: string, message?: string);
  code: string;
}
export class ClerkMcpError extends Error {
  constructor(code: string, message?: string);
  code: string;
}

export function parseSkillFrontmatter(markdown: string): Record<string, string>;
export function resolveClerkSkillsRoot(explicitRoot?: string): string;
export function loadClerkCatalog(options?: { skillsRoot?: string }): Promise<ClerkSkill[]>;
export function clearClerkCatalogCache(): void;
export function selectClerkSkills(
  request: string,
  catalog: ClerkSkill[],
  limit?: number,
): ClerkSkill[];
export function searchClerkSkills(query: string, catalog: ClerkSkill[]): ClerkSkill[];
export function readClerkSkill(
  skillName: string,
  options?: { file?: string; skillsRoot?: string },
): Promise<ClerkSkillRead>;

export function normalizeMcpUrl(rawUrl?: string, options?: { allowInsecure?: boolean }): string;
export function resolveClerkMcpConfig(options?: {
  env?: Record<string, string | undefined>;
  url?: string;
  token?: string;
  tokenFile?: string;
  allowInsecure?: boolean;
}): Promise<ClerkMcpConfig>;
export function isReadOnlyClerkTool(name: string, extraTools?: string[]): boolean;
export function describeClerkMcpTools(extraTools?: string[]): string[];

export class ClerkMcpClient {
  constructor(options?: {
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    allowInsecure?: boolean;
    extraTools?: string[];
  });
  readonly url: string;
  sessionId: string | null;
  serverInfo: unknown;
  initialize(): Promise<{ protocolVersion?: string; serverInfo?: unknown }>;
  listTools(): Promise<ClerkMcpTool[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: { context?: string },
  ): Promise<ClerkMcpToolResult>;
}

export function createClerkMcpClient(options?: {
  env?: Record<string, string | undefined>;
  url?: string;
  token?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecure?: boolean;
}): Promise<{ config: ClerkMcpConfig; client: ClerkMcpClient }>;

export function clerkToolkitDoctor(options?: {
  env?: Record<string, string | undefined>;
  url?: string;
  token?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecure?: boolean;
  skillsRoot?: string;
}): Promise<Record<string, unknown>>;
