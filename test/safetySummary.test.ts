import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/gemini.js", () => ({ generateJson: vi.fn() }));

import { generateJson } from "../src/agent/gemini.js";
import { summarizeSafety } from "../src/agent/safetySummary.js";
import type { BlockSafetyReport } from "../src/safety.js";

const NOW = new Date("2026-09-26T16:00:00Z");

const columbia = {
  placeLabel: "Columbia University",
  hourEt: 13,
  years: 2,
  neighborhoodMeters: 800,
  neighborhoodCount: 2400,
  hourNeighborhoodCount: 50,
  peakHour: 15,
  peakHourCount: 160,
  cityHourComplaints: 20_000,
  observation: { start: "2024-09-01T00:00:00Z", end: "2026-06-30T12:00:00Z", days: 667 },
  baselines: {
    borough: "MANHATTAN",
    areaVsNyc: 0.8,
    hourVsNyc: 0.3,
    hourVsArea: 0.4,
    areaVsBorough: 0.7,
    hourVsBorough: 0.35,
  },
} as BlockSafetyReport;

describe("summarizeSafety", () => {
  it("returns the deterministic context card without calling Gemini", async () => {
    const text = await summarizeSafety(columbia, NOW);
    expect(text).toMatch(/^From historical reported complaints, this area's 1–2 PM count is below its own typical hour/);
    expect(text).toContain("50 reports over 667 days");
    expect(text).toMatch(/Not live conditions/);
    expect(text).not.toMatch(/\b(safe|unsafe|dangerous|avoid)\b|safer than typical NYC/i);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("says there is too little data instead of a verdict for a thin sample", async () => {
    const thin = {
      ...columbia,
      hourNeighborhoodCount: 2,
      observation: { start: "2026-06-15T00:00:00Z", end: "2026-06-30T00:00:00Z", days: 15 },
    } as BlockSafetyReport;
    const text = await summarizeSafety(thin, NOW);
    expect(text).toMatch(/^Too few reported complaints near here at 1–2 PM \(2 in 15 days/);
  });
});
