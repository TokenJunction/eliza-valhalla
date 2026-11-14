-- Customer map for the Valhalla device sign-in.
-- The device token does not set auth.uid(). Do not use that claim as proof of this sign-in.
-- Only the backend service role may read or insert rows.
-- A row is one personal customer. It is not an admin grant and it stores no leader secret.

create table if not exists public.customer_identity (
  customer_id uuid primary key default gen_random_uuid(),
  tenant text not null default 'valhalla' check (tenant = 'valhalla'),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (tenant, email_hash)
);

alter table public.customer_identity enable row level security;

revoke all on table public.customer_identity from public, anon, authenticated;
grant select, insert on table public.customer_identity to service_role;

drop policy if exists customer_identity_service_select on public.customer_identity;
create policy customer_identity_service_select on public.customer_identity
  for select to service_role
  using (true);

drop policy if exists customer_identity_service_insert on public.customer_identity;
create policy customer_identity_service_insert on public.customer_identity
  for insert to service_role
  with check (true);
