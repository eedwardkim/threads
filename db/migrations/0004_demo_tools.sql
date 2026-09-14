alter table threads.user_state
  add column if not exists demo_enabled boolean not null default false;
