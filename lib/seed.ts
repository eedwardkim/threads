import type { ChatRepository } from "./db/repository";
import type { ModelKey } from "./models";

export const SEED_TITLE = "Design a local-first knowledge base";

export const SEED_PRELUDE = `## Begin with the experience, not the sync protocol

A knowledge base should feel like a room you can enter at any time. Opening a note, following a link, and finding yesterday's thought should work on a train, during a service outage, or years after a subscription ends. That is a useful starting point because it turns “local first” from a slogan into a set of observable promises.

The device holds a complete working copy. The network distributes changes, but it does not grant permission to read or write. Without it, the collection stays intelligible and exportable.

### Three guarantees worth writing down

1. **A saved edit is durable on this device.** The interface says saved after a local transaction commits, not after a request enters an in-memory queue.
2. **Ordinary reads require no connection.** Documents, links, and search results come from local data. A stale sync badge does not make a note unavailable.
3. **Unfinished delivery survives a restart.** The application can explain which changes are pending and resume them without relying on the original process.

These guarantees do not require every device to agree immediately. Agreement takes time. A reliable editor can remain useful while another device is offline, provided its sync status is honest.

### Make SQLite the center of gravity

Start with tables for notes, links, and pending operations. Keep note bodies in an ordinary, documented format such as Markdown. Store stable IDs separately from titles so renaming a page does not break backlinks. Add the indexes required by actual screens: recent notes, incoming links, and due outbox work.

SQLite gives the local application a concrete commit boundary. A transaction can update a note and record the operation that should deliver it elsewhere. Both changes become durable together, or neither does. That is much easier to reason about than coordinating a document file, a search cache, and an in-memory request queue independently.

Use a thin repository with named operations: saveNote, listBacklinks, and listDueOperations. Keep the SQL close enough that someone can inspect each transaction and see what it protects.

### Distinguish content from projections

The note body is primary data. A search index, a rendered preview, and a list of extracted links are derived views. This distinction gives you a recovery strategy: preserve the content carefully, and make the projections cheap enough to rebuild.

Update small link and search projections in the save transaction. If indexing becomes expensive, use a durable indexing job, not a callback lost on exit. A user should not need to edit a document merely to make it searchable again.

### Give identity a longer life than a title

Allocate a note ID once, on the device that creates it. A random UUID is a reasonable note identity; determinism is more useful for operation IDs, which can be derived from a persistent device ID and a transactional sequence. Keep those two concepts separate.

A retry is the same operation happening again, while a new edit is a new operation on the same note. Persist both identities. Do not generate another operation ID when a request times out, and do not identify notes by a hash of their changing content. Titles, paths, and timestamps should remain attributes that can change without breaking references.

### Let synchronization be a small worker

The worker reads due outbox rows, sends one bounded batch, and commits acknowledgements locally. It starts on application launch and wakes periodically, so a missed notification cannot strand an edit. Network availability is a useful hint to try sooner, not a proof that a request will succeed.

A first version can use one worker and preserve order for each note. Persist attempt counts, next-attempt times, and a safe error category. Reserve a visible needs-attention state for conflicts or expired credentials. An endless spinner hides information that a calm status label could explain.

### Choose an honest collaboration boundary

For a single person on several devices, begin with revision checks and an explicit conflict copy. If two devices edit the same base revision, keep both texts and ask for a choice. Silent last-write-wins looks simple in code but can make an important paragraph disappear.

A CRDT may be worthwhile for simultaneous rich-text collaboration. It is not required for offline search or durable saves. Let collaboration requirements determine the editing model, not the reverse.

### Build one complete path first

Create a note while disconnected. Close the application completely, reopen it, search for a phrase, and follow a link into the note. Then reconnect and confirm that pending work drains without changing the visible content. Repeat with a deliberately lost acknowledgement.

This small journey tests the architecture more honestly than a diagram of services. Once it works, add export and restore, observe query timings with a realistic collection, and document the few invariants the code must preserve. The best first design is one whose failure behavior you can explain without opening six dashboards.`;

export const SEED_RELIABILITY = `## Treat interruption as an ordinary execution path

“Did the save work?” hides two questions: did the device commit the edit, and did another machine accept it? Separate those answers to make crashes and retries understandable.

### The local transaction is the first boundary

Validate the note, then open a short write transaction. Check its expected revision, reserve the next device-scoped operation sequence, update the note, and insert an immutable outbox payload. Commit before notifying the UI or scheduling network work.

If the app stops before the commit, SQLite rolls the transaction back. If it stops afterward, the note and pending operation both remain. A wake-up callback may be lost, but the intent is not. Startup recovery simply asks the database for due work again.

\`\`\`typescript
type OutboxEntry = {
  id: string;
  noteId: string;
  baseRevision: number;
  payload: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};
\`\`\`

The payload is a snapshot of the operation, not a pointer to whatever the note contains tomorrow. If a user makes another edit while the first one is in flight, that edit gets its own operation. Reusing the first ID with different bytes would make receiver-side deduplication ambiguous.

### A timeout means unknown, not rejected

Imagine the server applies an operation, commits, and loses its connection before the reply reaches the client. Retrying is necessary, but applying the edit twice is not. The receiver should record the operation ID and its result in the same transaction as the mutation, then return the stored result on a duplicate request.

This is an exactly-once effect over at-least-once delivery, not a promise that packets arrive once. An idempotent receiver makes retries safe; a confident client cannot make the network reliable by assumption.

### Retry classes, not every error

- **Temporary transport failures:** retry with capped exponential backoff and jitter.
- **Rate limits:** honor the retry window before adding another attempt.
- **Expired authentication:** pause delivery and ask for sign-in without blocking editing.
- **Revision conflicts:** preserve the competing versions and require a resolution path.
- **Invalid operations:** retain enough metadata to diagnose the problem instead of looping forever.

Persist the next attempt time so restarting does not hammer the endpoint. Cap the backoff and allow deliberate resumption. Pressing Retry schedules the existing operation; it must not invent a new identity.

### Preserve order where order has meaning

Deliver dependent revisions in order for each note. A conflict blocks that note, not the entire collection. Begin with small batches and one worker before adding concurrent claims and expiring leases.

Acknowledge receipts in a local transaction. If the app stops before that commit, delivery repeats and the server returns the same receipt. Cover this boundary with a test rather than relying on a worker author's memory.

### A compact failure matrix

| Interruption | Durable state | Recovery |
| --- | --- | --- |
| Before local commit | Previous note, no new operation | Let the user retry the edit |
| After local commit | New note and pending operation | Resume the worker |
| After remote commit | Pending operation, remote receipt | Resend the same ID |
| After local acknowledgement | New note, no pending delivery | No repair needed |

After a local commit, reopening the note must show that edit. A pending badge is honest; replacing the text with an older remote snapshot because sync has not caught up is not.

### Test the awkward moments deliberately

Use a fake transport that can accept an operation and drop its reply. Restart the worker against the same database, then assert that the remote effect exists once and the outbox eventually empties. Also test an offline launch, a duplicate receipt, and two queued edits to one note.

Measure pending count and oldest pending age without logging private note bodies. Add an export-and-restore drill. Reliability means a committed thought stays readable and interrupted delivery stays recoverable.`;

export const SEED_ANSWER = `# A small system, designed to last

A good knowledge base should become more dependable as it fills with your life. A **local-first architecture** keeps its useful parts close to you: your words, your links, and the ability to make another thought permanent without asking a server for permission.

I would build it around three quiet guarantees: reads stay local, saves have a clear commit boundary, and delivery can always be resumed. Everything else should make those guarantees easier to understand.

## 1. Give each kind of state one home

SQLite holds notes and pending work. A note has a stable ID, body, and revision. An outbox entry has an operation ID, immutable payload, and retry schedule. Previews and full-text indexes are projections, never a second authority for the content.

- **Keep reads on the device.** Opening a page, following a backlink, and searching should all work without a network round trip.
- **Commit the edit and its delivery intent together.** A saved note must not depend on a queue that disappears when the app closes.
- **Make pending work visible.** “Saved on this device” and “Synced” are different, useful facts.
- **Keep an exit door.** Export ordinary Markdown plus a small manifest of IDs and links, and test restoring it.

Keep the model small enough to inspect in a database browser, explain to a contributor, and recover without invisible callbacks.

## 2. Make Save a transaction, not a request

The save operation checks the base revision, writes the note, and inserts its outbox entry in one short SQLite transaction. Nothing inside that boundary should wait for the network. Only after the commit does the interface say saved and the worker receive a hint that new work exists.

Behind a typed database adapter, the shape is straightforward:

\`\`\`typescript
type Note = {
  id: string;
  body: string;
  baseRevision: number;
};

async function saveNote(note: Note) {
  await db.transaction(async (tx) => {
    const sequence = await tx.nextDeviceSequence(deviceId);
    const operationId = JSON.stringify([deviceId, sequence]);
    const saved = await tx.notes.updateFromBase(note);

    await tx.outbox.insert({
      id: operationId,
      noteId: saved.id,
      payload: JSON.stringify(saved),
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
  });

  sync.requestWake();
}
\`\`\`

The adapter allocates the sequence and verifies the revision transactionally; either failure rolls back the write. The worker also checks for due work on startup and periodically, covering a stop between commit and wake-up.

## 3. Separate a note's identity from an operation's identity

Allocate the note ID once. Renaming the title, changing a folder, or editing the first paragraph must not change what other notes point to. A random UUID works well here; identity does not need to describe the content.

Derive operation IDs deterministically from a persistent device ID and a transactional sequence. Retries keep the same ID and payload; later edits get new sequences. Restore to a fresh device identity if the original may still be active, avoiding reuse of its counter.

Titles repeat; clocks disagree. Neither belongs in an identity scheme. These are ordinary facts about people's devices, not edge cases to postpone.

## 4. Let a small outbox absorb unreliable delivery

Start with one worker and bounded batches. Read due rows, deliver an operation, then commit its acknowledgement locally. Preserve per-note ordering when later revisions depend on earlier ones. A conflicted note can wait while unrelated notes continue to move.

A lost reply is an unknown outcome: the change may already be accepted. The receiver commits a receipt keyed by operation ID alongside the mutation, then returns it on duplicates. Safe retries do not require pretending the network delivers exactly once.

Retry temporary failures with capped exponential backoff and jitter. Persist attempt counts and next-attempt times. Pause for expired credentials, expose conflicts, and preserve both competing texts until a user or defined merge policy resolves them.

## 5. Keep the read path pleasantly ordinary

Read the committed local note, including unsynchronized edits. Update small search and backlink projections in the save transaction; use durable indexing jobs for expensive work. Every index must be rebuildable from content.

Add indexes for actual queries, with stable tie-breakers for pagination. The [SQLite write-ahead logging documentation](https://www.sqlite.org/wal.html) explains how readers and a writer can coexist; WAL is a concurrency choice, not a replacement for an explicit durability setting or a tested backup procedure.

Do not copy only the main database file while committed changes may still live in the WAL. Use the database's supported backup mechanism, then rehearse opening that backup as a fresh installation.

## 6. Prove the guarantees at the boundaries

Test offline saves followed by a restart, lost acknowledgements, two queued edits, duplicate delivery, and search-index rebuilds. Assert what remains durable, not just which functions were called.

Observe pending count, oldest pending age, and actionable errors, without logging note bodies. “3 changes waiting to sync” is more useful than a spinner asking the user to guess whether their writing is safe.

**Build the smallest complete journey first:** create a note offline, restart, find it locally, reconnect, and watch its outbox entry settle. Then export the collection and restore it somewhere clean. When that path is reliable, you have the foundation of a tool that can earn trust one saved thought at a time.`;

const SEED_MESSAGES: { role: "user" | "assistant"; content: string; modelKey: ModelKey | null }[] = [
  { role: "user", content: SEED_TITLE, modelKey: null },
  { role: "assistant", content: SEED_PRELUDE, modelKey: "fast" },
  { role: "user", content: "What should the write path and retry worker guarantee if the app crashes or an acknowledgement is lost?", modelKey: null },
  { role: "assistant", content: SEED_RELIABILITY, modelKey: "thinking" },
  { role: "user", content: "How would you put SQLite, deterministic IDs, and a durable sync outbox together without complicating the read path?", modelKey: null },
  { role: "assistant", content: SEED_ANSWER, modelKey: "thinking" },
];

export function seedDatabase(repository: ChatRepository): void {
  if (repository.listChats().length > 0) return;
  const chat = repository.createChat();
  const start = Date.now() - 18 * 60 * 1000;
  SEED_MESSAGES.forEach((message, index) => {
    repository.appendMessage({
      chatId: chat.id,
      threadId: null,
      ...message,
      complete: true,
      createdAt: start + index * 2 * 60 * 1000,
    });
  });
}
