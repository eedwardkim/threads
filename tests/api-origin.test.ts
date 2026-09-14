import { describe, expect, it } from "vitest";
import { assertLocalRequest } from "../lib/api";

describe("same-origin mutation protection", () => {
  it("uses the browser Host header when Next normalizes the internal URL to localhost", () => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).not.toThrow();
  });

  it("rejects a foreign origin even with a same-origin claim", () => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "https://example.org", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).toThrow("This request must come from the app.");
  });

  it("rejects cross-site requests without an Origin header", () => {
    expect(() => assertLocalRequest(new Request("http://localhost:3000/api/chats", { headers: { "sec-fetch-site": "cross-site" } }))).toThrow();
  });

  it("accepts a same-origin loopback preview whose proxy rewrites the target port", () => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:51816", "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).not.toThrow();
  });

  it.each(["same-site", "cross-site", "none", ""])("rejects a different local port when browser metadata is %s", (site) => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:51816", "sec-fetch-site": site },
    });
    expect(() => assertLocalRequest(request)).toThrow("This request must come from the app.");
  });

  it.each(["null", "https://127.0.0.1:51816", "http://localhost.example.org:51816"])("rejects an untrusted preview origin %s", (origin) => {
    const request = new Request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin, "sec-fetch-site": "same-origin" },
    });
    expect(() => assertLocalRequest(request)).toThrow("This request must come from the app.");
  });

  it("allows local command-line requests without browser origin headers", () => {
    const request = new Request("http://localhost:3000/api/chats");
    expect(() => assertLocalRequest(request)).not.toThrow();
  });
});

