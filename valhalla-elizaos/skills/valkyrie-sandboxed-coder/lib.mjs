// Sandboxed coding proposals for ValhallaOS.
//
// The skill never edits the real working tree while proposing. It copies the
// project into a temporary directory, applies the patch there, runs syntax
// checks and node --test under the Node permission model, and stores a
// hash-locked proposal. A separate explicit approval command is the only path
// that applies the same patch to the real working tree. There is no commit,
// push, deploy or credential path in this module.

import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_PATCH_BYTES = 512 * 1024;
export const MAX_FILES = 50;
export const MAX_TEST_FILES = 20;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;
export const PROPOSAL_DIR = '.coding-skill/proposals';

const PROPOSAL_ID = /^[a-f0-9]{8,32}$/;
const TEST_FILE = /\.test\.(?:mjs|cjs|js)$/;
const OUTPUT_LIMIT = 32 * 1024;
const FORBIDDEN_SEGMENTS = new Set([
  '.git', '.coding-skill', 'node_modules', 'site-build', 'dist', 'build',
  'coverage', 'secrets', 'private-export', '__pycache__', '.ssh', '.next', '.cache',
  '.github', '.vercel', '.netlify', '.terraform', '.aws', '.kube'
]);
const FORBIDDEN_BASENAMES = new Set([
  '.env', 'id_rsa', 'id_ed25519', '.npmrc', '.yarnrc', '.pypirc', '.netrc',
  '.git-credentials', '.gitconfig', 'credentials', 'auth.json'
]);
const FORBIDDEN_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.crt', '.tfstate'];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:SUPABASE_SERVICE_ROLE_KEY|PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE)\s*=\s*[^\s'"`]{10,}/i
];

export class SkillError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SkillError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillError(code, message);
}

function digest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function bound(text) {
  const value = String(text || '');
  return value.length > OUTPUT_LIMIT ? value.slice(0, OUTPUT_LIMIT) + '\n[output truncated]' : value;
}

function forbiddenBasename(name) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_BASENAMES.has(lower)) return true;
  if (lower.startsWith('.env.')) return true;
  return FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function validateRelativePath(value, label) {
  if (typeof value !== 'string' || !value) fail('INVALID_PATH', (label || 'Path') + ' is required.');
  if (value.includes('\0') || value.includes('\n') || value.includes('\r') || value.includes('\t')) {
    fail('INVALID_PATH', (label || 'Path') + ' contains control characters.');
  }
  if (value.includes('\\')) fail('INVALID_PATH', (label || 'Path') + ' must use forward slashes.');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail('ABSOLUTE_PATH', (label || 'Path') + ' must stay inside the project.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('PATH_ESCAPE', (label || 'Path') + ' contains an empty, current or parent segment.');
  }
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) {
    fail('FORBIDDEN_PATH', (label || 'Path') + ' targets a protected directory.');
  }
  if (forbiddenBasename(parts[parts.length - 1])) {
    fail('FORBIDDEN_PATH', (label || 'Path') + ' targets a secret or generated file.');
  }
  if (value.length > 240) fail('INVALID_PATH', (label || 'Path') + ' is too long.');
  return parts.join('/');
}

function addPatchPath(files, raw, label) {
  let value = String(raw || '').trim();
  if (!value) fail('INVALID_PATCH', 'A patch path is empty.');
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
  if (value === '/dev/null') return;
  files.add(validateRelativePath(value, label));
}

export function validatePatch(patch) {
  const text = String(patch == null ? '' : patch).replace(/\r\n/g, '\n');
  if (!text.trim()) fail('INVALID_PATCH', 'A unified diff is required.');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_PATCH_BYTES) fail('PATCH_TOO_LARGE', 'Patch exceeds the 512 KiB limit.');
  if (/^GIT binary patch$/m.test(text) || /^Binary files /m.test(text) || /^Submodule /m.test(text)) {
    fail('BINARY_OR_SUBMODULE', 'Binary patches and submodule changes are not allowed.');
  }

  const files = new Set();
  for (const line of text.split('\n')) {
    if (/^(?:new|old) (?:file )?mode 120000$/.test(line) || /^new mode 120000$/.test(line)) {
      fail('SYMLINK_PATCH', 'Symlink changes are not allowed.');
    }
    const diff = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diff) {
      if (diff[1].includes('"') || diff[2].includes('"')) fail('QUOTED_PATH', 'Quoted patch paths are not allowed.');
      addPatchPath(files, diff[1], 'Patch path');
      addPatchPath(files, diff[2], 'Patch path');
      continue;
    }
    if (line.startsWith('--- ')) {
      addPatchPath(files, line.slice(4).split('\t')[0].trim(), 'Patch path');
      continue;
    }
    if (line.startsWith('+++ ')) {
      addPatchPath(files, line.slice(4).split('\t')[0].trim(), 'Patch path');
      continue;
    }
    const renameFrom = line.match(/^rename from (.+)$/);
    if (renameFrom) addPatchPath(files, renameFrom[1], 'Patch path');
    const renameTo = line.match(/^rename to (.+)$/);
    if (renameTo) addPatchPath(files, renameTo[1], 'Patch path');
  }

  if (!files.size) fail('EMPTY_PATCH', 'The patch does not touch a file.');
  if (files.size > MAX_FILES) fail('TOO_MANY_FILES', 'Patch touches more than 50 files.');

  const added = text.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(added))) {
    fail('SECRET_IN_PATCH', 'The patch appears to add a private key, token or secret. Remove it and use an environment variable.');
  }

  return { patch: text, files: Array.from(files).sort(), bytes };
}

export function validateTestFiles(testFiles) {
  if (!Array.isArray(testFiles) || !testFiles.length) {
    fail('TEST_REQUIRED', 'At least one relative *.test.mjs/cjs/js file is required.');
  }
  const unique = [];
  for (const value of testFiles) {
    const file = validateRelativePath(value, 'Test file');
    if (!TEST_FILE.test(file)) fail('INVALID_TEST_FILE', 'Only *.test.mjs, *.test.cjs or *.test.js files are allowed.');
    if (file.startsWith('-')) fail('INVALID_TEST_FILE', 'Test paths cannot start with a dash.');
    if (!unique.includes(file)) unique.push(file);
  }
  if (unique.length > MAX_TEST_FILES) fail('TOO_MANY_TESTS', 'At most 20 test files are allowed.');
  return unique;
}

export function validateTimeout(value) {
  const timeout = value == null ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) {
    fail('INVALID_TIMEOUT', 'Timeout must be an integer between 1000 and 300000 milliseconds.');
  }
  return timeout;
}

export function validateId(value) {
  const id = String(value || '');
  if (!PROPOSAL_ID.test(id)) fail('INVALID_PROPOSAL_ID', 'Proposal id must be 8-32 lowercase hex characters.');
  return id;
}

async function normalizeRoot(root) {
  const resolved = path.resolve(String(root || process.cwd()));
  const info = await lstat(resolved).catch(() => null);
  if (!info || !info.isDirectory()) fail('ROOT_NOT_FOUND', 'Project root does not exist or is not a directory.');
  return resolved;
}

function copyFilter(root, source) {
  const relative = path.relative(root, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) return false;
  return !forbiddenBasename(parts[parts.length - 1]);
}

async function makeSandbox(root) {
  const dir = await mkdtemp(path.join(tmpdir(), 'valkyrie-sandbox-'));
  const repo = path.join(dir, 'repo');
  try {
    await cp(root, repo, {
      recursive: true,
      force: true,
      filter: (source) => copyFilter(root, source)
    });
    const scratch = path.join(repo, '.sandbox-tmp');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    return { dir, repo, scratch };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function safeEnv(repo) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NODE_ENV: 'test',
    NO_COLOR: '1',
    HOME: repo,
    TMPDIR: path.join(repo, '.sandbox-tmp')
  };
}

function runProcess(command, args, options) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd;
  const env = options.env;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal: signal || null, timedOut, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child) child.kill('SIGKILL');
              }, timeoutMs);
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      stderr = bound(error && error.message || 'process failed to start');
      finish(127, null);
      return;
    }
    child.stdout.on('data', (chunk) => { stdout = bound(stdout + String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = bound(stderr + String(chunk)); });
    child.on('error', (error) => {
      stderr = bound(stderr + '\n' + String(error && error.message || error));
      finish(127, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function runGitApply(root, patch) {
  const patchDir = await mkdtemp(path.join(tmpdir(), 'valkyrie-patch-'));
  const patchFile = path.join(patchDir, 'change.patch');
  await writeFile(patchFile, patch, { mode: 0o600 });
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  };
  try {
    const check = await runProcess('git', ['apply', '--check', '--whitespace=nowarn', patchFile], {
      cwd: root,
      env,
      timeoutMs: 30_000
    });
    if (check.code !== 0) {
      fail('PATCH_REJECTED', check.stderr || check.stdout || 'The patch does not apply cleanly.');
    }
    const applied = await runProcess('git', ['apply', '--whitespace=nowarn', patchFile], {
      cwd: root,
      env,
      timeoutMs: 30_000
    });
    if (applied.code !== 0) {
      fail('PATCH_FAILED', applied.stderr || applied.stdout || 'The patch could not be applied.');
    }
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }
}

async function syntaxCheck(root, files) {
  const codeFiles = files.filter((file) => /\.(?:mjs|cjs|js)$/.test(file)).slice(0, MAX_FILES);
  const results = [];
  for (const file of codeFiles) {
    const result = await runProcess(process.execPath, ['--check', file], {
      cwd: root,
      env: safeEnv(root),
      timeoutMs: 15_000
    });
    results.push({
      file,
      ok: result.code === 0 && !result.timedOut,
      code: result.code,
      stderr: bound(result.stderr)
    });
  }
  return results;
}

async function sandboxTests(root, testFiles, timeoutMs) {
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) {
    fail('SANDBOX_UNSUPPORTED', 'This Node runtime does not support the permission model required by the sandbox.');
  }
  if (!process.allowedNodeEnvironmentFlags.has('--test-isolation')) {
    fail('SANDBOX_UNSUPPORTED', 'This Node runtime does not support --test-isolation=none.');
  }
  const args = [
    '--permission',
    '--allow-fs-read=' + root,
    '--allow-fs-write=' + root,
    '--test-isolation=none',
    '--test',
    ...testFiles
  ];
  const result = await runProcess(process.execPath, args, {
    cwd: root,
    env: safeEnv(root),
    timeoutMs
  });
  return {
    command: 'node ' + args.join(' '),
    ok: result.code === 0 && !result.timedOut,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: bound(result.stdout),
    stderr: bound(result.stderr)
  };
}

async function snapshotFiles(root, files) {
  const snapshot = {};
  for (const file of files) {
    const target = path.join(root, file);
    const info = await lstat(target).catch(() => null);
    if (!info) {
      snapshot[file] = null;
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('UNSAFE_TARGET', 'Target is not a regular file: ' + file);
    }
    snapshot[file] = digest(await readFile(target));
  }
  return snapshot;
}

function sameSnapshot(expected, actual) {
  for (const file of Object.keys(expected)) {
    if (expected[file] !== actual[file]) return false;
  }
  return true;
}

function proposalPath(root, id) {
  return path.join(root, PROPOSAL_DIR, id + '.json');
}

async function saveProposal(root, proposal) {
  const dir = path.join(root, PROPOSAL_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(proposalPath(root, proposal.id), JSON.stringify(proposal, null, 2) + '\n', { mode: 0o600 });
}

export async function readProposal(root, id) {
  const cleanId = validateId(id);
  const projectRoot = await normalizeRoot(root);
  let raw;
  try {
    raw = await readFile(proposalPath(projectRoot, cleanId), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('PROPOSAL_NOT_FOUND', 'No proposal with that id exists in this project.');
    throw error;
  }
  let proposal;
  try {
    proposal = JSON.parse(raw);
  } catch (error) {
    fail('PROPOSAL_INVALID', 'The stored proposal is not valid JSON.');
  }
  if (!proposal || proposal.id !== cleanId) fail('PROPOSAL_INVALID', 'The stored proposal id does not match.');
  return proposal;
}

export async function propose(options) {
  const root = await normalizeRoot(options && options.root);
  const normalized = validatePatch(options && options.patch);
  const testFiles = validateTestFiles(options && options.testFiles);
  const timeoutMs = validateTimeout(options && options.timeoutMs);
  const id = options && options.id ? validateId(options.id) : randomBytes(8).toString('hex');
  const now = options && options.now ? Number(options.now) : Date.now();
  const before = await snapshotFiles(root, normalized.files);
  const sandbox = await makeSandbox(root);
  try {
    await runGitApply(sandbox.repo, normalized.patch);
    for (const file of testFiles) {
      const target = path.join(sandbox.repo, file);
      const info = await lstat(target).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) {
        fail('TEST_NOT_FOUND', 'Test file is missing after applying the patch: ' + file);
      }
    }
    const syntax = await syntaxCheck(sandbox.repo, normalized.files);
    const tests = await sandboxTests(sandbox.repo, testFiles, timeoutMs);
    const status = syntax.every((row) => row.ok) && tests.ok ? 'pending_approval' : 'tests_failed';
    const proposal = {
      version: 1,
      id,
      createdAt: new Date(now).toISOString(),
      root,
      status,
      files: normalized.files,
      patch: normalized.patch,
      patchSha256: digest(normalized.patch),
      testFiles,
      timeoutMs,
      before,
      syntax,
      tests,
      sandbox: { isolatedCopy: true, nodePermissionModel: true, testIsolation: 'none' },
      mode: 'working-tree-only'
    };
    await saveProposal(root, proposal);
    return proposal;
  } finally {
    await rm(sandbox.dir, { recursive: true, force: true });
  }
}

export async function approve(options) {
  const projectRoot = await normalizeRoot(options && options.root);
  if (!options || options.confirm !== 'APPLY') {
    fail('APPROVAL_CONFIRMATION_REQUIRED', 'Approval requires exactly --confirm APPLY.');
  }
  const proposal = await readProposal(projectRoot, options.id);
  if (proposal.status !== 'pending_approval') {
    fail('PROPOSAL_NOT_APPROVABLE', 'Proposal is ' + proposal.status + '; only pending_approval proposals can be applied.');
  }
  if (proposal.root !== projectRoot) {
    fail('ROOT_MISMATCH', 'This proposal belongs to a different project root.');
  }
  if (digest(proposal.patch) !== proposal.patchSha256) {
    fail('PATCH_HASH_MISMATCH', 'The stored patch changed after review; refusing to apply it.');
  }
  const current = await snapshotFiles(projectRoot, proposal.files);
  if (!sameSnapshot(proposal.before, current)) {
    fail('STALE_TREE', 'The target files changed after this proposal was tested; re-run the proposal.');
  }
  await runGitApply(projectRoot, proposal.patch);
  proposal.status = 'applied';
  proposal.appliedAt = new Date().toISOString();
  await saveProposal(projectRoot, proposal);
  return proposal;
}

export async function reject(options) {
  const projectRoot = await normalizeRoot(options && options.root);
  const proposal = await readProposal(projectRoot, options.id);
  if (proposal.status === 'applied') fail('PROPOSAL_ALREADY_APPLIED', 'Applied proposals cannot be rejected.');
  proposal.status = 'rejected';
  proposal.rejectedAt = new Date().toISOString();
  await saveProposal(projectRoot, proposal);
  return proposal;
}

export async function listProposals(options) {
  const projectRoot = await normalizeRoot(options && options.root);
  const dir = path.join(projectRoot, PROPOSAL_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const proposal = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8'));
      rows.push({
        id: proposal.id,
        status: proposal.status,
        createdAt: proposal.createdAt,
        files: proposal.files,
        testFiles: proposal.testFiles
      });
    } catch (error) {
      rows.push({ id: entry.name.replace(/\.json$/, ''), status: 'invalid', files: [] });
    }
  }
  return rows.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

export const internals = {
  copyFilter,
  digest,
  snapshotFiles,
  sameSnapshot
};
