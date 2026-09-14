alter table threads.guest_sessions add column permanent boolean not null default false;

do $$
declare t text;
begin
  foreach t in array array['chats', 'folders', 'messages', 'threads', 'generation_jobs', 'user_state', 'rate_windows', 'usage_ledger'] loop
    execute format('alter policy %I on threads.%I using
      (owner_id in (select owner_id from threads.guest_sessions where not permanent and expires_at <= clock_timestamp()))', t || '_guest_read', t);
    execute format('alter policy %I on threads.%I using
      (owner_id in (select owner_id from threads.guest_sessions where not permanent and expires_at <= clock_timestamp()))', t || '_guest_delete', t);
  end loop;
end $$;

grant create on schema threads to threads_guest_manager;

create function threads.register_guest(auth_created_at timestamptz) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare expiry timestamptz := auth_created_at + interval '1 hour';
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('guest:' || threads.current_user_id()::text, 0));
  if expiry is null or expiry <= clock_timestamp() or auth_created_at > clock_timestamp() then return null; end if;
  insert into threads.guest_sessions (owner_id, expires_at)
    values (threads.current_user_id(), expiry) on conflict (owner_id) do nothing;
  return (select expires_at from threads.guest_sessions where owner_id = threads.current_user_id() and not permanent);
end $$;

create or replace function threads.purge_guest(guest_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('guest:' || guest_id::text, 0)) then return false; end if;
  perform 1 from threads.guest_sessions
    where owner_id = guest_id and not permanent and expires_at <= clock_timestamp() for update;
  if not found then return false; end if;
  delete from threads.chats where owner_id = guest_id;
  delete from threads.folders where owner_id = guest_id;
  delete from threads.generation_jobs where owner_id = guest_id;
  delete from threads.rate_windows where owner_id = guest_id;
  delete from threads.usage_ledger where owner_id = guest_id;
  delete from threads.user_state where owner_id = guest_id;
  return true;
end $$;

create or replace function threads.end_guest() returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('guest:' || threads.current_user_id()::text, 0));
  update threads.guest_sessions set expires_at = least(expires_at, clock_timestamp())
    where owner_id = threads.current_user_id() and not permanent;
  return threads.purge_guest(threads.current_user_id());
end $$;

create or replace function threads.cleanup_guests() returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare guest record; removed integer := 0;
begin
  for guest in select owner_id from threads.guest_sessions
    where not permanent and expires_at <= clock_timestamp() order by expires_at limit 500 loop
    if threads.purge_guest(guest.owner_id) then removed := removed + 1; end if;
  end loop;
  return removed;
end $$;

create function threads.guest_auth_lifecycle() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('guest:' || old.id::text, 0));
  if tg_op = 'DELETE' then
    update threads.guest_sessions set expires_at = least(expires_at, clock_timestamp()) where owner_id = old.id and not permanent;
    perform threads.purge_guest(old.id);
    delete from threads.guest_sessions where owner_id = old.id;
    return old;
  end if;
  insert into threads.guest_sessions (owner_id, expires_at, permanent) values (old.id, clock_timestamp(), true)
    on conflict (owner_id) do update set permanent = true;
  return new;
end $$;

alter function threads.register_guest(timestamptz) owner to threads_guest_manager;
alter function threads.purge_guest(uuid) owner to threads_guest_manager;
alter function threads.end_guest() owner to threads_guest_manager;
alter function threads.cleanup_guests() owner to threads_guest_manager;
alter function threads.guest_auth_lifecycle() owner to threads_guest_manager;
revoke create on schema threads from threads_guest_manager;
revoke all on function threads.register_guest(timestamptz), threads.purge_guest(uuid), threads.end_guest(), threads.cleanup_guests(), threads.guest_auth_lifecycle() from public;
grant execute on function threads.register_guest(timestamptz), threads.end_guest() to threads_app;

create trigger threads_guest_converted before update of is_anonymous on auth.users
  for each row when (old.is_anonymous and not new.is_anonymous)
  execute function threads.guest_auth_lifecycle();
create trigger threads_guest_deleted before delete on auth.users
  for each row when (old.is_anonymous)
  execute function threads.guest_auth_lifecycle();

select cron.schedule('threads-expire-guests', '* * * * *', $job$
  delete from auth.users where is_anonymous and id in (
    select owner_id from threads.guest_sessions
    where not permanent and expires_at <= clock_timestamp()
    order by expires_at limit 500
  );
$job$);
