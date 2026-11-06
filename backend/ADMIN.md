# Administrator notes

The public site and the Render blueprint stay at the repository root on `docs/site`. This folder is the customer API. It is not a second website and it is not applied as a Render service by the root `render.yaml`. Do not point GitHub Pages at this folder.



You create the host accounts. This repo does not contain your keys.

## Keep these private

`SESSION_SECRET`, `SETUP_MASTER_KEY`, `VALHALLA_SIGNING_PRIVATE_KEY`, `VALHALLA_LICENSE_PUBLIC_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_URL`, provider API keys, and webhook secrets.

Generate the signing key on the server with `node scripts/generate-signing-key.js`. The files stay in `backend/data` and are gitignored. Copy them into the host secret store. Do not commit them.

## Upgrade and rollback

1. Export the workspace from `GET /api/setup/export`. That file has no secrets.
2. Deploy the new build.
3. Apply `supabase/migrations/001_v35.sql` if you use Supabase.
4. To roll back, deploy the previous build and import the exported file. Restore secret values from your own backup. The export cannot restore them.

## Ollama

Use an HTTPS address you control. Localhost and plain HTTP are rejected. When that address does not answer, cloud calls run only if that provider key is stored. Otherwise the request is unavailable.

## Live trading

Live trading is not enabled. There is no transaction signer in this service.
