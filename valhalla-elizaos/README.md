# Project Starter

This is the starter template for ElizaOS projects.

## Valkyrie proposal-only coding

The Valhalla runtime includes a proposal-only coding action for sandboxed patch testing. It cannot approve or deploy. See `VALKYRIE-CODING.md` for configuration, role grants and the human approval path.

## Clerk toolkit

The runtime also ports Clerk's Cursor plugin: 20 bundled Clerk Agent Skills plus a read-only Clerk MCP client. It can read Clerk setup/framework/RBAC/billing/webhooks/testing guidance and read-only account data, but it cannot change Clerk applications, users, domains or production settings. See `CLERK-TOOLKIT.md`.

## Solana mint snapshots

Zeus, Cerberus and Gorgo expose the read-only `SOLANA_MINT_SNAPSHOT` action. It reads an SPL mint through Solana RPC and never signs, sends, swaps or touches a wallet.

- Each agent has its own fixed-window rate limit: 10 requests per 60 seconds by default. A limited request returns `rate_limited` with `retryAfter`, `limit` and `windowMs`; no RPC call is made.
- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to keep the counters in Upstash Redis. Counters are incremented and given a TTL atomically, so all server replicas share one budget per agent. Without those two variables, the limiter stays in-process and each replica has its own budget.
- If Redis is configured but unavailable, the action fails closed with `rate_limit_unavailable` and makes no RPC call; it does not fall back to per-replica counters. Fix the Redis connection or unset both variables to return to the in-process limiter.
- Denied requests log `mint_snapshot_rate_limited` with the agent, agent name, retry delay, limit, window and limiter backend. Redis outages log `mint_snapshot_rate_limit_unavailable` with the same agent context and retry delay.
- Set `SOLANA_MINT_RATE_LIMIT` and `SOLANA_MINT_RATE_WINDOW_MS`, or pass a `rateLimit` option when creating the plugin, to tune the limit. The limit is per agent, not global, so one agent cannot exhaust another agent's budget.
- Name and symbol are filled from the RPC's DAS `getAsset` response when available. If DAS is unavailable or returns no metadata, they are read from the mint's on-chain Metaplex Token Metadata account. The fallback does not fetch the off-chain metadata URI, so `logo` remains null in that case; a missing or unsafe logo never fails the core mint snapshot. DAS logos must be HTTPS URLs.
- Mint metadata is cached in memory for 60 seconds per plugin instance, keyed by the RPC URL and mint. Repeated snapshots still read the mint account, but skip the DAS and Metaplex metadata RPCs during the window. Empty metadata is cached too, so a token without metadata does not trigger repeated lookups. The cache is bounded to 256 entries, uses a fixed TTL, and does not persist across restarts.

## Features

- Pre-configured project structure for ElizaOS development
- Comprehensive testing setup with component and e2e tests
- Default character configuration with plugin integration
- Example service, action, and provider implementations
- TypeScript configuration for optimal developer experience
- Built-in documentation and examples

## Getting Started

```bash
# Create a new project
elizaos create --type project my-project
# Dependencies are automatically installed and built

# Navigate to the project directory
cd my-project

# Start development immediately
elizaos dev
```

## Development

```bash
# Start development with hot-reloading (recommended)
elizaos dev

# OR start without hot-reloading
elizaos start
# Note: When using 'start', you need to rebuild after changes:
# bun run build

# Test the project
elizaos test
```

## Testing

ElizaOS employs a dual testing strategy:

1. **Component Tests** (`src/__tests__/*.test.ts`)

   - Run with Bun's native test runner
   - Fast, isolated tests using mocks
   - Perfect for TDD and component logic

2. **E2E Tests** (`src/__tests__/e2e/*.e2e.ts`)
   - Run with ElizaOS custom test runner
   - Real runtime with actual database (PGLite)
   - Test complete user scenarios

### Test Structure

```
src/
  __tests__/              # All tests live inside src
    *.test.ts            # Component tests (use Bun test runner)
    e2e/                 # E2E tests (use ElizaOS test runner)
      project-starter.e2e.ts  # E2E test suite
      README.md          # E2E testing documentation
  index.ts               # Export tests here: tests: [ProjectStarterTestSuite]
```

### Running Tests

- `elizaos test` - Run all tests (component + e2e)
- `elizaos test component` - Run only component tests
- `elizaos test --type e2e` - Run only E2E tests
- `bun run test:smoke:port` - opt-in startup smoke test: starts with `PORT` set and `SERVER_PORT` unset, then checks `/health` (override the wait with `SMOKE_TIMEOUT_MS`).

### Cypress tests

- `bun run test:install` validates the declared and resolvable Cypress test packages; it does not install or modify dependencies.
- `bun run cypress:component` runs the React/Vite component tests.
- `bun run cypress:e2e` runs browser tests against the configured base URL (`http://localhost:3000` by default) and requires the app to be running there.
- `bash scripts/test-all.sh` starts the app, waits for its health endpoint, and then runs Cypress E2E tests.

### Writing Tests

Component tests use bun:test:

```typescript
// Unit test example (__tests__/config.test.ts)
describe('Configuration', () => {
  it('should load configuration correctly', () => {
    expect(config.debug).toBeDefined();
  });
});

// Integration test example (__tests__/integration.test.ts)
describe('Integration: Plugin with Character', () => {
  it('should initialize character with plugins', async () => {
    // Test interactions between components
  });
});
```

E2E tests use ElizaOS test interface:

```typescript
// E2E test example (e2e/project.test.ts)
export class ProjectTestSuite implements TestSuite {
  name = 'project_test_suite';
  tests = [
    {
      name: 'project_initialization',
      fn: async (runtime) => {
        // Test project in a real runtime
      },
    },
  ];
}

export default new ProjectTestSuite();
```

The test utilities in `__tests__/utils/` provide helper functions to simplify writing tests.

## Configuration

Customize your project by modifying:

- `src/index.ts` - Main entry point
- `src/character.ts` - Character definition

### AI room storage

The authenticated Valhalla room uses a private file-backed store by default for
local development. Production uses Supabase so the history and audit trail
survive Render restarts:

```bash
VALHALLA_ROOM_STORAGE=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
```

The service role key must only be set on the server. The room tables have RLS
enabled with no client policies, so they are not readable with the anon key.
This project's Supabase REST API exposes the `api` schema, so apply both room
migrations: `20261116220000_valhalla_room_supabase.sql` creates the private
tables and `20261116223000_valhalla_room_supabase_api_schema.sql` moves them
into `api`. The API keeps the same 200 message replay window and 2,000-entry
audit window; `seq` is allocated by the database identity columns.
