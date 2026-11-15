# Valhalla sign-in Worker

This is the consolidated server-side auth stack from PRs #11, #24, and #27.

- **#11** supplied the emailed six-digit code, hashed-code storage, expiry, attempt limits, and the signed device cookie.
- **#24** supplied the Supabase token handoff: the Worker verifies the Supabase user against the fixed project and accepts only a Google identity.
- **#27** supplied the Durable Object session store, one-time nonces, access/device session separation, revocation, and the preview-only family demo.

The browser gate from #24 and #27 is deliberately not copied. On `develop`, `/app` redirects to `/` and the public entrance uses `website/supabase.js` with the official Supabase SDK. Reintroducing the old gate would revive a retired UI and create a second sign-in path. The Worker is the server-side half that the current Supabase entrance can call once the OS session handoff is wired in a separate change.

## Endpoints

- `GET /auth/supabase` returns the origin-bound callback and a one-time nonce.
- `POST /auth/supabase` verifies the Supabase access token, checks the Google identity, and creates or resumes the Worker session. A new device can require an emailed code.
- `POST /auth/email/start` sends a code. `POST /auth/email/verify` consumes it once.
- `GET /auth/access` reports plan and owner status for the signed access session.
- `POST /auth/leader`, `/auth/chat-config`, `/auth/engagement`, and `/auth/security` keep their existing owner/consent checks.
- `GET /auth/devices` and `POST /auth/devices/revoke` list and revoke remembered devices.
- `POST /auth/demo` is hidden unless both preview flags and the demo verifier are configured.

## Configuration

Copy `auth.toml` into the deployment pipeline and set these values outside the repository:

- `DEVICE_COOKIE_SECRET` — long random HMAC secret.
- `SUPABASE_ANON_KEY` — the public publishable key for the fixed Supabase project.
- `LEADER_EMAIL` — the Google-authenticated owner mailbox. Unset disables owner access.
- `RESEND_API_KEY` — optional fallback when Cloudflare Email Sending is unavailable.
- `AUTH_KV` — KV namespace id, already recorded in `auth.toml`.
- `AUTH_DO` — Durable Object binding, already recorded in `auth.toml`.

Preview-only demo variables are listed in `auth.toml`. Do not set them on the production Worker. Never put any of these secrets in `website/site-config.js`.

The Worker refuses to start without `AUTH_KV`, `DEVICE_COOKIE_SECRET`, and `GOOGLE_CLIENT_ID`. Supabase verification additionally requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

## Tests

```sh
node --test workers/*.test.mjs
```

The suite covers Supabase host, user-id, callback and nonce checks; Google-only identity; code expiry, replay and attempt limits; device revocation and idle expiry; owner step-up; and the preview demo's lockout.
