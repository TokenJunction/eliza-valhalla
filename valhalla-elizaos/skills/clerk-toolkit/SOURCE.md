# Source and port notes

- Upstream plugin: `clerk/cursor-plugin`, version 0.2.1, MIT.
  - Manifest: `.cursor-plugin/plugin.json`
  - MCP config: `mcp.json` → `https://mcp.clerk.com/mcp`
- Upstream skills: `clerk/skills`, commit
  `a02dbd2a933b8929525129a6cb9dcf6ed66d0adf` (2026-10-07), MIT.
  - Vendored verbatim under `skills/clerk-toolkit/skills/`.
  - Every `SKILL.md`, reference, template and eval file is included; the
    upstream `.git` metadata is not.
- License: see `LICENSE` (Clerk, Inc., MIT).
- Ported runtime pieces:
  - `lib.mjs` — catalog/frontmatter reader, intent selector, skill reader,
    Streamable HTTP MCP client, read-only tool allowlist.
  - `cli.mjs` — local skill browser and read-only MCP diagnostic CLI.
  - `src/clerk-toolkit.ts` — ElizaOS provider and actions.

The upstream Cursor plugin has no executable code of its own. It is a manifest
that points Cursor at the MCP endpoint and the skills directory. This port keeps
the same split: skills are local documents, and MCP is the only network surface.

Clerk MCP details verified against the published documentation:

- Transport: Streamable HTTP only (SSE-only transport is not supported).
- Authentication: OAuth bearer token. Unauthenticated `initialize` returns HTTP
  401 with `WWW-Authenticate` and scopes `user:org:read applications:read
  applications:manage users:read users:manage application_domains:read
  application_domains:manage`.
- Read-only tools: `clerk_sdk_snippet`, `list_clerk_sdk_snippets`, `whoami`,
  `list_applications`, `get_application`, `get_instance_config`,
  `get_instance_config_schema`, `list_users`, `list_domains`,
  `get_domain_status`, `get_deploy_oauth_providers`,
  `list_application_feedback`.
- Mutating tools blocked by this port: `create_application`,
  `patch_instance_config`, `put_instance_config`, `create_user`,
  `check_domain_dns`, `create_production_instance`,
  `set_oauth_provider_credentials`, `submit_feedback`, `get_more_tools`.

`submit_feedback` and `get_more_tools` send data to Clerk, so they are treated as
writes and are not available to the Valkyries.
