import { describe, expect, it } from "vitest";
import type { Recommendation } from "../src/domain/contracts.js";
import { asksForMorePlans, extractConstraints, membersFromTranscript } from "../src/planning/constraints.js";
import { formatGroupPlans } from "../src/planning/format.js";
import { scorePlan } from "../src/planning/score.js";
import { paretoFrontier, selectGroupPlans } from "../src/planning/select.js";
import { rankRecommendationsSync } from "../src/agent/compose.js";

function rec(partial: Partial<Recommendation> & Pick<Recommendation, "id" | "name">): Recommendation {
  return {
    kind: "food",
    location: { label: partial.name, latitude: 40.8, longitude: -73.96 },
    distanceMeters: 600,
    categories: [],
    source: { name: "test" },
    ...partial,
  };
}

const steak = rec({
  id: "steak",
  name: "Peter Luger Steakhouse",
  distanceMeters: 400,
  priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE",
  categories: ["steak"],
  description: "steak and ribs",
  rating: 4.8,
});
const ramen = rec({
  id: "ramen",
  name: "Jin Ramen",
  distanceMeters: 640,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  categories: ["ramen"],
  rating: 4.4,
});
const pizza = rec({
  id: "pizza",
  name: "Joe's Pizza",
  distanceMeters: 480,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  categories: ["pizza"],
  rating: 4.2,
});
const farShow = rec({
  id: "show",
  kind: "event",
  name: "Far Pier Concert",
  distanceMeters: 4000,
  categories: ["music"],
  description: "free outdoor concert",
});
const movie = rec({
  id: "movie",
  kind: "event",
  name: "Riverside outdoor movie",
  distanceMeters: 800,
  categories: ["Movies"],
  description: "free wheelchair accessible screening",
});
const walkup = rec({
  id: "walkup",
  name: "Walk-up tasting room",
  distanceMeters: 500,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  description: "stairs only, walk-up only, no elevator",
});

const group = [
  { who: "Maya", text: "I can only spend $20 and I'm vegan" },
  { who: "Priya", text: "I can't walk more than 15 minutes" },
  { who: "Jordan", text: "I love steak" },
];

describe("member constraints", () => {
  it("parses budget, diet, and walk cap per speaker", () => {
    const members = membersFromTranscript(group);
    const maya = members.find((m) => m.name === "Maya");
    const priya = members.find((m) => m.name === "Priya");
    expect(maya?.maxBudget).toBe("low");
    expect(maya?.dietary).toContain("vegan");
    expect(priya?.maxTravelMinutes).toBe(15);
    expect(extractConstraints("needs a wheelchair accessible place").needsAccessible).toBe(true);
  });
});

describe("hard constraints and group ranking", () => {
  it("does not pick a high-average plan one person cannot attend", () => {
    const members = membersFromTranscript(group);
    const steakScore = scorePlan(steak, members);
    expect(steakScore.feasible).toBe(false);
    expect(steakScore.byPerson.find((row) => row.name === "Maya")?.hardViolations.join(" ")).toMatch(/budget|vegan/i);

    const farScore = scorePlan(farShow, members);
    expect(farScore.feasible).toBe(false);
    expect(farScore.byPerson.find((row) => row.name === "Priya")?.hardViolations.join(" ")).toMatch(/time/i);

    const result = selectGroupPlans([steak, ramen, pizza, farShow, movie], members);
    expect(result.ranked).toHaveLength(3);
    expect(result.ranked.map((p) => p.item.id)).not.toContain("steak");
    expect(result.ranked.map((p) => p.item.id)).not.toContain("show");
    expect(result.infeasible.some((p) => p.item.id === "steak")).toBe(true);
    const ids = new Set(result.ranked.map((p) => p.item.id));
    expect(ids.has("ramen") || ids.has("pizza") || ids.has("movie")).toBe(true);
    expect(result.ranked[0]?.strategy).toBe("leastMisery");
  });

  it("treats accessibility as inviolable when the venue is stairs-only", () => {
    const members = membersFromTranscript([{ who: "Alex", text: "I need wheelchair accessible, max 20 minutes" }]);
    expect(scorePlan(walkup, members).feasible).toBe(false);
    expect(scorePlan(movie, members).feasible).toBe(true);
  });

  it("keeps Pareto-undominated plans and drops strictly worse ones", () => {
    const members = membersFromTranscript(group);
    const feasible = [ramen, pizza, movie].map((item) => scorePlan(item, members)).filter((p) => p.feasible);
    const front = paretoFrontier(feasible);
    expect(front.size).toBeGreaterThan(0);
    for (const plan of feasible) {
      if (!front.has(plan.item.id)) {
        expect(feasible.some((other) => front.has(other.item.id))).toBe(true);
      }
    }
  });

  it("lists top 3 with a constraint sentence and offers more", () => {
    const members = membersFromTranscript(group);
    const extra = rec({
      id: "thai",
      name: "Cheap Thai",
      distanceMeters: 700,
      priceLevel: "PRICE_LEVEL_INEXPENSIVE",
      categories: ["thai"],
    });
    const extra2 = rec({
      id: "bagel",
      name: "Absolute Bagels",
      distanceMeters: 550,
      priceLevel: "PRICE_LEVEL_INEXPENSIVE",
      categories: ["bagel"],
    });
    const result = selectGroupPlans([steak, ramen, pizza, movie, extra, extra2], members);
    const text = formatGroupPlans(result);
    expect(text).toMatch(/^1\. /);
    expect(text).toMatch(/^2\. /m);
    expect(text).toMatch(/^3\. /m);
    expect(text).toMatch(/least misery|Nash welfare|average satisfaction/i);
    expect(text).toMatch(/show more/i);
    expect(result.leftover.length).toBeGreaterThan(0);
  });

  it("advances to the next feasible slice on show more", () => {
    const first = rankRecommendationsSync(
      "what should we do tonight",
      [ramen, pizza, movie, rec({ id: "tacos", name: "Tacos", distanceMeters: 500, priceLevel: "PRICE_LEVEL_INEXPENSIVE", categories: ["mexican"] })],
      group,
    );
    expect(first.picks).toHaveLength(3);
    expect(asksForMorePlans("none of these, show more")).toBe(true);
    const second = rankRecommendationsSync(
      "show more",
      [ramen, pizza, movie, rec({ id: "tacos", name: "Tacos", distanceMeters: 500, priceLevel: "PRICE_LEVEL_INEXPENSIVE", categories: ["mexican"] })],
      group,
    );
    expect(second.picks.length).toBeGreaterThan(0);
    expect(second.picks[0]?.item.id).not.toBe(first.picks[0]?.item.id);
  });
});
