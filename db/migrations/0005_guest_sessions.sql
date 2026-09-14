create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'threads_guest_manager') then
    create role threads_guest_manager nologin nobypassrls noinherit;
  end if;
end $$;
grant threads_guest_manager to current_user;
grant usage on schema threads to threads_guest_manager;

create table threads.guest_sessions (
  owner_id uuid primary key,
  expires_at timestamptz not null
);
create index guest_sessions_expiry_idx on threads.guest_sessions (expires_at);
alter table threads.guest_sessions enable row level security;
create policy guest_owner_read on threads.guest_sessions for select to threads_app
  using (owner_id = threads.current_user_id());
create policy guest_manager_all on threads.guest_sessions for all to threads_guest_manager
  using (true) with check (true);
grant select on threads.guest_sessions to threads_app;
grant select, insert, update, delete on threads.guest_sessions to threads_guest_manager;

do $$
declare t text;
begin
  foreach t in array array['chats', 'folders', 'messages', 'threads', 'generation_jobs', 'user_state', 'rate_windows', 'usage_ledger'] loop
    execute format('grant select, delete on threads.%I to threads_guest_manager', t);
    execute format('create policy %I on threads.%I for select to threads_guest_manager using
      (owner_id in (select owner_id from threads.guest_sessions where expires_at <= clock_timestamp()))', t || '_guest_read', t);
    execute format('create policy %I on threads.%I for delete to threads_guest_manager using
      (owner_id in (select owner_id from threads.guest_sessions where expires_at <= clock_timestamp()))', t || '_guest_delete', t);
  end loop;
end $$;
