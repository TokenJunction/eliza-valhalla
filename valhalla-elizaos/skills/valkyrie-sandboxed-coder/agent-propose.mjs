#!/usr/bin/env node
// Agent-facing entrypoint for the sandboxed coder.
//
// This process can only create a proposal. It deliberately does not import the
// approval or rejection functions, and it has no commit, push or deploy path.
// The human approval CLI is a separate, interactive program.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { propose, validatePatch, SkillError } from './lib.mjs';

const MAX_PATCH_BYTES = 512 * 1024;
const FORBIDDEN_PREFIXES = ['valhalla-elizaos/', 'skills/'];

const USAGE = `valkyrie-sandboxed-coder agent runner

Usage:
  node agent-propose.mjs propose --root <dir> --patch <file|-> --test <relative-test> [--test ...] [--timeout <ms>]

This runner can only create a proposal. It cannot approve, apply, commit, push
or deploy. Human review uses the separate cli.mjs program.
`;

function fail(code, message) {
  throw new SkillError(code, message);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) {
    fail('MISSING_VALUE', flag + ' needs a value.');
  }
  return value;
}

function parse(argv) {
  const command = argv[0];
  const options = {
    root: undefined,
    patchPath: undefined,
    testFiles: [],
    timeoutMs: undefined,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = requireValue(argv, index, '--root');
      index += 1;
    } else if (arg === '--patch') {
      options.patchPath = requireValue(argv, index, '--patch');
      index += 1;
    } else if (arg === '--test') {
      options.testFiles.push(requireValue(argv, index, '--test'));
      index += 1;
    } else if (arg === '--timeout') {
      options.timeoutMs = requireValue(argv, index, '--timeout');
      index += 1;
    } else {
      fail('UNKNOWN_OPTION', 'Unknown option: ' + arg);
    }
  }
  return { command, options };
}

async function readPatch(file) {
  if (file !== '-') return readFile(path.resolve(file), 'utf8');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PATCH_BYTES) {
      fail('PATCH_TOO_LARGE', 'Patch exceeds the 512 KiB limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function rejectAgentOwnedPaths(files) {
  for (const file of files) {
    if (
      FORBIDDEN_PREFIXES.some(
        (prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix),
      )
    ) {
      fail(
        'AGENT_PATCH_FORBIDDEN',
        'Agent proposals cannot modify the ElizaOS runtime or the proposal skill.',
      );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command !== 'propose') {
    fail('UNSUPPORTED_COMMAND', 'This runner only supports propose.');
  }

  const { options } = parse(argv);
  if (!options.root) fail('ROOT_REQUIRED', '--root is required.');
  if (!path.isAbsolute(options.root)) {
    fail('ROOT_MUST_BE_ABSOLUTE', '--root must be an absolute path.');
  }
  if (!options.patchPath) fail('PATCH_REQUIRED', '--patch is required.');
  if (!options.testFiles.length) {
    fail('TEST_REQUIRED', 'At least one --test is required.');
  }

  const patch = await readPatch(options.patchPath);
  const validated = validatePatch(patch);
  rejectAgentOwnedPaths(validated.files);

  const proposal = await propose({
    root: options.root,
    patch,
    testFiles: options.testFiles,
    timeoutMs: options.timeoutMs,
  });

  console.log(
    JSON.stringify({
      ok: true,
      id: proposal.id,
      status: proposal.status,
      createdAt: proposal.createdAt,
      files: proposal.files,
      patchSha256: proposal.patchSha256,
      syntax: proposal.syntax.map(({ file, ok }) => ({ file, ok })),
      tests: {
        ok: proposal.tests.ok,
        command: proposal.tests.command,
        timedOut: proposal.tests.timedOut,
        stdout: proposal.tests.stdout,
        stderr: proposal.tests.stderr,
      },
      canApprove: false,
      canDeploy: false,
      approval: 'human_cli_only',
    }),
  );
}

try {
  await main();
} catch (error) {
  const code = error instanceof SkillError ? error.code : 'UNEXPECTED';
  const message =
    error instanceof SkillError ? error.message : 'The proposal could not be created.';
  console.error(JSON.stringify({ ok: false, error: { code, message } }));
  process.exitCode = 1;
}
