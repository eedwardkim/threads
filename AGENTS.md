# Threads project notes

- Use Node 22 LTS and npm. The pinned runtime is in `.nvmrc`.
- `npm install` then `npm run dev` starts the local mock without environment files or an API key.
- Verification: `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. There is no end-to-end test suite; use the browser for interaction acceptance checks.
- On this machine the system Node is newer than 22. To verify with the pinned runtime without changing the system installation, use `npm exec --yes --package=node@22.23.2 --package=npm@11.19.1 -- npm <command>`.
- SQLite lives at `.data/threads.sqlite`; initialization, migrations, and one-time seeding run automatically. Never clear this directory to reset an existing user's app. Unit tests use in-memory databases.
- Tailwind source discovery is explicitly limited to `app` and `components`. Keep generated files and SQLite writes out of the CSS dependency graph to avoid development refresh loops.
- `lib/markdown-offsets.ts` owns all source-position mapping and anchor rendering. Accept only verified raw offsets; transformed text that cannot be mapped exactly fails closed.
- Completed message content is immutable. Main and thread queries must remain strictly separated. Copying a thread message to main creates a separate, immutable snapshot.
- `lib/stream-store.ts` owns browser streams independently of mounted components. The shared concurrency switch is `lib/generation-policy.ts`.
- API model IDs belong only in `lib/models.ts`; persist stable model keys. Provider credentials and mode are server-only. The page passes only provider-status booleans to the client.
- Frozen context metadata is stripped before prompt assembly. Usage attribution must not change briefing text or prompt bytes; explicit context refresh invalidates old usage attribution.
- The DeepSeek adapter uses the AI SDK's dedicated system field for leading instructions. Later context labels remain in order as user-level data; do not disable the system-message guard. The thinking request mapping is isolated in `lib/provider.ts`.
- The local browser preview rewrites the upstream port. Its origin exception is restricted to identical loopback hosts/protocols with browser-controlled `Sec-Fetch-Site: same-origin`; ordinary cross-port `same-site` and foreign-origin requests stay rejected.
