import { afterEach, describe, expect, it, vi } from "vitest";
import { spokenMath } from "../lib/speech/math";
import {
  createElevenLabsSpeechProvider, createOpenAISpeechProvider, mockSpeechAudio, mockSpeechProvider, READ_ALOUD_INSTRUCTIONS, speechProvider,
} from "../lib/speech/provider";
import { CHUNK_LIMIT, FIRST_CHUNK_LIMIT, HARD_CHUNK_LIMIT, speechChunks, speechSegments, speechText } from "../lib/speech/speakable";

const r = String.raw;

describe("spokenMath", () => {
  it.each([
    [r`x^2`, "x squared"],
    [r`x^3 + 2x`, "x cubed plus 2 x"],
    [r`e^{i\pi} + 1 = 0`, "e to the power of i pi plus 1 equals 0"],
    [r`\frac{1}{2}`, "one half"],
    [r`\frac{a}{b}`, "a over b"],
    [r`\frac{n(n+1)}{2}`, "the fraction n, n plus 1, over 2"],
    [r`\sqrt{2}`, "the square root of 2"],
    [r`\sqrt[3]{y}`, "the cube root of y"],
    [r`\sum_{i=1}^{n} i`, "the sum from i equals 1 to n of i"],
    [r`\int_0^1 x^2\,dx`, "the integral from 0 to 1 of x squared d x"],
    [r`\lim_{x \to 0} \frac{\sin x}{x}`, "the limit as x goes to 0 of sine x over x"],
    [r`\left[\frac{x^3}{3}\right]_0^1`, "x cubed over 3, evaluated from 0 to 1"],
    [r`f'(x) = \nabla f \cdot \hat{n}`, "f prime of x, equals del f times n hat"],
    [r`x_{n+1} = x_n - \frac{f(x_n)}{f'(x_n)}`, "x sub n plus 1 equals x sub n minus the fraction f of x sub n, over f prime of x sub n"],
    [r`P(A \mid B) = \frac{P(B \mid A)P(A)}{P(B)}`, "P of A given B, equals the fraction P of B given A, P of A, over P of B"],
    [r`\alpha_i \neq \beta^T`, "alpha sub i is not equal to beta transpose"],
    [r`|x| \leq \sqrt[3]{y}`, "the absolute value of x, is less than or equal to the cube root of y"],
    [r`\mathbb{R}^n`, "the real numbers to the power of n"],
    [r`\text{speed} = 3.5 \times 10^{-4} \, \mathrm{m/s}`, "speed equals 3.5 times 10 to the power of minus 4 m over s"],
    [r`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`, "the matrix with rows: 1, 2. 3, 4."],
    [r`\forall \epsilon > 0\; \exists \delta > 0`, "for all epsilon is greater than 0 there exists delta is greater than 0"],
  ])("reads %s", (latex, spoken) => {
    expect(spokenMath(latex)).toBe(spoken);
  });

  it("never leaks backslash commands or braces", () => {
    const samples = [r`\frac{\partial f}{\partial x}`, r`\vec{v} \cdot \vec{w}`, r`\binom{n}{k}`, r`\underbrace{a+b}_{\text{sum}}`, r`\unknowncmd{x}`, r`{{x}}`];
    for (const sample of samples) {
      const spoken = spokenMath(sample);
      expect(spoken).not.toMatch(/[\\{}]/);
      expect(spoken.trim().length).toBeGreaterThan(0);
    }
  });
});

const ARTICLE = `# Newton's method

Newton's method finds roots of $f(x) = 0$ by iterating:

$$
x_{n+1} = x_n - \\frac{f(x_n)}{f'(x_n)}
$$

Steps:

1. Pick a starting point $x_0$.
2. Repeat until **converged**.

- [ ] Prove convergence
- [x] Try it on \`sqrt(2)\`

\`\`\`python
def newton(f, df, x):
    return x - f(x) / df(x)
\`\`\`

> It converges *quadratically* near a simple root.

| Iteration | Value |
| --- | --- |
| 0 | 1 |
| 1 | 1.5 |

![A plot of the tangent line](plot.png) See [the wiki](https://example.com) for more.
`;

describe("speechText", () => {
  it("turns markdown into something a listener can follow", () => {
    const spoken = speechText(ARTICLE);
    expect(spoken).toMatchInlineSnapshot(`
      "Newton's method.

      Newton's method finds roots of f of x, equals 0 by iterating:

      x sub n plus 1 equals x sub n minus the fraction f of x sub n, over f prime of x sub n.

      Steps:

      1. Pick a starting point x sub 0.

      2. Repeat until converged.

      To do: Prove convergence.

      Done: Try it on sqrt(2).

      A python code block with 2 lines.

      Quote: It converges quadratically near a simple root.

      A table with columns Iteration, Value. Iteration: 0, Value: 1. Iteration: 1, Value: 1.5.

      Image: A plot of the tangent line. See the wiki for more."
    `);
  });

  it("reads markdown structures without leaking syntax", () => {
    const spoken = speechText(ARTICLE);
    expect(spoken).not.toMatch(/[#*`|$\\]|\]\(/);
    expect(spoken).not.toContain("https://");
  });

  it("keeps source offsets that point back into the message", () => {
    const segments = speechSegments(ARTICLE);
    expect(segments[0]).toMatchObject({ heading: true, text: "Newton's method.", start: 0 });
    for (const segment of segments) {
      expect(segment.start).toBeLessThan(segment.end);
      expect(segment.end).toBeLessThanOrEqual(ARTICLE.length);
    }
    const table = segments.find((segment) => segment.text.startsWith("A table"))!;
    expect(ARTICLE.slice(table.start, table.end)).toMatch(/^\| Iteration/);
  });

  it("is deterministic and empty for content with nothing to say", () => {
    expect(speechText(ARTICLE)).toBe(speechText(ARTICLE));
    expect(speechChunks("")).toEqual([]);
    expect(speechChunks("```\ncode only\n```")).toHaveLength(1);
    expect(speechChunks("   \n\n")).toEqual([]);
  });
});

describe("speechChunks", () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} explains one idea in a couple of sentences. It keeps going for a while so chunks fill up.`);
  const long = paragraphs.join("\n\n");

  it("starts with a short chunk for low first-audio latency, then larger ones", () => {
    const chunks = speechChunks(long);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].text.length).toBeLessThanOrEqual(FIRST_CHUNK_LIMIT);
    for (const chunk of chunks.slice(1)) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_LIMIT + 200);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
    for (let i = 1; i < chunks.length; i += 1) expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toContain("Paragraph 39");
  });

  it("splits a single enormous paragraph on sentence boundaries", () => {
    const sentence = "This sentence is repeated to make a very long paragraph. ";
    const chunks = speechChunks(sentence.repeat(120));
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(HARD_CHUNK_LIMIT);
      expect(chunk.text.endsWith(".")).toBe(true);
    }
  });
});

describe("speechProvider", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it("picks the provider from configuration", () => {
    const env = (values: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...values });
    expect(speechProvider(env({}))).toBeNull();
    expect(speechProvider(env({ USE_MOCK: "true" }))?.id).toBe("mock");
    expect(speechProvider(env({ OPENAI_API_KEY: "k" }))?.id).toBe("openai");
    expect(speechProvider(env({ OPENAI_API_KEY: "k", ELEVENLABS_API_KEY: "e" }))?.id).toBe("elevenlabs");
    expect(speechProvider(env({ OPENAI_API_KEY: "k", ELEVENLABS_API_KEY: "e", THREADS_SPEECH_PROVIDER: "openai" }))?.id).toBe("openai");
    expect(speechProvider(env({ OPENAI_API_KEY: "k", USE_MOCK: "true" }))?.id).toBe("openai");
    expect(speechProvider(env({ THREADS_SPEECH_PROVIDER: "mock" }))).toBeNull();
    expect(() => speechProvider(env({ THREADS_SPEECH_PROVIDER: "siri" }))).toThrow(/THREADS_SPEECH_PROVIDER/);
  });

  it("sends OpenAI speech requests with delivery instructions and maps failures", async () => {
    const fetchMock = vi.fn(async () => new Response("audio", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = createOpenAISpeechProvider("secret");
    const audio = await provider.synthesize({ text: "Hello there.", voice: "marin" });
    expect(audio.contentType).toBe("audio/mpeg");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ model: "gpt-4o-mini-tts", voice: "marin", input: "Hello there.", instructions: READ_ALOUD_INSTRUCTIONS, response_format: "mp3" });

    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    await expect(provider.synthesize({ text: "x", voice: "marin" })).rejects.toMatchObject({ status: 429, code: "rate_limit" });
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(provider.synthesize({ text: "x", voice: "marin" })).rejects.toMatchObject({ status: 502, code: "speech_key" });
    globalThis.fetch = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    await expect(provider.synthesize({ text: "x", voice: "marin" })).rejects.toMatchObject({ status: 502, code: "speech_unavailable" });
  });

  it("passes neighbouring chunks to ElevenLabs and caches its voice list", async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/v1/voices")
      ? Response.json({ voices: [{ voice_id: "v1", name: "Ada" }] })
      : new Response("audio", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = createElevenLabsSpeechProvider("key");
    expect(await provider.voices()).toEqual([{ id: "v1", label: "Ada" }]);
    expect(await provider.voices()).toEqual([{ id: "v1", label: "Ada" }]);
    await provider.synthesize({ text: "middle", voice: "v1", previousText: "before", nextText: "after" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/text-to-speech/v1?");
    expect(JSON.parse(String(init.body))).toMatchObject({ text: "middle", previous_text: "before", next_text: "after", model_id: "eleven_multilingual_v2" });
  });

  it("produces a valid WAV whose length tracks the text in mock mode", async () => {
    const short = mockSpeechAudio("Hi.");
    const long = mockSpeechAudio("word ".repeat(200));
    expect(new TextDecoder().decode(short.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(short.slice(8, 12))).toBe("WAVE");
    expect(long.byteLength).toBeGreaterThan(short.byteLength);
    const audio = await mockSpeechProvider.synthesize({ text: "Hi.", voice: "mock" });
    expect(audio.contentType).toBe("audio/wav");
    expect((await new Response(audio.body).arrayBuffer()).byteLength).toBe(short.byteLength);
  });
});
