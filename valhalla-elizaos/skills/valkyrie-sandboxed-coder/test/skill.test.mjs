import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, propose, readProposal, reject, SkillError } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');
const ORIGINAL = 'export function add(a, b) {\n  return a + b;\n}\n';

const PASS_PATCH = `diff --git a/src/math.mjs b/src/math.mjs
index 1111111..2222222 100644
--- a/src/math.mjs
+++ b/src/math.mjs
@@ -1,3 +1,7 @@
 export function add(a, b) {
   return a + b;
 }
+
+export function double(n) {
+  return n * 2;
+}
diff --git a/test/double.test.mjs b/test/double.test.mjs
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/test/double.test.mjs
@@ -0,0 +1,6 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import { double } from '../src/math.mjs';
+test('double', () => {
+  assert.equal(double(3), 6);
+});
`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'valkyrie-skill-test-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/math.mjs'), ORIGINAL);
  await writeFile(path.join(root, 'test/math.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.mjs';
test('add', () => {
  assert.equal(add(2, 3), 5);
});
`);
  return root;
}

async function withFixture(fn) {
  const root = await fixture();
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function codeOf(error) {
  return error instanceof SkillError ? error.code : null;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(codeOf(error), code);
    return true;
  });
}

test('propose tests in a copy and leaves the real tree unchanged', async () => {
  await withFixture(async (root) => {
    const proposal = await propose({
      root,
      patch: PASS_PATCH,
      testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
      id: 'a1b2c3d4',
      now: 1_700_000_000_000
    });
    assert.equal(proposal.status, 'pending_approval');
    assert.equal(proposal.tests.ok, true);
    assert.equal(proposal.tests.timedOut, false);
    assert.match(proposal.tests.stdout, /pass 2/);
    assert.equal(proposal.syntax.every((row) => row.ok), true);
    assert.equal(proposal.patchSha256.length, 64);
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), ORIGINAL);
    await assert.rejects(stat(path.join(root, 'test/double.test.mjs')), (error) => error.code === 'ENOENT');
    const stored = await readProposal(root, 'a1b2c3d4');
    assert.equal(stored.status, 'pending_approval');
  });
});

test('approval requires APPLY and only then changes the real tree', async () => {
  await withFixture(async (root) => {
    const proposal = await propose({
      root,
      patch: PASS_PATCH,
      testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
      id: 'b1b2c3d4'
    });
    await rejectsWith(approve({ root, id: proposal.id, confirm: 'yes' }), 'APPROVAL_CONFIRMATION_REQUIRED');
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), ORIGINAL);
    const applied = await approve({ root, id: proposal.id, confirm: 'APPLY' });
    assert.equal(applied.status, 'applied');
    assert.match(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), /export function double/);
    assert.match(await readFile(path.join(root, 'test/double.test.mjs'), 'utf8'), /double\(3\), 6/);
  });
});

test('failed tests cannot be approved', async () => {
  await withFixture(async (root) => {
    const badPatch = PASS_PATCH.replace('return n * 2;', 'return n * 3;');
    const proposal = await propose({
      root,
      patch: badPatch,
      testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
      id: 'c1b2c3d4'
    });
    assert.equal(proposal.status, 'tests_failed');
    assert.equal(proposal.tests.ok, false);
    await rejectsWith(approve({ root, id: proposal.id, confirm: 'APPLY' }), 'PROPOSAL_NOT_APPROVABLE');
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), ORIGINAL);
  });
});

test('parent, absolute and protected paths are rejected before testing', async () => {
  await withFixture(async (root) => {
    const parent = PASS_PATCH.replaceAll('a/src/math.mjs', 'a/../escape.mjs').replaceAll('b/src/math.mjs', 'b/../escape.mjs');
    await rejectsWith(propose({ root, patch: parent, testFiles: ['test/math.test.mjs'] }), 'PATH_ESCAPE');
    const absolute = PASS_PATCH.replaceAll('a/src/math.mjs', 'a//etc/escape.mjs').replaceAll('b/src/math.mjs', 'b//etc/escape.mjs');
    await rejectsWith(propose({ root, patch: absolute, testFiles: ['test/math.test.mjs'] }), 'ABSOLUTE_PATH');
    const protectedFile = PASS_PATCH.replaceAll('src/math.mjs', '.env.local');
    await rejectsWith(propose({ root, patch: protectedFile, testFiles: ['test/math.test.mjs'] }), 'FORBIDDEN_PATH');
    const credentialFile = PASS_PATCH.replaceAll('src/math.mjs', '.npmrc');
    await rejectsWith(propose({ root, patch: credentialFile, testFiles: ['test/math.test.mjs'] }), 'FORBIDDEN_PATH');
  });
});

test('a secret-shaped added line is rejected', async () => {
  await withFixture(async (root) => {
    const secretPatch = `diff --git a/src/math.mjs b/src/math.mjs
--- a/src/math.mjs
+++ b/src/math.mjs
@@ -1,3 +1,4 @@
 export function add(a, b) {
   return a + b;
 }
+const token = 'sk-12345678901234567890';
`;
    await rejectsWith(propose({ root, patch: secretPatch, testFiles: ['test/math.test.mjs'] }), 'SECRET_IN_PATCH');
  });
});

test('a stale tree cannot be approved', async () => {
  await withFixture(async (root) => {
    const proposal = await propose({
      root,
      patch: PASS_PATCH,
      testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
      id: 'd1b2c3d4'
    });
    await writeFile(path.join(root, 'src/math.mjs'), ORIGINAL + '\n// changed after proposal\n');
    await rejectsWith(approve({ root, id: proposal.id, confirm: 'APPLY' }), 'STALE_TREE');
    assert.doesNotMatch(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), /export function double/);
  });
});

test('editing the stored patch invalidates the proposal', async () => {
  await withFixture(async (root) => {
    const proposal = await propose({
      root,
      patch: PASS_PATCH,
      testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
      id: 'e1b2c3d4'
    });
    const file = path.join(root, '.coding-skill/proposals', proposal.id + '.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.patch = stored.patch.replace('return n * 2;', 'return n * 9;');
    await writeFile(file, JSON.stringify(stored, null, 2) + '\n');
    await rejectsWith(approve({ root, id: proposal.id, confirm: 'APPLY' }), 'PATCH_HASH_MISMATCH');
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), ORIGINAL);
  });
});

test('a missing new test file is a hard failure', async () => {
  await withFixture(async (root) => {
    await rejectsWith(propose({
      root,
      patch: PASS_PATCH,
      testFiles: ['test/math.test.mjs', 'test/missing.test.mjs'],
      id: 'f1b2c3d4'
    }), 'TEST_NOT_FOUND');
  });
});

test('reject closes a proposal without touching the tree', async () => {
  await withFixture(async (root) => {
    const proposal = await propose({
      root,
      patch: PASS_PATCH,
      testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
      id: 'a2b2c3d4'
    });
    const rejected = await reject({ root, id: proposal.id });
    assert.equal(rejected.status, 'rejected');
    await rejectsWith(approve({ root, id: proposal.id, confirm: 'APPLY' }), 'PROPOSAL_NOT_APPROVABLE');
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), ORIGINAL);
  });
});

test('CLI help has no deploy command', () => {
  const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /propose/);
  assert.match(result.stdout, /approve/);
  assert.match(result.stdout, /--confirm APPLY/);
  assert.doesNotMatch(result.stdout, /^\s*deploy\b/m);
});
