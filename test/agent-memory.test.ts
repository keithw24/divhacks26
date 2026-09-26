import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMemory } from "../src/agent/classify.js";
import { reconcileMemories } from "../src/agent/decisions.js";
import { handleInboundMessage, type InboundDeps, type InboundMessage } from "../src/agent/inbound.js";
import { logAgentTurn, redactSecrets } from "../src/agent/log.js";
import { parseAgentInvocation } from "../src/chat/invoke.js";
import { buildContext } from "../src/agent/suggest.js";
import type { SuggestInput } from "../src/agent/suggest.js";
import { systemPrompt } from "../src/agent/prompt.js";
import {
  BackboardRequestError,
  type BackboardClient,
  type SendMessageInput,
} from "../src/backboard/client.js";
import { resolveUser, userIdFor } from "../src/identity/users.js";
import { createFileStateStore, createMemoryStateStore, type StateStore } from "../src/store/state.js";
import { createTransportationService } from "../src/transport/service.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import type { RouteResult, TravelMode } from "../src/transport/types.js";

const SECRET = "super-secret-backboard-key";

class FakeBackboard implements BackboardClient {
  assistants: string[] = [];
  threads: { assistantId: string; threadId: string }[] = [];
  sent: SendMessageInput[] = [];
  memories = new Map<string, string[]>();
  fail: { kind: BackboardRequestError["kind"]; status?: number } | null = null;

  async createAssistant(input: { name: string; systemPrompt: string }) {
    this.assertOk();
    expect(input.systemPrompt.toLowerCase()).toContain("exactly one person");
    const assistantId = `asst-${this.assistants.length + 1}`;
    this.assistants.push(assistantId);
    return { assistantId };
  }

  async createThread(assistantId: string) {
    this.assertOk();
    const threadId = `thread-${this.threads.length + 1}`;
    this.threads.push({ assistantId, threadId });
    return { threadId };
  }

  async sendMessage(input: SendMessageInput) {
    this.assertOk();
    this.sent.push(input);
    if (input.memory === "Auto" || input.memoryPro === "Auto") {
      const existing = this.memories.get(input.assistantId) ?? [];
      this.memories.set(input.assistantId, [...existing, input.content]);
    }
    const retrieved =
      input.memory === "Readonly" || input.memoryPro === "Readonly"
        ? (this.memories.get(input.assistantId) ?? [])
        : [];
    return { assistantId: input.assistantId, threadId: input.threadId, retrievedMemories: retrieved };
  }

  async searchMemories(assistantId: string) {
    this.assertOk();
    return this.memories.get(assistantId) ?? [];
  }

  private assertOk() {
    if (this.fail) throw new BackboardRequestError(this.fail.kind, this.fail.status);
  }
}

function actions(sink: string[]) {
  return {
    reply: async (text: string) => {
      sink.push(text);
      return { id: "reply" };
    },
    send: async (text: string) => {
      sink.push(`send:${text}`);
      return { id: "send" };
    },
    responding: async <T>(fn: () => Promise<T>) => fn(),
  };
}

function deps(store: StateStore, backboard: BackboardClient | undefined, suggest: InboundDeps["suggest"], extra?: Partial<InboundDeps>): InboundDeps {
  return {
    autoReply: true,
    store,
    backboard,
    memoryPro: false,
    writeMode: "Auto",
    verboseMemory: false,
    secrets: [SECRET],
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
    messageId: partial.messageId ?? `m-${partial.text.slice(0, 12)}`,
    senderId: partial.senderId ?? "rohan-id",
    senderName: partial.senderName ?? "Rohan",
    timestamp: partial.timestamp ?? "2026-09-26T18:00:00.000Z",
    isGroup: partial.isGroup ?? true,
    spaceId: partial.spaceId,
    text: partial.text,
  };
}

describe("@agent detection and group context", () => {
  it("answers an explicit @agent request in that Photon space", async () => {
    const sink: string[] = [];
    let seen = "";
    const outcome = await handleInboundMessage(
      inbound({ spaceId: "space-eat", text: "@agent where should we eat tonight?" }),
      actions(sink),
      deps(createMemoryStateStore(), undefined, async (input) => {
        seen = input.question;
        return "Try a vegetarian spot nearby.";
      }),
    );
    expect(outcome).toBe("gemini");
    expect(seen).toBe("where should we eat tonight?");
    expect(sink).toEqual(["Try a vegetarian spot nearby."]);
  });

  it("does not answer an ordinary group message", async () => {
    let calls = 0;
    const sink: string[] = [];
    const outcome = await handleInboundMessage(
      inbound({ spaceId: "space-quiet", text: "what time is dinner?" }),
      actions(sink),
      deps(createMemoryStateStore(), undefined, async () => {
        calls += 1;
        return "nope";
      }),
    );
    expect(outcome).toBe("unaddressed");
    expect(calls).toBe(0);
    expect(sink).toEqual([]);
  });

  it("recognizes @Agent and extracts the request", () => {
    expect(parseAgentInvocation("@Agent where should we eat?").invoked).toBe(true);
    expect(parseAgentInvocation("@AGENT summarize what we decided").request).toBe("summarize what we decided");
    expect(parseAgentInvocation("guys what do you think? @agent give us some options").request).toBe(
      "guys what do you think? give us some options",
    );
    expect(parseAgentInvocation("@agent").request).toBe("");
    expect(parseAgentInvocation("lol").invoked).toBe(false);
  });

  it("sends recent context from the same space only", async () => {
    const store = createMemoryStateStore();
    const seen: SuggestInput[] = [];
    const suggest = async (input: SuggestInput) => {
      seen.push(input);
      return "noted";
    };
    const base = deps(store, undefined, suggest);
    await handleInboundMessage(inbound({ spaceId: "space-alpha", senderId: "keith-id", senderName: "Keith", text: "Meet at the alpha pier." }), actions([]), base);
    await handleInboundMessage(inbound({ spaceId: "space-beta", senderId: "bob-id", senderName: "Bob", text: "Meet at the beta pier." }), actions([]), base);
    await handleInboundMessage(inbound({ spaceId: "space-alpha", text: "@agent what did we decide?" }), actions([]), base);

    const prompt = buildContext(seen[0] as SuggestInput);
    expect(prompt).toContain("RECENT GROUP CONTEXT");
    expect(prompt).toContain("alpha pier");
    expect(prompt).not.toContain("beta pier");
    expect(prompt).toContain("CURRENT USER");
    expect(prompt).toContain("Rohan");
  });
});

describe("Backboard identity and memory", () => {
  it("maps one Photon user to one stable assistant and gives another user a different assistant", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const first = await resolveUser({ store, photonIdentifier: "rohan-id", displayName: "Rohan", client: backboard });
    const again = await resolveUser({ store, photonIdentifier: "rohan-id", displayName: "Rohan", client: backboard });
    const other = await resolveUser({ store, photonIdentifier: "keith-id", displayName: "Rohan", client: backboard });

    expect(first.userId).toBe(userIdFor("rohan-id"));
    expect(first.backboardAssistantId).toBe(again.backboardAssistantId);
    expect(other.backboardAssistantId).not.toBe(first.backboardAssistantId);
    expect(backboard.assistants).toHaveLength(2);
    expect(store.getState().users["rohan-id"]?.photonIdentifier).toBe("rohan-id");
    expect(store.getState().users["Rohan"]).toBeUndefined();
  });

  it("keeps the same assistant across two group chats", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    const seen: SuggestInput[] = [];
    const shared = deps(store, backboard, async (input) => {
      seen.push(input);
      return "Take the subway.";
    });
    await handleInboundMessage(
      inbound({ spaceId: "chat-1", text: "I always take the subway instead of Uber." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({ spaceId: "chat-2", text: "@agent what form of transportation do I prefer?" }),
      actions([]),
      shared,
    );

    expect(backboard.assistants).toHaveLength(1);
    const writes = backboard.sent.filter((message) => message.memory === "Auto");
    const reads = backboard.sent.filter((message) => message.memory === "Readonly");
    expect(writes.map((message) => message.content)).toEqual(["I always take the subway instead of Uber."]);
    expect(writes[0]?.sendToLlm).toBe(false);
    expect(writes[0]?.assistantId).toBe(reads[0]?.assistantId);
    expect(seen[0]?.userMemories?.join(" ")).toMatch(/subway/i);
    const prompt = buildContext(seen[0] as SuggestInput);
    expect(prompt).toContain("RELEVANT MEMORY FOR Rohan");
    expect(prompt).toMatch(/subway/i);
  });

  it("ingests a durable preference and skips lol", async () => {
    expect(classifyMemory("I hate walking through Midtown.")).toBe("DURABLE_PREFERENCE");
    expect(classifyMemory("I don't eat meat")).toBe("DURABLE_PREFERENCE");
    expect(classifyMemory("lol")).toBe("EPHEMERAL");
    expect(classifyMemory("see you in 5")).toBe("EPHEMERAL");
    expect(classifyMemory("what form of transportation do I prefer?")).toBe("UNCERTAIN");

    const backboard = new FakeBackboard();
    const store = createMemoryStateStore();
    const shared = deps(store, backboard, async () => "unused");
    await handleInboundMessage(inbound({ spaceId: "facts", text: "I don't eat meat" }), actions([]), shared);
    await handleInboundMessage(inbound({ spaceId: "facts", text: "lol" }), actions([]), shared);

    expect(backboard.sent).toHaveLength(1);
    expect(backboard.sent[0]?.content).toBe("I don't eat meat");
    expect(backboard.sent[0]?.memory).toBe("Auto");
    expect(backboard.sent[0]?.sendToLlm).toBe(false);
  });

  it("lets a newer preference supersede a stale one", () => {
    const reconciled = reconcileMemories(
      ["I hate sushi."],
      ["I hate sushi.", "I've started liking sushi recently."],
    );
    expect(reconciled.memories.join(" ")).not.toMatch(/hate sushi/i);
    expect(reconciled.overrides.join(" ")).toMatch(/liking sushi/i);
    expect(reconciled.overrides.join(" ")).not.toMatch(/hate sushi/i);
  });

  it("passes attributed participant memories and does not merge assistants", async () => {
    const store = createMemoryStateStore();
    const backboard = new FakeBackboard();
    store.update((state) => {
      state.users["keith-id"] = {
        userId: "photon:keith-id",
        photonIdentifier: "keith-id",
        displayName: "Keith",
        backboardAssistantId: "asst-keith",
      };
    });
    backboard.memories.set("asst-keith", ["Keith is vegetarian."]);
    let seen: SuggestInput | undefined;
    await handleInboundMessage(
      inbound({ spaceId: "dinner", senderId: "keith-id", senderName: "Keith", text: "I'm around." }),
      actions([]),
      deps(store, backboard, async () => "no"),
    );
    await handleInboundMessage(
      inbound({ spaceId: "dinner", text: "@agent where should all four of us eat?" }),
      actions([]),
      deps(store, backboard, async (input) => {
        seen = input;
        return "Somewhere vegetarian works.";
      }),
    );

    expect(seen?.participantMemories).toEqual([
      { userId: "photon:keith-id", displayName: "Keith", memories: ["Keith is vegetarian."] },
    ]);
    expect(seen?.userMemories ?? []).not.toContain("Keith is vegetarian.");
    const prompt = buildContext(seen as SuggestInput);
    expect(prompt).toContain("Keith (photon:keith-id)");
    expect(prompt).toContain("Keith is vegetarian.");
    expect(backboard.assistants.filter((id) => id === "asst-keith")).toHaveLength(0);
  });

  it("does not repeat private memory in the group reply", async () => {
    const sink: string[] = [];
    const backboard = new FakeBackboard();
    await handleInboundMessage(
      inbound({ spaceId: "private-walk", text: "I don't like walking through Midtown." }),
      actions([]),
      deps(createMemoryStateStore(), backboard, async () => "unused"),
    );
    await handleInboundMessage(
      inbound({ spaceId: "private-walk", text: "@agent how should we get to the restaurant?" }),
      actions(sink),
      deps(createMemoryStateStore(), backboard, async () => {
        return "Rohan told me three months ago in a private chat that he hates walking through Midtown. I'd lean toward the subway route here since it avoids that walk.";
      }),
    );

    expect(sink[0]).not.toMatch(/private chat|told me|months ago/i);
    expect(sink[0]).toMatch(/subway/i);
    expect(systemPrompt(true, { personalized: true })).toMatch(/do not reveal private/i);
  });
});

describe("memory changes transportation decisions", () => {
  const walk: RouteResult = {
    mode: "WALK",
    durationSeconds: 40 * 60,
    steps: [{ mode: "WALK", instruction: "Walk through Midtown" }],
  };
  const transit: RouteResult = {
    mode: "TRANSIT",
    durationSeconds: 20 * 60,
    steps: [{ mode: "TRANSIT", lineShortName: "1", departureStop: "116 St", arrivalStop: "Times Sq-42 St" }],
  };
  const drive: RouteResult = {
    mode: "DRIVE",
    durationSeconds: 25 * 60,
    steps: [{ mode: "DRIVE", instruction: "Drive via the highway" }],
  };

  function routing(requested: TravelMode[]) {
    return {
      async getRoute(_origin: unknown, _destination: unknown, mode: TravelMode) {
        requested.push(mode);
        if (mode === "DRIVE") return drive;
        if (mode === "TRANSIT") return transit;
        return walk;
      },
    };
  }

  it("drops a walk through an avoided area when transit exists", async () => {
    const requested: TravelMode[] = [];
    const backboard = new FakeBackboard();
    const store = createMemoryStateStore();
    const transport = createTransportationService({
      routing: routing(requested),
      resolver: { resolve: async (query) => lookupGazetteer(query) },
    });
    const sink: string[] = [];
    const shared = deps(store, backboard, async () => "should not be used", { transport });
    await handleInboundMessage(
      inbound({ spaceId: "route-walk", isGroup: false, text: "I don't like walking through Midtown." }),
      actions([]),
      shared,
    );
    const outcome = await handleInboundMessage(
      inbound({
        spaceId: "route-walk",
        isGroup: false,
        text: "@agent how should I get from Columbia University to Times Square?",
      }),
      actions(sink),
      shared,
    );

    expect(outcome).toBe("transport");
    expect(sink[0]).toMatch(/20 min/);
    expect(sink[0]).not.toMatch(/Walk through Midtown/);
    expect(sink[0]).toMatch(/avoids that walk/);
  });

  it("follows an explicit Uber request instead of an older subway preference", async () => {
    const requested: TravelMode[] = [];
    const backboard = new FakeBackboard();
    const store = createMemoryStateStore();
    const transport = createTransportationService({
      routing: routing(requested),
      resolver: { resolve: async (query) => lookupGazetteer(query) },
    });
    const sink: string[] = [];
    const shared = deps(store, backboard, async () => "should not be used", { transport });
    await handleInboundMessage(
      inbound({ spaceId: "route-uber", isGroup: false, text: "I usually prefer the subway." }),
      actions([]),
      shared,
    );
    await handleInboundMessage(
      inbound({
        spaceId: "route-uber",
        isGroup: false,
        text: "@agent get us an Uber from Columbia University to Times Square.",
      }),
      actions(sink),
      shared,
    );

    expect(requested).toEqual(["DRIVE"]);
    expect(sink[0]).toMatch(/Drive is about 25 min/);
    expect(sink[0]).not.toMatch(/Take the 1/);
  });
});

describe("Backboard failures fall back to Gemini", () => {
  const cases: Array<{ kind: BackboardRequestError["kind"]; status?: number }> = [
    { kind: "timeout" },
    { kind: "unauthorized", status: 401 },
    { kind: "forbidden", status: 403 },
    { kind: "rate_limit", status: 429 },
    { kind: "server", status: 500 },
    { kind: "malformed" },
  ];

  for (const failure of cases) {
    it(`still replies when Backboard returns ${failure.kind}`, async () => {
      const backboard = new FakeBackboard();
      backboard.fail = failure;
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((message) => {
        errors.push(String(message));
      });
      const sink: string[] = [];
      let called = false;
      const outcome = await handleInboundMessage(
        inbound({ spaceId: `fail-${failure.kind}`, text: "@agent where should we eat?" }),
        actions(sink),
        deps(createMemoryStateStore(), backboard, async () => {
          called = true;
          return "Use the recent chat.";
        }),
      );
      spy.mockRestore();

      expect(outcome).toBe("gemini");
      expect(called).toBe(true);
      expect(sink).toEqual(["Use the recent chat."]);
      expect(errors.join("\n")).toContain(failure.kind);
      expect(errors.join("\n")).not.toContain(SECRET);
    });
  }

  it("answers with empty memory", async () => {
    const seen: SuggestInput[] = [];
    const outcome = await handleInboundMessage(
      inbound({ spaceId: "empty-memory", text: "@agent what time should we leave?" }),
      actions([]),
      deps(createMemoryStateStore(), new FakeBackboard(), async (input) => {
        seen.push(input);
        return "Leave at 6.";
      }),
    );
    expect(outcome).toBe("gemini");
    expect(seen[0]?.userMemories).toEqual([]);
    expect(buildContext(seen[0] as SuggestInput)).toContain("- none");
  });

  it("does not log the API key or memory text by default", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((message) => {
      lines.push(String(message));
    });
    logAgentTurn(
      {
        spaceId: `space ${SECRET}`,
        senderId: "rohan-id",
        recentContextMessageCount: 2,
        backboardEnabled: true,
        backboardAssistantFound: true,
        retrievedMemoryCount: 1,
        otherParticipantsQueried: 0,
        geminiCalled: true,
        responseSent: true,
      },
      { secrets: [SECRET] },
    );
    spy.mockRestore();
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).toContain("[redacted]");
    expect(lines.join("\n")).not.toContain("hates walking through Midtown");
    expect(redactSecrets(`key ${SECRET}`, [SECRET])).toBe("key [redacted]");
  });
});

describe("persisted agent state", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("reloads the same assistant id after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-state-"));
    dirs.push(dir);
    const file = join(dir, "agent-state.json");
    const first = createFileStateStore(file);
    first.update((state) => {
      state.users["rohan-id"] = {
        userId: "photon:rohan-id",
        photonIdentifier: "rohan-id",
        displayName: "Rohan",
        backboardAssistantId: "asst-rohan",
      };
      state.spaces["space-1"] = {
        photonSpaceId: "space-1",
        participants: [{ id: "rohan-id", displayName: "Rohan" }],
        recentMessages: [
          {
            id: "m1",
            spaceId: "space-1",
            senderId: "rohan-id",
            senderName: "Rohan",
            text: "I like Italian food.",
            timestamp: "2026-09-26T18:00:00.000Z",
          },
        ],
      };
    });
    const second = createFileStateStore(file);
    expect(second.getState().users["rohan-id"]?.backboardAssistantId).toBe("asst-rohan");
    expect(second.getState().spaces["space-1"]?.recentMessages[0]?.text).toBe("I like Italian food.");
  });
});
