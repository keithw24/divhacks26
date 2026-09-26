import type { BlockSafetyReport } from "./safety.js";

export type SafetyBand = "safer" | "typical" | "slightly elevated" | "elevated";

export function safetyBand(ratio: number | null | undefined): SafetyBand | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio < 0.7) return "safer";
  if (ratio <= 1.3) return "typical";
  if (ratio <= 2.0) return "slightly elevated";
  return "elevated";
}

/** @deprecated use safetyBand */
export function activityBand(ratio: number | null | undefined): SafetyBand | null {
  return safetyBand(ratio);
}

function roundRatio(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

const NYC_RATIO_NOTE =
  "1.0 = typical NYC complaint density at that hour; higher = more recorded complaints, not how crowded it feels.";

/** Compact Tiger comparison for Gemini — ratios, not incident lists. */
export function safetyFacts(report: BlockSafetyReport) {
  const baselines = report.baselines ?? {
    borough: null,
    areaVsNyc: null,
    hourVsNyc: null,
    hourVsArea: null,
    areaVsBorough: null,
    hourVsBorough: null,
  };
  const ratio = baselines.hourVsNyc ?? baselines.areaVsNyc;
  const band = safetyBand(ratio);
  return {
    place: report.placeLabel ?? "unknown",
    hourEt: report.hourEt,
    sampleYears: report.years,
    vsNycThisHour: roundRatio(baselines.hourVsNyc),
    vsNycOverall: roundRatio(baselines.areaVsNyc),
    vsThisNeighborhoodUsualHour: roundRatio(baselines.hourVsArea),
    vsBoroughThisHour: roundRatio(baselines.hourVsBorough),
    borough: baselines.borough,
    ratioMeaning: NYC_RATIO_NOTE,
    calibratedAdvice: bandAdvice(band),
  };
}

function bandAdvice(band: SafetyBand | null): string {
  if (band === "safer") {
    return "Safer than typical NYC. Everyday awareness only. Do not tell them to be cautious or extra careful.";
  }
  if (band === "typical") {
    return "About as safe as typical NYC. Reasonable awareness, not extra caution.";
  }
  if (band === "slightly elevated") {
    return "A bit less safe than typical NYC. Suggest being slightly cautious. Do not say super cautious, avoid, or dangerous.";
  }
  if (band === "elevated") {
    return "Noticeably less safe than typical NYC. Suggest a bit more caution than usual, still reasonable — not panic, not avoid the area.";
  }
  return "Not enough comparison data. Stay neutral.";
}

/** Fallback if Gemini is down: one calm sentence vs NYC. */
export function nycComparisonPhrase(report: BlockSafetyReport): string {
  const band = safetyBand(report.baselines?.hourVsNyc ?? report.baselines?.areaVsNyc);
  if (band === "safer") {
    return "Looks safer than typical NYC — everyday awareness is enough.";
  }
  if (band === "typical") {
    return "About as safe as typical NYC — stay reasonably aware, nothing unusual.";
  }
  if (band === "slightly elevated") {
    return "A bit less safe than typical NYC — be slightly cautious, not alarmed.";
  }
  if (band === "elevated") {
    return "Less safe than typical NYC — a bit more caution than usual, but it's not a red flag.";
  }
  return "Not enough city data for a safety reading.";
}

export function formatSafetyReply(_place: unknown, report: BlockSafetyReport): string {
  return nycComparisonPhrase(report);
}
