import { describe, expect, it, vi } from "vitest";
import { createMessageClaimer } from "../src/chat/claim.js";

/** A tiny stand-in for the claims table shared by several agent processes. */
function sharedTable() {
  const rows = new Map<string, string>();
  return (instance: string) =>
    vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("INSERT")) {
        const id = String(params?.[0]);
        if (rows.has(id)) return { rowCount: 0 };
        rows.set(id, instance);
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });
}

describe("message claims", () => {
  it("answers a redelivered message only once in one process", async () => {
    const claims = createMessageClaimer();
    expect(await claims.claim("m1")).toBe(true);
    expect(await claims.claim("m1")).toBe(false);
    expect(await claims.claim("m2")).toBe(true);
  });

  it("lets only one of two running agents answer", async () => {
    const table = sharedTable();
    const laptop = createMessageClaimer({ query: table("laptop"), instance: "laptop" });
    const droplet = createMessageClaimer({ query: table("droplet"), instance: "droplet" });
    const [a, b] = await Promise.all([laptop.claim("m1"), droplet.claim("m1")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("fails open when the database is down", async () => {
    const claims = createMessageClaimer({ query: async () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await claims.claim("m1")).toBe(true);
  });

  it("fails open when the database hangs", async () => {
    const claims = createMessageClaimer({ query: () => new Promise(() => undefined), timeoutMs: 10 });
    expect(await claims.claim("m1")).toBe(true);
  });
});
