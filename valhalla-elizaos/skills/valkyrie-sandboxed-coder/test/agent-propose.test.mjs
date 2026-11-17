import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'agent-propose.mjs');
const ORIGINAL = 'export function add(a, b) {\n  return a + b;\n}\n';

const PASS_PATCH = `diff --git a/src/math.mjs b/src/math.mjs
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
--- /dev/null
+++ b/test/double.test.mjs
@@ -0,0 +1,6 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import { double } from '../src/math.mjs';
+test('double', () => {
+  assert.equal(double(3), 6);
+});
+`;

const SELF_PATCH = `diff --git a/valhalla-elizaos/src/index.ts b/valhalla-elizaos/src/index.ts
--- a/valhalla-elizaos/src/index.ts
+++ b/valhalla-elizaos/src/index.ts
@@ -1,1 +1,2 @@
 export default {};
+// agent self-patch
`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'valkyrie-agent-test-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/math.mjs'), ORIGINAL);
  await writeFile(
    path.join(root, 'test/math.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.mjs';
test('add', () => {
  assert.equal(add(2, 3), 5);
});
`,
  );
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

function run(args, input) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    input,
    timeout: 30_000,
  });
}

test('agent runner proposes in a copy and leaves the real tree unchanged', async () => {
  await withFixture(async (root) => {
    const patchPath = path.join(root, 'change.patch');
    await writeFile(patchPath, PASS_PATCH);
    const result = run([
      'propose',
      '--root',
      root,
      '--patch',
      patchPath,
      '--test',
      'test/math.test.mjs',
      '--test',
      'test/double.test.mjs',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const proposal = JSON.parse(result.stdout);
    assert.equal(proposal.ok, true);
    assert.equal(proposal.status, 'pending_approval');
    assert.equal(proposal.tests.ok, true);
    assert.equal(proposal.canApprove, false);
    assert.equal(proposal.canDeploy, false);
    assert.equal(proposal.approval, 'human_cli_only');
    assert.equal(proposal.patchSha256.length, 64);
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), ORIGINAL);
    await assert.rejects(stat(path.join(root, 'test/double.test.mjs')), (error) => error.code === 'ENOENT');
  });
});

test('agent runner rejects a patch to the ElizaOS runtime or its own skill', async () => {
  await withFixture(async (root) => {
    const patchPath = path.join(root, 'self.patch');
    await writeFile(patchPath, SELF_PATCH);
    const result = run([
      'propose',
      '--root',
      root,
      '--patch',
      patchPath,
      '--test',
      'test/math.test.mjs',
    ]);

    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, 'AGENT_PATCH_FORBIDDEN');
    await assert.rejects(stat(path.join(root, '.coding-skill')), (error) => error.code === 'ENOENT');
  });
});

test('agent runner help exposes no approval or deploy command', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /propose/);
  assert.doesNotMatch(result.stdout, /^\s*(?:approve|reject|deploy|commit|push)\b/im);
});
