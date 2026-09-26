import type { GeocodedPlace } from "./geocode.js";
import type { BlockSafetyReport, SafetyBaselines } from "./safety.js";

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}

function windowLabel(hour: number): string {
  if (hour >= 7 && hour <= 10) return "morning commute";
  if (hour >= 11 && hour <= 16) return "midday";
  if (hour >= 17 && hour <= 21) return "evening";
  return "late night";
}

export type SafetyVerdict = "relatively safe" | "mixed" | "extra caution";
export type ActivityBand = "quieter" | "about average" | "busier";

export function activityBand(ratio: number | null | undefined): ActivityBand | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio < 0.7) return "quieter";
  if (ratio <= 1.3) return "about average";
  return "busier";
}

function boroughLabel(name: string | null): string {
  if (!name) return "this borough";
  return name
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Higher = more activity vs NYC / borough / this area's usual hour. */
export function safetyHeat(report: BlockSafetyReport): number {
  const { baselines } = report;
  const ratios = [baselines.hourVsNyc, baselines.hourVsArea, baselines.areaVsNyc, baselines.hourVsBorough]
    .filter((value): value is number => value != null && Number.isFinite(value))
    .map((value) => Math.min(value, 3));
  const typical = mean(ratios);
  let heat = typical == null ? 40 : (typical / 3) * 80;
  if (report.shootings.hourNeighborhoodCount > 0) heat += 20;
  heat += Math.min(report.hourNeighborhoodFelonies, 5) * 4;
  return heat;
}

export function safetyVerdict(report: BlockSafetyReport): SafetyVerdict {
  const heat = safetyHeat(report);
  if (heat >= 65) return "extra caution";
  if (heat >= 38) return "mixed";
  return "relatively safe";
}

function comparisonLine(baselines: SafetyBaselines): string | undefined {
  const vsNyc = activityBand(baselines.hourVsNyc);
  const vsArea = activityBand(baselines.hourVsArea);
  const vsBorough = activityBand(baselines.hourVsBorough ?? baselines.areaVsBorough);
  const parts: string[] = [];
  if (vsNyc) {
    parts.push(
      vsNyc === "about average"
        ? "in line with typical NYC at this hour"
        : `${vsNyc} than typical NYC at this hour`,
    );
  }
  if (vsArea) {
    parts.push(
      vsArea === "about average"
        ? "a typical hour for this neighborhood"
        : `${vsArea} than this neighborhood's usual hours`,
    );
  }
  if (vsBorough && baselines.borough) {
    parts.push(
      vsBorough === "about average"
        ? `about even with ${boroughLabel(baselines.borough)} overall`
        : `${vsBorough} than ${boroughLabel(baselines.borough)} overall`,
    );
  }
  if (!parts.length) return undefined;
  if (parts.length === 1) return `It is ${parts[0]}.`;
  return `It is ${parts[0]}, and ${parts.slice(1).join("; ")}.`;
}

export function formatSafetyReply(place: GeocodedPlace, report: BlockSafetyReport): string {
  const hour = hourLabel(report.hourEt);
  const window = windowLabel(report.hourEt);
  const years = report.years;
  const verdict = safetyVerdict(report);
  const label = place.label || report.placeLabel || "this area";

  let headline: string;
  if (verdict === "relatively safe") {
    headline = `Around ${hour} (${window}) near ${label}, this area is considered relatively safe.`;
  } else if (verdict === "mixed") {
    headline = `Around ${hour} (${window}) near ${label}, this area is mixed — typical city activity, so stay aware.`;
  } else {
    headline = `Around ${hour} (${window}) near ${label}, extra caution is a good idea.`;
  }

  return [
    headline,
    comparisonLine(report.baselines),
    `Based on public records from the past ${years} years, compared with NYC and neighborhood averages — not live 911 and not a personal-risk score.`,
  ]
    .filter(Boolean)
    .join("\n");
}
