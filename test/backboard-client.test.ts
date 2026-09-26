import { describe, expect, it, vi } from "vitest";
import { BackboardRequestError, createBackboardClient } from "../src/backboard/client.js";

const SECRET = "live-looking-key-do-not-log";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Backboard HTTP client", () => {
  it("sends the key only as a header and creates one assistant", async () => {
    const calls: Array<{ url: string; header: string | null; body: string }> = [];
    const client = createBackboardClient({
      apiKey: SECRET,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), header: headers.get("X-API-Key"), body: String(init?.body ?? "") });
        return jsonResponse(200, { assistant_id: "asst-created" });
      },
    });
    const created = await client.createAssistant({ name: "personal-memory", systemPrompt: "exactly one person" });
    expect(created.assistantId).toBe("asst-created");
    expect(calls[0]?.url).toBe("https://app.backboard.io/api/assistants");
    expect(calls[0]?.header).toBe(SECRET);
    expect(calls[0]?.body).toContain("exactly one person");
  });

  it("uses Readonly retrieval and does not put the key in errors", async () => {
    const client = createBackboardClient({
      apiKey: SECRET,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { memory?: string; send_to_llm?: string };
        expect(body.memory).toBe("Readonly");
        expect(body.send_to_llm).toBe("false");
        return jsonResponse(200, {
          thread_id: "thread-1",
          assistant_id: "asst-1",
          retrieved_memories: [{ memory: "Prefers the subway." }],
        });
      },
    });
    const result = await client.sendMessage({
      assistantId: "asst-1",
      threadId: "thread-1",
      content: "What do I prefer?",
      memory: "Readonly",
      sendToLlm: false,
    });
    expect(result.retrievedMemories).toEqual(["Prefers the subway."]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limit"],
    [500, "server"],
  ] as const)("maps HTTP %s to %s without echoing the key", async (status, kind) => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const client = createBackboardClient({
      apiKey: SECRET,
      fetchImpl: async () => new Response(`{"error":"${SECRET}"}`, { status }),
    });
    await expect(client.createAssistant({ name: "x", systemPrompt: "y" })).rejects.toMatchObject({ kind, status });
    spy.mockRestore();
    try {
      await client.createAssistant({ name: "x", systemPrompt: "y" });
    } catch (error) {
      expect(error).toBeInstanceOf(BackboardRequestError);
      expect((error as Error).message).not.toContain(SECRET);
    }
    expect(errors.join("\n")).not.toContain(SECRET);
  });

  it("treats a timeout and malformed JSON as recoverable client errors", async () => {
    const timeoutClient = createBackboardClient({
      apiKey: SECRET,
      fetchImpl: async () => {
        throw Object.assign(new Error(`timed out ${SECRET}`), { name: "TimeoutError" });
      },
    });
    await expect(timeoutClient.searchMemories("asst-1", "subway")).rejects.toMatchObject({ kind: "timeout" });

    const malformed = createBackboardClient({
      apiKey: SECRET,
      fetchImpl: async () => new Response(`not-json ${SECRET}`, { status: 200 }),
    });
    await expect(malformed.searchMemories("asst-1", "subway")).rejects.toMatchObject({ kind: "malformed" });
    try {
      await malformed.searchMemories("asst-1", "subway");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
