-- Model keys are validated by the application registry (lib/models.ts). The database only enforces the
-- key format so adding a model no longer requires a schema migration.
alter table threads.messages drop constraint if exists messages_model_key_check;
alter table threads.messages
  add constraint messages_model_key_check check (model_key is null or model_key ~ '^[a-z0-9][a-z0-9.-]{0,63}$');
