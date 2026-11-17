#!/usr/bin/env node
// Human-facing CLI for the sandboxed coding skill.
//
// propose  — test a unified diff in a temporary copy; never edits the real tree
// approve  — explicit human action; applies the exact reviewed patch to the working tree
// reject   — marks a proposal rejected
// show/list — review proposal metadata
//
// There is deliberately no commit, push or deploy command.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { approve, listProposals, propose, readProposal, reject, SkillError } from './lib.mjs';

const USAGE = `valkyrie-sandboxed-coder — proposal-only coding skill

Usage:
  node cli.mjs propose --root <dir> --patch <file|-> --test <relative-test> [--test ...] [--timeout <ms>]
  node cli.mjs approve --root <dir> --id <proposal-id> --confirm APPLY
  node cli.mjs reject  --root <dir> --id <proposal-id>
  node cli.mjs show    --root <dir> --id <proposal-id>
  node cli.mjs list    --root <dir>
  node cli.mjs help

Rules:
  - propose copies the project to a temporary directory, applies the patch there,
    runs node --check and node --test under the Node permission model, and stores
    a hash-locked proposal. It never edits the real working tree.
  - approve is a separate, explicit human action. It applies the exact tested patch
    to the working tree only. It does not commit, push or deploy.
  - Agents must not run approve on their own. Present the proposal and wait for a human.
  - Patches cannot touch .git, .env, node_modules, secrets, keys or generated build output.
`;

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) throw new SkillError('MISSING_VALUE', flag + ' needs a value.');
  return value;
}

function parse(argv) {
  const command = argv[0];
  const options = { root: process.cwd(), testFiles: [], timeoutMs: undefined, id: undefined, confirm: undefined, patchPath: undefined };
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
    } else if (arg === '--id') {
      options.id = requireValue(argv, index, '--id');
      index += 1;
    } else if (arg === '--confirm') {
      options.confirm = requireValue(argv, index, '--confirm');
      index += 1;
    } else {
      throw new SkillError('UNKNOWN_OPTION', 'Unknown option: ' + arg);
    }
  }
  return { command, options };
}

async function readPatch(file) {
  if (file === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path.resolve(file), 'utf8');
}

function printProposal(proposal) {
  console.log('Proposal ' + proposal.id + ' — ' + proposal.status);
  console.log('Files: ' + proposal.files.join(', '));
  console.log('Patch SHA-256: ' + proposal.patchSha256);
  console.log('Sandbox: ' + (proposal.sandbox.nodePermissionModel ? 'Node permission model, isolated copy' : 'isolated copy'));
  for (const row of proposal.syntax) {
    console.log('Syntax ' + (row.ok ? 'PASS' : 'FAIL') + ': ' + row.file);
  }
  console.log('Tests ' + (proposal.tests.ok ? 'PASS' : 'FAIL') + ': ' + proposal.tests.command);
  if (!proposal.tests.ok) {
    const detail = proposal.tests.stderr || proposal.tests.stdout;
    if (detail) console.error(detail.trim());
  }
  console.log('The real working tree was not changed.');
  if (proposal.status === 'pending_approval') {
    console.log('A human can apply it with:');
    console.log('  node ' + process.argv[1] + ' approve --root ' + JSON.stringify(proposal.root) + ' --id ' + proposal.id + ' --confirm APPLY');
  } else {
    console.log('This proposal is not approvable. Fix the patch and propose again.');
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  const { options } = parse(process.argv.slice(2));
  if (command === 'propose') {
    if (!options.patchPath) throw new SkillError('PATCH_REQUIRED', 'Use --patch <file|->.');
    if (!options.testFiles.length) throw new SkillError('TEST_REQUIRED', 'Use --test <relative-test> at least once.');
    const proposal = await propose({
      root: options.root,
      patch: await readPatch(options.patchPath),
      testFiles: options.testFiles,
      timeoutMs: options.timeoutMs
    });
    printProposal(proposal);
    if (proposal.status !== 'pending_approval') process.exitCode = 1;
    return;
  }
  if (command === 'approve') {
    if (!options.id) throw new SkillError('ID_REQUIRED', 'Use --id <proposal-id>.');
    if (options.confirm !== 'APPLY') throw new SkillError('APPROVAL_CONFIRMATION_REQUIRED', 'Use --confirm APPLY.');
    if (!process.stdin.isTTY) {
      throw new SkillError('HUMAN_APPROVAL_REQUIRED', 'approve must be run interactively by a human in a terminal. Agents must not approve their own proposals.');
    }
    const proposal = await approve({ root: options.root, id: options.id, confirm: options.confirm });
    console.log('Applied proposal ' + proposal.id + ' to the working tree.');
    console.log('No commit, push or deployment was performed.');
    return;
  }
  if (command === 'reject') {
    if (!options.id) throw new SkillError('ID_REQUIRED', 'Use --id <proposal-id>.');
    const proposal = await reject({ root: options.root, id: options.id });
    console.log('Proposal ' + proposal.id + ' marked ' + proposal.status + '.');
    return;
  }
  if (command === 'show') {
    if (!options.id) throw new SkillError('ID_REQUIRED', 'Use --id <proposal-id>.');
    const proposal = await readProposal(options.root, options.id);
    console.log(JSON.stringify(proposal, null, 2));
    return;
  }
  if (command === 'list') {
    const rows = await listProposals({ root: options.root });
    if (!rows.length) {
      console.log('No proposals.');
      return;
    }
    for (const row of rows) {
      console.log(row.id + '  ' + String(row.status).padEnd(18) + '  ' + (row.createdAt || '') + '  ' + (row.files || []).join(', '));
    }
    return;
  }
  throw new SkillError('UNKNOWN_COMMAND', 'Unknown command: ' + command);
}

try {
  await main();
} catch (error) {
  if (error instanceof SkillError) {
    console.error('ERROR ' + error.code + ': ' + error.message);
    process.exitCode = 1;
  } else {
    console.error('ERROR UNEXPECTED: ' + String(error && error.message || error));
    process.exitCode = 1;
  }
}
