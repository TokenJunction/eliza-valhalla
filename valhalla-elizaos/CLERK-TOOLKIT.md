# Clerk toolkit for the Valkyries

The `valhalla-clerk-toolkit` plugin ports the official Clerk Cursor plugin into
the ElizaOS roster. It gives granted agents the Clerk coding knowledge and a
read-only view of a connected Clerk workspace. It does not add a mutating Clerk
action, an approval path or a deploy path.

## What was reverse engineered

Clerk's Cursor integration is two things, not an executable library:

1. `.cursor-plugin/plugin.json` points Cursor at 20 Agent Skills in the
   `clerk/skills` repository.
2. `mcp.json` points Cursor at the remote Streamable HTTP server
   `https://mcp.clerk.com/mcp`.

The server starts unauthenticated with HTTP 401 and asks for the OAuth scopes
`user:org:read applications:read applications:manage users:read users:manage
application_domains:read application_domains:manage`. Its account tools can
create applications, patch instance configuration, create users, check domains
and create production instances. Those are all writes, so the Valkyrie port
does not expose them.

The bundled skills are vendored verbatim at
`skills/clerk-toolkit/skills/` from `clerk/skills` commit
`a02dbd2a933b8929525129a6cb9dcf6ed66d0adf` (MIT). See
`skills/clerk-toolkit/SOURCE.md` and `LICENSE`.

## Agent experience

The `CLERK_TOOLKIT` provider injects a compact catalog and the most relevant
skill when a granted role mentions Clerk. Examples:

| Request | Injected skill |
|---|---|
| Add Clerk auth to my Next.js app | `clerk-nextjs-patterns` |
| React Router loaders with Clerk | `clerk-react-router-patterns` |
| Set up Clerk organizations and RBAC | `clerk-orgs` |
| Clerk billing with a pricing table | `clerk-billing` |
| Playwright Clerk login test | `clerk-testing` |
| Clerk on Expo / React Native | `clerk-expo` |
| Clerk CLI env pull | `clerk-cli` |

The provider also adds a matching reference file when the request names a topic
such as middleware, caching or server actions. Unrelated messages get no Clerk
context.

The three actions are read-only:

- `CLERK_SKILL_LOOKUP` lists, searches or reads a bundled skill/reference.
- `CLERK_SNIPPET` lists or fetches SDK snippets/bundles from Clerk MCP, with a
  local-skill fallback when MCP is not configured.
- `CLERK_MCP_READ` calls one tool on the read-only allowlist. Unknown and
  mutating tool names are refused before a request is sent.

Coding still uses `VALKYRIE_PROPOSE_PATCH`: an agent can write a diff and have
it tested in an isolated copy, but only a human can approve it. There is no
commit, push or deploy action.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `CLERK_MCP_TOKEN` | no | OAuth bearer token for Clerk MCP. Keep it in a secret store. |
| `CLERK_MCP_TOKEN_FILE` | no | Path to a file containing the token, for mounted secrets. |
| `CLERK_MCP_URL` | no | Must be HTTPS. Defaults to `https://mcp.clerk.com/mcp`. |
| `CLERK_MCP_EXTRA_READ_TOOLS` | no | Comma-separated additional read-only tool names. Known mutating names stay blocked. |
| `CLERK_ALLOWED_ROLES` | no | Roles granted the toolkit. Defaults to `zeus`, `odin`, `wren`, `valkyrie`, `forge`, `hermod`. |
| `CLERK_SKILLS_DIR` | no | Override the vendored skills directory. |
| `CLERK_TOOLKIT_MAX_CHARS` | no | Skill context cap per turn, 4,000–60,000. Defaults to 24,000. |

Without a token, the local skills and the coding fallback work normally. Account
reads fail closed with `clerk_mcp_not_configured`, and snippet requests fall back
to the matching bundled skill with `degraded: true`.

The runtime does not perform an interactive OAuth browser flow. Obtain a bearer
token from an OAuth-capable Clerk MCP client or your workspace's approved token
issuer, store it as a secret, and restart the runtime. Tokens expire; a 401 is
reported as `MCP_AUTH_REQUIRED`, never as a successful call.

## Commands

```sh
node skills/clerk-toolkit/cli.mjs list
node skills/clerk-toolkit/cli.mjs show clerk-nextjs-patterns
node skills/clerk-toolkit/cli.mjs show clerk-nextjs-patterns references/middleware-strategies.md
node skills/clerk-toolkit/cli.mjs search "b2b billing"
node skills/clerk-toolkit/cli.mjs doctor
```

With a token:

```sh
node skills/clerk-toolkit/cli.mjs mcp tools
node skills/clerk-toolkit/cli.mjs mcp call whoami
node skills/clerk-toolkit/cli.mjs mcp call clerk_sdk_snippet '{"slug":"organizations"}'
```

The CLI never prints the token. `doctor` reports the skill count and MCP status;
it does not print token material.

## Security boundary

- Mutating Clerk tools are denied in `isReadOnlyClerkTool` before any network
  request. Unknown tools are denied by default. `CLERK_MCP_EXTRA_READ_TOOLS`
  cannot re-enable a name on the known mutating list.
- Tool arguments and output are bounded and token-redacted. Errors include a
  status or code, never the bearer token.
- Skill files are resolved inside the selected skill directory. Absolute paths,
  `..`, hidden files, symlinks and non-text extensions are rejected.
- The MCP endpoint must be HTTPS; plain HTTP is allowed only for a loopback test
  with an explicit `allowInsecure` option.
- The MCP server's secret keys are never requested by the toolkit, and Clerk
  documents that it does not return them.

## Tests

```sh
bun test src/__tests__/clerk-toolkit.test.ts
node --test skills/clerk-toolkit/test/*.test.mjs
bun run test:clerk
```

The tests cover all 20 skills, frontmatter parsing, intent selection, reference
reads, path traversal, the provider role gate, snippet fallback, a local
Streamable HTTP MCP server, SSE parsing, session headers, 401 handling, token
redaction and the read-only allowlist.

The live Clerk endpoint was probed and correctly returned HTTP 401 without a
token. No live authenticated Clerk call was made in this workspace because no
Clerk OAuth token was provided. The MCP contract is proven against the local mock
server, not against a real Clerk workspace.
