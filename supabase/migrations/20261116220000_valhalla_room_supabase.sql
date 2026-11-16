-- Private storage for the authenticated Valhalla AI room.
--
-- The room API is the only writer. These tables are never exposed to the
-- browser: RLS is enabled with no policies, and the anon/authenticated roles
-- have no table or sequence privileges. The Render service uses the service
-- role key, which bypasses RLS.

create table public.valhalla_room_messages (
  id uuid primary key,
  seq bigint generated always as identity unique,
  room_id text not null
    check (room_id = 'valhalla:private:zeus-cerberus-gorgo'),
  member text not null
    check (member in ('zeus', 'cerberus', 'gorgo')),
  text text not null
    check (char_length(text) between 1 and 2000),
  at timestamptz not null,
  reply_to uuid,
  constraint valhalla_room_messages_reply_to_fk
    foreign key (reply_to) references public.valhalla_room_messages (id)
);

create index valhalla_room_messages_room_seq_idx
  on public.valhalla_room_messages (room_id, seq desc);

create table public.valhalla_room_audit (
  id uuid primary key,
  seq bigint generated always as identity unique,
  at timestamptz not null,
  room_id text not null
    check (room_id = 'valhalla:private:zeus-cerberus-gorgo'),
  member text not null
    check (member in ('zeus', 'cerberus', 'gorgo')),
  event text not null
    check (event in (
      'message_sent',
      'message_rejected',
      'messages_read',
      'audit_read',
      'rate_limited'
    )),
  outcome text not null
    check (outcome in ('allowed', 'rejected')),
  reason text,
  field text,
  message_id uuid,
  message_seq bigint,
  details jsonb,
  constraint valhalla_room_audit_details_object
    check (details is null or jsonb_typeof(details) = 'object')
);

create index valhalla_room_audit_room_seq_idx
  on public.valhalla_room_audit (room_id, seq desc);

alter table public.valhalla_room_messages enable row level security;
alter table public.valhalla_room_audit enable row level security;

revoke all on table public.valhalla_room_messages from anon, authenticated;
revoke all on table public.valhalla_room_audit from anon, authenticated;
revoke all on sequence public.valhalla_room_messages_seq_seq from anon, authenticated;
revoke all on sequence public.valhalla_room_audit_seq_seq from anon, authenticated;

comment on table public.valhalla_room_messages is
  'Append-only Valhalla AI room history. The API serves the latest 200 rows and allocates seq via identity.';
comment on table public.valhalla_room_audit is
  'Append-only Valhalla AI room audit trail. Never contains message text or member keys.';
