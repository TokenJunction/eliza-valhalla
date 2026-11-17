---
name: valkyrie-sandboxed-coder
description: Propose and test code patches in an isolated copy, then require explicit human approval before applying anything to the working tree. Never commits, pushes or deploys.
version: 1.0.0
triggers:
  - propose a code patch
  - fix this bug safely
  - run tests before applying
  - review a sandboxed patch
dependencies:
  - node
  - git
---

# Valkyrie Sandboxed Coder

A proposal-only coding skill for ValhallaOS. It lets an agent prepare a patch, run real syntax checks and tests in a disposable copy, and present the result for human approval. No source file in the real working tree is changed until a human explicitly approves the exact tested patch.

## Hard rules

1. **Never edit project files directly.** Produce a unified diff (`git diff` output) and use `propose`.
2. **Never run `approve` on your own.** Only a human may run the approval command. If a task says “apply it,” present the proposal and wait.
3. **No commit, push or deploy.** This skill has no command for those actions. Approval applies the patch to the working tree only. A separate, reviewed process is required for version control and deployment.
4. **Never put secrets in a patch.** Tokens, private keys, seed phrases and service-role keys must come from the environment. The validator rejects common secret shapes.
5. **Only test what is in the sandbox.** The test runner is fixed to `node --test` with the Node permission model, an isolated copy and no shell. It is not a substitute for a real container when running hostile code.

## What it protects

- The real tree is not written during `propose`; only `.coding-skill/proposals/<id>.json` is created.
- Patches may not touch `.git`, `.env*`, `node_modules`, `secrets`, `.ssh`, `.coding-skill`, build output, symlinks, binaries or submodules.
- Patch size is capped at 512 KiB and 50 files.
- The proposal stores SHA-256 hashes of every target file before testing. If anything changes before approval, the proposal becomes stale and cannot be applied.
- The stored patch is hash-locked; editing the proposal file does not let a different patch through.
- Approval requires the exact phrase `--confirm APPLY` **and an interactive terminal**. The CLI refuses non-interactive approval so an agent cannot silently approve its own proposal.

## Agent integration

ElizaOS agents use `agent-propose.mjs`, not `cli.mjs`. This entrypoint imports only `propose`; it has no approval, rejection, commit, push or deploy command.

```sh
node agent-propose.mjs propose \
  --root /srv/checkout \
  --patch - \
  --test test/feature.test.mjs
```

The runner reads a unified diff from stdin (or `--patch <file>`), tests it in an isolated copy, and prints one JSON object with the proposal id, status, files, hash and test result. It also rejects any patch targeting `valhalla-elizaos/` or `skills/`, so an agent cannot propose changes to its own runtime or this skill.

A human still runs `cli.mjs approve` interactively. The agent runtime has no action or route that can call it.

## Commands

Run from the project root (or pass `--root`):

```sh
# 1. Test a patch without touching the real tree.
node skills/valkyrie-sandboxed-coder/cli.mjs propose \
  --root . \
  --patch change.patch \
  --test test/math.test.mjs \
  --test test/new-feature.test.mjs

# 2. Review the proposal.
node skills/valkyrie-sandboxed-coder/cli.mjs show --root . --id <id>
node skills/valkyrie-sandboxed-coder/cli.mjs list --root .

# 3. A HUMAN applies the exact reviewed patch.
node skills/valkyrie-sandboxed-coder/cli.mjs approve \
  --root . --id <id> --confirm APPLY

# Or reject it.
node skills/valkyrie-sandboxed-coder/cli.mjs reject --root . --id <id>
```

`--patch -` reads the diff from standard input. `--timeout` is optional and bounded to 300 seconds. Test paths must be relative and end in `.test.mjs`, `.test.cjs` or `.test.js`.

## Proposal workflow

1. Capture the current change as a unified diff. Do not apply it to the real tree.
2. Call `propose` with one or more test files.
3. The skill copies the project to a temporary directory, applies the patch there, runs `node --check` on changed JavaScript files, then runs:
   ```sh
   node --permission --allow-fs-read=<sandbox> --allow-fs-write=<sandbox> \
     --test-isolation=none --test <test files>
   ```
4. If tests fail, the proposal is stored as `tests_failed` and cannot be approved. Fix the patch and propose again.
5. If tests pass, the proposal is `pending_approval`. Show the human the proposal id, changed files, test result and patch hash.
6. The human runs `approve` with `--confirm APPLY`. The skill rechecks the original hashes, applies the exact patch to the working tree, and stops. It does not commit, push or deploy.
7. A stale tree, tampered patch, rejected proposal or failed test is a hard stop — never work around it.

## What the sandbox does and does not do

**Does:**

- Copy only ordinary project files into a fresh temporary directory.
- Block protected paths, symlinks, binary patches, submodules and common secret patterns.
- Run syntax checks and tests in that copy under Node's permission model.
- Deny filesystem reads and writes outside the sandbox during tests.
- Run with a cleaned environment (`HOME` and `TMPDIR` inside the sandbox; no user tokens or provider keys).
- Use `--test-isolation=none` so the test runner does not need child-process permission.

**Does not:**

- Provide network isolation. A test can still attempt network access.
- Virtualize the kernel or protect against a Node/V8 escape.
- Run `npm install`, package scripts, arbitrary shells or deployment commands.
- Apply, commit, push or deploy without a human approval command.

For untrusted third-party code or a real security boundary, run the proposal inside a disposable container or VM in addition to this skill.

## Failure codes

| Code | Meaning |
|---|---|
| `INVALID_PATCH` | Not a usable unified diff |
| `PATH_ESCAPE` / `ABSOLUTE_PATH` | Patch tries to leave the project |
| `FORBIDDEN_PATH` | Patch targets a protected directory or secret file |
| `SYMLINK_PATCH` / `BINARY_OR_SUBMODULE` | Unsupported or unsafe patch type |
| `SECRET_IN_PATCH` | Added line looks like a credential |
| `PATCH_REJECTED` / `PATCH_FAILED` | `git apply` could not apply the diff |
| `TEST_REQUIRED` / `TEST_NOT_FOUND` | No test, or a test file missing after the patch |
| `SANDBOX_UNSUPPORTED` | Node runtime lacks the permission model or test isolation |
| `STALE_TREE` | Target files changed after proposal testing |
| `PATCH_HASH_MISMATCH` | Stored patch was edited after review |
| `APPROVAL_CONFIRMATION_REQUIRED` | Missing `--confirm APPLY` |
| `PROPOSAL_NOT_APPROVABLE` | Tests failed, or proposal is already applied/rejected |

## Example patch shape

```diff
diff --git a/src/math.mjs b/src/math.mjs
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
```

The patch is tested in the copy. The real `src/math.mjs` changes only after a human approves the proposal.
