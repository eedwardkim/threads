-- Image attachments. Bytes live in Postgres next to the conversation so the same owner-scoped RLS
-- protects them; images are bounded by the API (dimensions and size) before insertion.
-- `message_id` is null while the upload sits in the composer and is set atomically when the message is
-- sent. `digest` caches the one-time structured visual description used for text-only models and for
-- older turns, so an image is only ever interpreted once.
create table if not exists threads.attachments (
  id text primary key,
  owner_id uuid not null,
  chat_id text not null,
  message_id text,
  name text not null,
  media_type text not null,
  width integer not null,
  height integer not null,
  byte_size integer not null,
  sha256 text not null,
  data bytea not null,
  digest text,
  digest_model text,
  created_at bigint not null,
  constraint attachments_id_owner_unique unique (id, owner_id),
  constraint attachments_name_nonempty check (length(name) > 0),
  constraint attachments_media_type_check check (media_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  constraint attachments_dimensions_check check (width > 0 and height > 0 and width <= 8192 and height <= 8192),
  constraint attachments_size_check check (byte_size > 0 and byte_size = length(data) and byte_size <= 6291456),
  constraint attachments_chat_fk foreign key (chat_id, owner_id) references threads.chats (id, owner_id) on delete cascade,
  constraint attachments_message_fk foreign key (message_id, chat_id) references threads.messages (id, chat_id) on delete cascade
);
create index if not exists attachments_owner_message_idx on threads.attachments (owner_id, message_id, created_at, id);
create index if not exists attachments_owner_chat_pending_idx on threads.attachments (owner_id, chat_id, created_at) where message_id is null;

-- Once attached, an image belongs to that message for good; only the cached digest may change.
create or replace function threads.protect_attachment() returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id or new.chat_id is distinct from old.chat_id
     or new.data is distinct from old.data or new.sha256 is distinct from old.sha256
     or new.media_type is distinct from old.media_type or new.width is distinct from old.width
     or new.height is distinct from old.height or new.created_at is distinct from old.created_at
     or (old.message_id is not null and new.message_id is distinct from old.message_id) then
    raise exception 'Attachment content cannot be changed.' using errcode = 'check_violation', constraint = 'attachments_immutable';
  end if;
  return new;
end $$;

drop trigger if exists attachments_protect on threads.attachments;
create trigger attachments_protect before update on threads.attachments
  for each row execute function threads.protect_attachment();

alter table threads.attachments enable row level security;
drop policy if exists attachments_owner_select on threads.attachments;
drop policy if exists attachments_owner_insert on threads.attachments;
drop policy if exists attachments_owner_update on threads.attachments;
drop policy if exists attachments_owner_delete on threads.attachments;
create policy attachments_owner_select on threads.attachments for select to threads_app using (owner_id = threads.current_user_id());
create policy attachments_owner_insert on threads.attachments for insert to threads_app with check (owner_id = threads.current_user_id());
create policy attachments_owner_update on threads.attachments for update to threads_app using (owner_id = threads.current_user_id()) with check (owner_id = threads.current_user_id());
create policy attachments_owner_delete on threads.attachments for delete to threads_app using (owner_id = threads.current_user_id());

grant select, insert, update, delete on threads.attachments to threads_app;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on threads.attachments from %I', r);
    end if;
  end loop;
end $$;
