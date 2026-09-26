import { describe, expect, it } from "vitest";
import { extractTransportIntent } from "../../src/transport/intent.js";
import { lookupGazetteer } from "../../src/transport/locations.js";
import type { PlaceResolver, RouteResult } from "../../src/transport/types.js";
import {
  callsMatching,
  createRouteHarness,
  durationOnlyRoute,
  factsFromRoutes,
  responseQualityIssues,
  unsupportedRouteClaims,
} from "./support.js";

const transitFacts: RouteResult = {
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

const walkFacts: RouteResult = {
  mode: "WALK",
  durationSeconds: 75 * 60,
  distanceMeters: 6000,
  steps: [],
};

function routed() {
  return createRouteHarness({
    routes: {
      TRANSIT: transitFacts,
      WALK: walkFacts,
    },
  });
}

describe("maps route requests", () => {
  it("routes an explicit Columbia University to Times Square question through Maps", async () => {
    const intent = extractTransportIntent("How should I get from Columbia University to Times Square?");
    expect(intent.isTransport).toBe(true);
    expect(intent.originQuery).toMatch(/columbia university/i);
    expect(intent.destinationQuery).toMatch(/times square/i);

    const { service, calls } = routed();
    const result = await service.handle({
      spaceId: "explicit-1",
      text: "How should I get from Columbia University to Times Square?",
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(callsMatching(calls, { origin: /columbia/i, destination: /times square/i }).length).toBeGreaterThan(0);
    expect(callsMatching(calls, { origin: /times square/i, destination: /columbia/i })).toHaveLength(0);

    const reply = result.reply ?? "";
    expect(result.handled).toBe(true);
    expect(reply).toMatch(/35 min/);
    expect(reply).toMatch(/116 St-Columbia University/);
    expect(unsupportedRouteClaims(reply, factsFromRoutes([transitFacts, walkFacts]))).toEqual([]);
    expect(reply).not.toMatch(/Q train|\$2\.90|\bfare\b/i);
    expect(responseQualityIssues(reply)).toEqual([]);
  });

  it("uses Columbia as the origin after the user said they are there", async () => {
    const { service, calls } = routed();
    await service.handle({ spaceId: "ctx-origin", text: "I’m at Columbia University." });
    const result = await service.handle({
      spaceId: "ctx-origin",
      text: "How do I get to Washington Square Park?",
    });

    expect(result.handled).toBe(true);
    expect(callsMatching(calls, { origin: /columbia/i, destination: /washington square/i }).length).toBeGreaterThan(0);
    expect(callsMatching(calls, { origin: /washington square/i, destination: /columbia/i })).toHaveLength(0);
  });

  it("resolves Katz's from conversation context for how should we get there", async () => {
    const { service, calls } = routed();
    await service.handle({
      spaceId: "ctx-dest",
      senderId: "user",
      isGroup: true,
      text: "Let’s go to Katz’s Delicatessen.",
    });
    await service.handle({
      spaceId: "ctx-dest",
      senderId: "friend",
      isGroup: true,
      text: "Sounds good.",
    });
    const result = await service.handle({
      spaceId: "ctx-dest",
      senderId: "user",
      isGroup: true,
      text: "@Agent how should we get there?",
    });

    const reply = result.reply ?? "";
    expect(result.handled).toBe(true);
    expect(reply).toMatch(/Katz/i);
    expect(callsMatching(calls, { destination: /times square|washington|brooklyn/i })).toHaveLength(0);
    if (calls.length > 0) {
      expect(calls.every((call) => /katz/i.test(call.destination))).toBe(true);
    }
  });

  it("keeps both places and looks up WALK when the user asks to walk instead", async () => {
    const { service, calls } = routed();
    await service.handle({
      spaceId: "mode-change",
      text: "How should I get from Columbia to Times Square?",
    });
    const before = calls.length;
    const result = await service.handle({
      spaceId: "mode-change",
      text: "Can I walk instead?",
    });

    const followUps = calls.slice(before);
    expect(result.handled).toBe(true);
    expect(callsMatching(followUps, { origin: /columbia/i, destination: /times square/i, mode: "WALK" }).length).toBeGreaterThan(0);
    expect(followUps.some((call) => /washington|katz|brooklyn/i.test(call.destination))).toBe(false);
  });

  it("changes only the destination when the user asks about Washington Square Park", async () => {
    const followUp = extractTransportIntent("What about Washington Square Park?");
    expect(followUp.isTransport).toBe(true);
    expect(followUp.destinationQuery).toMatch(/washington square/i);

    const { service, calls } = routed();
    await service.handle({
      spaceId: "dest-change",
      text: "How should I get from Columbia to Times Square?",
    });
    const before = calls.length;
    await service.handle({
      spaceId: "dest-change",
      text: "What about Washington Square Park?",
    });

    const followUps = calls.slice(before);
    expect(callsMatching(followUps, { origin: /columbia/i, destination: /washington square/i }).length).toBeGreaterThan(0);
    expect(callsMatching(followUps, { destination: /times square/i })).toHaveLength(0);
  });

  it("asks for the missing origin and does not invent a location for Central Park", async () => {
    const { service, calls } = routed();
    const result = await service.handle({
      spaceId: "missing-origin",
      text: "How do I get to Central Park?",
    });

    const reply = result.reply ?? "";
    expect(result.handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(reply).toMatch(/central park/i);
    expect(reply).toMatch(/where|start|from/i);
    expect(reply).not.toMatch(/\d+\s*min/);
    expect(reply).not.toMatch(/columbia|times square|i am at|you're at/i);
  });

  it("asks for a destination when none is in context", async () => {
    const { service, calls } = routed();
    const result = await service.handle({
      spaceId: "missing-dest",
      text: "How should I get there?",
    });

    const reply = result.reply ?? "";
    expect(result.handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(reply).toMatch(/where|which|go/i);
    expect(reply).not.toMatch(/\d+\s*min|columbia|times square|katz|subway/i);
  });

  it("does not silently pick one Joe's Pizza", async () => {
    const gazetteer = lookupGazetteer("Joe's Pizza");
    expect(gazetteer.status).not.toBe("resolved");

    const { service, calls } = routed();
    const result = await service.handle({
      spaceId: "joes",
      text: "Take me to Joe’s Pizza.",
    });

    const reply = result.reply ?? "";
    expect(calls).toHaveLength(0);
    expect(reply).not.toMatch(/\d+\s*min/);
    expect(reply).toMatch(/joe/i);
    expect(reply).toMatch(/which|several|more than one|address/i);
    expect(reply).not.toMatch(/carmine|broadway|14th/i);
  });

  it("looks up both walk and subway before comparing Washington Square Park to Union Square", async () => {
    const walk = durationOnlyRoute("WALK", 12);
    const subway = {
      ...durationOnlyRoute("TRANSIT", 6),
      steps: [
        {
          mode: "TRANSIT" as const,
          lineShortName: "R",
          departureStop: "West 4 St",
          arrivalStop: "14 St-Union Sq",
        },
      ],
    };
    const { service, calls } = createRouteHarness({ routes: { WALK: walk, TRANSIT: subway } });
    const result = await service.handle({
      spaceId: "compare",
      text: "Should I walk or take the subway from Washington Square Park to Union Square?",
    });

    expect(callsMatching(calls, { origin: /washington square/i, destination: /union square/i, mode: "WALK" })).toHaveLength(1);
    expect(callsMatching(calls, { origin: /washington square/i, destination: /union square/i, mode: "TRANSIT" })).toHaveLength(1);
    const reply = result.reply ?? "";
    expect(unsupportedRouteClaims(reply, factsFromRoutes([walk, subway]))).toEqual([]);
    expect(reply).toMatch(/12 min/);
    expect(reply).toMatch(/6 min/);
    expect(reply).not.toMatch(/\b(4|5|6) train\b|\$\d|fare/i);
  });

  it("consults Maps for the subway from Times Square to Grand Central", async () => {
    const shuttle: RouteResult = {
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
    const { service, calls } = createRouteHarness({ routes: { TRANSIT: shuttle } });
    const result = await service.handle({
      spaceId: "shuttle",
      text: "What subway should I take from Times Square to Grand Central?",
    });

    expect(callsMatching(calls, { origin: /times square/i, destination: /grand central/i, mode: "TRANSIT" }).length).toBeGreaterThan(0);
    const reply = result.reply ?? "";
    expect(reply).toMatch(/\bS\b/);
    expect(unsupportedRouteClaims(reply, factsFromRoutes([shuttle]))).toEqual([]);
    expect(reply).not.toMatch(/\b7 train\b|\bfare\b/i);
  });

  it("recognizes Times Square to Times Square as the same place", async () => {
    const nonsense: RouteResult = {
      mode: "TRANSIT",
      durationSeconds: 25 * 60,
      summary: "1 train",
      steps: [
        {
          mode: "TRANSIT",
          lineShortName: "1",
          departureStop: "Times Sq-42 St",
          arrivalStop: "Times Sq-42 St",
        },
      ],
    };
    const { service } = createRouteHarness({ routes: { TRANSIT: nonsense, WALK: durationOnlyRoute("WALK", 1) } });
    const result = await service.handle({
      spaceId: "same-place",
      text: "How do I get from Times Square to Times Square?",
    });

    const origin = lookupGazetteer("Times Square").places[0];
    const destination = lookupGazetteer("Times Square").places[0];
    expect(origin?.latitude).toBe(destination?.latitude);
    expect(origin?.longitude).toBe(destination?.longitude);

    const reply = result.reply ?? "";
    expect(reply).toMatch(/same place|already there|you(?:'|’)re there|no need to/i);
    expect(reply).not.toMatch(/take the|subway|\btrain\b/i);
    expect(reply).not.toMatch(/25 min/);
  });

  it("does not invent an NYC place for a nonsense destination", async () => {
    const { service, calls } = routed();
    const result = await service.handle({
      spaceId: "invalid-dest",
      text: "How do I get from Times Square to asdfghjkl123456?",
    });

    const reply = result.reply ?? "";
    expect(result.handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(lookupGazetteer("asdfghjkl123456").status).toBe("unknown");
    expect(reply).not.toMatch(/\d+\s*min|subway|columbia|central park|union square/i);
    expect(reply).toMatch(/where|which|find|couldn|don(?:'|’)t|recognize|clarify/i);
  });

  it("asks which Joe's when the place resolver returns two locations", async () => {
    const resolver: PlaceResolver = {
      async resolve(query) {
        if (/joe/i.test(query)) {
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
                confidence: 0.76,
              },
              {
                name: "Joe's Pizza",
                address: "1435 Broadway, New York, NY",
                latitude: 40.7547,
                longitude: -73.987,
                source: "places",
                confidence: 0.74,
              },
            ],
          };
        }
        return lookupGazetteer(query);
      },
    };
    const { service, calls } = createRouteHarness({
      resolver,
      routes: { TRANSIT: transitFacts },
    });
    const result = await service.handle({
      spaceId: "joes-resolver",
      text: "Take me to Joe’s Pizza.",
    });

    expect(calls).toHaveLength(0);
    expect(result.reply).toMatch(/which/i);
    expect(result.reply).toMatch(/Carmine/);
    expect(result.reply).toMatch(/Broadway/);
    expect(result.reply).not.toMatch(/\d+\s*min/);
  });
});
