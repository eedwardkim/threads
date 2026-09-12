# Margin

A local, single-user DeepSeek chat client. Select a passage in an answer to keep a follow-up beside the idea that started it.

## Quickstart

1. Install with Node 22 LTS: `npm install`.
2. Run: `npm run dev`, then open http://localhost:3000.
3. Go live: set `DEEPSEEK_API_KEY=your-key` and `USE_MOCK=false` in `.env.local`, then restart.

No configuration or API key is needed for the default mock. The SQLite database is created, migrated, and seeded automatically at `.data/margin.sqlite`. Both environment variables are server-only; `.env.example` documents their defaults. Keep `.env.local` and `.data` private.

## Controls

- Select text in a completed main-chat answer, then choose **Reply** or press **R**.
- **Cmd/Ctrl+Enter** sends. **Stop** keeps the partial answer; **Retry** retries an incomplete answer.
- **Cmd/Ctrl+K** switches chats. **Cmd/Ctrl+F** searches the current chat and its threads.
- **Escape** clears search or closes the open panel.
- A thread's **Copy to main** control creates a separate, immutable message with the same role and text, without generating a response. Stopped responses can also be copied; the source stays unchanged.

## Verification

`npm test` runs unit tests. `npm run typecheck`, `npm run lint`, and `npm run build` check the production code.

Markdown selections are mapped at text-leaf level. Each leaf is checked against its raw source before accepting a selection. Formatting delimiters and block separators between selected leaves remain in the stored raw-markdown anchor; unsupported transformed text fails closed rather than guessing. Completed messages are immutable.

The default mock streams locally with no network model calls. Main-chat prompts exclude all thread messages. Thread briefings are frozen until you explicitly update them, and failed compression falls back to the last four main-chat messages.
