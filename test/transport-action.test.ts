import { describe, expect, it } from "vitest";
import { decisionConstraints } from "../src/agent/decisions.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { DIRECTIONS_AUTHORIZATION_RULE, directionsModelInstructions } from "../src/transport/gemini.js";
import { extractTransportIntent } from "../src/transport/intent.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import { chooseTransportStep } from "../src/transport/service.js";
import { USER_FALLBACK, type PlaceResolver, type RouteResult } from "../src/transport/types.js";
import { createRouteHarness, scriptedGemini } from "./maps/support.js";

const FORBIDDEN_OFFER =
  /want me to|would you like me to|should i check|i can check|want directions|check train status/i;

const transit: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 20 * 60,
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
  durationSeconds: 40 * 60,
  distanceMeters: 6000,
  steps: [{ mode: "WALK", instruction: "Walk south" }],
};

describe("directions are answered immediately", () => {
  it("A. answers Columbia University to Times Square on the first turn", async () => {
    const { service, calls } = createRouteHarness({
      routes: { TRANSIT: { ...transit, durationSeconds: 35 * 60 }, WALK: { ...walkLong, durationSeconds: 75 * 60 } },
    });

    const result = await service.handle({
      spaceId: "action-a",
      text: "How do I get from Columbia University to Times Square?",
    });

    expect(result.handled).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(result.reply).toMatch(/35 min/);
    expect(result.reply).toMatch(/116 St-Columbia University/);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
    expect(result.reply).not.toMatch(/\?/);
  });

  it("B. compares routes for the fastest way from Times Square to Grand Central", async () => {
    const subway: RouteResult = {
      mode: "TRANSIT",
      durationSeconds: 8 * 60,
      steps: [
        {
          mode: "TRANSIT",
          lineShortName: "S",
          departureStop: "Times Sq-42 St",
          arrivalStop: "Grand Central-42 St",
        },
      ],
    };
    const walk: RouteResult = { mode: "WALK", durationSeconds: 25 * 60, steps: [] };
    const { service, calls } = createRouteHarness({ routes: { TRANSIT: subway, WALK: walk } });

    const result = await service.handle({
      spaceId: "action-b",
      text: "What's the fastest way from Times Square to Grand Central?",
    });

    expect(result.handled).toBe(true);
    expect(calls.some((call) => call.mode === "TRANSIT" && /times square/i.test(call.origin))).toBe(true);
    expect(calls.some((call) => call.mode === "WALK" && /grand central/i.test(call.destination))).toBe(true);
    expect(result.reply).toMatch(/8 min/);
    expect(result.reply).toMatch(/25 min/);
    expect(result.reply).toMatch(/fastest/i);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
    expect(result.reply).not.toMatch(/\?/);
  });

  it("compares walking and the subway without asking which lookup to run", async () => {
    const intent = extractTransportIntent("Should I walk or take the subway to Joe's Pizza?");
    expect(intent.isTransport).toBe(true);
    expect(intent.destinationQuery).toMatch(/joe'?s pizza/i);

    const { service, calls } = createRouteHarness({
      routes: {
        WALK: { mode: "WALK", durationSeconds: 12 * 60, steps: [] },
        TRANSIT: { ...transit, durationSeconds: 9 * 60 },
      },
      resolver: {
        async resolve(query) {
          if (/joe/i.test(query)) {
            return {
              status: "resolved",
              query,
              places: [
                {
                  name: "Joe's Pizza",
                  address: "7 Carmine St, New York, NY",
                  latitude: 40.7303,
                  longitude: -74.003,
                  source: "places",
                  confidence: 0.91,
                },
              ],
            };
          }
          return lookupGazetteer(query);
        },
      },
    });

    const result = await service.handle({
      spaceId: "action-compare",
      text: "Should I walk or take the subway from Columbia University to Joe's Pizza?",
    });

    expect(calls.some((call) => call.mode === "WALK" && /joe/i.test(call.destination))).toBe(true);
    expect(calls.some((call) => call.mode === "TRANSIT" && /joe/i.test(call.destination))).toBe(true);
    expect(result.reply).toMatch(/12 min/);
    expect(result.reply).toMatch(/9 min/);
    expect(result.reply).not.toMatch(/where are you trying to go/i);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
  });

  it("C. uses Carbone from context for how do I get there", async () => {
    let carboneKnown = false;
    const resolver: PlaceResolver = {
      async resolve(query) {
        if (/carbone/i.test(query)) {
          if (!carboneKnown) return { status: "unknown", query, places: [] };
          return {
            status: "resolved",
            query,
            places: [
              {
                name: "Carbone",
                address: "181 Thompson St, New York, NY",
                latitude: 40.7278,
                longitude: -74.003,
                source: "places",
                confidence: 0.9,
              },
            ],
          };
        }
        return lookupGazetteer(query);
      },
    };
    const { service, calls } = createRouteHarness({
      resolver,
      routes: { TRANSIT: transit, WALK: walkLong },
    });

    await service.handle({ spaceId: "action-c", text: "Let's go to Carbone." });
    await service.handle({ spaceId: "action-c", text: "I'm at Columbia University." });
    carboneKnown = true;
    const before = calls.length;
    const result = await service.handle({ spaceId: "action-c", text: "How do I get there?" });
    const other = await service.handle({ spaceId: "action-c-other", text: "How do I get there?" });

    expect(result.handled).toBe(true);
    expect(calls.slice(before).some((call) => /carbone/i.test(call.destination) && /columbia/i.test(call.origin))).toBe(
      true,
    );
    expect(result.reply).toMatch(/20 min/);
    expect(result.reply).not.toMatch(/where are you trying to go/i);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
    expect(other.reply).toMatch(/where are you trying to go/i);
  });

  it("D. applies a stored walking limit without asking again", async () => {
    const question = "How do I get from Columbia University to Times Square?";
    const prefs = decisionConstraints(["I hate walking more than 10 minutes."], question).route;
    expect(prefs.maxWalkMinutes).toBe(10);

    const { service } = createRouteHarness({ routes: { TRANSIT: transit, WALK: walkLong } });
    const limited = await service.handle({ spaceId: "action-d", text: question, preferences: prefs });
    const open = await service.handle({ spaceId: "action-d-other", text: question });

    expect(limited.reply).toMatch(/20 min/);
    expect(limited.reply).not.toMatch(/40 min/);
    expect(limited.reply).not.toMatch(FORBIDDEN_OFFER);
    expect(limited.reply).not.toMatch(/\?/);
    expect(open.reply).toMatch(/40 min/);
  });

  it("uses a stored subway preference instead of asking about Uber", async () => {
    const question = "How do I get from Columbia University to Times Square?";
    const prefs = decisionConstraints(["I prefer the subway over Uber."], question).route;
    expect(prefs.preferTransit).toBe(true);

    const requested: string[] = [];
    const { service, calls } = createRouteHarness({ routes: { TRANSIT: transit, WALK: walkLong } });
    const result = await service.handle({ spaceId: "action-subway", text: question, preferences: prefs });
    requested.push(...calls.map((call) => call.mode));

    expect(requested).toContain("TRANSIT");
    expect(requested).not.toContain("DRIVE");
    expect(result.reply).toMatch(/20 min/);
    expect(result.reply).not.toMatch(/uber or subway|should i take/i);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
  });

  it("infers a remembered origin instead of asking where to start", async () => {
    const question = "How do I get to Times Square?";
    const prefs = decisionConstraints(["I live near Columbia University."], question).route;
    expect(prefs.defaultOrigin).toMatch(/columbia university/i);

    const { service, calls } = createRouteHarness({ routes: { TRANSIT: transit, WALK: walkLong } });
    const result = await service.handle({ spaceId: "action-home", text: question, preferences: prefs });

    expect(calls.some((call) => /columbia/i.test(call.origin) && /times square/i.test(call.destination))).toBe(true);
    expect(result.reply).toMatch(/20 min/);
    expect(result.reply).not.toMatch(/starting from/i);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
  });

  it("E. asks where to go only when no destination exists", async () => {
    const { service, calls } = createRouteHarness({ routes: { TRANSIT: transit } });
    const result = await service.handle({ spaceId: "action-e", text: "How do I get there?" });

    expect(result.handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(result.reply).toMatch(/where are you trying to go/i);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
    expect(result.reply).not.toMatch(/\d+\s*min/);
  });

  it("F. stays grounded when the transit lookup fails", async () => {
    const gemini = scriptedGemini("Take the Q train from 116 St. About 12 min. The fare is $2.90.");
    const { service } = createRouteHarness({
      throwError: new Error("Routes API unavailable"),
      gemini,
      routes: { TRANSIT: transit },
    });

    const result = await service.handle({
      spaceId: "action-f",
      text: "How do I get from Columbia University to Times Square?",
    });

    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toMatch(/\bQ train\b|116 St|12 min|\$2\.90|\bfare\b/i);
    expect(gemini.calls).toHaveLength(0);
  });

  it("G. removes unsolicited follow-up offers from a valid route", async () => {
    const facts = { ...transit, durationSeconds: 35 * 60 };
    const gemini = scriptedGemini(
      [
        "Take the 1 from 116 St-Columbia University to Times Sq-42 St. About 35 min.",
        "Want me to check train status?",
        "Would you like me to look that up?",
        "Should I check live service?",
        "I can check another route.",
        "Want directions to the station?",
      ].join(" "),
    );
    const { service } = createRouteHarness({
      routes: { TRANSIT: facts, WALK: walkLong },
      gemini,
    });

    const result = await service.handle({
      spaceId: "action-g",
      text: "How do I get from Columbia University to Times Square?",
    });

    expect(result.reply).toMatch(/Take the 1/);
    expect(result.reply).toMatch(/35 min/);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
  });

  it("answers from route data when the model only offers to look it up", async () => {
    const gemini = scriptedGemini("Want me to look up the directions? Should I check train status?");
    const { service } = createRouteHarness({
      routes: { TRANSIT: { ...transit, durationSeconds: 35 * 60 }, WALK: walkLong },
      gemini,
    });

    const result = await service.handle({
      spaceId: "action-g-offer",
      text: "How do I get from Columbia University to Times Square?",
    });

    expect(result.reply).toMatch(/35 min/);
    expect(result.reply).toMatch(/116 St-Columbia University/);
    expect(result.reply).not.toMatch(FORBIDDEN_OFFER);
  });
});

describe("directions authorization", () => {
  it("puts the no-permission rule in the Gemini directions prompt and the agent prompt", () => {
    expect(DIRECTIONS_AUTHORIZATION_RULE).toMatch(/treat the request as authorization to perform all available route/i);
    expect(DIRECTIONS_AUTHORIZATION_RULE).toMatch(/Do not ask whether the user wants you to check routes/i);

    const instructions = directionsModelInstructions({
      question: "How do I get from Columbia University to Times Square?",
      routes: [],
      modes: ["WALK", "TRANSIT"],
    });
    expect(instructions.system).toContain(DIRECTIONS_AUTHORIZATION_RULE);
    expect(instructions.user).toMatch(/do not ask a follow-up/i);
    expect(systemPrompt(false)).toContain("treat the request as authorization to perform all available route");
  });

  it("answers when both ends are known and asks only for a missing required end", () => {
    expect(
      chooseTransportStep({
        destinationAmbiguous: false,
        originAmbiguous: false,
        destinationKnown: true,
        originKnown: true,
      }),
    ).toBe("answer");
    expect(
      chooseTransportStep({
        destinationAmbiguous: false,
        originAmbiguous: false,
        destinationKnown: false,
        originKnown: false,
      }),
    ).toBe("ask-destination");
    expect(
      chooseTransportStep({
        destinationAmbiguous: false,
        originAmbiguous: false,
        destinationKnown: true,
        originKnown: false,
      }),
    ).toBe("ask-origin");
    expect(
      chooseTransportStep({
        destinationAmbiguous: true,
        originAmbiguous: false,
        destinationKnown: false,
        originKnown: true,
      }),
    ).toBe("ask-which");
  });
});
