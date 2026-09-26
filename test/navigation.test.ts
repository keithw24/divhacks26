import { describe, expect, it } from "vitest";
import { applyNavHazards, streetTokens } from "../src/navigation/guide.js";
import { lookupNavHazards, recentOpsNote } from "../src/navigation/hazards.js";
import { createTransportationService } from "../src/transport/service.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import type { RouteResult, RoutingProvider } from "../src/transport/types.js";

const walk: RouteResult = {
  mode: "WALK",
  durationSeconds: 12 * 60,
  summary: "Walk down Broadway",
  steps: [{ mode: "WALK", instruction: "Head south on Broadway" }],
};

const transit: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 18 * 60,
  summary: "1 train",
  steps: [{ mode: "TRANSIT", lineShortName: "1", departureStop: "116 St-Columbia University" }],
};

describe("nav hazards", () => {
  it("tokenizes film-permit street holds", () => {
    expect(streetTokens("BROADWAY BETWEEN WEST 110 STREET AND WEST 111 STREET")).toContain("broadway");
  });

  it("prefers transit at night when 311 streetlights are out on the walk", () => {
    const guided = applyNavHazards([walk, transit], [{ kind: "streetlight", label: "Street Light Out", nearCorridor: true }], {
      hourEt: 23,
    });
    expect(guided.preferTransit).toBe(true);
    expect(guided.routes[0]?.mode).toBe("TRANSIT");
    expect(guided.note).toMatch(/streetlight/i);
  });

  it("does not swap a typical daytime walk for historical lights", () => {
    const guided = applyNavHazards([walk, transit], [{ kind: "streetlight", label: "Street Light Out", nearCorridor: true }], {
      hourEt: 14,
    });
    expect(guided.preferTransit).toBe(false);
    expect(guided.routes[0]?.mode).toBe("WALK");
  });

  it("drops a walk that hits a film-shoot street hold", () => {
    const guided = applyNavHazards(
      [walk, transit],
      [{ kind: "film_shoot", label: "Shooting Permit", street: "BROADWAY BETWEEN WEST 110 STREET AND WEST 111 STREET" }],
      { hourEt: 14 },
    );
    expect(guided.routes.some((route) => route.mode === "WALK")).toBe(false);
    expect(guided.note).toMatch(/film shoot/i);
  });

  it("skips a walk with collision reports from the last few hours", () => {
    const guided = applyNavHazards(
      [walk, transit],
      [{ kind: "crash", label: "recent collision report", street: "Broadway", nearCorridor: true }],
      { hourEt: 14 },
    );
    expect(guided.preferTransit).toBe(true);
    expect(guided.routes.some((route) => route.mode === "WALK")).toBe(false);
    expect(guided.note).toMatch(/collision/i);
  });

  it("describes recent ops without calling it a crime feed", () => {
    const note = recentOpsNote([
      { kind: "crash", label: "recent collision report", nearCorridor: true },
      { kind: "street_closed", label: "Street Condition", nearCorridor: true },
    ]);
    expect(note).toMatch(/last few hours/i);
    expect(note).toMatch(/not a live crime/i);
  });

  it("looks up open 311 rows along the corridor", async () => {
    const hazards = await lookupNavHazards({
      points: [{ latitude: 40.8075, longitude: -73.9626 }],
      query: async () => ({
        rows: [
          {
            kind: "streetlight",
            label: "Street Light Out",
            street: "Broadway",
            latitude: 40.8075,
            longitude: -73.9626,
          },
        ],
      }),
    });
    expect(hazards[0]?.kind).toBe("streetlight");
    expect(hazards[0]?.nearCorridor).toBe(true);
  });
});

describe("transport uses 311 hazards", () => {
  it("recommends subway when a film hold is on the walking street", async () => {
    const columbia = lookupGazetteer("Columbia University").places[0]!;
    const timesSquare = lookupGazetteer("Times Square").places[0]!;
    const routing: RoutingProvider = {
      async getRoute(_o, _d, mode) {
        return mode === "WALK" ? walk : transit;
      },
    };
    const service = createTransportationService({
      resolver: {
        async resolve(query) {
          return lookupGazetteer(query);
        },
      },
      routing,
      hazardLookup: async () => [
        { kind: "film_shoot", label: "Shooting Permit", street: "Broadway between West 42 Street and West 43 Street" },
      ],
    });

    const result = await service.handle({
      spaceId: "nav-1",
      text: `How do I get from ${columbia.name} to ${timesSquare.name}?`,
    });

    expect(result.reply).toMatch(/film shoot/i);
    expect(result.reply).not.toMatch(/I’d walk rather than wait/);
  });
});
