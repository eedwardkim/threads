# Threads

A multi-user AI chat client for Vercel + Supabase. Select a passage in an answer to keep a follow-up beside the idea that started it.

## Quickstart (local, same stack as production)

1. Install with Node 22 LTS: `npm install`.
2. Start local Supabase (`supabase start`, or any Postgres + Supabase Auth you own) and copy `.env.example` to `.env.local` with its URLs/keys.
3. Apply migrations once: `npm run db:migrate` (uses `DIRECT_DATABASE_URL`, falls back to `DATABASE_URL`). Migrations never run during `next build`, cold starts, or requests.
4. Run: `npm run dev`, sign up at http://localhost:3000/login, and you land directly in Threads.
5. Go live: set a provider key (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) and `USE_MOCK=false`, then restart.

There is no SQLite at runtime. `.env.example` documents every variable by name; keep `.env.local` private.

## Deployment (Vercel + Supabase)

- Region: `vercel.json` pins functions to `yul1` (Montreal), the Vercel region closest to the Supabase project in `ca-central-1`. Change both together if the database moves.
- Environment (Preview and Production scopes are configured separately, never shared): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (transaction pooler, port 6543), `DIRECT_DATABASE_URL` (session pooler/direct; only needed where migrations/imports run), provider keys, and `USE_MOCK=false`. Mock inference is refused when `VERCEL_ENV=production` unless `THREADS_ALLOW_MOCK_IN_PRODUCTION=true`.
- Supabase Auth: add the deployment origin(s) to Site URL / Redirect URLs (`https://<host>/auth/callback`). Password recovery uses `/auth/callback?next=/auth/reset`.
- Migrations: run `npm run db:migrate` from CI or a workstation against the target database *before* deploying code that needs the new schema (`npm run db:migrate:check` reports pending versions without applying). All migrations are additive and live in `db/migrations/`; existing tables in the `public` schema are untouched because Threads owns the separate `threads` schema.
- Runtime role: the migration creates the non-login, non-bypass-RLS role `threads_app` and grants it to the migrating user. Every unit of work runs `SET LOCAL ROLE threads_app` with transaction-local JWT claims, so RLS applies to all runtime queries regardless of the login user. Recommended hardening for hosted databases: create a dedicated login user and point `DATABASE_URL` at it:
  `create role threads_runtime login password '<generated>'; grant threads_app to threads_runtime;`
- Function limits: `/api/generate` declares `maxDuration = 300` and stops generation itself at 280 s so finalization always completes before the platform deadline. Verify the plan's maximum duration in the project settings; on a plan capped below 300 s, lower `maxDuration` and `deadlineMs` in `lib/generation.ts` together.

## Legacy import (SQLite → Postgres)

The original single-user database is imported explicitly, never automatically:

```
npm run db:import-sqlite -- --sqlite /path/to/threads.sqlite --user <destination auth user uuid> --dry-run
npm run db:import-sqlite -- --sqlite /path/to/threads.sqlite --user <destination auth user uuid>
```

The importer opens the source read-only (WAL-consistent), preserves ids, text, timestamps, model keys, frozen context, anchors and thread state, validates counts/foreign keys/content hashes/anchor offsets, and is idempotent (re-running reports zero new rows). Demo chats already hydrated for the destination user are matched by their demo key; the source file is never modified.

## Controls

### Temporary guests

Enable **Anonymous sign-ins** in Supabase Auth before using **Continue as guest**. Locally, set `auth.enable_anonymous_sign_ins = true` in the Supabase configuration and restart Supabase. Apply migrations `0005` and `0006` before deploying the guest UI.

Guest access expires one hour after the verified anonymous Auth account was created. Refreshing or signing in again does not extend it. Every guest database transaction checks the server-side expiry. **End guest session** deletes application data immediately and clears browser state; the anonymous Auth account and sessions are removed by the next cleanup run.

`pg_cron` runs `threads-expire-guests` every minute, including when the browser is closed. It deletes up to 500 expired anonymous accounts per run using the migration owner's scheduled database connection; an Auth deletion trigger removes their application rows under `threads_guest_manager` (non-login, non-bypass-RLS). Neither application role gets access to `auth.users`. A conversion trigger protects accounts linked to a permanent identity, including races with enrollment or cleanup. Monitor `cron.job_run_details` for failed runs or a cleanup backlog; physical deletion normally follows expiry within a minute, while access ends immediately. This retention covers Astra's database; it does not change an inference provider's retention policy.

```sql
select status, return_message, start_time from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'threads-expire-guests')
order by start_time desc limit 10;
```

- Select text in a completed main-chat answer, then choose **Reply** or press **R**.
- **Cmd/Ctrl+Enter** sends. **Stop** keeps the partial answer; **Retry** retries an incomplete answer.
- **Cmd/Ctrl+K** switches chats. **Cmd/Ctrl+F** searches the current chat and its threads.
- **Escape** clears search or closes the open panel.
- A thread's **Copy to main** control creates a separate, immutable message with the same role and text, without generating a response.

## Developer demos

Sign in and open `/dev-tools` (or press **Ctrl+Alt+D** in a chat) to show/hide the prewritten demo library. Normal sign-in does not seed demos. Previously seeded demos are hidden by default after migration `0004_demo_tools`; they are not deleted. Visibility is an owner-scoped account preference, not an administrator permission.

**Restore and show demo library** adds missing catalog entries without overwriting edits, moved chats, or follow-ups. **Show saved demos** only changes visibility, so deliberately deleted demos stay deleted. Contents still hydrate one conversation at a time. Personal folders and chats filed inside a hidden demo folder appear at the library root without changing their stored placement.

## Verification

| Command | What it covers |
| --- | --- |
| `npm test` | Unit (jsdom) and Postgres integration projects together |
| `npm run test:pg` | Postgres only: repository semantics, RLS with runtime-equivalent grants, pooled identity reset, two-user isolation, generation admission/idempotency/lease/fencing/cross-process stop, checkpoint durability, Unicode round trips, demo hydration races, importer |
| `npm run test:e2e` | Playwright acceptance (builds and serves a production build on :3100; set `E2E_BASE_URL` to test a hosted preview instead) |
| `npm run perf` | Deterministic mock load harness: 20 sessions, 10 concurrent streams, cross-instance Stop (`PERF_SECOND_BASE_URL`), browser timings; writes `perf-results/*.json` |
| `npm run typecheck`, `npm run lint`, `npm run build` | Static checks and the production build |

Postgres, e2e and perf runs need `DATABASE_URL`/`DIRECT_DATABASE_URL`, the Supabase URL/publishable key and `SUPABASE_SECRET_KEY` (test-user creation) in `.env.local`; they create fresh random owners/users and never truncate shared data. Point them only at local Supabase or a database explicitly designated for testing.

Markdown selections are mapped at text-leaf level. Each leaf is checked against its raw source before accepting a selection; unsupported transformed text fails closed rather than guessing. Completed messages are immutable (enforced by a trigger). Main-chat prompts exclude all thread messages. Thread briefings are frozen until you explicitly update them, and failed compression falls back to the last four main-chat messages.
