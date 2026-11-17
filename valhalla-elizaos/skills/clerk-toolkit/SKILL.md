---
name: clerk-toolkit
description: Clerk authentication toolkit for ValhallaOS — bundled Clerk Agent Skills plus a read-only Clerk MCP client for setup, framework patterns, organizations, billing, webhooks, testing and account reads.
license: MIT
metadata:
  version: 1.0.0
---

# Clerk Toolkit for ValhallaOS

This is the ValhallaOS port of Clerk's Cursor plugin. It combines the two parts
the official plugin ships:

1. **Clerk Agent Skills** — the same 20 `SKILL.md` packages Cursor loads, vendored
   under `skills/` so they work with no network and no account.
2. **Clerk's remote MCP server** — a Streamable HTTP client for
   `https://mcp.clerk.com/mcp`, restricted to read-only tools.

Use this skill when the user asks to add Clerk authentication, configure Clerk,
write Clerk middleware, protect routes, use Clerk organizations/billing/webhooks,
test Clerk auth, or inspect a Clerk account.

## What the Valkyries can do

- Read the router or any specific Clerk skill and its references/templates.
- Generate framework-correct Clerk code from the bundled skill content.
- List and fetch Clerk SDK snippets and bundles through the MCP server.
- Read account data through the MCP read-only allowlist (`whoami`,
  `list_applications`, `get_application`, instance config, users, domains,
  deployment OAuth providers, feedback).
- Propose a patch through `VALKYRIE_PROPOSE_PATCH` after writing the code.

## What the Valkyries cannot do

- No mutating Clerk MCP tool: no `create_application`,
  `patch_instance_config`, `put_instance_config`, `create_user`,
  `check_domain_dns`, `create_production_instance`,
  `set_oauth_provider_credentials`, `submit_feedback` or `get_more_tools`.
- No Clerk secret key or password handling. The MCP server never returns secret
  keys, and the toolkit never asks for one.
- No approval, apply, commit, push or deploy. Coding remains proposal-only.

The read-only allowlist is enforced before an HTTP request is made. Unknown tool
names are denied by default. `CLERK_MCP_EXTRA_READ_TOOLS` can add a new read
tool, but names on the known mutating list are still refused.

## Commands

```sh
# Local skills — no account required.
node skills/clerk-toolkit/cli.mjs list
node skills/clerk-toolkit/cli.mjs show clerk-nextjs-patterns
node skills/clerk-toolkit/cli.mjs show clerk-nextjs-patterns references/middleware-strategies.md
node skills/clerk-toolkit/cli.mjs search "b2b billing"

# Health check; reports skills and MCP status without printing the token.
node skills/clerk-toolkit/cli.mjs doctor
```

## MCP authentication

Clerk MCP uses OAuth and every tool requires sign-in. The ElizaOS runtime does
not run an interactive browser callback, so it accepts a bearer access token
from a secret source:

| Variable | Meaning |
|---|---|
| `CLERK_MCP_TOKEN` | OAuth access token. Preferred in a secret manager. |
| `CLERK_MCP_TOKEN_FILE` | Path to a file containing the token, for mounted secrets. |
| `CLERK_MCP_URL` | Optional override. Defaults to `https://mcp.clerk.com/mcp`. |
| `CLERK_MCP_EXTRA_READ_TOOLS` | Comma-separated additional read-only tool names. |
| `CLERK_ALLOWED_ROLES` | Roles granted the toolkit. Defaults to the coding roles. |
| `CLERK_SKILLS_DIR` | Optional override for the bundled skills directory. |

Without a token the skills still work. Snippet actions fall back to the matching
bundled skill and report `degraded: true`; account reads return
`clerk_mcp_not_configured`.

Tokens expire. Refresh the secret and restart the runtime when Clerk returns
`MCP_AUTH_REQUIRED`.

## Agent tools

- `CLERK_SKILL_LOOKUP` — list, search or read a bundled skill/reference.
- `CLERK_SNIPPET` — list Clerk SDK snippets or fetch one by slug, using MCP when
  configured and the local skill otherwise.
- `CLERK_MCP_READ` — explicit read-only MCP call:
  `clerk mcp tools`, `clerk mcp whoami`, or
  `clerk mcp list_applications {"limit":5}`.

The provider injects the router catalog plus the most relevant skill into the
model context. A request such as "add Clerk auth to my Next.js app" gets
`clerk-nextjs-patterns`; "set up B2B billing" gets `clerk-billing`; unrelated
messages get no Clerk context.

## Source

Vendored from `clerk/skills` at commit
`a02dbd2a933b8929525129a6cb9dcf6ed66d0adf` (MIT). The plugin wrapper is
`clerk/cursor-plugin` 0.2.1. See `SOURCE.md` and `LICENSE`.

## Tests

```sh
bun test src/__tests__/clerk-toolkit.test.ts
node --test skills/clerk-toolkit/test/*.test.mjs
```
