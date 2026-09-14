-- Threads: multi-user Postgres schema.
-- Everything lives in the dedicated "threads" schema so that pre-existing objects in "public"
-- (including legacy tables from earlier deployments) are never touched or exposed through the Data API.

create schema if not exists threads;

-- Runtime role. The application connects with the configured database user and switches to this
-- role for the duration of each unit of work (SET LOCAL ROLE), so row-level security is enforced on
-- every runtime query. The role never logs in directly and never bypasses RLS.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'threads_app') then
    create role threads_app nologin nobypassrls noinherit;
  end if;
end $$;

grant threads_app to current_user;
grant usage on schema threads to threads_app;

-- Identity comes from a transaction-local setting written by the application layer after verifying
-- the Supabase session server-side. PostgREST uses the same setting name, so the policies also hold
-- if these tables are ever exposed through the Data API.
create or replace function threads.current_user_id() returns uuid
language sql stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create table if not exists threads.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists threads.user_state (
  owner_id uuid primary key,
  demo_seed_key text,
  created_at bigint not null
);

create table if not exists threads.folders (
  id text primary key,
  owner_id uuid not null,
  name text not null,
  parent_id text,
  created_at bigint not null,
  sort_order integer not null default 0,
  demo_key text,
  constraint folders_name_nonempty check (length(name) > 0),
  constraint folders_id_owner_unique unique (id, owner_id),
  constraint folders_demo_key_unique unique (owner_id, demo_key),
  constraint folders_parent_fk foreign key (parent_id, owner_id) references threads.folders (id, owner_id) on delete cascade
);
create index if not exists folders_owner_parent_sort_idx on threads.folders (owner_id, parent_id, sort_order, created_at);

create table if not exists threads.chats (
  id text primary key,
  owner_id uuid not null,
  title text not null,
  folder_id text,
  created_at bigint not null,
  demo_key text,
  constraint chats_id_owner_unique unique (id, owner_id),
  constraint chats_demo_key_unique unique (owner_id, demo_key),
  -- Composite owner FK: deleting a folder clears only the nullable relationship, never the owner.
  constraint chats_folder_fk foreign key (folder_id, owner_id) references threads.folders (id, owner_id) on delete set null (folder_id)
);
create index if not exists chats_owner_created_idx on threads.chats (owner_id, created_at desc, id desc);
create index if not exists chats_owner_folder_idx on threads.chats (owner_id, folder_id);

create table if not exists threads.messages (
  id text primary key,
  owner_id uuid not null,
  chat_id text not null,
  thread_id text,
  role text not null,
  content text not null,
  model_key text,
  complete boolean not null default true,
  input_tokens integer,
  output_tokens integer,
  created_at bigint not null,
  attempt integer not null default 0,
  constraint messages_id_owner_unique unique (id, owner_id),
  constraint messages_id_chat_unique unique (id, chat_id),
  constraint messages_role_check check (role in ('user', 'assistant')),
  constraint messages_model_key_check check (model_key is null or model_key in ('fast', 'thinking', 'opus', 'sonnet', 'haiku', 'gpt-5', 'gpt-5-mini')),
  constraint messages_input_tokens_check check (input_tokens is null or input_tokens >= 0),
  constraint messages_output_tokens_check check (output_tokens is null or output_tokens >= 0),
  constraint messages_attempt_check check (attempt >= 0),
  constraint messages_chat_fk foreign key (chat_id, owner_id) references threads.chats (id, owner_id) on delete cascade
);

create table if not exists threads.threads (
  id text primary key,
  owner_id uuid not null,
  chat_id text not null,
  parent_message_id text not null,
  anchor_start integer not null,
  anchor_end integer not null,
  anchor_exact text not null,
  compressed_context text,
  context_frozen_at bigint,
  source text not null default 'user',
  resolved boolean not null default false,
  title text not null,
  created_at bigint not null,
  constraint threads_id_owner_unique unique (id, owner_id),
  constraint threads_id_chat_unique unique (id, chat_id),
  constraint threads_anchor_bounds_check check (anchor_start >= 0 and anchor_end > anchor_start),
  constraint threads_source_check check (source = 'user'),
  constraint threads_compressed_context_check check (compressed_context is null or pg_input_is_valid(compressed_context, 'jsonb')),
  constraint threads_chat_fk foreign key (chat_id, owner_id) references threads.chats (id, owner_id) on delete cascade,
  -- The parent must be a message of the same chat; an ID existing elsewhere is not sufficient.
  constraint threads_parent_fk foreign key (parent_message_id, chat_id) references threads.messages (id, chat_id) on delete cascade
);
create index if not exists threads_owner_chat_created_idx on threads.threads (owner_id, chat_id, created_at, id);
create index if not exists threads_parent_anchor_idx on threads.threads (parent_message_id, anchor_start, anchor_end);

alter table threads.messages drop constraint if exists messages_thread_fk;
alter table threads.messages add constraint messages_thread_fk
  foreign key (thread_id, chat_id) references threads.threads (id, chat_id) on delete cascade;
create index if not exists messages_owner_scope_created_idx on threads.messages (owner_id, chat_id, thread_id, created_at, id);
create index if not exists messages_thread_idx on threads.messages (thread_id);
create index if not exists messages_owner_created_idx on threads.messages (owner_id, created_at desc);

-- Completed message source is immutable at the database boundary.
create or replace function threads.protect_completed_message() returns trigger
language plpgsql
as $$
begin
  if old.complete then
    if new.content is distinct from old.content or new.complete is distinct from true
       or new.role is distinct from old.role or new.chat_id is distinct from old.chat_id
       or new.thread_id is distinct from old.thread_id or new.created_at is distinct from old.created_at
       or new.model_key is distinct from old.model_key or new.owner_id is distinct from old.owner_id then
      raise exception 'Completed message content cannot be changed.' using errcode = 'check_violation', constraint = 'messages_completed_immutable';
    end if;
  end if;
  if new.owner_id is distinct from old.owner_id or new.chat_id is distinct from old.chat_id or new.role is distinct from old.role then
    raise exception 'Message scope cannot be changed.' using errcode = 'check_violation', constraint = 'messages_scope_immutable';
  end if;
  return new;
end $$;

drop trigger if exists messages_protect_completed on threads.messages;
create trigger messages_protect_completed before update on threads.messages
  for each row execute function threads.protect_completed_message();

-- Durable generation coordination shared by every server instance.
create sequence if not exists threads.generation_fence_seq;

create table if not exists threads.generation_jobs (
  id uuid primary key,
  owner_id uuid not null,
  kind text not null default 'generation',
  chat_id text not null,
  thread_id text,
  scope_key text not null,
  payload_hash text not null,
  status text not null,
  message_id text,
  user_message_id text,
  attempt integer not null default 0,
  fence bigint not null default nextval('threads.generation_fence_seq'),
  lease_expires_at bigint not null,
  cancel_requested boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  finished_at bigint,
  error_code text,
  constraint generation_jobs_kind_check check (kind in ('generation', 'context')),
  constraint generation_jobs_status_check check (status in ('running', 'completed', 'stopped', 'failed', 'expired')),
  constraint generation_jobs_chat_fk foreign key (chat_id, owner_id) references threads.chats (id, owner_id) on delete cascade
);
create unique index if not exists generation_jobs_active_scope_idx on threads.generation_jobs (owner_id, scope_key) where status = 'running';
create index if not exists generation_jobs_owner_status_idx on threads.generation_jobs (owner_id, status, lease_expires_at);
create index if not exists generation_jobs_running_idx on threads.generation_jobs (status, lease_expires_at) where status = 'running';

-- Bounded overall concurrency needs a cross-owner count, exposed only through this function.
create or replace function threads.count_running_jobs(now_ms bigint) returns integer
language sql stable security definer set search_path = threads, pg_temp
as $$
  select count(*)::integer from threads.generation_jobs where status = 'running' and lease_expires_at > now_ms
$$;
revoke all on function threads.count_running_jobs(bigint) from public;
grant execute on function threads.count_running_jobs(bigint) to threads_app;

create table if not exists threads.rate_windows (
  owner_id uuid not null,
  window_start bigint not null,
  requests integer not null default 0,
  primary key (owner_id, window_start)
);

create table if not exists threads.usage_ledger (
  owner_id uuid not null,
  day date not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  requests integer not null default 0,
  primary key (owner_id, day)
);

-- Row-level security: every user-data table is owner-scoped, including write checks.
do $$
declare
  t text;
begin
  foreach t in array array['folders', 'chats', 'messages', 'threads', 'generation_jobs', 'rate_windows', 'usage_ledger'] loop
    execute format('alter table threads.%I enable row level security', t);
    execute format('drop policy if exists %I on threads.%I', t || '_owner_select', t);
    execute format('drop policy if exists %I on threads.%I', t || '_owner_insert', t);
    execute format('drop policy if exists %I on threads.%I', t || '_owner_update', t);
    execute format('drop policy if exists %I on threads.%I', t || '_owner_delete', t);
    execute format('create policy %I on threads.%I for select to threads_app using (owner_id = threads.current_user_id())', t || '_owner_select', t);
    execute format('create policy %I on threads.%I for insert to threads_app with check (owner_id = threads.current_user_id())', t || '_owner_insert', t);
    execute format('create policy %I on threads.%I for update to threads_app using (owner_id = threads.current_user_id()) with check (owner_id = threads.current_user_id())', t || '_owner_update', t);
    execute format('create policy %I on threads.%I for delete to threads_app using (owner_id = threads.current_user_id())', t || '_owner_delete', t);
  end loop;
end $$;

alter table threads.user_state enable row level security;
drop policy if exists user_state_owner_all on threads.user_state;
create policy user_state_owner_all on threads.user_state for all to threads_app
  using (owner_id = threads.current_user_id()) with check (owner_id = threads.current_user_id());

grant select, insert, update, delete on threads.folders, threads.chats, threads.messages, threads.threads,
  threads.generation_jobs, threads.rate_windows, threads.usage_ledger, threads.user_state to threads_app;
grant usage on sequence threads.generation_fence_seq to threads_app;

-- Supabase grants anon/authenticated/service_role broad default privileges on new objects in exposed
-- schemas. Nothing in this schema may be reachable through the public Data API.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema threads from %I', r);
      execute format('revoke all on all sequences in schema threads from %I', r);
      execute format('revoke all on all functions in schema threads from %I', r);
      execute format('revoke usage on schema threads from %I', r);
    end if;
  end loop;
end $$;
