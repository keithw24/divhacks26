import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/intent.js", () => ({ parseIntent: vi.fn() }));
vi.mock("../src/agent/compose.js", () => ({
  rankRecommendations: vi.fn(),
  renderResponse: vi.fn(() => "rendered response"),
}));
vi.mock("../src/skills/eventsSkill.js", () => ({ findEvents: vi.fn() }));
vi.mock("../src/skills/foodSkill.js", () => ({ findFood: vi.fn() }));
vi.mock("../src/skills/routeSkill.js", () => ({ getRoute: vi.fn() }));
vi.mock("../src/skills/safetySkill.js", () => ({ getSafety: vi.fn() }));
vi.mock("../src/geocode.js", () => ({ geocodeNyc: vi.fn(async () => null) }));

import { renderResponse, rankRecommendations } from "../src/agent/compose.js";
import { parseIntent } from "../src/agent/intent.js";
import { orchestrate } from "../src/agent/orchestrate.js";
import { findEvents } from "../src/skills/eventsSkill.js";
import { findFood } from "../src/skills/foodSkill.js";
import { getRoute } from "../src/skills/routeSkill.js";
import { getSafety } from "../src/skills/safetySkill.js";

const location = { who: "tester", latitude: 40.8075, longitude: -73.9626 };
const intentBase = {
  origin: { label: "shared", latitude: location.latitude, longitude: location.longitude },
  when: "now",
  categories: [],
  travelMode: "WALK" as const,
  needsClarification: false,
};

describe("skill dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findFood).mockResolvedValue({ status: "ok", data: [], sources: [], warnings: [] });
    vi.mocked(findEvents).mockResolvedValue({ status: "ok", data: [], sources: [], warnings: [] });
    vi.mocked(getSafety).mockResolvedValue({ status: "ok", data: null, sources: [], warnings: [] });
    vi.mocked(getRoute).mockResolvedValue({
      status: "ok",
      data: { mode: "WALK", summary: "10 min walk", directionsUrl: "https://maps.test" },
      sources: [],
      warnings: [],
    });
    vi.mocked(rankRecommendations).mockResolvedValue([]);
    vi.mocked(renderResponse).mockReturnValue("rendered response");
  });

  it("calls only safety for a focused safety request", async () => {
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, needs: ["safety"] });
    await expect(orchestrate({ question: "Is it safe here?", transcript: [], location })).resolves.toBe("rendered response");
    expect(getSafety).toHaveBeenCalledOnce();
    expect(findFood).not.toHaveBeenCalled();
    expect(findEvents).not.toHaveBeenCalled();
    expect(getRoute).not.toHaveBeenCalled();
  });

  it("still queries Tiger when Gemini omits the safety skill", async () => {
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, needs: ["food"] });
    await orchestrate({ question: "how safe is Columbia at 1pm", transcript: [], location });
    expect(getSafety).toHaveBeenCalledOnce();
    expect(getSafety).toHaveBeenCalledWith(
      expect.objectContaining({ when: "how safe is Columbia at 1pm" }),
    );
  });

  it("fans out a broad plan and routes the selected result", async () => {
    const event = {
      id: "event:parks:1",
      kind: "event" as const,
      name: "Outdoor Movie",
      location: { label: "Riverside Park", latitude: 40.805, longitude: -73.97 },
      distanceMeters: 700,
      categories: ["movie"],
      source: { name: "NYC Parks" },
    };
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, needs: ["events", "food", "safety", "route"] });
    vi.mocked(findEvents).mockResolvedValue({ status: "ok", data: [event], sources: [], warnings: [] });
    vi.mocked(rankRecommendations).mockResolvedValue([{ item: event, reason: "nearby" }]);

    await orchestrate({ question: "Plan a fun safe night", transcript: [], location });

    expect(findEvents).toHaveBeenCalledOnce();
    expect(findFood).toHaveBeenCalledOnce();
    expect(getSafety).toHaveBeenCalledWith(expect.objectContaining({ origin: event.location }));
    expect(getRoute).toHaveBeenCalledWith(expect.objectContaining({ destination: event.location }));
  });

  it("uses the fallback when no skill returns anything verified", async () => {
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, needs: ["food", "events", "safety"] });
    const fallback = vi.fn(async () => "gemini fallback");
    await expect(orchestrate({ question: "what now?", transcript: [], location, fallback })).resolves.toBe("gemini fallback");
    expect(fallback).toHaveBeenCalledOnce();
    expect(renderResponse).not.toHaveBeenCalled();
  });

  it("keeps the skill answer when any skill returns data", async () => {
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, needs: ["safety"] });
    vi.mocked(getSafety).mockResolvedValue({ status: "ok", data: { peakHour: 22 } as never, sources: [], warnings: [] });
    const fallback = vi.fn(async () => "gemini fallback");
    await expect(orchestrate({ question: "Is it safe here?", transcript: [], location, fallback })).resolves.toBe("rendered response");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("hands off to the fallback when no location can be resolved", async () => {
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, origin: undefined, needs: ["food"] });
    const fallback = vi.fn(async () => "where are you?");
    await expect(orchestrate({ question: "what now?", transcript: [], fallback })).resolves.toBe("where are you?");
    expect(findFood).not.toHaveBeenCalled();
  });

  it("uses the fallback when food/events were asked for but nothing was picked, even with safety data", async () => {
    vi.mocked(parseIntent).mockResolvedValue({ ...intentBase, needs: ["food", "events", "safety"] });
    vi.mocked(getSafety).mockResolvedValue({ status: "ok", data: { peakHour: 16 } as never, sources: [], warnings: [] });
    const fallback = vi.fn(async () => "gemini fallback");
    await expect(orchestrate({ question: "what should we do now?", transcript: [], location, fallback })).resolves.toBe("gemini fallback");
  });
});
