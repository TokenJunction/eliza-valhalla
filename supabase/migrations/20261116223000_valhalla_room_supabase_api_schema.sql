-- The ValhallaOS Supabase project exposes the `api` schema through PostgREST
-- (not `public`). Move the private room tables there so the server can reach
-- them without changing the project's exposed schemas. The tables are still
-- RLS-protected with no policies, and only the service role receives access.

alter table public.valhalla_room_messages set schema api;
alter table public.valhalla_room_audit set schema api;

grant usage on schema api to service_role;

grant select, insert, update, delete
  on table api.valhalla_room_messages to service_role;
grant select, insert, update, delete
  on table api.valhalla_room_audit to service_role;
grant usage, select
  on sequence api.valhalla_room_messages_seq_seq to service_role;
grant usage, select
  on sequence api.valhalla_room_audit_seq_seq to service_role;

revoke all on table api.valhalla_room_messages from anon, authenticated;
revoke all on table api.valhalla_room_audit from anon, authenticated;
revoke all on sequence api.valhalla_room_messages_seq_seq from anon, authenticated;
revoke all on sequence api.valhalla_room_audit_seq_seq from anon, authenticated;

comment on table api.valhalla_room_messages is
  'Append-only Valhalla AI room history. The API serves the latest 200 rows and allocates seq via identity.';
comment on table api.valhalla_room_audit is
  'Append-only Valhalla AI room audit trail. Never contains message text or member keys.';

-- Ask PostgREST to refresh its schema cache immediately after the move.
notify pgrst, 'reload schema';
