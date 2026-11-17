import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from '@elizaos/core';
import project from '../index.ts';
import {
  createValkyrieCoderPlugin,
  VALKYRIE_CODER_PLUGIN,
  VALKYRIE_PROPOSE_ACTION,
} from '../valkyrie-coder.ts';

const SKILL_DIR = fileURLToPath(
  new URL('../../skills/valkyrie-sandboxed-coder', import.meta.url),
);
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
  const root = await mkdtemp(path.join(tmpdir(), 'valkyrie-plugin-test-'));
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

async function withFixture(fn: (root: string) => Promise<void>) {
  const root = await fixture();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runtime(role: string): IAgentRuntime {
  return {
    character: {
      name: 'Test Agent',
      settings: { valhallaRole: role },
    },
  } as unknown as IAgentRuntime;
}

function message(text: string, extra: Record<string, unknown> = {}): Memory {
  return {
    content: { text, ...extra },
  } as unknown as Memory;
}

async function run(
  action: NonNullable<ReturnType<typeof createValkyrieCoderPlugin>['actions']>[number],
  role: string,
  content: { text: string; patch?: string; testFiles?: string[] },
  options: HandlerOptions = {},
): Promise<ActionResult> {
  let callbackContent: Content | undefined;
  const callback: HandlerCallback = async (value) => {
    callbackContent = value;
    return [];
  };
  const result = await action.handler(
    runtime(role),
    message(content.text, content),
    undefined,
    options,
    callback,
  );
  return result as ActionResult;
}

function coderPlugin(root: string, roles: string[] = ['zeus']) {
  return createValkyrieCoderPlugin({
    root,
    skillDir: SKILL_DIR,
    nodeBin: 'node',
    allowedRoles: roles,
    timeoutMs: 30_000,
  });
}

describe('Valkyrie proposal-only coder', () => {
  it('creates a tested proposal in a copy and leaves the real tree unchanged', async () => {
    await withFixture(async (root) => {
      const plugin = coderPlugin(root);
      const action = plugin.actions?.[0];
      expect(action?.name).toBe(VALKYRIE_PROPOSE_ACTION);
      await expect(
        action?.validate(runtime('zeus'), message('Propose this patch in the sandbox.')),
      ).resolves.toBe(true);

      const result = await run(
        action!,
        'zeus',
        {
          text: 'Propose this patch and run the tests in the sandbox.',
          patch: PASS_PATCH,
          testFiles: ['test/math.test.mjs', 'test/double.test.mjs'],
        },
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.status).toBe('pending_approval');
      expect((data.tests as Record<string, unknown>).ok).toBe(true);
      expect(data.canApprove).toBe(false);
      expect(data.canDeploy).toBe(false);
      expect(data.approval).toBe('human_cli_only');
      expect(String(data.patchSha256)).toHaveLength(64);
      expect(await readFile(path.join(root, 'src/math.mjs'), 'utf8')).toBe(ORIGINAL);
      await expect(stat(path.join(root, 'test/double.test.mjs'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('denies the action to a role without the coding grant', async () => {
    await withFixture(async (root) => {
      const plugin = coderPlugin(root, ['zeus']);
      const action = plugin.actions?.[0];
      await expect(
        action?.validate(runtime('cerberus'), message('Propose a patch.')),
      ).resolves.toBe(false);

      const result = await run(action!, 'cerberus', {
        text: 'Propose this patch.',
        patch: PASS_PATCH,
        testFiles: ['test/math.test.mjs'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('role_not_allowed');
      expect(await readFile(path.join(root, 'src/math.mjs'), 'utf8')).toBe(ORIGINAL);
    });
  });

  it('fails closed when no project root is configured', async () => {
    await withFixture(async (root) => {
      const plugin = createValkyrieCoderPlugin({
        root: '',
        skillDir: SKILL_DIR,
        nodeBin: 'node',
        allowedRoles: ['zeus'],
      });
      const result = await run(plugin.actions?.[0]!, 'zeus', {
        text: 'Propose this patch.',
        patch: PASS_PATCH,
        testFiles: ['test/math.test.mjs'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('coder_not_configured');
      expect(await readFile(path.join(root, 'src/math.mjs'), 'utf8')).toBe(ORIGINAL);
    });
  });

  it('rejects a proposal targeting the ElizaOS runtime', async () => {
    await withFixture(async (root) => {
      const result = await run(coderPlugin(root).actions?.[0]!, 'zeus', {
        text: 'Propose this patch.',
        patch: SELF_PATCH,
        testFiles: ['test/math.test.mjs'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('AGENT_PATCH_FORBIDDEN');
      await expect(stat(path.join(root, '.coding-skill'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('publishes no approval, apply, commit, push or deploy action', () => {
    const plugin = coderPlugin('/tmp');
    const names = plugin.actions?.map((action) => action.name) ?? [];
    expect(names).toEqual([VALKYRIE_PROPOSE_ACTION]);
    expect(plugin.routes).toBeUndefined();
    expect(names.some((name) => /APPROVE|APPLY|COMMIT|PUSH|DEPLOY/.test(name))).toBe(false);
  });

  it('is attached to every project agent but gated by role', async () => {
    const pluginNames = project.agents.map((agent) =>
      (agent.plugins ?? []).map((plugin) => plugin.name),
    );
    expect(pluginNames.every((names) => names.includes(VALKYRIE_CODER_PLUGIN))).toBe(true);

    const zeus = project.agents.find((agent) => agent.character.username === 'zeus');
    const cerberus = project.agents.find((agent) => agent.character.username === 'cerberus');
    const zeusAction = zeus?.plugins?.find((plugin) => plugin.name === VALKYRIE_CODER_PLUGIN)?.actions?.[0];
    const cerberusAction = cerberus?.plugins?.find((plugin) => plugin.name === VALKYRIE_CODER_PLUGIN)?.actions?.[0];
    expect(await zeusAction!.validate(runtime('zeus'), message('Propose a patch.'))).toBe(true);
    expect(await cerberusAction!.validate(runtime('cerberus'), message('Propose a patch.'))).toBe(false);
  });
});
