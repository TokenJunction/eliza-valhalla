# Valkyrie proposal-only coding for ElizaOS

The `valhalla-valkyrie-coder` plugin gives the ElizaOS agents one capability: **propose a tested patch**. It has no approval, apply, commit, push or deploy action. The only real-tree write is the proposal record under `.coding-skill/proposals/`; tracked source files are not changed.

## Agent action

`VALKYRIE_PROPOSE_PATCH` accepts a unified diff and one or more relative test paths. It:

1. Copies the configured checkout into a fresh temporary directory.
2. Applies and syntax-checks the diff **in the copy only**.
3. Runs the named tests with Node's permission model.
4. Stores a hash-locked proposal under `.coding-skill/proposals/`.
5. Returns the proposal id, status, changed files, patch hash and test result.

No tracked source file is changed during the propose step; the only real-tree write is `.coding-skill/proposals/<id>.json`.

The action is granted by default to `zeus`, `odin`, `wren`, `valkyrie`, `forge` and `hermod`. Set `VALKYRIE_ALLOWED_ROLES` to a comma-separated role list to change that grant. A role that is not in the grant is rejected both by `validate` and inside the handler.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `VALKYRIE_PROJECT_ROOT` | yes | Absolute path to the checkout the agents may propose against. The action fails closed when this is unset or is not a real, non-symlink directory. |
| `VALKYRIE_ALLOWED_ROLES` | no | Comma-separated role names. Defaults to the coding roles above. |
| `VALKYRIE_NODE_BIN` | no | Node executable for the propose runner. Defaults to `node`. Use Node 22+; the sandbox needs `--permission` and `--test-isolation=none`. |
| `VALKYRIE_PROPOSE_TIMEOUT_MS` | no | Test timeout, 1,000–300,000 ms. Defaults to 120,000 ms. |
| `VALKYRIE_SKILL_DIR` | no | Override the bundled skill location. Normally the plugin finds `skills/valkyrie-sandboxed-coder/`. |

`VALKYRIE_PROJECT_ROOT` should point at a disposable checkout or a dedicated review workspace. Do not accept it from chat or derive it from a user-supplied path. On the Render image the app lives at `/app`; the image does not contain a separate product checkout, so set this only after providing one. The Render blueprint declares it as a sync-false variable, so set the path in the Render dashboard rather than in source.

## Why the agent cannot approve

- The plugin imports only the action that runs `agent-propose.mjs`. It does not import the skill's `approve`, `reject` or CLI modules.
- `agent-propose.mjs` has one command: `propose`. It cannot invoke `cli.mjs approve`.
- There is no approval route, action, tool or environment secret in the agent process.
- The human approval CLI is separate and requires an interactive terminal plus `--confirm APPLY`.
- The runner rejects patches targeting `valhalla-elizaos/` or `skills/`, so an agent cannot propose changes to its own runtime or to this skill.
- The runner spawns Node with `shell: false`, a fixed argument vector and a minimal environment. It does not pass provider, database or deploy credentials into the test sandbox.

## Human approval

From a terminal on the machine that owns the checkout:

```bash
node skills/valkyrie-sandboxed-coder/cli.mjs list --root "$VALKYRIE_PROJECT_ROOT"
node skills/valkyrie-sandboxed-coder/cli.mjs show --root "$VALKYRIE_PROJECT_ROOT" --id <proposal-id>
node skills/valkyrie-sandboxed-coder/cli.mjs approve --root "$VALKYRIE_PROJECT_ROOT" --id <proposal-id> --confirm APPLY
```

Approval applies the exact hash-locked patch to the working tree and stops. It does **not** commit, push or deploy. If the target files changed after the proposal was tested, approval fails with `STALE_TREE`.

## Deploy boundary

There is no deploy action or command in this integration. A proposal is a working-tree change only after a human approves it. Committing, pushing, opening a PR and deploying remain separate, human-operated steps.

## Tests

```bash
bun test src/__tests__/valkyrie-coder.test.ts
bun run test:skill
```

The integration test proves that a proposal leaves the real fixture tree unchanged, a non-granted role is rejected, a patch to the ElizaOS runtime is rejected, and the plugin exposes no approval or deploy action.
