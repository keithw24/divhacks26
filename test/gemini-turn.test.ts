import { describe, expect, it } from "vitest";
import type { SuggestInput } from "../src/agent/suggest.js";
import { FRIENDLY_FAILURE, runConversationTurn, type TurnActions } from "../src/agent/turn.js";
import { recordMessage, transcript } from "../src/chat/context.js";
import { ConversationMemory } from "../src/transport/context.js";
import { createTransportationService } from "../src/transport/service.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import type { RouteResult, RoutingProvider } from "../src/transport/types.js";

function actions(sink: { replies: string[]; sends: string[] }): TurnActions {
  return {
    reply: async (text) => {
      sink.replies.push(text);
      return { id: "reply" };
    },
    send: async (text) => {
      sink.sends.push(text);
      return { id: "send" };
    },
    responding: async (fn) => fn(),
  };
}

describe("Photon turn → Gemini", () => {
  it("sends a Gemini answer back through the same space reply", async () => {
    const sink = { replies: [] as string[], sends: [] as string[] };
    let seenSpace = "";
    const outcome = await runConversationTurn(
      { spaceId: "dm-gemini", direction: "inbound", isGroup: false, question: "what should we do?" },
      actions(sink),
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: async (input) => {
          seenSpace = input.question;
          return "Walk to a nearby park.";
        },
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );

    expect(outcome).toBe("gemini");
    expect(seenSpace).toBe("what should we do?");
    expect(sink.replies).toEqual(["Walk to a nearby park."]);
    expect(sink.sends).toEqual([]);
  });

  it("keeps Gemini transcripts isolated by space.id", async () => {
    recordMessage("space-alpha", "ann", "Meet at the alpha pier.");
    recordMessage("space-alpha", "ann", "what should we do?");
    recordMessage("space-beta", "bob", "Meet at the beta pier.");
    recordMessage("space-beta", "bob", "what should we do?");

    const seen: string[] = [];
    const suggest = (spaceId: string) => async (input: SuggestInput) => {
      seen.push(`${spaceId}: ${input.transcript.map((line) => line.text).join(" | ")}`);
      return `answer for ${spaceId}`;
    };

    await runConversationTurn(
      { spaceId: "space-alpha", direction: "inbound", isGroup: false, question: "what should we do?" },
      actions({ replies: [], sends: [] }),
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: suggest("space-alpha"),
        transcript: () => transcript("space-alpha"),
        recordAssistant: () => undefined,
      },
    );
    await runConversationTurn(
      { spaceId: "space-beta", direction: "inbound", isGroup: true, question: "what should we do?" },
      actions({ replies: [], sends: [] }),
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: suggest("space-beta"),
        transcript: () => transcript("space-beta"),
        recordAssistant: () => undefined,
      },
    );

    expect(seen[0]).toContain("alpha pier");
    expect(seen[0]).not.toContain("beta pier");
    expect(seen[1]).toContain("beta pier");
    expect(seen[1]).not.toContain("alpha pier");
  });

  it("does not call Gemini for outbound or agent messages", async () => {
    let calls = 0;
    const sink = { replies: [] as string[], sends: [] as string[] };
    const deps = {
      autoReply: true,
      handleTransport: async () => {
        calls += 1;
        return { handled: false, acknowledgement: "👍" };
      },
      suggest: async () => {
        calls += 1;
        return "nope";
      },
      transcript: () => [],
      recordAssistant: () => undefined,
    };

    const outbound = await runConversationTurn(
      { spaceId: "dm-1", direction: "outbound", isGroup: false, question: "hello" },
      actions(sink),
      deps,
    );
    const self = await runConversationTurn(
      { spaceId: "dm-1", direction: "inbound", senderKind: "agent", isGroup: false, question: "hello" },
      actions(sink),
      deps,
    );

    expect(outbound).toBe("ignored");
    expect(self).toBe("ignored");
    expect(calls).toBe(0);
    expect(sink.replies).toEqual([]);
  });

  it("skips Gemini and transportation when auto-reply is off", async () => {
    let calls = 0;
    const outcome = await runConversationTurn(
      { spaceId: "dm-1", direction: "inbound", isGroup: false, question: "How do I get to Times Square?" },
      actions({ replies: [], sends: [] }),
      {
        autoReply: false,
        handleTransport: async () => {
          calls += 1;
          return { handled: true, acknowledgement: "👍", reply: "route" };
        },
        suggest: async () => {
          calls += 1;
          return "gemini";
        },
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );

    expect(outcome).toBe("silent");
    expect(calls).toBe(0);
  });

  it("returns a friendly failure and accepts the next turn after Gemini throws", async () => {
    const sink = { replies: [] as string[], sends: [] as string[] };
    let attempt = 0;
    const failed = await runConversationTurn(
      { spaceId: "dm-fail", direction: "inbound", isGroup: false, question: "what now?" },
      actions(sink),
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: async () => {
          attempt += 1;
          throw new Error("Gemini unavailable");
        },
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );
    const recovered = await runConversationTurn(
      { spaceId: "dm-fail", direction: "inbound", isGroup: false, question: "what now?" },
      actions(sink),
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: async () => "Still here.",
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );

    expect(failed).toBe("failed");
    expect(sink.sends).toEqual([FRIENDLY_FAILURE]);
    expect(recovered).toBe("gemini");
    expect(sink.replies).toContain("Still here.");
    expect(attempt).toBe(1);
    expect(FRIENDLY_FAILURE).not.toMatch(/Error|stack|key/i);
  });

  it("does not send twice when the provider returns no message", async () => {
    const sink = { replies: [] as string[], sends: [] as string[] };
    await runConversationTurn(
      { spaceId: "dm-fallback", direction: "inbound", isGroup: false, question: "what now?" },
      {
        reply: async (text) => {
          sink.replies.push(text);
          return undefined;
        },
        send: async (text) => {
          sink.sends.push(text);
        },
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: async () => "Use the park.",
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );

    expect(sink.replies).toEqual(["Use the park."]);
    expect(sink.sends).toEqual([]);
  });
});

describe("transportation stays on the transportation path", () => {
  it("does not ask Gemini suggest to invent a route", async () => {
    const route: RouteResult = {
      mode: "TRANSIT",
      durationSeconds: 20 * 60,
      distanceMeters: 3000,
      summary: "1 train",
      steps: [{ mode: "TRANSIT", lineShortName: "1", departureStop: "116 St", arrivalStop: "Times Sq-42 St" }],
    };
    const routing: RoutingProvider = {
      async getRoute() {
        return route;
      },
    };
    const memory = new ConversationMemory();
    const transport = createTransportationService({
      memory,
      routing,
      resolver: { async resolve(query) { return lookupGazetteer(query); } },
    });
    const sink = { replies: [] as string[], sends: [] as string[] };
    let suggested = false;

    const outcome = await runConversationTurn(
      {
        spaceId: "group-route",
        direction: "inbound",
        isGroup: true,
        question: "How do I get from Columbia University to Times Square?",
      },
      actions(sink),
      {
        autoReply: true,
        handleTransport: (request) => transport.handle(request),
        suggest: async () => {
          suggested = true;
          return "invented route";
        },
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );

    expect(outcome).toBe("transport");
    expect(suggested).toBe(false);
    expect(sink.replies[0]).toContain("20 min");
    expect(sink.replies[0]).not.toContain("invented");
    expect(memory.get("group-route").destination?.name).toMatch(/Times Square/);
  });
});

it("does not send an additional failure text when delivery may already have succeeded", async () => {
  const sent: string[] = [];
  const outcome = await runConversationTurn(
    { spaceId: "delivery-timeout", direction: "inbound", isGroup: false, question: "what now?" },
    {
      reply: async (text) => { sent.push(text); throw new Error("timeout after send"); },
      send: async (text) => { sent.push(text); },
      responding: async (fn) => fn(),
    },
    {
      autoReply: true,
      handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
      suggest: async () => "Use the park.",
      transcript: () => [],
      recordAssistant: () => undefined,
    },
  );
  expect(outcome).toBe("failed");
  expect(sent).toEqual(["Use the park."]);
});
