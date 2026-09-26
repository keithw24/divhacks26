import { describe, expect, it } from "vitest";
import { createRouteHarness, responseQualityIssues } from "./support.js";
import type { RouteResult } from "../../src/transport/types.js";

const route: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 35 * 60,
  distanceMeters: 7200,
  steps: [
    {
      mode: "TRANSIT",
      lineShortName: "1",
      departureStop: "116 St-Columbia University",
      arrivalStop: "Times Sq-42 St",
    },
  ],
};

describe("response quality", () => {
  it("returns a short plain-text iMessage without JSON, traces, secrets, or provider internals", async () => {
    const { service } = createRouteHarness({
      routes: { TRANSIT: route, WALK: { mode: "WALK", durationSeconds: 75 * 60, distanceMeters: 6000, steps: [] } },
    });
    const result = await service.handle({
      spaceId: "quality",
      text: "How should I get from Columbia University to Times Square?",
    });

    const reply = result.reply ?? "";
    expect(responseQualityIssues(reply, ["maps-test-SENTINEL-key"])).toEqual([]);
    expect(reply).not.toMatch(/^\s*[{[]/);
    expect(reply.length).toBeGreaterThan(10);
  });
});
