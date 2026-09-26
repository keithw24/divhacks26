import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleRoutesProvider } from "../../src/transport/routing.js";
import { createTransportationService } from "../../src/transport/service.js";
import { USER_FALLBACK } from "../../src/transport/types.js";
import { lookupGazetteer } from "../../src/transport/locations.js";
import { createRouteHarness, durationOnlyRoute, responseQualityIssues, scriptedGemini } from "./support.js";

const columbia = lookupGazetteer("Columbia University").places[0]!;
const timesSquare = lookupGazetteer("Times Square").places[0]!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("maps provider failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([401, 403, 429, 500])("HTTP %s does not become a route", async (status) => {
    vi.stubGlobal("fetch", async () => jsonResponse(status, { error: { message: `Routes API HTTP ${status}` } }));
    const provider = createGoogleRoutesProvider("maps-test-SENTINEL-key");
    await expect(provider.getRoute(columbia, timesSquare, "TRANSIT")).rejects.toThrow(String(status));
  });

  it("turns a thrown Maps timeout into a short fallback and does not invent a route", async () => {
    const { service, calls } = createRouteHarness({ throwError: new Error("timeout") });
    const result = await service.handle({
      spaceId: "maps-timeout",
      text: "How should I get from Columbia University to Times Square?",
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toMatch(/\d+\s*min|take the|subway/i);
    expect(responseQualityIssues(result.reply ?? "")).toEqual([]);
  });

  it("does not wait forever when the Routes request never completes", async () => {
    const rejectors: Array<(error: Error) => void> = [];
    let stop = false;
    vi.stubGlobal("fetch", () => {
      if (stop) return Promise.reject(new Error("cleanup"));
      return new Promise((_resolve, reject) => {
        rejectors.push(reject);
      });
    });
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key", { timeoutMs: 180 }),
    });
    const pending = service.handle({
      spaceId: "maps-hang",
      text: "How should I get from Columbia University to Times Square?",
    });
    const winner = await Promise.race([
      pending.then((result) => ({ kind: "done" as const, result })),
      new Promise<{ kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 1200)),
    ]);
    stop = true;
    for (const reject of rejectors) reject(new Error("cleanup"));
    await Promise.race([pending.then(() => undefined, () => undefined), new Promise((resolve) => setTimeout(resolve, 400))]);

    expect(winner.kind).toBe("done");
    if (winner.kind === "done") {
      expect(winner.result.reply).toBe(USER_FALLBACK);
    }
  }, 3000);

  it.each([401, 403, 429, 500])("service fallback for Maps HTTP %s does not invent a route", async (status) => {
    vi.stubGlobal("fetch", async () => jsonResponse(status, { error: { message: `Routes API HTTP ${status}` } }));
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key"),
    });
    const result = await service.handle({
      spaceId: `maps-${status}`,
      text: "How should I get from Columbia University to Times Square?",
    });

    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toContain("maps-test-SENTINEL-key");
    expect(result.reply).not.toMatch(/take the|\d+\s*min/);
  });

  it("treats a malformed Maps payload as failure instead of a usable route", async () => {
    vi.stubGlobal(
      "fetch",
      async () => jsonResponse(200, { routes: [{ duration: "nope", legs: [{ steps: "bad" }] }] }),
    );
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key"),
    });
    const result = await service.handle({
      spaceId: "maps-malformed",
      text: "How should I get from Columbia University to Times Square?",
    });

    const reply = result.reply ?? "";
    expect(reply).not.toMatch(/available|about \d+ min|take the/i);
    expect(reply).toMatch(/couldn|reliable|try again/i);
    expect(responseQualityIssues(reply)).toEqual([]);
  });

  it("treats an empty Maps payload as failure", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { routes: [] }));
    const service = createTransportationService({
      routing: createGoogleRoutesProvider("maps-test-SENTINEL-key"),
    });
    const result = await service.handle({
      spaceId: "maps-empty",
      text: "How should I get from Columbia University to Times Square?",
    });

    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toMatch(/\d+\s*min|take the/);
  });

  it("keeps the Maps facts when Gemini fails after a successful route lookup", async () => {
    const gemini = scriptedGemini("unused");
    gemini.phraseDirections = async () => {
      throw new Error("Gemini unavailable\n    at phraseDirections (src/transport/gemini.ts:1:1)");
    };
    const route = {
      ...durationOnlyRoute("TRANSIT", 35),
      steps: [
        {
          mode: "TRANSIT" as const,
          lineShortName: "1",
          departureStop: "116 St-Columbia University",
          arrivalStop: "Times Sq-42 St",
        },
      ],
    };
    const { service } = createRouteHarness({
      gemini,
      routes: { TRANSIT: route, WALK: durationOnlyRoute("WALK", 75) },
    });
    const result = await service.handle({
      spaceId: "gemini-after-maps",
      text: "How should I get from Columbia University to Times Square?",
    });

    const reply = result.reply ?? "";
    expect(reply).toMatch(/35 min/);
    expect(reply).toMatch(/\b1\b/);
    expect(reply).not.toMatch(/gemini\.ts|Gemini unavailable/);
    expect(responseQualityIssues(reply)).toEqual([]);
  });

  it("does not ask Gemini to invent a route when Maps fails", async () => {
    const gemini = scriptedGemini(
      "Take the 1 train from 116 St-Columbia University. Fare is $2.90. About 22 min.",
      true,
    );
    const { service, calls } = createRouteHarness({
      gemini,
      throwError: new Error("Routes API HTTP 500"),
    });
    const result = await service.handle({
      spaceId: "maps-fail-gemini-up",
      text: "How should I get from Columbia University to Times Square?",
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(gemini.calls).toHaveLength(0);
    expect(result.reply).toBe(USER_FALLBACK);
    expect(result.reply).not.toMatch(/take the|\$2\.90|22 min/);
  });
});
