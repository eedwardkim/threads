import { modelFor } from "../models";
import { estimateTokens } from "../tokens";
import type { Briefing, PromptMessage } from "../types";
import type { ChatProvider, StreamInput } from "./types";

function lastMessage(messages: PromptMessage[], role: PromptMessage["role"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) return messages[index].content;
  }
  return "";
}

function excerpt(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function markdownExcerpt(text: string, limit: number): string {
  return excerpt(text, limit).replace(/[\\`*_{}[\]<>#!|]/g, "\\$&");
}

function focusFor(text: string) {
  if (/retry|retries|backoff|outbox|sync|network/i.test(text)) {
    return {
      title: "Make retries safe before making them fast",
      detail: "The outbox is a record of unfinished work, not an in-memory queue. Persist the payload and operation ID with the edit, then retry that exact operation after a timeout. A missing acknowledgement means the outcome is unknown; it does not mean the server rejected the write.",
      decision: "Commit edits and outbox entries together; reuse the operation ID on every retry.",
      question: "Which failures need a retry, and which need an explicit conflict or sign-in action?",
    };
  }
  if (/read|search|index|query|queries/i.test(text)) {
    return {
      title: "Keep the read path independent of the network",
      detail: "Render from a local SQLite query, including pending edits. Treat full-text search as a rebuildable index of those same notes, not a second source of truth. Background delivery may change a sync badge, but it must not decide whether a document can be opened.",
      decision: "Read notes locally and maintain a rebuildable full-text index of committed content.",
      question: "Which read queries need indexes, and how will a search-index rebuild be verified?",
    };
  }
  if (/deterministic|idempot|identity|identities|\bids?\b/i.test(text)) {
    return {
      title: "Give an operation an identity that survives a retry",
      detail: "Allocate a note ID once and keep it through edits, exports, and imports. Derive each operation ID from the device identity and a sequence allocated in the save transaction. Do not derive note identity from its title: two notes can share a title without being the same document.",
      decision: "Keep stable note IDs and deterministic, device-scoped operation IDs for deduplication.",
      question: "How are device identities and monotonic operation sequences preserved during restore?",
    };
  }
  if (/sqlite|transaction|wal|durab|crash/i.test(text)) {
    return {
      title: "Make the commit boundary the promise",
      detail: "Use one SQLite transaction for the note, its revision, and the pending operation. The interface can say saved only after that transaction commits. WAL improves reader and writer concurrency; durability still depends on the chosen synchronous setting and a backup procedure that includes committed WAL data.",
      decision: "A successful save means the note and its pending operation have committed atomically.",
      question: "What durability setting and tested backup procedure match the product's save promise?",
    };
  }
  return {
    title: "Start with a guarantee you can explain",
    detail: "The useful boundary is a durable local save followed by optional delivery. Give notes stable identities, keep reads on the device, and make every unsent change inspectable. That leaves a small system whose behavior is understandable when the connection disappears halfway through an edit.",
    decision: "Use SQLite for local reads and writes, with a separate durable delivery worker.",
    question: "Is the first release single-device, or must it expose concurrent-edit conflicts?",
  };
}

function isLocalFirstTopic(text: string): boolean {
  return /local.first|knowledge.base|sqlite|outbox|sync.*(worker|queue)|offline.*(first|edit|read)|crdt|backlink/i.test(text);
}

function isMathTopic(text: string): boolean {
  return /eigen|determinant|integral|derivative|matrix|theorem|prove|gradient|probability|\\\(|\\\[|\$\$/i.test(text);
}

/** A deterministic, math-heavy answer so render/normalization paths can be profiled without a live model. */
function mathResponse(request: string, modelKey: StreamInput["modelKey"]): string {
  const intro = modelFor(modelKey).thinking
    ? "I'll set up the definitions first, then derive the result step by step."
    : "Here's the derivation, with the key identities called out.";
  const sections = Array.from({ length: 6 }, (_, k) => {
    const n = k + 2;
    return `### Step ${k + 1}: the case \\(n = ${n}\\)

For an \\(${n} \\times ${n}\\) matrix \\(A\\) with eigenvalues \\(\\lambda_1, \\dots, \\lambda_${n}\\) we have
\\[
\\det(A) = \\prod_{i=1}^{${n}} \\lambda_i, \\qquad \\operatorname{tr}(A) = \\sum_{i=1}^{${n}} \\lambda_i .
\\]
The characteristic polynomial \\(p(\\lambda) = \\det(\\lambda I - A)\\) expands as
\\[
p(\\lambda) = \\lambda^{${n}} - \\operatorname{tr}(A)\\,\\lambda^{${n - 1}} + \\cdots + (-1)^{${n}} \\det(A),
\\]
so the coefficient of \\(\\lambda^{${n - 1}}\\) is \\(-\\sum_i \\lambda_i\\) and the constant term is \\((-1)^{${n}} \\prod_i \\lambda_i\\).
Applying \\(\\int_0^1 x^{${n}}\\,dx = \\frac{1}{${n + 1}}\\) to the normalized trace gives \\(\\frac{\\operatorname{tr}(A)}{${n}} \\cdot \\frac{1}{${n + 1}}\\), which is bounded by \\(\\max_i |\\lambda_i|\\).`;
  }).join("\n\n");
  return `## Working through the mathematics

${intro}

> ${markdownExcerpt(request, 180)}

Let \\(A \\in \\mathbb{R}^{n \\times n}\\) be diagonalizable, so \\(A = P D P^{-1}\\) with \\(D = \\operatorname{diag}(\\lambda_1, \\dots, \\lambda_n)\\).

${sections}

### Putting it together

Since \\(\\det(P D P^{-1}) = \\det(P)\\det(D)\\det(P)^{-1} = \\det(D)\\), the determinant is invariant under similarity, and the same argument shows
\\[
\\operatorname{tr}(A^k) = \\sum_{i=1}^{n} \\lambda_i^k \\quad \\text{for every } k \\geq 1 .
\\]
**Conclusion:** the elementary symmetric polynomials of the eigenvalues are exactly the coefficients of \\(p(\\lambda)\\), up to sign.`;
}

function genericResponse(request: string, messages: PromptMessage[], modelKey: StreamInput["modelKey"]): string {
  const intro = modelFor(modelKey).thinking
    ? "Let me think through this carefully."
    : "Here's what I'd suggest.";
  const quoted = markdownExcerpt(request, 180);
  const conversationLength = messages.filter((m) => m.role === "user").length;

  if (isMathTopic(request)) return mathResponse(request, modelKey);

  if (/^(hi|hello|hey|sup|yo|what'?s up|howdy)\b/i.test(request.trim())) {
    return `Hello! I'm here to help. What would you like to work on?`;
  }

  if (request.trim().length < 12) {
    return `> ${quoted}\n\nCould you tell me more about what you're looking for? I'm happy to help with design, architecture, debugging, or working through an idea.`;
  }

  return `## Thinking about this

${intro}

> ${quoted}

${conversationLength > 1 ? "Building on our conversation so far — here" : "Here"} are a few angles worth considering:

### Start with the core constraint

Every design benefits from identifying the one constraint that, if removed, would change the approach entirely. Name that constraint explicitly, then build the simplest system that respects it.

### Keep the first version small

Ship the smallest thing that proves the idea works end to end. A vertical slice that touches every layer — even crudely — teaches more than a polished component in isolation.

### Make the boundaries testable

Define clear inputs and outputs at each boundary. When something breaks, a good boundary tells you which side the problem is on without opening a debugger.

**What would help most?** If you can share more about the specific problem — the constraints, what you've tried, or where you're stuck — I can give a more targeted recommendation.`;
}

function responseFor({ messages, modelKey }: StreamInput): string {
  const request = lastMessage(messages, "user") || "Design a local-first knowledge base.";
  const threadPrompt = messages.find((message) => message.role === "system" && message.content.includes("Thread subject"));

  if (!threadPrompt && !isLocalFirstTopic(request)) {
    return genericResponse(request, messages, modelKey);
  }

  const subject = threadPrompt?.content.split("Thread subject")[1]?.replace(/^\s*:\s*/, "").trim().split("\n")[0] || "the selected passage";
  const focus = focusFor(`${request} ${threadPrompt ? subject : ""}`);
  const intro = modelFor(modelKey).thinking
    ? "I'll work through the guarantees first, then the implementation."
    : "Here's the practical version, with a small implementation to start from.";
  const question = `> ${markdownExcerpt(request, 180)}`;

  if (threadPrompt) {
    return `## A closer look at the boundary

${intro}

${question}

**Thread subject:** ${markdownExcerpt(subject, 120)}

### ${focus.title}

${focus.detail}

In a **local-first architecture**, saving and delivering are different promises. A SQLite commit saves the edit; a recoverable background task delivers it. A slow connection must not hold a local save hostage.

1. **Commit together.** Write the note and outbox entry in one transaction.
2. **Retry safely.** Keep the operation's ID and payload stable.
3. **Expose status.** Show pending or synced without blocking reads.

\`\`\`typescript
type PendingOperation = {
  id: string;
  noteId: string;
  attempts: number;
  nextAttemptAt: number;
};

async function deliver(op: PendingOperation) {
  const receipt = await transport.send(op.id);
  await outbox.acknowledge(op.id, receipt);
}
\`\`\`

The transport loads the persisted payload for that ID. If the app stops after remote acceptance but before the acknowledgement commits, send the same operation again. A durable receiver-side receipt makes replay harmless.

### What to bring back

${focus.decision} Test a lost acknowledgement and a restart before tuning throughput. ${focus.question}

Keep the broader design small while making this one guarantee precise.`;
  }

  return `## A local-first plan you can build in layers

${intro}

${question}

A **local-first architecture** starts with a promise: the knowledge base remains useful without a working connection. Notes open from the device, edits commit locally, and synchronization is allowed to catch up. The network is a delivery mechanism, not a prerequisite for thinking.

### ${focus.title}

${focus.detail}

### 1. Put a durable transaction behind Save

Use SQLite for notes, revisions, and a small outbox. One write transaction records the new content and the operation that will eventually deliver it. If the transaction fails, neither becomes visible. If it commits, the interface can truthfully say saved even when the sync service is unavailable.

Keep the critical section short: validate first, perform only local writes inside it, and wake the worker afterward. Never hold the transaction open for an HTTP request.

- **Keep reads on the device.** Opening a note should never wait for a remote round trip.
- **Make pending work durable.** A process restart must not empty the delivery queue.
- **Separate save from sync.** A pending badge is not a failed save.
- **Keep recovery ordinary.** Replaying a committed operation should be a supported path, not an emergency repair.

### 2. Use stable identities, not convenient labels

A note gets its ID when it is created, and keeps it when its title changes. A delivery operation gets a different identity. Derive that operation ID from a persistent device ID and a monotonic sequence allocated in the same transaction as the edit. Retries reuse it; another edit gets a new sequence.

Titles repeat and clocks disagree. Hashing a document would change its identity on every edit. Keep those attributes separate from the stable note ID that backlinks use.

### 3. Keep the write path legible

Behind a typed SQLite adapter, the application service can remain small. The adapter below allocates the sequence and checks the base revision under the same write transaction, so two writers cannot silently claim the same revision.

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

The wake-up is a hint. The worker also checks for due rows on startup and periodically, covering a stop between commit and notification. Persist intent; derive scheduling from it.

### 4. Make read models disposable

The note table owns the content. Full-text search, previews, and backlink indexes are projections that can be rebuilt from it. Update small projections transactionally where practical; for expensive ones, store a durable indexing task rather than assuming an in-memory callback will run.

Index the queries each screen actually runs. Use the note ID as a deterministic tie-breaker so equal timestamps do not shuffle between pages. Measure a representative collection, not an empty database.

### 5. Design for the acknowledgement you never receive

A timeout is an unknown outcome. The server may have committed the operation while the reply was lost. Store a durable receipt keyed by operation ID alongside the server-side change, and return that receipt for duplicates. This gives an exactly-once effect over an at-least-once delivery mechanism without pretending the network itself is exactly once.

Retry temporary failures with capped backoff and jitter; persist the attempt count and next eligible time. Pause for expired credentials and expose revision conflicts. A retry loop cannot choose which competing paragraph to keep.

Preserve per-note order when revisions depend on each other. Let unrelated notes continue past a blocked note. Begin with one worker and bounded batches before adding parallelism.

### 6. Make recovery visible and testable

Track pending count, oldest pending age, and actionable errors without logging note bodies. Rehearse restoring an export. Read the [SQLite WAL documentation](https://www.sqlite.org/wal.html) before choosing checkpoint and backup behavior.

Test stops at the commit boundary, duplicate deliveries, offline startup, and lost acknowledgements. Assert that the note stays readable and delivery settles without applying an edit twice.

**Next step:** ship one vertical slice: create a note offline, restart, find it through local search, then reconnect and drain the outbox. ${focus.question} Let that working slice set the shape of the rest of the system.`;
}

function waitForChunk(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), 18);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export const mockProvider: ChatProvider = {
  async *streamChat(input) {
    if (input.signal?.aborted) return;
    const response = responseFor(input);
    let offset = 0;
    let piece = 0;
    while (offset < response.length) {
      if (!(await waitForChunk(input.signal)) || input.signal?.aborted) return;
      const text = response.slice(offset, offset + 8 + (piece % 9));
      offset += text.length;
      piece += 1;
      yield { type: "text", text };
    }
    if (input.signal?.aborted) return;
    yield {
      type: "usage",
      inputTokens: estimateTokens(input.messages),
      outputTokens: estimateTokens(response),
    };
  },

  async compress({ messages, direction, signal }): Promise<Briefing> {
    signal?.throwIfAborted();
    const request = excerpt(lastMessage(messages, "user"), 140) || "Design a durable local-first knowledge base.";
    const focus = focusFor(request);
    const returning = direction === "thread-to-main";
    const latestAnswer = excerpt(lastMessage(messages, "assistant"), 120);

    return {
      goal: returning ? `Bring focused findings back to the main design: ${request}` : `Give a focused thread the context to investigate: ${request}`,
      constraints: [
        "Offline reads and edits use SQLite; synchronization must not block saving.",
        "Keep the implementation small, durable, and recoverable after a restart.",
      ],
      decisions: returning
        ? [focus.decision, "Carry the thread's conclusion forward without replacing unrelated main-chat decisions."]
        : ["Use an atomic note-and-outbox transaction with stable operation IDs.", focus.decision],
      artifacts: [
        "TypeScript saveNote transaction and a persisted, retryable outbox record.",
        ...(latestAnswer ? [`${returning ? "Thread result" : "Main design excerpt"}: ${latestAnswer}`] : []),
      ],
      open_questions: [focus.question, returning ? "Which follow-up belongs in the main implementation plan?" : "What concrete recommendation should this thread return to the main chat?"],
    };
  },
};
