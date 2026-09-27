import { describe, expect, it } from "vitest";
import { processPhotonTextMessage } from "../src/transport/dispatch.js";
import { ConversationMemory } from "../src/transport/context.js";
import { createTransportationServiceFromEnv } from "../src/transport/factory.js";
import { inspectMapsGrounding } from "../src/transport/grounding.js";
import { extractTransportIntent } from "../src/transport/intent.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import { createTransportationService } from "../src/transport/service.js";
import {
  UNGROUNDED_FALLBACK,
  USER_FALLBACK,
  type GeminiGroundedText,
  type GeminiMapsClient,
  type PlaceResolver,
  type RouteResult,
  type RoutingProvider,
} from "../src/transport/types.js";

const columbia = lookupGazetteer("Columbia University").places[0]!;
const timesSquare = lookupGazetteer("Times Square").places[0]!;
const katzs = lookupGazetteer("Katz's").places[0]!;
const washingtonSquare = lookupGazetteer("Washington Square Park").places[0]!;

const transitRoute: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 35 * 60,
  distanceMeters: 7200,
  summary: "1 train",
  steps: [
    {
      mode: "TRANSIT",
      lineShortName: "1",
      departureStop: "116 St-Columbia University",
      arrivalStop: "Times Sq-42 St",
      headsign: "South Ferry",
    },
  ],
};

const walkLong: RouteResult = {
  mode: "WALK",
  durationSeconds: 75 * 60,
  distanceMeters: 6000,
  steps: [],
};

const walkShort: RouteResult = {
  mode: "WALK",
  durationSeconds: 12 * 60,
  distanceMeters: 900,
  steps: [],
};

function routingFrom(table: Partial<Record<RouteResult["mode"], RouteResult>>): RoutingProvider {
  return {
    async getRoute(_origin, _destination, mode) {
      return table[mode];
    },
  };
}

function gazetteerResolver(): PlaceResolver {
  return {
    async resolve(query) {
      return lookupGazetteer(query);
    },
  };
}

function failingGemini(): GeminiMapsClient {
  const failure = async () => {
    throw new Error("Gemini unavailable");
  };
  return {
    resolvePlaces: failure,
    nearby: failure,
    phraseDirections: failure,
  };
}

function groundedText(text: string, title = "Times Square"): GeminiGroundedText {
  const sources = [{ title, uri: "https://maps.google.com/?cid=1" }];
  return {
    text,
    sources,
    grounded: true,
    grounding: { grounded: true, sources, supportCount: 1, webSearchQueries: ["directions"] },
  };
}

function ungroundedText(text: string): GeminiGroundedText {
  return {
    text,
    sources: [],
    grounded: false,
    grounding: { grounded: false, sources: [], supportCount: 0, webSearchQueries: [] },
  };
}

function geminiOnly(overrides: Partial<GeminiMapsClient> = {}): GeminiMapsClient {
  return {
    resolvePlaces: async (query) => lookupGazetteer(query),
    nearby: async () => groundedText("Near you: Katz's Delicatessen.", "Katz's Delicatessen"),
    phraseDirections: async (input) =>
      groundedText(
        `From ${input.origin?.name} to ${input.destination?.name} by ${input.modes.join("/")}. Take the 1. About 35 min.`,
        input.destination?.name ?? "Times Square",
      ),
    ...overrides,
  };
}

describe("transport intent", () => {
  it("detects an explicit Columbia to Times Square request", () => {
    const intent = extractTransportIntent("How do I get from Columbia to Times Square?");
    expect(intent.isTransport).toBe(true);
    expect(intent.originQuery?.toLowerCase()).toContain("columbia");
    expect(intent.destinationQuery?.toLowerCase()).toContain("times square");
  });

  it("does not treat a safety question as directions", () => {
    expect(extractTransportIntent("is columbia safe at 11pm").isTransport).toBe(false);
    expect(extractTransportIntent("is it safe there").isTransport).toBe(false);
  });

  it("does not treat a wallet purpose clause as a destination", () => {
    const intent = extractTransportIntent("to make payments");
    expect(intent.isTransport).toBe(false);
    expect(intent.destinationQuery).toBeUndefined();
  });

  it("treats directions home as a trip, including walk home", () => {
    expect(extractTransportIntent("directions home").isTransport).toBe(true);
    expect(extractTransportIntent("directions home").destinationQuery).toBe("home");
    expect(extractTransportIntent("how do I get home").isTransport).toBe(true);
    expect(extractTransportIntent("walk me home").destinationQuery).toBe("home");
  });
});

describe("transportation service", () => {
  it("answers How do I get from Columbia to Times Square?", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });

    const result = await service.handle({
      spaceId: "dm-1",
      text: "How do I get from Columbia to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("1");
    expect(result.reply).toContain("35 min");
    expect(result.reply).toMatch(/116 St-Columbia University/);
    expect(result.reply).not.toMatch(/\{"origin"/);
  });

  it("uses a known origin from context for How do I get to Times Square?", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });

    await service.handle({ spaceId: "dm-2", text: "I’m at Columbia." });
    const result = await service.handle({
      spaceId: "dm-2",
      text: "How do I get to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("35 min");
    expect(result.reply).toContain("1");
  });

  it("answers Can I walk there? when both places are established", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({
        TRANSIT: { ...transitRoute, durationSeconds: 18 * 60 },
        WALK: walkShort,
      }),
    });

    await service.handle({
      spaceId: "dm-3",
      text: "How do I get from Washington Square Park to Katz’s?",
    });
    const result = await service.handle({
      spaceId: "dm-3",
      text: "Can I walk there?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("12 min");
    expect(result.reply).toMatch(/walk/i);
  });

  it("handles Take us to Katz's in a group chat", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });

    const result = await service.handle({
      spaceId: "group-katz",
      senderId: "user-1",
      isGroup: true,
      text: "Take us to Katz's",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/Katz/i);
    expect(result.reply).toMatch(/starting from|116 St|35 min/i);
  });

  it("recovers How do I get there? after a destination appeared earlier", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });

    const first = await service.handle({
      spaceId: "group-context",
      senderId: "user-1",
      isGroup: true,
      text: "Let’s go to Katz’s.",
    });
    expect(first.handled).toBe(false);

    await service.handle({
      spaceId: "group-context",
      senderId: "user-2",
      isGroup: true,
      text: "I’m at Columbia University.",
    });

    const result = await service.handle({
      spaceId: "group-context",
      senderId: "user-1",
      isGroup: true,
      text: "How do I get there?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("35 min");
    expect(katzs.name).toMatch(/Katz/);
    expect(washingtonSquare.name).toMatch(/Washington/);
  });

  it("asks a short clarification for an ambiguous destination", async () => {
    const resolver: PlaceResolver = {
      async resolve(query) {
        if (/joe['’]?s pizza/i.test(query)) {
          return {
            status: "ambiguous",
            query,
            places: [
              {
                name: "Joe's Pizza",
                address: "7 Carmine St, New York, NY",
                latitude: 40.7303,
                longitude: -74.003,
                source: "places",
                confidence: 0.72,
              },
              {
                name: "Joe's Pizza",
                address: "1435 Broadway, New York, NY",
                latitude: 40.7547,
                longitude: -73.987,
                source: "places",
                confidence: 0.7,
              },
            ],
          };
        }
        return lookupGazetteer(query);
      },
    };

    const service = createTransportationService({
      resolver,
      routing: routingFrom({ TRANSIT: transitRoute }),
    });

    const result = await service.handle({
      spaceId: "dm-ambiguous",
      text: "How do I get from Columbia to Joe’s Pizza?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/which/i);
    expect(result.reply).toMatch(/Carmine|Broadway/);
    expect(result.reply).not.toContain("35 min");
  });

  it("asks for a missing origin", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute }),
    });

    const result = await service.handle({
      spaceId: "dm-no-origin",
      text: "How do I get to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/starting from/i);
    expect(result.reply).toMatch(/Times Square/);
    expect(result.reply).not.toContain("35 min");
  });

  it("asks for a missing destination", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute }),
    });

    const result = await service.handle({
      spaceId: "dm-no-dest",
      text: "How do I get there?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/where are you trying to go/i);
    expect(result.reply).not.toContain("35 min");
  });

  it("does not invent a route when Gemini fails", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      gemini: failingGemini(),
    });

    const result = await service.handle({
      spaceId: "dm-gemini-fail",
      text: "How do I get from Columbia to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toMatch(/take the/i);
  });

  it("does not invent a route when Maps routing fails", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: {
        async getRoute() {
          throw new Error("Routes API unavailable");
        },
      },
    });

    const result = await service.handle({
      spaceId: "dm-maps-fail",
      text: "How do I get from Columbia to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toContain("116 St-Columbia University");
  });

  it("keeps two group chats isolated", async () => {
    const memory = new ConversationMemory();
    const service = createTransportationService({
      memory,
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });

    await service.handle({
      spaceId: "group-a",
      isGroup: true,
      text: "Let’s go to Katz’s.",
    });
    await service.handle({
      spaceId: "group-b",
      isGroup: true,
      text: "Let’s go to Times Square.",
    });
    await service.handle({
      spaceId: "group-a",
      isGroup: true,
      text: "I’m at Columbia.",
    });
    await service.handle({
      spaceId: "group-b",
      isGroup: true,
      text: "I’m at Washington Square Park.",
    });

    const a = await service.handle({
      spaceId: "group-a",
      isGroup: true,
      text: "How do I get there?",
    });
    const b = await service.handle({
      spaceId: "group-b",
      isGroup: true,
      text: "How do I get there?",
    });

    expect(memory.get("group-a").destination?.name).toMatch(/Katz/);
    expect(memory.get("group-b").destination?.name).toMatch(/Times Square/);
    expect(memory.get("group-a").origin?.name).toMatch(/Columbia/);
    expect(memory.get("group-b").origin?.name).toMatch(/Washington Square/);
    expect(a.reply).toBeTruthy();
    expect(b.reply).toBeTruthy();
  });

  it("replaces only the destination on a What about Penn Station follow-up", async () => {
    const memory = new ConversationMemory();
    const service = createTransportationService({
      memory,
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });

    await service.handle({
      spaceId: "dest-follow",
      text: "How do I get from Columbia University to Washington Square Park?",
    });
    const result = await service.handle({
      spaceId: "dest-follow",
      text: "What about Penn Station?",
    });

    expect(memory.get("dest-follow").origin?.name).toMatch(/Columbia/);
    expect(memory.get("dest-follow").destination?.name).toMatch(/Penn Station/);
    expect(memory.get("dest-follow").destination?.name).not.toMatch(/Washington/);
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("35 min");
  });
});

describe("Photon message → transportation handler → reply", () => {
  it("replies through the Photon action adapters", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkLong }),
    });
    const replies: string[] = [];
    const reactions: string[] = [];

    const kind = await processPhotonTextMessage(
      {
        spaceId: "photon-dm",
        senderId: "sender-1",
        text: "How do I get from Columbia to Times Square?",
      },
      {
        reply: async (text) => {
          replies.push(text);
          return { id: "sent" };
        },
        send: async () => {
          throw new Error("space.send should not run when reply returns a message");
        },
        react: async (emoji) => {
          reactions.push(emoji);
        },
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        transport: service,
        suggest: async () => {
          throw new Error("Gemini suggest should not run for a transportation question");
        },
      },
    );

    expect(kind).toBe("transport");
    expect(reactions).toEqual(["👍"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("35 min");
    expect(replies[0]).not.toContain("neighborhood report");
  });

  it("keeps non-transport messages on the Gemini BoroughOS path", async () => {
    const service = createTransportationService({ resolver: gazetteerResolver() });
    const replies: string[] = [];
    const questions: string[] = [];

    const kind = await processPhotonTextMessage(
      {
        spaceId: "photon-dm",
        text: "The elevator is broken again",
      },
      {
        reply: async (text) => {
          replies.push(text);
          return { id: "sent" };
        },
        send: async () => {
          throw new Error("space.send should not run when reply returns a message");
        },
        react: async () => ({ id: "react" }),
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        transport: service,
        suggest: async (input) => {
          questions.push(input.question);
          return "I can help look at that neighborhood issue.";
        },
      },
    );

    expect(kind).toBe("gemini");
    expect(questions).toEqual(["The elevator is broken again"]);
    expect(replies[0]).toContain("neighborhood issue");
    expect(replies[0]).not.toContain("35 min");
  });
});

describe("Gemini-only transportation path", () => {
  it("works with GEMINI_API_KEY only and does not require GOOGLE_MAPS_API_KEY", async () => {
    const service = createTransportationServiceFromEnv(
      { geminiApiKey: "test-gemini-key" },
      { resolver: gazetteerResolver(), gemini: geminiOnly() },
    );

    const result = await service.handle({
      spaceId: "gemini-only",
      text: "How do I get from Columbia to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Columbia University");
    expect(result.reply).toContain("Times Square");
    expect(result.reply).toMatch(/Google Maps/);
  });

  it("requests Maps grounding and processes grounding metadata", async () => {
    let requested = false;
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      gemini: geminiOnly({
        phraseDirections: async (input) => {
          requested = Boolean(input.origin && input.destination);
          return groundedText("Take the 1 downtown. Sources: Times Square — Google Maps");
        },
      }),
    });

    const result = await service.handle({
      spaceId: "grounding-meta",
      text: "How do I get from Columbia to Times Square?",
    });

    expect(requested).toBe(true);
    expect(result.reply).toMatch(/Google Maps/);
    expect(
      inspectMapsGrounding({
        groundingChunks: [{ maps: { title: "Times Square", uri: "https://maps.google.com/?cid=1" } }],
        groundingSupports: [{ groundingChunkIndices: [0] }],
      }).grounded,
    ).toBe(true);
  });

  it("detects an ungrounded transportation answer and does not invent route facts", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      gemini: geminiOnly({
        phraseDirections: async () => ungroundedText("Take the 1 downtown from 116 St for 12 minutes and transfer to the N."),
      }),
    });

    const result = await service.handle({
      spaceId: "ungrounded",
      text: "How do I get from Columbia to Times Square?",
    });

    expect(result.reply).toBe(UNGROUNDED_FALLBACK);
    expect(result.reply).not.toContain("116 St");
    expect(result.reply).not.toContain("12 minutes");
    expect(inspectMapsGrounding({})).toEqual({
      grounded: false,
      sources: [],
      supportCount: 0,
      webSearchQueries: [],
    });
  });

  it("preserves origin and destination for Can I walk instead?", async () => {
    let seenOrigin: string | undefined;
    let seenDest: string | undefined;
    let seenModes: string[] = [];

    const service = createTransportationService({
      resolver: gazetteerResolver(),
      gemini: geminiOnly({
        phraseDirections: async (input) => {
          seenOrigin = input.origin?.name;
          seenDest = input.destination?.name;
          seenModes = input.modes;
          return groundedText(`Walking from ${input.origin?.name} to ${input.destination?.name} looks reasonable.`);
        },
      }),
    });

    await service.handle({
      spaceId: "walk-followup",
      text: "I’m at Columbia University.",
    });
    await service.handle({
      spaceId: "walk-followup",
      text: "How should I get to Washington Square Park?",
    });
    const result = await service.handle({
      spaceId: "walk-followup",
      text: "Can I walk instead?",
    });

    expect(seenOrigin).toMatch(/Columbia/);
    expect(seenDest).toMatch(/Washington Square/);
    expect(seenModes).toContain("WALK");
    expect(result.reply).toMatch(/walk/i);
  });

  it("trades a short walk for transit when going home in a less-safe hour", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkShort }),
      safetyLookup: async () =>
        ({
          baselines: { hourVsNyc: 1.9, areaVsNyc: 1.4 },
        }) as never,
    });
    service.noteCoordinates("home-1", { latitude: columbia.latitude!, longitude: columbia.longitude! });

    const result = await service.handle({
      spaceId: "home-1",
      text: "directions home",
      preferences: { defaultOrigin: "Times Square" },
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/1 train|116 St-Columbia University/);
    expect(result.reply).toMatch(/less safe than typical NYC/);
    expect(result.reply).not.toMatch(/I’d walk rather than wait/);
  });

  it("keeps the short walk home when the hour looks like typical NYC", async () => {
    const service = createTransportationService({
      resolver: gazetteerResolver(),
      routing: routingFrom({ TRANSIT: transitRoute, WALK: walkShort }),
      safetyLookup: async () =>
        ({
          baselines: { hourVsNyc: 1.0, areaVsNyc: 0.9 },
        }) as never,
    });
    service.noteCoordinates("home-2", { latitude: columbia.latitude!, longitude: columbia.longitude! });

    const result = await service.handle({
      spaceId: "home-2",
      text: "directions home",
      preferences: { defaultOrigin: "Times Square" },
    });

    expect(result.reply).toMatch(/I’d walk rather than wait for the subway/);
    expect(result.reply).not.toMatch(/less safe than typical NYC/);
  });
});
