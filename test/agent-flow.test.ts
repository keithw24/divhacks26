import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type SuggestInput } from "../src/agent/suggest.js";
import { handleInboundMessage, type InboundDeps, type InboundMessage } from "../src/agent/inbound.js";
import {
  type BackboardClient,
  type SendMessageInput,
} from "../src/backboard/client.js";
import { ensureSpaceThread, resolveUser } from "../src/identity/users.js";
import { readGroupContext } from "../src/chat/group.js";
import { createFileStateStore, createMemoryStateStore, threadKey, type StateStore } from "../src/store/state.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import { createTransportationService } from "../src/transport/service.js";
import type { RouteResult, TravelMode } from "../src/transport/types.js";

class FakeBackboard implements BackboardClient {
  assistants: string[] = [];
  threads: { assistantId: string; threadId: string }[] = [];
  sent: SendMessageInput[] = [];
  memories = new Map<string, string[]>();

  async createAssistant() {
    const assistantId = `asst-${this.assistants.length + 1}`;
    this.assistants.push(assistantId);
    return { assistantId };
  }

  async createThread(assistantId: string) {
    const threadId = `thread-${this.threads.length + 1}`;
    this.threads.push({ assistantId, threadId });
    return { threadId };
  }

  async sendMessage(input: SendMessageInput) {
    this.sent.push(input);
    if (input.memory === "Auto" || input.memoryPro === "Auto") {
      const existing = this.memories.get(input.assistantId) ?? [];
      this.memories.set(input.assistantId, [...existing, input.content]);
    }
    const retrieved =
      input.memory === "Readonly" || input.memoryPro === "Readonly" ? (this.memories.get(input.assistantId) ?? []) : [];
    return { assistantId: input.assistantId, threadId: input.threadId, retrievedMemories: retrieved };
  }

  async searchMemories(assistantId: string) {
    return this.memories.get(assistantId) ?? [];
  }
}

function actions(sink: string[]) {
  return {
    reply: async (text: string) => {
      sink.push(text);
      return { id: `reply-${sink.length}` };
    },
    responding: async <T>(fn: () => Promise<T>) => fn(),
  };
}

function deps(
  store: StateStore,
  backboard: BackboardClient | undefined,
  suggest: InboundDeps["suggest"],
  extra?: Partial<InboundDeps>,
): InboundDeps {
  return {
    autoReply: true,
    store,
    backboard,
    memoryPro: false,
    writeMode: "Auto",
    verboseMemory: false,
    transport: {
      observe: async () => undefined,
      handle: async () => ({ handled: false, acknowledgement: "👍" }),
    },
    suggest,
    transcript: () => [],
    recordChatMessage: () => undefined,
    recordAssistant: () => undefined,
    ...extra,
  };
}

function inbound(partial: Partial<InboundMessage> & Pick<InboundMessage, "spaceId" | "text">): InboundMessage {
  return {
    messageIds: partial.messageIds,
    messageId: partial.messageId ?? `m-${partial.spaceId}-${partial.text.length}-${partial.senderId ?? "rohan"}`,
    senderId: partial.senderId ?? "rohan-id",
    senderName: partial.senderName ?? "Rohan",
    timestamp: partial.timestamp ?? "2026-09-26T18:00:00.000Z",
    isGroup: partial.isGroup ?? true,
    direction: partial.direction,
    senderKind: partial.senderKind,
    spaceId: partial.spaceId,
    text: partial.text,
  };
}

const walkThroughTimesSquare: RouteResult = {
  mode: "WALK",
  durationSeconds: 40 * 60,
  steps: [{ mode: "WALK", instruction: "Walk through Times Square" }],
};
const transit: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 20 * 60,
  steps: [{ mode: "TRANSIT", lineShortName: "1", departureStop: "116 St", arrivalStop: "34 St-Penn Station" }],
};

function routing(requested: TravelMode[]) {
  return {
    async getRoute(_origin: unknown, _destination: unknown, mode: TravelMode) {
      requested.push(mode);
      if (mode === "WALK") return walkThroughTimesSquare;
      if (mode === "DRIVE") {
        return {
          mode: "DRIVE" as const,
          durationSeconds: 25 * 60,
          steps: [{ mode: "DRIVE", instruction: "Drive via 12th Ave" }],
        };
      }
      return transit;
    },
  };
}

describe("cross-conversation memory and isolation", () => {
  it("reuses one assistant across spaces and applies the stored walking preference", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const requested: TravelMode[] = [];
    const resolved: string[] = [];
    const transport = createTransportationService({
      routing: routing(requested),
      resolver: {
        resolve: async (query) => {
          resolved.push(query);
          return lookupGazetteer(query);
        },
      },
    });
    const shared = deps(store, backboard, async () => "unused", { transport });
    const sink: string[] = [];

    await handleInboundMessage(
      inbound({ spaceId: "space-a", messageId: "pref-1", text: "I don't like walking through Times Square." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "space-b", senderId: "keith-id", senderName: "Keith", messageId: "b1", text: "We're at Columbia University." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "space-b", senderId: "keith-id", senderName: "Keith", messageId: "b2", text: "Let's go to Penn Station." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "space-b", messageId: "b3", text: "@agent how should I get there?" }),
      actions(sink),
      shared,
    );

    const reads = backboard.sent.filter((message) => message.memory === "Readonly");
    expect(new Set(reads.map((message) => message.assistantId)).size).toBe(1);
    expect(backboard.assistants).toEqual(["asst-1"]);
    expect(backboard.threads.map((thread) => thread.threadId)).toEqual(["thread-1", "thread-2"]);
    expect(sink[0]).toMatch(/20 min/);
    expect(sink[0]).not.toMatch(/40 min/);
    expect(resolved.join(" ")).toMatch(/Penn Station/);
    expect(resolved.join(" ")).toMatch(/Columbia/);
  });

  it("keeps two people's memories on different assistants", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const seen: SuggestInput[] = [];
    const shared = deps(store, backboard, async (input) => {
      seen.push(input);
      return "Something nearby.";
    });

    await handleInboundMessage(
      inbound({ spaceId: "a-chat", senderId: "a-id", senderName: "Ava", messageId: "a-fact", text: "I hate sushi." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "b-chat", senderId: "b-id", senderName: "Ben", messageId: "b-fact", text: "I love sushi." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "a-chat", senderId: "a-id", senderName: "Ava", messageId: "a-ask", text: "@agent where should I eat?" }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "b-chat", senderId: "b-id", senderName: "Ben", messageId: "b-ask", text: "@agent where should I eat?" }),
      actions([]),
      shared,
    );

    expect(backboard.assistants).toEqual(["asst-1", "asst-2"]);
    const ava = seen.find((input) => input.currentUser?.displayName === "Ava");
    const ben = seen.find((input) => input.currentUser?.displayName === "Ben");
    expect(ava?.userMemories?.join(" ")).toMatch(/hate sushi/i);
    expect(ava?.userMemories?.join(" ")).not.toMatch(/love sushi/i);
    expect(ben?.userMemories?.join(" ")).toMatch(/love sushi/i);
    expect(ben?.userMemories?.join(" ")).not.toMatch(/hate sushi/i);
    const avaRead = backboard.sent.filter((message) => message.memory === "Readonly" && message.content?.includes("Ava") === false);
    const assistantIds = backboard.sent.filter((message) => message.memory === "Readonly").map((message) => message.assistantId);
    expect(new Set(assistantIds)).toEqual(new Set(["asst-1", "asst-2"]));
    expect(avaRead).toBeDefined();
  });
});

describe("group context with personal memory", () => {
  it("gives Gemini the prior group lines that explain there", async () => {
    const store = createMemoryStateStore();
    let seen: SuggestInput | undefined;
    const shared = deps(store, undefined, async (input) => {
      seen = input;
      return "Head to Times Square.";
    });
    await handleInboundMessage(
      inbound({ spaceId: "plans", senderId: "keith-id", senderName: "Keith", messageId: "k1", text: "Let's go to Joe's Pizza." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "plans", messageId: "r1", text: "What about Times Square after?" }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "plans", senderId: "keith-id", senderName: "Keith", messageId: "k2", text: "Sure." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "plans", messageId: "r2", text: "@agent how should we get there?" }),
      actions([]),
      shared,
    );

    const prompt = buildContext(seen as SuggestInput);
    expect(prompt).toContain("Keith: Let's go to Joe's Pizza.");
    expect(prompt).toContain("Rohan: What about Times Square after?");
    expect(prompt).toContain("Keith: Sure.");
    expect(prompt).toContain("how should we get there?");
    expect(prompt).toContain("Times Square");
  });

  it("combines the group destination with subway and walking limits", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const requested: TravelMode[] = [];
    const resolved: string[] = [];
    const transport = createTransportationService({
      routing: routing(requested),
      resolver: {
        resolve: async (query) => {
          resolved.push(query);
          return lookupGazetteer(query);
        },
      },
    });
    const shared = deps(store, backboard, async () => "unused", { transport });
    const sink: string[] = [];

    await handleInboundMessage(
      inbound({
        spaceId: "memory-chat",
        messageId: "mem-1",
        text: "I prefer the subway and don't like walks longer than 15 minutes.",
      }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "tonight", senderId: "keith-id", senderName: "Keith", messageId: "t1", text: "We're at Columbia University." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "tonight", senderId: "keith-id", senderName: "Keith", messageId: "t2", text: "Let's go to Times Square." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "tonight", messageId: "t3", text: "@agent how should we get there?" }),
      actions(sink),
      shared,
    );

    expect(resolved.join(" ")).toMatch(/Times Square/);
    expect(requested).toEqual(expect.arrayContaining(["TRANSIT"]));
    expect(sink[0]).toMatch(/20 min/);
    expect(sink[0]).not.toMatch(/40 min/);
    expect(sink[0]).not.toMatch(/Walk through Times Square/);
  });

  it("does not replace an explicit Uber request with a stored subway preference", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const requested: TravelMode[] = [];
    const transport = createTransportationService({
      routing: routing(requested),
      resolver: { resolve: async (query) => lookupGazetteer(query) },
    });
    const sink: string[] = [];
    const shared = deps(store, backboard, async () => "unused", { transport });
    await handleInboundMessage(
      inbound({ spaceId: "prefs", messageId: "sub", text: "I usually prefer the subway." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({
        spaceId: "ride",
        messageId: "uber",
        text: "@agent get us an Uber from Columbia University to Times Square.",
      }),
      actions(sink),
      shared,
    );

    expect(requested).toEqual(["DRIVE"]);
    expect(sink[0]).toMatch(/Drive/);
    expect(sink[0]).not.toMatch(/Take the 1/);
  });

  it("uses a private preference without saying where it came from", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const sink: string[] = [];
    const shared = deps(store, backboard, async () => {
      return [
        "From your previous private conversation, you dislike that walk.",
        "I remember that Rohan hates walking through Times Square.",
        "Three weeks ago you said you avoid it.",
        "I'd lean toward the subway.",
      ].join(" ");
    });
    await handleInboundMessage(
      inbound({ spaceId: "private", isGroup: false, messageId: "p1", text: "I don't like walking through Times Square." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "group", messageId: "g1", text: "@agent how should we get to the restaurant?" }),
      actions(sink),
      shared,
    );

    expect(sink[0]).toBe("I'd lean toward the subway.");
    expect(sink[0]).not.toMatch(/private|remember|weeks ago|told me/i);
  });
});

describe("delivery, restart, and concurrency", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("ingests one Photon message id only once", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const shared = deps(store, backboard, async () => "unused");
    const message = inbound({ spaceId: "dup", messageId: "abc123", text: "I hate sushi." });
    await handleInboundMessage(message, actions([]), shared);
    await handleInboundMessage(message, actions([]), shared);

    expect(backboard.sent.filter((item) => item.memory === "Auto")).toHaveLength(1);
    expect(readGroupContext(store, "dup").recentMessages).toHaveLength(1);
    expect(store.getState().ingestedMessageIds["dup:abc123"]).toBe(true);
  });

  it("keeps the same assistant, thread, participants, and recent context after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-restart-"));
    dirs.push(dir);
    const file = join(dir, "state.json");
    const backboard = new FakeBackboard();
    const first = createFileStateStore(file);
    await handleInboundMessage(
      inbound({ spaceId: "room", messageId: "m1", text: "I like Italian food." }),
      actions([]),
      deps(first, backboard, async () => "unused"),
    );
    const assistantId = first.getState().users["rohan-id"]?.backboardAssistantId;
    const threadId = first.getState().threads[threadKey("photon:rohan-id", "room")]?.backboardThreadId;

    const restarted = createFileStateStore(file);
    const beforeThreads = backboard.threads.length;
    const beforeAssistants = backboard.assistants.length;
    await resolveUser({
      store: restarted,
      photonIdentifier: "rohan-id",
      displayName: "Rohan",
      client: backboard,
    });
    const thread = await ensureSpaceThread({
      store: restarted,
      userId: "photon:rohan-id",
      photonSpaceId: "room",
      assistantId: assistantId ?? "",
      client: backboard,
    });

    expect(assistantId).toBe("asst-1");
    expect(restarted.getState().users["rohan-id"]?.backboardAssistantId).toBe(assistantId);
    expect(thread).toBe(threadId);
    expect(backboard.assistants).toHaveLength(beforeAssistants);
    expect(backboard.threads).toHaveLength(beforeThreads);
    expect(restarted.getState().spaces["room"]?.participants).toEqual([{ id: "rohan-id", displayName: "Rohan" }]);
    expect(restarted.getState().spaces["room"]?.recentMessages[0]?.text).toBe("I like Italian food.");
    expect(restarted.getState().ingestedMessageIds["room:m1"]).toBe(true);
  });

  it("ignores the agent's own messages", async () => {
    let calls = 0;
    const store = createMemoryStateStore();
    const shared = deps(store, undefined, async () => {
      calls += 1;
      return "loop";
    });
    const agent = await handleInboundMessage(
      inbound({ spaceId: "loop", messageId: "agent-1", senderKind: "agent", text: "@agent say that again" }),
      actions([]),
      shared,
    );
    const outbound = await handleInboundMessage(
      inbound({ spaceId: "loop", messageId: "out-1", direction: "outbound", text: "@agent say that again" }),
      actions([]),
      shared,
    );

    expect(agent).toBe("ignored");
    expect(outbound).toBe("ignored");
    expect(calls).toBe(0);
    const listener = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(listener).toContain('message.sender?.kind === "agent"');
    expect(listener).toContain("senderKind: message.sender?.kind");
  });

  it("answers two spaces at the same time without mixing context or threads", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const seen: SuggestInput[] = [];
    const sinks = { alpha: [] as string[], beta: [] as string[] };
    const shared = deps(store, backboard, async (input) => {
      seen.push(input);
      return `answer:${input.question}`;
    });

    await handleInboundMessage(
      inbound({ spaceId: "alpha", senderId: "keith-id", senderName: "Keith", messageId: "a0", text: "Meet at the alpha pier." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "beta", senderId: "ben-id", senderName: "Ben", messageId: "b0", text: "Meet at the beta pier." }),
      actions([]),
      shared,
    );
    await Promise.all([
      handleInboundMessage(
        inbound({ spaceId: "alpha", messageId: "a1", text: "@agent what did we just say?" }),
        actions(sinks.alpha),
        shared,
      ),
      handleInboundMessage(
        inbound({ spaceId: "beta", senderId: "ben-id", senderName: "Ben", messageId: "b1", text: "@agent what did we just say?" }),
        actions(sinks.beta),
        shared,
      ),
    ]);

    const alpha = seen.find((input) => input.groupLines?.some((line) => line.text.includes("alpha pier")));
    const beta = seen.find((input) => input.groupLines?.some((line) => line.text.includes("beta pier")));
    expect(alpha?.groupLines?.map((line) => line.text).join(" ")).not.toContain("beta pier");
    expect(beta?.groupLines?.map((line) => line.text).join(" ")).not.toContain("alpha pier");
    expect(sinks.alpha).toEqual(["answer:what did we just say?"]);
    expect(sinks.beta).toEqual(["answer:what did we just say?"]);
    expect(alpha?.currentUser?.id).not.toBe(beta?.currentUser?.id);
    const alphaThread = store.getState().threads[threadKey("photon:rohan-id", "alpha")]?.backboardThreadId;
    const betaThread = store.getState().threads[threadKey("photon:ben-id", "beta")]?.backboardThreadId;
    expect(alphaThread).toBeTruthy();
    expect(betaThread).toBeTruthy();
    expect(alphaThread).not.toBe(betaThread);
  });

  it("still answers from group context when Backboard is down", async () => {
    const store = createMemoryStateStore();
    const backboard: BackboardClient = {
      async createAssistant() {
        throw Object.assign(new Error("down"), { name: "TimeoutError" });
      },
      async createThread() {
        throw new Error("down");
      },
      async sendMessage() {
        throw new Error("down");
      },
      async searchMemories() {
        throw new Error("down");
      },
    };
    let seen: SuggestInput | undefined;
    const sink: string[] = [];
    await handleInboundMessage(
      inbound({ spaceId: "fallback", senderId: "keith-id", senderName: "Keith", messageId: "f1", text: "Let's go to Times Square." }),
      actions([]),
      deps(store, backboard, async () => "unused"),
    );
    const outcome = await handleInboundMessage(
      inbound({ spaceId: "fallback", messageId: "f2", text: "@agent how should we get there?" }),
      actions(sink),
      deps(store, backboard, async (input) => {
        seen = input;
        return "Times Square works.";
      }),
    );

    expect(outcome).toBe("gemini");
    expect(sink).toEqual(["Times Square works."]);
    expect(buildContext(seen as SuggestInput)).toContain("Let's go to Times Square.");
    expect(seen?.userMemories ?? []).toEqual([]);
  });

  it("creates one Backboard thread when the same user and space start together", async () => {
    const store = createMemoryStateStore();
    let sameEntered = 0;
    let otherEntered = 0;
    let releaseSame: () => void = () => undefined;
    const holdSame = new Promise<void>((resolve) => {
      releaseSame = resolve;
    });
    const client: BackboardClient = {
      async createAssistant() {
        throw new Error("assistant should already exist");
      },
      async createThread(assistantId: string) {
        if (assistantId === "asst-rohan") {
          sameEntered += 1;
          await holdSame;
          return { threadId: "thread-rohan-room" };
        }
        otherEntered += 1;
        return { threadId: `thread-other-${otherEntered}` };
      },
      async sendMessage() {
        return { retrievedMemories: [] };
      },
      async searchMemories() {
        return [];
      },
    };

    const same = {
      store,
      userId: "photon:rohan-id",
      photonSpaceId: "room",
      assistantId: "asst-rohan",
      client,
    };
    const pending = Promise.all([
      ...Array.from({ length: 5 }, () => ensureSpaceThread(same)),
      ensureSpaceThread({
        store,
        userId: "photon:ben-id",
        photonSpaceId: "other-room",
        assistantId: "asst-ben",
        client,
      }),
    ]);

    expect(sameEntered).toBe(1);
    expect(otherEntered).toBe(1);
    releaseSame();
    const ids = await pending;

    expect(ids.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => "thread-rohan-room"));
    expect(ids[5]).toBe("thread-other-1");
    expect(store.getState().threads[threadKey("photon:rohan-id", "room")]?.backboardThreadId).toBe("thread-rohan-room");
    expect(store.getState().threads[threadKey("photon:ben-id", "other-room")]?.backboardThreadId).toBe("thread-other-1");
    expect(Object.keys(store.getState().threads)).toHaveLength(2);

    const again = await ensureSpaceThread(same);
    expect(again).toBe("thread-rohan-room");
    expect(sameEntered).toBe(1);
  });

  it("does not keep a thread mapping when Backboard thread creation fails", async () => {
    const store = createMemoryStateStore();
    let calls = 0;
    const client: BackboardClient = {
      async createAssistant() {
        return { assistantId: "asst-1" };
      },
      async createThread() {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return { threadId: "thread-after-retry" };
      },
      async sendMessage() {
        return { retrievedMemories: [] };
      },
      async searchMemories() {
        return [];
      },
    };
    const options = {
      store,
      userId: "photon:rohan-id",
      photonSpaceId: "room",
      assistantId: "asst-1",
      client,
    };
    const failed = await Promise.allSettled([ensureSpaceThread(options), ensureSpaceThread(options)]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    expect(store.getState().threads[threadKey("photon:rohan-id", "room")]).toBeUndefined();

    const threadId = await ensureSpaceThread(options);
    expect(threadId).toBe("thread-after-retry");
    expect(calls).toBe(2);
  });
});

describe("place context after restart", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function restartedTransport(resolved: string[]) {
    const requested: TravelMode[] = [];
    return createTransportationService({
      routing: routing(requested),
      resolver: {
        resolve: async (query) => {
          resolved.push(query);
          return lookupGazetteer(query);
        },
      },
    });
  }

  it("rebuilds Times Square from the persisted transcript after a new transport cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-places-"));
    dirs.push(dir);
    const file = join(dir, "state.json");
    const first = createFileStateStore(file);
    const quiet = deps(first, undefined, async () => "unused");
    await handleInboundMessage(
      inbound({ spaceId: "after-restart", senderId: "keith-id", senderName: "Keith", messageId: "k1", text: "Let's go to Times Square." }),
      actions([]),
      quiet,
    );
    await handleInboundMessage(
      inbound({ spaceId: "after-restart", messageId: "r1", text: "Sure." }),
      actions([]),
      quiet,
    );

    const resolved: string[] = [];
    const sink: string[] = [];
    const restarted = createFileStateStore(file);
    await handleInboundMessage(
      inbound({ spaceId: "after-restart", messageId: "r2", text: "@agent how should we get there?" }),
      actions(sink),
      deps(restarted, undefined, async () => "unused", { transport: restartedTransport(resolved) }),
    );

    expect(resolved.join(" ")).toMatch(/Times Square/);
    expect(sink[0]).toMatch(/Times Square/);
    expect(sink[0]).not.toMatch(/Where are you trying to go/);
  });

  it("rebuilds both the origin and the destination from the persisted transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-places-both-"));
    dirs.push(dir);
    const file = join(dir, "state.json");
    const first = createFileStateStore(file);
    const quiet = deps(first, undefined, async () => "unused");
    await handleInboundMessage(
      inbound({
        spaceId: "after-restart-both",
        senderId: "keith-id",
        senderName: "Keith",
        messageId: "o1",
        text: "We're at Columbia University.",
      }),
      actions([]),
      quiet,
    );
    await handleInboundMessage(
      inbound({
        spaceId: "after-restart-both",
        senderId: "keith-id",
        senderName: "Keith",
        messageId: "d1",
        text: "Let's go to Times Square.",
      }),
      actions([]),
      quiet,
    );

    const resolved: string[] = [];
    const sink: string[] = [];
    const restarted = createFileStateStore(file);
    await handleInboundMessage(
      inbound({ spaceId: "after-restart-both", messageId: "ask", text: "@agent how should we get there?" }),
      actions(sink),
      deps(restarted, undefined, async () => "unused", { transport: restartedTransport(resolved) }),
    );

    expect(resolved.join(" ")).toMatch(/Columbia/);
    expect(resolved.join(" ")).toMatch(/Times Square/);
    expect(sink[0]).toMatch(/20 min/);
    expect(sink[0]).not.toMatch(/Where are you starting from/);
  });
});

it("claims inbound message IDs before async work and retains them across store reloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inbound-dedup-"));
  const statePath = join(dir, "state.json");
  const store = createFileStateStore(statePath);
  const sink: string[] = [];
  let calls = 0;
  const dependencies = deps(store, undefined, async () => { calls++; return "One answer"; });
  const message = inbound({ spaceId: "dedup", messageId: "original", messageIds: ["original", "correction"], text: "@agent coffee\n*tea" });
  await Promise.all([
    handleInboundMessage(message, actions(sink), dependencies),
    handleInboundMessage(message, actions(sink), dependencies),
  ]);
  const reloaded = createFileStateStore(statePath);
  await handleInboundMessage({ ...message, messageIds: undefined, messageId: "correction" }, actions(sink), { ...dependencies, store: reloaded });
  rmSync(dir, { recursive: true, force: true });
  expect(calls).toBe(1);
  expect(sink).toHaveLength(1);
});
