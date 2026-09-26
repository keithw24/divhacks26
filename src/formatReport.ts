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
    .slice(0, 4)
    .map((row) => `${row.offense} (${row.n})`)
    .join("; ");
  const precinct = report.precincts[0];
  const peak =
    report.peakHour == null
      ? "no complaint peak in this extract"
      : `complaint volume peaked ~${hourLabel(report.peakHour)}`;
  const hour = hourLabel(report.hourEt);

  return [
    `Area: ${place.label}`,
    `Asked hour: ${hour} ET (${windowLabel(report.hourEt)}).`,
    `NYPD complaints within ~${report.neighborhoodMeters}m: ${report.neighborhoodCount} in the loaded sample (${report.hourNeighborhoodCount} at ${hour}). ${peak}. ${precinct ? `Mostly precinct ${precinct.precinct} / ${precinct.borough}.` : ""} ${offenses ? `Common: ${offenses}.` : ""}`,
    `Shootings within ~${report.neighborhoodMeters}m: ${report.shootings.neighborhoodCount} (${report.shootings.hourNeighborhoodCount} at ${hour}).`,
    `Crashes within ~${report.neighborhoodMeters}m: ${report.collisions.neighborhoodCount} (${report.collisions.hourNeighborhoodCount} at ${hour}); pedestrian/cyclist injuries in that sample: ${report.collisions.pedCycHurt}.`,
    `311 street lights/signals within ~${report.neighborhoodMeters}m: ${report.lights.neighborhoodCount} (${report.lights.openNeighborhood} still marked open).`,
    "All of this is public Open Data snapped to a block midpoint or intersection — not live 911 and not a personal-risk score.",
  ]
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
