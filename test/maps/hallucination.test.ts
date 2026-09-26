import { describe, expect, it } from "vitest";
import { createTransportationService } from "../../src/transport/service.js";
import { createRouteHarness, durationOnlyRoute, factsFromRoutes, scriptedGemini, unsupportedRouteClaims } from "./support.js";

const HALLUCINATED =
  "Take the 1 train from 116 St-Columbia University to Times Sq-42 St. Fare is $2.90. Walk 0.4 miles. Transfer at 42nd. Delays on the line. About 20 min.";

describe("anti-hallucination", () => {
  it("flags unsupported route details in the detector", () => {
    const issues = unsupportedRouteClaims(HALLUCINATED, factsFromRoutes([durationOnlyRoute("TRANSIT", 20)]));
    expect(issues).toEqual(
      expect.arrayContaining(["fare", "transfer", "service status", "distance", "subway line 1"]),
    );
  });

  it("does not add subway, fare, distance, transfer, or status when Maps returned only a duration", async () => {
    const routes = {
      TRANSIT: durationOnlyRoute("TRANSIT", 20),
      WALK: durationOnlyRoute("WALK", 20),
    };
    const { service } = createRouteHarness({ routes });
    const result = await service.handle({
      spaceId: "duration-only",
      text: "How should I get from Columbia University to Times Square?",
    });

    const reply = result.reply ?? "";
    expect(reply).toMatch(/20 min/);
    expect(unsupportedRouteClaims(reply, factsFromRoutes([routes.TRANSIT, routes.WALK]))).toEqual([]);
  });

  it("drops unsupported facts even when grounded Gemini adds them on top of a duration-only route", async () => {
    const routes = {
      TRANSIT: durationOnlyRoute("TRANSIT", 20),
      WALK: durationOnlyRoute("WALK", 20),
    };
    const gemini = scriptedGemini(HALLUCINATED, true);
    const { service } = createRouteHarness({ routes, gemini });
    const result = await service.handle({
      spaceId: "gemini-adds-facts",
      text: "How should I get from Columbia University to Times Square?",
    });

    const reply = result.reply ?? "";
    expect(gemini.calls.length).toBeGreaterThan(0);
    expect(gemini.calls[0]?.routes.every((route) => route.steps.length === 0)).toBe(true);
    expect(unsupportedRouteClaims(reply, factsFromRoutes([routes.TRANSIT, routes.WALK]))).toEqual([]);
  });

  it("does not publish subway, fare, or duration claims from Gemini when no route payload exists", async () => {
    const gemini = scriptedGemini(HALLUCINATED, true);
    const service = createTransportationService({ gemini });
    const result = await service.handle({
      spaceId: "gemini-without-routes",
      text: "How should I get from Columbia University to Times Square?",
    });

    expect(gemini.calls.length).toBeGreaterThan(0);
    expect(gemini.calls[0]?.routes).toEqual([]);
    expect(unsupportedRouteClaims(result.reply ?? "", factsFromRoutes([]))).toEqual([]);
  });
});
