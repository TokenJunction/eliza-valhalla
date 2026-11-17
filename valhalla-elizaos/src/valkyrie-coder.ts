import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
} from '@elizaos/core';
import {
  VALHALLA_ROLE_IDS,
  type ValhallaRoleId,
} from './character.ts';

export const VALKYRIE_CODER_PLUGIN = 'valhalla-valkyrie-coder';
export const VALKYRIE_PROPOSE_ACTION = 'VALKYRIE_PROPOSE_PATCH';
export const DEFAULT_ALLOWED_CODING_ROLES: readonly ValhallaRoleId[] = [
  'zeus',
  'odin',
  'wren',
  'valkyrie',
  'forge',
  'hermod',
];

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_TEST_FILES = 20;
const OUTPUT_LIMIT = 64 * 1024;
const SKILL_DIRECTORY = 'skills/valkyrie-sandboxed-coder';

type RecordValue = Record<string, unknown>;

export type ValkyrieCoderPluginOptions = {
  /** Absolute path to the checkout the agents may inspect. Never accept this from chat input. */
  root?: string;
  /** Override the skill directory in tests or a packaged deployment. */
  skillDir?: string;
  /** Node executable used for the propose-only runner. */
  nodeBin?: string;
  allowedRoles?: readonly string[];
  timeoutMs?: number | string;
};

type ProposalRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
  return [content.text, content.patch, content.diff]
    .map(textValue)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function roleOf(runtime: IAgentRuntime | undefined): string {
  const settings = asRecord(runtime?.character?.settings);
  return textValue(settings?.valhallaRole).toLowerCase();
}

function bound(text: string): string {
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[output truncated]`
    : text;
}

function resolveProjectRoot(explicit?: string): string | null {
  const raw =
    explicit !== undefined
      ? explicit
      : process.env.VALKYRIE_PROJECT_ROOT;
  const value = textValue(raw);
  return value ? path.resolve(value) : null;
}

function resolveSkillDir(explicit?: string): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.VALKYRIE_SKILL_DIR,
    path.resolve(process.cwd(), SKILL_DIRECTORY),
    path.resolve(moduleDir, '..', SKILL_DIRECTORY),
    path.resolve(moduleDir, '..', '..', SKILL_DIRECTORY),
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate));

  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, 'agent-propose.mjs')),
    ) ?? null
  );
}

function normalizeRoles(value: readonly string[] | string | undefined): Set<string> {
  const source =
    value === undefined || value === ''
      ? DEFAULT_ALLOWED_CODING_ROLES
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

function normalizeTimeout(value: number | string | undefined): number {
  const parsed = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1_000), MAX_TIMEOUT_MS);
}

function wantsProposal(message: Memory | undefined): boolean {
  const content = asRecord(message?.content) ?? {};
  if (textValue(content.patch) || textValue(content.diff)) return true;
  return /\b(propose|proposal|patch|diff|sandbox|test.*(patch|change)|review.*patch|fix.*safely)\b/i.test(
    messageText(message),
  );
}

function extractPatch(message: Memory | undefined, options: RecordValue | null): string {
  const content = asRecord(message?.content) ?? {};
  const direct =
    textValue(options?.patch) ||
    textValue(options?.diff) ||
    textValue(content.patch) ||
    textValue(content.diff);
  if (direct) return direct;

  const fenced = messageText(message).match(
    /```(?:diff|patch)?[ \t]*\n([\s\S]*?)```/i,
  );
  return fenced?.[1]?.trim() ?? '';
}

function splitTests(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function extractTestFiles(
  message: Memory | undefined,
  options: RecordValue | null,
): string[] {
  const content = asRecord(message?.content) ?? {};
  const listed = [
    ...splitTests(options?.testFiles),
    ...splitTests(options?.tests),
    ...splitTests(content.testFiles),
    ...splitTests(content.tests),
  ];
  if (listed.length) {
    return Array.from(new Set(listed))
      .filter((file) => /\.(?:mjs|cjs|js)$/.test(file))
      .slice(0, MAX_TEST_FILES);
  }
  const mentioned = textValue(content.text).match(
    /\b[\w./-]+\.test\.(?:mjs|cjs|js)\b/g,
  ) ?? [];
  return Array.from(new Set(mentioned))
    .filter(
      (file) =>
        /\.(?:mjs|cjs|js)$/.test(file) &&
        !file.startsWith('a/') &&
        !file.startsWith('b/'),
    )
    .slice(0, MAX_TEST_FILES);
}

function parseProposal(stdout: string): RecordValue | null {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as RecordValue;
      }
    } catch {
      // Ignore non-JSON log lines from a future runner.
    }
  }
  return null;
}

function runProposal(options: {
  nodeBin: string;
  skillDir: string;
  root: string;
  patch: string;
  testFiles: string[];
  timeoutMs: number;
}): Promise<ProposalRun> {
  return new Promise((resolve) => {
    const args = [
      path.join(options.skillDir, 'agent-propose.mjs'),
      'propose',
      '--root',
      options.root,
      '--patch',
      '-',
      ...options.testFiles.flatMap((test) => ['--test', test]),
      '--timeout',
      String(options.timeoutMs),
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: tmpdir(),
      NODE_ENV: 'production',
      GIT_TERMINAL_PROMPT: '0',
    };
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: bound(stdout),
        stderr: bound(stderr),
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGKILL');
    }, options.timeoutMs + 20_000);

    try {
      child = spawn(options.nodeBin, args, {
        cwd: options.root,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = bound(
        error instanceof Error ? error.message : 'proposal process failed',
      );
      finish(127);
      return;
    }

    child.on('error', (error) => {
      stderr = bound(`${stderr}\n${error.message}`);
      finish(127);
    });
    child.stdout?.on('data', (chunk) => {
      stdout = bound(stdout + String(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr = bound(stderr + String(chunk));
    });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {
      // The child can exit before consuming a large diff; close is handled above.
    });
    child.stdin?.end(options.patch);
  });
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
      actions: [VALKYRIE_PROPOSE_ACTION],
      source: 'valkyrie-coder',
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

function createProposeAction(options: {
  root: string | null;
  skillDir: string | null;
  nodeBin: string;
  allowedRoles: ReadonlySet<string>;
  timeoutMs: number;
}): Action {
  return {
    name: VALKYRIE_PROPOSE_ACTION,
    similes: [
      'PROPOSE_PATCH',
      'SANDBOX_PATCH',
      'TEST_PATCH',
      'PROPOSE_CODE_CHANGE',
      'VALKYRIE_CODER',
    ],
    description:
      'Test a unified diff in an isolated copy with the Valkyrie sandboxed coder and return a hash-locked proposal for human review. This action never changes source files in the real working tree; it writes only a proposal record. It cannot approve, apply, commit, push or deploy a change.',
    validate: async (runtime: IAgentRuntime, message: Memory) => {
      const role = roleOf(runtime);
      return options.allowedRoles.has(role) && wantsProposal(message);
    },
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state,
      handlerOptions,
      callback,
    ) => {
      const role = roleOf(runtime);
      if (!options.allowedRoles.has(role)) {
        return respond(
          callback,
          'The Valkyrie coder is not granted to this agent role.',
          false,
          'role_not_allowed',
          { canApprove: false, canDeploy: false },
        );
      }
      if (!options.root) {
        return respond(
          callback,
          'The Valkyrie coder has no configured project root, so it cannot create a proposal.',
          false,
          'coder_not_configured',
          { canApprove: false, canDeploy: false },
        );
      }
      if (!options.skillDir) {
        return respond(
          callback,
          'The Valkyrie coder skill is not installed in this runtime.',
          false,
          'coder_not_configured',
          { canApprove: false, canDeploy: false },
        );
      }

      const patch = extractPatch(message, asRecord(handlerOptions));
      if (!patch) {
        return respond(
          callback,
          'Provide a unified diff (or a fenced diff block) to propose. I can test it in the sandbox, but I cannot apply it.',
          false,
          'patch_required',
          { canApprove: false, canDeploy: false },
        );
      }
      if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
        return respond(
          callback,
          'The diff is larger than the 512 KiB proposal limit.',
          false,
          'patch_too_large',
          { canApprove: false, canDeploy: false },
        );
      }

      const testFiles = extractTestFiles(message, asRecord(handlerOptions));
      if (!testFiles.length) {
        return respond(
          callback,
          'Name at least one relative *.test.mjs, *.test.cjs or *.test.js file so the patch can be tested in the sandbox.',
          false,
          'tests_required',
          { canApprove: false, canDeploy: false },
        );
      }

      const rootInfo = await lstat(options.root).catch(() => null);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || options.root === path.parse(options.root).root) {
        return respond(
          callback,
          'The configured Valkyrie project root is unavailable or unsafe to copy.',
          false,
          'coder_root_unavailable',
          { canApprove: false, canDeploy: false },
        );
      }

      const run = await runProposal({
        nodeBin: options.nodeBin,
        skillDir: options.skillDir,
        root: options.root,
        patch,
        testFiles,
        timeoutMs: options.timeoutMs,
      });
      if (run.timedOut) {
        return respond(
          callback,
          'The sandbox proposal timed out. No change was made to the working tree.',
          false,
          'proposal_timeout',
          { canApprove: false, canDeploy: false },
        );
      }

      const proposal = parseProposal(run.stdout) ?? parseProposal(run.stderr);
      if (run.code !== 0 || !proposal || proposal.ok !== true) {
        const error = asRecord(proposal?.error);
        return respond(
          callback,
          'The sandbox could not create a valid proposal. No change was made to the working tree.',
          false,
          textValue(error?.code) || 'proposal_failed',
          { canApprove: false, canDeploy: false },
        );
      }

      const status = textValue(proposal.status) || 'unknown';
      const tests = asRecord(proposal.tests);
      const testsOk = tests?.ok === true;
      const proposalId = textValue(proposal.id);
      const files = Array.isArray(proposal.files)
        ? proposal.files.filter((file): file is string => typeof file === 'string')
        : [];
      const syntax = Array.isArray(proposal.syntax)
        ? proposal.syntax
            .map(asRecord)
            .filter((row): row is RecordValue => Boolean(row))
            .map((row) => ({ file: textValue(row.file), ok: row.ok === true }))
        : [];
      const text =
        status === 'pending_approval'
          ? `Sandbox proposal ${proposalId} is pending human approval. Tests passed and no source file was changed; the proposal record is in .coding-skill/proposals. I cannot approve, apply, commit, push or deploy it; a human must review it in a terminal.`
          : `Sandbox proposal ${proposalId} was created with status ${status}. No source file was changed; the proposal record is in .coding-skill/proposals. I cannot approve, apply, commit, push or deploy it.`;

      return respond(callback, text, true, undefined, {
        proposalId,
        status,
        files,
        patchSha256: textValue(proposal.patchSha256),
        syntax,
        tests: {
          ok: testsOk,
          timedOut: tests?.timedOut === true,
        },
        canApprove: false,
        canDeploy: false,
        approval: 'human_cli_only',
      });
    },
    examples: [
      [
        {
          name: 'User',
          content: {
            text: 'Propose this unified diff and run test/math.test.mjs in the sandbox.',
          },
        },
        {
          name: 'Valkyrie',
          content: {
            text: 'I created the proposal and ran the tests in an isolated copy. It is pending human approval; I cannot approve or deploy it.',
            actions: [VALKYRIE_PROPOSE_ACTION],
          },
        },
      ],
    ],
  };
}

export function createValkyrieCoderPlugin(
  options: ValkyrieCoderPluginOptions = {},
): Plugin {
  const root = resolveProjectRoot(options.root);
  const skillDir = resolveSkillDir(options.skillDir);
  const allowedRoles = normalizeRoles(
    options.allowedRoles ?? process.env.VALKYRIE_ALLOWED_ROLES,
  );
  const nodeBin = options.nodeBin || process.env.VALKYRIE_NODE_BIN || 'node';
  const timeoutMs = normalizeTimeout(
    options.timeoutMs ?? process.env.VALKYRIE_PROPOSE_TIMEOUT_MS,
  );

  return {
    name: VALKYRIE_CODER_PLUGIN,
    description:
      'Proposal-only sandboxed coding for ValhallaOS agents. Creates tested, hash-locked proposals for human approval. It has no approval, apply, commit, push or deploy action.',
    actions: [
      createProposeAction({
        root,
        skillDir,
        nodeBin,
        allowedRoles,
        timeoutMs,
      }),
    ],
  };
}

export const valkyrieCoderPlugin = createValkyrieCoderPlugin();
