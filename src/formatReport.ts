import type { GeocodedPlace } from "./geocode.js";
import type { BlockSafetyReport } from "./safety.js";

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}

function windowLabel(hour: number): string {
  if (hour >= 7 && hour <= 10) return "morning commute";
  if (hour >= 11 && hour <= 16) return "midday / afternoon";
  if (hour >= 17 && hour <= 21) return "evening";
  return "late night / overnight";
}

export function formatSafetyReply(place: GeocodedPlace, report: BlockSafetyReport): string {
  const offenses = report.topOffenses
    .slice(0, 5)
    .map((row) => `${row.offense} (${row.lawCategory.toLowerCase()}, ${row.n})`)
    .join("; ");
  const precinct = report.precincts[0];
  const precinctLine = precinct
    ? `Most reports sit in precinct ${precinct.precinct ?? "?"} / ${precinct.borough ?? "NYC"}.`
    : "";
  const peak =
    report.peakHour == null
      ? "Not enough nearby points to name a peak hour."
      : `In this sample, nearby volume peaked around ${hourLabel(report.peakHour)} (${report.peakHourCount} reports).`;

  return [
    `Area: ${place.label}`,
    `Clock: ${report.asOfEt} (${windowLabel(report.hourEt)}).`,
    "",
    `Block (~${report.blockMeters}m, midpoint/intersection points): ${report.blockCount} complaints in the loaded sample; ${report.hourBlockCount} in the ${hourLabel(report.hourEt)} hour.`,
    `Neighborhood (~${report.neighborhoodMeters}m): ${report.neighborhoodCount} complaints; ${report.hourNeighborhoodCount} at ${hourLabel(report.hourEt)}.`,
    peak,
    precinctLine,
    offenses ? `Common nearby types: ${offenses}.` : "No offense mix in this radius.",
    "",
    "This is NYPD public complaints, geocoded to the block midpoint or intersection — not a building address, and not a personal-risk score. Sample window is mid-to-late June 2026 YTD extract. Treat it as a pattern sketch, not a guarantee.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
