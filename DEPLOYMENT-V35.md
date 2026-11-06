# Valhalla V35 deployment readiness

## Current deployment boundaries

The public website is a static GitHub Pages site built from `site-build` by `.github/workflows/pages.yml` on `docs/site`. Render hosts the separate ElizaOS backend; the frontend must not be switched to Vercel or have its production DNS changed as part of this deployment.

The ElizaOS runtime is for health reporting and simulated/paper workflows only. It must not store wallet private keys, sign transactions, submit trades, or autonomously post to social accounts. Trading, social dispatch, private-key storage, and Zeus idle jobs are explicitly off by default.

## Local setup

1. Use Node.js 23.3 or newer and Bun, as required by the current ElizaOS CLI.
2. Run `bash setup.sh` on macOS/Linux or `.\setup.ps1` on Windows. The scripts use `npm ci --legacy-peer-deps` with the root lockfile, then `bun install --frozen-lockfile` and the ElizaOS TypeScript check. Install Node.js and Bun before running them; they do not make system-wide runtime changes.
3. Copy `.env.production.example` into the deployment provider's secret manager. Never commit populated environment files.
4. Run `npm run build` and `npm test` from the repository root.
5. Apply `supabase/migrations/20261105000000_valhalla_v35_foundation.sql` only after linking the intended Supabase project and reviewing the migration.

The ElizaOS `start` command validates its environment before launch. Production requires at least one configured model-provider key; Supabase and Upstash REST URL/token pairs must be complete when used, and unsupported trading, key-storage, social-dispatch, and Zeus idle-job switches must remain disabled. Redis and Supabase are optional integrations and are not represented as connected merely because a URL is configured.

The database policies use Supabase's authenticated `auth.uid()` claim, not an email address supplied by a client. Vault audit records are service-role-only. The service-role key must never be exposed to a browser.

## Hosting setup

- **GitHub Pages:** `.github/workflows/pages.yml` publishes the static website from `docs/site`. It does not deploy Workers or the ElizaOS runtime.
- **Render:** `render.yaml` describes a separate Docker service with auto-deploy disabled and the ElizaOS `/health` check. Its free plan may sleep when idle and is not suitable for an always-on production service. The runtime exposes read-only Zeus and Gorgo agent definitions; these are not authenticated admin access or per-user sandboxes.
- **Queue:** the root service includes an opt-in BullMQ worker for allow-listed health and paper-simulation jobs. It is disabled by default and requires a TLS `REDIS_URL` plus a server-only `VALHALLA_DISPATCH_TOKEN`; the dispatch endpoint does not accept an email header as identity. Treasury, signing, trading, arbitrary execution, and social jobs are rejected or blocked. This does not authenticate a browser user as the owner; owner authentication remains in the verified Google-plus-code Worker flow.
- **Model providers:** the ElizaOS runtime loads the OpenAI and Google GenAI plugins only when their corresponding API keys are set. No social plugins, wallet integrations, or transaction executors are installed.
- **Supabase:** provision and link the intended project before applying the migration.
- **Upstash and model providers:** credentials in `.env.production.example` are blank. Add only the provider credentials the configured agent actually uses.

Configure `MASTER_ADMIN_EMAIL` and `LEADER_EMAIL` as matching server-side secrets; do not hardcode the owner address in public source. Owner operations still require a server-verified Google identity and sign-in code. An email-only login or client-supplied header does not grant owner access.

Run `npm run validate:env` to check production secrets and the server-side owner email allowlist before release. It never authenticates an HTTP request; the existing Google verification and second-factor flow remains the admin authorization boundary. The validator and deployment scripts are excluded from GitHub Pages output.

## Hosts

The public site stays on GitHub Pages from this branch. Render stays the default app host in `render.yaml`, with auto-deploy left off. The personal Vercel account `tokenjunction` is on the Hobby plan and `excessBillingEnabled` is false. Do not use the TokenJunction team. A personal Vercel preview is optional later and is not required. Future modules must fit a Hobby account: no paid add-ons and no assumption of an always-on server. Model calls use the customer's own key and quota. The status text is "Your provider, your quota". A free Valhalla seat does not make a provider free.

`docs/site` and `develop` have no merge base. This branch starts at `3079186aa8eca791740d422fb6251afd49c1190e`. Commit `47a70d414833d182eeeec76237242acc363c7296` on `feat/supabase-redis-health` was not merged. It rewrites the public homepage and adds an OpenRouter model ladder. The Supabase and Redis health work is already in the `docs/site` history.

## Customer API beside this site

`backend/` is the tested customer API for a deployment the customer hosts. The root `render.yaml` does not start it, and `scripts/build-site.py` does not copy it into the GitHub Pages output. The site process can answer `GET /api/odin` and `GET /api/substrate` with an unavailable status when no workspace key is configured. It does not replace sign-in, and it does not claim that a sleeping computer ran a model. Ollama is accepted only as an HTTPS address that is not localhost. Marketplace payouts, Hive rewards, custody, and live trading stay unavailable. The Motoko sample in `experiments/motoko` is not this runtime.

## Not included in this deployment

No Supabase, Render, Vercel, or Upstash resources are provisioned by this repository. No production API keys, OAuth redirect changes, signing keys, transaction executor, X/Twitter dispatcher, or automated social-posting credentials are configured. Financial chart views must use real, labeled source data; placeholder or simulated values must not be presented as live P&L.

The Render service is not production-ready until its required secrets and model credentials are supplied, a deployment is explicitly initiated, and its health endpoint is verified. No periodic pinger is used to defeat host idle behavior; continuous operation requires an appropriate always-on Render plan and separately provisioned Redis. The runtime reports capabilities as disabled; it does not implement trading, key storage, social dispatch, per-user sandbox provisioning, or Zeus idle jobs.
