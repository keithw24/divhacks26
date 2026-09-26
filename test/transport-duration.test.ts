import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionConstraints } from "../src/agent/decisions.js";
import { directionsModelInstructions, parseTravelTimeEstimate } from "../src/transport/gemini.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import { createGoogleRoutesProvider } from "../src/transport/routing.js";
import { createTransportationService } from "../src/transport/service.js";
import type {
  GeminiMapsClient,
  PhraseDirectionsInput,
  RouteResult,
  TravelTimeEstimate,
  TravelTimeEstimateInput,
} from "../src/transport/types.js";

const LEAK =
  /routes api|api key|not configured|exact travel time|google maps failed|google routes|\bquota\b|timed out|\btimeout\b|GOOGLE_|GEMINI_|\bHTTP\b|\b(?:401|403|429|500)\b/i;

const QUESTION = "How do I get from Columbia University to Times Square?";

const transitSteps = [
  {
    mode: "TRANSIT" as const,
    lineShortName: "1",
    departureStop: "116 St-Columbia University",
    arrivalStop: "Times Sq-42 St",
    headsign: "South Ferry",
  },
];

function grounded(text: string) {
  const sources = [{ title: "Times Square", uri: "https://maps.google.com/?cid=1" }];
  return {
    text,
    sources,
    grounded: true,
    grounding: { grounded: true, sources, supportCount: 1, webSearchQueries: [] },
  };
}

function estimatingClient(phrase: string, estimate: TravelTimeEstimate | null) {
  const phraseCalls: PhraseDirectionsInput[] = [];
  const estimateCalls: TravelTimeEstimateInput[] = [];
  const estimateFn = vi.fn(async (input: TravelTimeEstimateInput) => {
    estimateCalls.push(input);
    return estimate;
  });
  const client: GeminiMapsClient = {
    async resolvePlaces(query) {
      return lookupGazetteer(query);
    },
    async nearby() {
      return grounded(phrase);
    },
    estimateTravelTime: estimateFn,
    async phraseDirections(input) {
      phraseCalls.push(input);
      return grounded(phrase);
    },
  };
  return { client, phraseCalls, estimateCalls, estimateFn };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("directions duration fallback", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("A. uses a Google Routes duration and does not replace it with a Gemini estimate", async () => {
    const route: RouteResult = {
      mode: "TRANSIT",
      durationSeconds: 23 * 60,
      distanceMeters: 7200,
      steps: transitSteps,
    };
    const { client, phraseCalls, estimateFn } = estimatingClient(
      "Take the 1 from 116 St-Columbia University to Times Sq-42 St. It should take about 40–50 minutes.",
      { lowMinutes: 40, highMinutes: 50, phrase: "about 40–50 minutes" },
    );
    const service = createTransportationService({
      routing: {
        async getRoute(_origin, _destination, mode) {
          return mode === "TRANSIT" ? route : undefined;
        },
      },
      gemini: client,
    });

    const result = await service.handle({ spaceId: "dur-a", text: QUESTION });

    expect(estimateFn).not.toHaveBeenCalled();
    expect(phraseCalls[0]?.durationSource).toBe("google_routes");
    expect(phraseCalls[0]?.durationLabel).toBe("23 min");
    expect(result.reply).toMatch(/Take the 1/);
    expect(result.reply).toMatch(/116 St-Columbia University/);
    expect(result.reply).toMatch(/23 min/);
    expect(result.reply).not.toMatch(/40|50/);
    expect(result.reply).not.toMatch(LEAK);
    expect(info).toHaveBeenCalledWith("duration_source=google_routes");
  });

  it("B. estimates an approximate duration when GOOGLE_MAPS_API_KEY is missing", async () => {
    const { client, phraseCalls, estimateFn } = estimatingClient(
      "Take the 1 train from 116 St-Columbia University to Times Sq-42 St. It should take about 20–25 minutes.",
      { lowMinutes: 20, highMinutes: 25, phrase: "about 20–25 minutes" },
    );
    const service = createTransportationService({ gemini: client });

    const result = await service.handle({ spaceId: "dur-b", text: QUESTION });

    expect(estimateFn).toHaveBeenCalled();
    expect(phraseCalls[0]?.durationSource).toBe("gemini_estimate");
    expect(phraseCalls[0]?.routeSummary ?? null).toBeNull();
    expect(result.reply).toMatch(/Columbia University/);
    expect(result.reply).toMatch(/Times Square/);
    expect(result.reply).toMatch(/about 20–25 minutes/);
    expect(result.reply).not.toMatch(/\b1 train\b|116 St/);
    expect(result.reply).not.toMatch(LEAK);
    expect(info).toHaveBeenCalledWith("duration_source=gemini_estimate");
  });

  it("C. hides a Routes 429 and still estimates a duration", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(429, { error: { message: "Quota exceeded" } }));
    const { client } = estimatingClient(
      "Routes API HTTP 429. Quota exceeded. Exact travel time is unavailable. From Columbia University to Times Square. It should take about 18–22 minutes.",
      { lowMinutes: 18, highMinutes: 22, phrase: "about 18–22 minutes" },
    );
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key"),
      gemini: client,
    });

    const result = await service.handle({ spaceId: "dur-c", text: QUESTION });

    expect(result.reply).toMatch(/about 18–22 minutes/);
    expect(result.reply).toMatch(/Columbia University/);
    expect(result.reply).not.toMatch(LEAK);
    expect(result.reply).not.toContain("maps-test-SENTINEL-key");
    expect(info).toHaveBeenCalledWith("duration_source=gemini_estimate");
  });

  it("D. hides a Routes timeout and still estimates a duration", async () => {
    const rejectors: Array<(error: Error) => void> = [];
    vi.stubGlobal("fetch", () => new Promise((_resolve, reject) => rejectors.push(reject)));
    const { client } = estimatingClient(
      "The request timed out. From Columbia University to Times Square. It should take about 20–25 minutes.",
      { lowMinutes: 20, highMinutes: 25, phrase: "about 20–25 minutes" },
    );
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key"),
      gemini: client,
    });

    const result = await service.handle({ spaceId: "dur-d", text: QUESTION });
    for (const reject of rejectors) reject(new Error("cleanup"));

    expect(result.reply).toMatch(/about 20–25 minutes/);
    expect(result.reply).not.toMatch(LEAK);
    expect(info).toHaveBeenCalledWith("duration_source=gemini_estimate");
  });

  it("E. hides a Routes 500 and still estimates a duration", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(500, {}));
    const { client } = estimatingClient(
      "Routes API HTTP 500. From Columbia University to Times Square. It should take about 20–25 minutes.",
      { lowMinutes: 20, highMinutes: 25, phrase: "about 20–25 minutes" },
    );
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key"),
      gemini: client,
    });

    const result = await service.handle({ spaceId: "dur-e", text: QUESTION });

    expect(result.reply).toMatch(/about 20–25 minutes/);
    expect(result.reply).not.toMatch(LEAK);
    expect(result.reply).not.toContain("500");
    expect(info).toHaveBeenCalledWith("duration_source=gemini_estimate");
  });

  it("F. returns grounded directions without a duration when Gemini cannot estimate", async () => {
    const gemini: GeminiMapsClient = {
      async resolvePlaces(query) {
        return lookupGazetteer(query);
      },
      async nearby() {
        throw new Error("Gemini unavailable");
      },
      async estimateTravelTime() {
        throw new Error("Gemini quota 429");
      },
      async phraseDirections() {
        throw new Error("Gemini unavailable");
      },
    };
    const service = createTransportationService({
      routing: {
        async getRoute(_origin, _destination, mode) {
          if (mode !== "TRANSIT") return undefined;
          return { mode: "TRANSIT", steps: transitSteps };
        },
      },
      gemini,
    });

    const result = await service.handle({ spaceId: "dur-f", text: QUESTION });

    expect(result.reply).toMatch(/Take the 1/);
    expect(result.reply).toMatch(/116 St-Columbia University/);
    expect(result.reply).toMatch(/Times Sq-42 St/);
    expect(result.reply).not.toMatch(/\d+\s*min|exact travel time|unavailable|not configured|429|quota/i);
    expect(info).toHaveBeenCalledWith("duration_source=none");
  });

  it("G. does not invent a subway line or station when no grounded route exists", async () => {
    const { client } = estimatingClient(
      "Take the Q train from 96 St to 42 St. It should take about 20–25 minutes.",
      { lowMinutes: 20, highMinutes: 25, phrase: "about 20–25 minutes" },
    );
    const service = createTransportationService({
      routing: {
        async getRoute() {
          throw new Error("Routes API HTTP 500");
        },
      },
      gemini: client,
    });

    const result = await service.handle({ spaceId: "dur-g", text: QUESTION });

    expect(result.reply).toMatch(/Columbia University/);
    expect(result.reply).toMatch(/Times Square/);
    expect(result.reply).toMatch(/about 20–25 minutes/);
    expect(result.reply).not.toMatch(/\bQ train\b|96 St|take the/i);
    expect(result.reply).not.toMatch(LEAK);
  });

  it("H. resolves How do I get there? inside the current Photon space", async () => {
    const calls: string[] = [];
    const service = createTransportationService({
      routing: {
        async getRoute(origin, destination, mode) {
          calls.push(`${mode}:${origin.name}->${destination.name}`);
          if (mode !== "TRANSIT") return undefined;
          return {
            mode: "TRANSIT",
            durationSeconds: 22 * 60,
            steps: transitSteps,
          };
        },
      },
    });

    const mention = await service.handle({ spaceId: "dur-h", text: "Let’s go to Katz’s." });
    await service.handle({ spaceId: "dur-h", text: "I’m at Columbia University." });
    const result = await service.handle({ spaceId: "dur-h", text: "How do I get there?" });
    const fromHere = await service.handle({ spaceId: "dur-h", text: "Directions from here" });
    const other = await service.handle({ spaceId: "dur-h-other", text: "How do I get there?" });

    expect(mention.handled).toBe(false);
    expect(calls.some((call) => /columbia/i.test(call) && /katz/i.test(call))).toBe(true);
    expect(result.reply).toMatch(/22 min/);
    expect(result.reply).toMatch(/Take the 1/);
    expect(fromHere.reply).toMatch(/22 min/);
    expect(other.reply).toMatch(/where are you trying to go/i);
    expect(result.reply).not.toMatch(LEAK);
  });

  it("I. keeps applying a subway preference and a walking limit", async () => {
    const question = QUESTION;
    const prefs = decisionConstraints(
      ["I prefer the subway over Uber.", "I hate walking more than 10 minutes."],
      question,
    ).route;
    expect(prefs.preferTransit).toBe(true);
    expect(prefs.maxWalkMinutes).toBe(10);

    const remembered = estimatingClient("unused", {
      lowMinutes: 40,
      highMinutes: 50,
      phrase: "about 40–50 minutes",
    });
    const withRoutes = createTransportationService({
      gemini: remembered.client,
      routing: {
        async getRoute(_origin, _destination, mode) {
          if (mode === "WALK") return { mode: "WALK", durationSeconds: 40 * 60, steps: [] };
          if (mode === "TRANSIT") {
            return { mode: "TRANSIT", durationSeconds: 20 * 60, steps: transitSteps };
          }
          return undefined;
        },
      },
    });
    const limited = await withRoutes.handle({ spaceId: "dur-i-routes", text: question, preferences: prefs });

    expect(remembered.estimateFn).not.toHaveBeenCalled();
    expect(limited.reply).toMatch(/20 min/);
    expect(limited.reply).toMatch(/Take the 1/);
    expect(limited.reply).not.toMatch(/40 min/);
    expect(limited.reply).not.toMatch(/\?/);

    const fallback = estimatingClient(
      "Take the Q train from 96 St. It should take about 15–20 minutes.",
      { lowMinutes: 15, highMinutes: 20, phrase: "about 15–20 minutes" },
    );
    const withoutRoutes = createTransportationService({
      gemini: fallback.client,
      routing: {
        async getRoute() {
          throw new Error("Routes request timed out");
        },
      },
    });
    const estimated = await withoutRoutes.handle({ spaceId: "dur-i-fallback", text: question, preferences: prefs });
    const notes = fallback.estimateCalls[0]?.preferenceNotes?.join(" ") ?? "";

    expect(fallback.estimateCalls[0]?.modes).toContain("TRANSIT");
    expect(notes).toMatch(/subway/i);
    expect(notes).toMatch(/10/);
    expect(estimated.reply).toMatch(/about 15–20 minutes/);
    expect(estimated.reply).not.toMatch(/\bQ train\b|96 St/);
    expect(estimated.reply).not.toMatch(LEAK);
    expect(estimated.reply).not.toMatch(/\?/);
  });
});

describe("travel time estimate parsing", () => {
  it("keeps a conservative range and drops guesses that are not responsible", () => {
    expect(parseTravelTimeEstimate({ canEstimate: false }, ["TRANSIT"])).toBeNull();
    expect(parseTravelTimeEstimate({ canEstimate: true, lowMinutes: 20, highMinutes: 80 }, ["TRANSIT"])).toBeNull();
    expect(parseTravelTimeEstimate({ canEstimate: true, lowMinutes: 0, highMinutes: 10 }, ["TRANSIT"])).toBeNull();
    expect(parseTravelTimeEstimate({ canEstimate: true, lowMinutes: 20, highMinutes: 25 }, ["WALK", "TRANSIT"])).toEqual({
      lowMinutes: 20,
      highMinutes: 25,
      phrase: "about 20–25 minutes",
    });
    expect(parseTravelTimeEstimate({ canEstimate: true, lowMinutes: 10, highMinutes: 10 }, ["DRIVE"])?.phrase).toBe(
      "roughly 10 minutes by car",
    );
    expect(parseTravelTimeEstimate({ canEstimate: true, lowMinutes: 15, highMinutes: 15 }, ["WALK"])?.phrase).toBe(
      "around a 15-minute walk",
    );
  });

  it("gives Gemini structured facts and forbids implementation language", () => {
    const columbia = lookupGazetteer("Columbia University").places[0];
    const timesSquare = lookupGazetteer("Times Square").places[0];
    const instructions = directionsModelInstructions({
      question: QUESTION,
      origin: columbia,
      destination: timesSquare,
      routes: [],
      modes: ["TRANSIT"],
      routeSummary: null,
      durationLabel: "about 20–25 minutes",
      distanceLabel: null,
      durationSource: "gemini_estimate",
    });

    expect(instructions.user).toContain('"durationSource":"gemini_estimate"');
    expect(instructions.user).toContain('"route":null');
    expect(instructions.user).toContain("Columbia University");
    expect(instructions.user).toContain("Times Square");
    expect(instructions.system).toMatch(/never mention APIs/i);
    expect(instructions.system).toMatch(/never invent a subway line/i);
    expect(instructions.user).toMatch(/do not ask a follow-up/i);
  });
});
