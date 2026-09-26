import { describe, expect, it } from "vitest";
import {
  buildSafetyContext,
  classifyUncertainty,
  compareToBaseline,
  hourRangeLabel,
  poissonInterval,
  renderSafetyContext,
  SAFETY_LIMITATIONS,
} from "../src/safetyContext.js";
import { circleKm2, NYC_LAND_KM2, type BlockSafetyReport } from "../src/safety.js";

const NOW = new Date("2026-09-26T16:00:00Z");
const BANNED = /\b(safe|unsafe|dangerous|avoid|sketchy|risky)\b/i;
const NEIGHBORHOOD_LABELS = /\b(bad|good|rough|shady|high-crime|low-crime) (area|neighborhood)\b/i;

function report(overrides: Partial<BlockSafetyReport> = {}): BlockSafetyReport {
  return {
    latitude: 40.80775,
    longitude: -73.96249,
    hourEt: 22,
    asOfEt: "Sat, Sep 26, 12:00 PM EDT",
    blockMeters: 250,
    neighborhoodMeters: 800,
    blockCount: 100,
    neighborhoodCount: 2400,
    hourBlockCount: 5,
    hourNeighborhoodCount: 50,
    peakHour: 15,
    peakHourCount: 160,
    years: 2,
    hourNeighborhoodFelonies: 10,
    neighborhoodByHour: [],
    topOffenses: [],
    precincts: [],
    shootings: { blockCount: 0, neighborhoodCount: 0, hourBlockCount: 0, hourNeighborhoodCount: 0 },
    collisions: { blockCount: 0, neighborhoodCount: 0, hourBlockCount: 0, hourNeighborhoodCount: 0, pedCycHurt: 0 },
    lights: { blockCount: 0, neighborhoodCount: 0, hourBlockCount: 0, hourNeighborhoodCount: 0, openNeighborhood: 0 },
    baselines: {
      borough: "MANHATTAN",
      areaVsNyc: 1,
      hourVsNyc: 1,
      hourVsArea: 1,
      areaVsBorough: 1,
      hourVsBorough: 1,
    },
    cityHourComplaints: 20_000,
    observation: {
      start: "2024-09-01T00:00:00Z",
      end: "2026-06-30T12:00:00Z",
      days: 667,
    },
    ...overrides,
  };
}

describe("poissonInterval / compareToBaseline", () => {
  it("uses c ± 1.96√c and [0, 3.7] for zero", () => {
    expect(poissonInterval(0)).toEqual([0, 3.7]);
    const [lo, hi] = poissonInterval(100);
    expect(lo).toBeCloseTo(80.4, 5);
    expect(hi).toBeCloseTo(119.6, 5);
  });

  it("says below/above only when the interval excludes the baseline", () => {
    expect(compareToBaseline(50, 100)).toBe("below");
    expect(compareToBaseline(100, 50)).toBe("above");
    expect(compareToBaseline(100, 110)).toBe("no clear difference");
    expect(compareToBaseline(100, 90)).toBe("no clear difference");
    expect(compareToBaseline(0, 3.5)).toBe("no clear difference");
    expect(compareToBaseline(0, 4)).toBe("below");
  });
});

describe("classifyUncertainty", () => {
  const ok = { count: 40, windowDays: 180, ageDays: 10 };

  it("is low only with enough reports, a long window and fresh data", () => {
    expect(classifyUncertainty(ok)).toBe("low");
  });

  it("is high below 10 reports, under 30 days of data, or data older than 180 days", () => {
    expect(classifyUncertainty({ ...ok, count: 9 })).toBe("high");
    expect(classifyUncertainty({ ...ok, count: 10 })).toBe("medium");
    expect(classifyUncertainty({ ...ok, windowDays: 29 })).toBe("high");
    expect(classifyUncertainty({ ...ok, windowDays: 30 })).toBe("medium");
    expect(classifyUncertainty({ ...ok, ageDays: 181 })).toBe("high");
    expect(classifyUncertainty({ ...ok, ageDays: 180 })).toBe("low");
    expect(classifyUncertainty({ ...ok, ageDays: null })).toBe("high");
  });

  it("is medium below 40 reports or under 180 days of data", () => {
    expect(classifyUncertainty({ ...ok, count: 39 })).toBe("medium");
    expect(classifyUncertainty({ ...ok, windowDays: 179 })).toBe("medium");
  });
});

describe("buildSafetyContext", () => {
  it("uses the real observation window and computes both baselines", () => {
    const ctx = buildSafetyContext(report(), NOW);
    expect(ctx.observationWindowDays).toBe(667);
    expect(ctx.reportedComplaintCount).toBe(50);
    expect(ctx.sampleSize).toBe(2400);
    expect(ctx.localBaseline).toBe(100);
    expect(ctx.cityBaseline).toBeCloseTo((20_000 * circleKm2(800)) / NYC_LAND_KM2, 6);
    expect(ctx.dataFreshness).toBe("reports through Jun 30, 2026 (88 days ago)");
    expect(ctx.uncertainty).toBe("low");
    expect(ctx.vsLocal).toBe("below");
  });

  it("does not assume a 2-year sample when the table only holds ~15 days", () => {
    const ctx = buildSafetyContext(
      report({
        observation: { start: "2026-06-15T00:00:00Z", end: "2026-06-30T00:00:00Z", days: 15 },
      }),
      NOW,
    );
    expect(ctx.observationWindowDays).toBe(15);
    expect(ctx.uncertainty).toBe("high");
  });

  it("always includes the fixed limitations", () => {
    for (const r of [report(), report({ observation: undefined }), report({ hourNeighborhoodCount: 0 })]) {
      expect(buildSafetyContext(r, NOW).limitations).toEqual([...SAFETY_LIMITATIONS]);
    }
    expect(SAFETY_LIMITATIONS.join(" ")).toMatch(/not actual risk/);
    expect(SAFETY_LIMITATIONS.join(" ")).toMatch(/most serious/);
    expect(SAFETY_LIMITATIONS.join(" ")).toMatch(/time can differ/);
    expect(SAFETY_LIMITATIONS.join(" ")).toMatch(/revised/);
    expect(SAFETY_LIMITATIONS.join(" ")).toMatch(/block midpoints/);
    expect(SAFETY_LIMITATIONS.join(" ")).toMatch(/not live conditions/);
  });

  it("makes no comparisons when uncertainty is high", () => {
    const ctx = buildSafetyContext(report({ hourNeighborhoodCount: 3 }), NOW);
    expect(ctx.uncertainty).toBe("high");
    expect(ctx.vsLocal).toBeNull();
    expect(ctx.vsCity).toBeNull();
  });

  it("treats missing dates as high uncertainty", () => {
    const ctx = buildSafetyContext(report({ observation: undefined }), NOW);
    expect(ctx.observationWindowDays).toBe(0);
    expect(ctx.dataFreshness).toBe("report dates unavailable");
    expect(ctx.uncertainty).toBe("high");
  });
});

describe("renderSafetyContext", () => {
  it("renders a comparison card for low/medium uncertainty", () => {
    const text = renderSafetyContext(buildSafetyContext(report(), NOW));
    expect(text).toMatch(/^From historical reported complaints, this area's 10–11 PM count is below its own typical hour/);
    expect(text).toContain("50 reports over 667 days");
    expect(text).toContain("Jun 30, 2026");
    expect(text).toMatch(/Not live conditions, and it doesn't predict personal safety\.$/);
  });

  it("says 'no clear difference' when the interval covers the baseline", () => {
    const text = renderSafetyContext(
      buildSafetyContext(report({ hourNeighborhoodCount: 95, cityHourComplaints: 0 }), NOW),
    );
    expect(text).toContain("shows no clear difference from its own typical hour");
    expect(text).not.toMatch(/\b(below|above)\b/);
  });

  it("renders the too-few card with no comparison when uncertainty is high", () => {
    const text = renderSafetyContext(
      buildSafetyContext(report({ hourEt: 23, hourNeighborhoodCount: 4 }), NOW),
    );
    expect(text).toMatch(/^Too few reported complaints near here at 11 PM–12 AM \(4 in 667 days/);
    expect(text).toMatch(/Not live conditions\.$/);
    expect(text).not.toMatch(/\b(below|above|no clear difference|typical|citywide)\b/);
  });

  it("never uses verdict words or labels the neighborhood", () => {
    const variants = [
      report(),
      report({ hourNeighborhoodCount: 400 }),
      report({ hourNeighborhoodCount: 95 }),
      report({ hourNeighborhoodCount: 0 }),
      report({ hourNeighborhoodCount: 20, observation: { start: "2026-05-01T00:00:00Z", end: "2026-09-20T00:00:00Z", days: 142 } }),
      report({ observation: undefined }),
    ];
    for (const r of variants) {
      const text = renderSafetyContext(buildSafetyContext(r, NOW));
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(NEIGHBORHOOD_LABELS);
      expect(text).toMatch(/Not live conditions/);
    }
  });
});

describe("hourRangeLabel", () => {
  it("formats hour ranges across noon and midnight", () => {
    expect(hourRangeLabel(22)).toBe("10–11 PM");
    expect(hourRangeLabel(23)).toBe("11 PM–12 AM");
    expect(hourRangeLabel(11)).toBe("11 AM–12 PM");
    expect(hourRangeLabel(0)).toBe("12–1 AM");
  });
});
