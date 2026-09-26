import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/gemini.js", () => ({ generateJson: vi.fn() }));

import { generateJson } from "../src/agent/gemini.js";
import { summarizeSafety } from "../src/agent/safetySummary.js";
import type { BlockSafetyReport } from "../src/safety.js";

const quiet = {
  placeLabel: "Columbia University",
  hourEt: 13,
  years: 2,
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
  beforeEach(() => {
    vi.mocked(generateJson).mockReset();
  });

  it("uses Gemini's calibrated sentence", async () => {
    vi.mocked(generateJson).mockResolvedValue({
      summary: "Looks safer than typical NYC — everyday awareness is enough.",
    });
    await expect(summarizeSafety(quiet)).resolves.toMatch(/everyday awareness/i);
    expect(generateJson).toHaveBeenCalledOnce();
    const prompt = String(vi.mocked(generateJson).mock.calls[0]?.[0]);
    expect(prompt).toContain("vsNycThisHour");
    expect(prompt).toContain("everyday awareness");
  });

  it("falls back if Gemini over-warns a safer-than-NYC place", async () => {
    vi.mocked(generateJson).mockResolvedValue({
      summary: "Be super cautious around here and extra careful after dark.",
    });
    await expect(summarizeSafety(quiet)).resolves.toMatch(/everyday awareness/i);
  });
});
