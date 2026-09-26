import { describe, expect, it, vi } from "vitest";
import {
  buildChartFacts,
  checkReadback,
  renderChartPng,
  renderChartSvg,
  safetyChartImage,
  type ChartFacts,
  type ChartReadback,
} from "../src/safetyChart.js";
import type { BlockSafetyReport } from "../src/safety.js";

const NOW = new Date("2026-09-26T16:00:00Z");
const COUNTS = [60, 45, 38, 30, 22, 20, 28, 55, 85, 110, 130, 140, 150, 160, 165, 160, 150, 140, 125, 110, 90, 78, 50, 70];

function report(overrides: Partial<BlockSafetyReport> = {}): BlockSafetyReport {
  const counts = COUNTS;
  return {
    hourEt: 22,
    neighborhoodMeters: 800,
    neighborhoodCount: counts.reduce((a, b) => a + b, 0),
    hourNeighborhoodCount: counts[22],
    peakHour: 14,
    peakHourCount: 165,
    cityHourComplaints: 20_000,
    neighborhoodByHour: counts.map((complaints, hourEt) => ({ hourEt, complaints, felonies: 0 })),
    observation: { start: "2024-09-01T12:00:00Z", end: "2026-06-30T12:00:00Z", days: 667 },
    ...overrides,
  } as BlockSafetyReport;
}

function goodReadback(facts: ChartFacts): ChartReadback {
  return {
    headline: facts.headline,
    allText: [facts.subtitle, facts.legendHour, facts.legendLine, "Your time", "Midnight 6 AM Noon 6 PM", facts.footnote].join(" "),
    highlightedBarVsDashedLine: facts.highlightedVsLine === "about equal" ? "about equal" : facts.highlightedVsLine,
    sameBarShapeAsOriginal: true,
    hasAlarmingImagery: false,
  };
}

describe("buildChartFacts", () => {
  it("writes a plain-language headline from the Poisson comparison", () => {
    const facts = buildChartFacts(report(), NOW)!;
    expect(facts.headline).toBe("Fewer reports than usual here at 10–11 PM");
    expect(facts.highlightedVsLine).toBe("shorter");
    expect(facts.counts).toEqual(COUNTS);
    expect(facts.footnote).toBe("2211 reports, Sep 1, 2024 to Jun 30, 2026. Past reports, not live conditions.");
  });

  it("says 'about the usual' when the difference is not clear", () => {
    const counts = [...COUNTS];
    counts[22] = 90;
    const facts = buildChartFacts(
      report({
        hourNeighborhoodCount: 90,
        neighborhoodCount: counts.reduce((a, b) => a + b, 0),
        neighborhoodByHour: counts.map((complaints, hourEt) => ({ hourEt, complaints, felonies: 0 })),
      }),
      NOW,
    )!;
    expect(facts.headline).toBe("About the usual number of reports here at 10–11 PM");
  });

  it("draws nothing when uncertainty is high or dates are missing", () => {
    expect(buildChartFacts(report({ hourNeighborhoodCount: 4 }), NOW)).toBeNull();
    expect(buildChartFacts(report({ observation: { start: "2026-06-15T00:00:00Z", end: "2026-06-30T00:00:00Z", days: 15 } }), NOW)).toBeNull();
    expect(buildChartFacts(report({ observation: undefined }), NOW)).toBeNull();
  });

  it("never uses verdict words anywhere on the chart", () => {
    const svg = renderChartSvg(buildChartFacts(report(), NOW)!);
    const text = svg.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(safe|unsafe|dangerous|avoid|risky)\b/i);
    expect(text).toContain("not live conditions");
  });
});

describe("renderChartPng", () => {
  it("renders the exact chart to a PNG", () => {
    const png = renderChartPng(buildChartFacts(report(), NOW)!);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.length).toBeGreaterThan(5_000);
  });
});

describe("checkReadback", () => {
  const facts = buildChartFacts(report(), NOW)!;

  it("accepts a faithful restyle", () => {
    expect(checkReadback(facts, goodReadback(facts))).toEqual({ ok: true, reasons: [] });
  });

  it("tolerates dash and case differences in the headline", () => {
    const rb = { ...goodReadback(facts), headline: "fewer reports than usual here at 10-11 PM" };
    expect(checkReadback(facts, rb).ok).toBe(true);
  });

  it("rejects a changed headline, invented numbers, verdict words, a flipped bar, a new shape, or alarming imagery", () => {
    const cases: Array<[Partial<ChartReadback>, RegExp]> = [
      [{ headline: "More reports than usual here at 10–11 PM" }, /headline/],
      [{ allText: `${goodReadback(facts).allText} 3,500 incidents` }, /unexpected numbers: 3500/],
      [{ allText: `${goodReadback(facts).allText} Stay safe` }, /verdict/],
      [{ highlightedBarVsDashedLine: "taller" }, /highlighted bar/],
      [{ highlightedBarVsDashedLine: "unclear" }, /highlighted bar/],
      [{ sameBarShapeAsOriginal: false }, /shape/],
      [{ hasAlarmingImagery: true }, /alarming/],
    ];
    for (const [change, reason] of cases) {
      const check = checkReadback(facts, { ...goodReadback(facts), ...change });
      expect(check.ok).toBe(false);
      expect(check.reasons.join("; ")).toMatch(reason);
    }
  });
});

describe("safetyChartImage", () => {
  const restyled = { data: Buffer.from("restyled"), mimeType: "image/jpeg" };

  it("returns the restyled image when the read-back matches", async () => {
    const restyle = vi.fn(async (_png: Buffer, _facts: ChartFacts) => restyled);
    const readback = vi.fn(async (_png: Buffer) => goodReadback(buildChartFacts(report(), NOW)!));
    await expect(safetyChartImage(report(), { now: NOW, restyle, readback })).resolves.toBe(restyled);
    expect(restyle.mock.calls[0]?.[0]?.subarray(1, 4).toString()).toBe("PNG");
  });

  it("sends nothing when the restyle fails the check", async () => {
    const readback = async () => ({ ...goodReadback(buildChartFacts(report(), NOW)!), sameBarShapeAsOriginal: false });
    await expect(safetyChartImage(report(), { now: NOW, restyle: async () => restyled, readback })).resolves.toBeNull();
  });

  it("falls back to the exact chart when Gemini is out of quota", async () => {
    const restyle = async () => {
      throw new Error("429 RESOURCE_EXHAUSTED");
    };
    const image = await safetyChartImage(report(), { now: NOW, restyle, readback: vi.fn() });
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data.subarray(1, 4).toString()).toBe("PNG");
  });

  it("falls back to the exact chart when the read-back times out", async () => {
    const readback = () => new Promise<ChartReadback>(() => {});
    const image = await safetyChartImage(report(), { now: NOW, restyle: async () => restyled, readback, timeoutMs: 20 });
    expect(image?.mimeType).toBe("image/png");
  });

  it("sends nothing and calls no model when there is too little data", async () => {
    const restyle = vi.fn();
    await expect(safetyChartImage(report({ hourNeighborhoodCount: 3 }), { now: NOW, restyle })).resolves.toBeNull();
    expect(restyle).not.toHaveBeenCalled();
  });
});
