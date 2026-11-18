'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_PROPOSALS = 20;
const MAX_FILES = 12;
const MAX_JSON_FILES = 200;
const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;
const PROPOSAL_DIR = path.join('.coding-skill', 'proposals');

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);
}

function fileList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text(entry, 240))
    .filter(Boolean)
    .slice(0, MAX_FILES);
}

function resolveRoot(env) {
  const raw = text(env && env.VALKYRIE_PROJECT_ROOT, 4096);
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    const info = fs.lstatSync(raw);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return fs.realpathSync(raw);
  } catch {
    return null;
  }
}

function proposalDirectory(root) {
  const directory = path.join(root, PROPOSAL_DIR);
  try {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return directory;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeProposal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id, 32);
  if (!/^[a-f0-9]{8,32}$/.test(id)) return null;

  const tests = raw.tests && typeof raw.tests === 'object' ? raw.tests : {};
  const syntax = Array.isArray(raw.syntax) ? raw.syntax : [];
  const patchSha256 = text(raw.patchSha256, 64);

  return {
    id,
    status: text(raw.status, 32),
    createdAt: text(raw.createdAt, 40),
    files: fileList(raw.files),
    testFiles: fileList(raw.testFiles),
    testsOk: tests.ok === true,
    testsTimedOut: tests.timedOut === true,
    syntaxOk: syntax.length > 0 && syntax.every((row) => row && row.ok === true),
    patchSha256: /^[a-f0-9]{64}$/.test(patchSha256) ? patchSha256 : '',
  };
}

async function listPendingProposals(env = process.env) {
  const root = resolveRoot(env);
  if (!root) {
    return { configured: false, pendingCount: 0, proposals: [], truncated: false };
  }

  const directory = proposalDirectory(root);
  if (!directory) {
    return { configured: true, pendingCount: 0, proposals: [], truncated: false };
  }

  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { configured: true, pendingCount: 0, proposals: [], truncated: false };
    }
    throw error;
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => right.name.localeCompare(left.name));
  const files = jsonFiles.slice(0, MAX_JSON_FILES);

  const rows = await Promise.all(
    files.map(async (entry) => {
      try {
        const filePath = path.join(directory, entry.name);
        const info = await fsp.stat(filePath);
        if (!info.isFile() || info.size > MAX_PROPOSAL_BYTES) return null;
        const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        return normalizeProposal(raw);
      } catch {
        return null;
      }
    }),
  );

  const pending = rows
    .filter((row) => row && row.status === 'pending_approval')
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  return {
    configured: true,
    pendingCount: pending.length,
    proposals: pending.slice(0, MAX_PROPOSALS),
    truncated: jsonFiles.length > MAX_JSON_FILES || pending.length > MAX_PROPOSALS,
  };
}

module.exports = { listPendingProposals };
