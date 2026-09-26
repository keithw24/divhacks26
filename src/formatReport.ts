import type { GeocodedPlace } from "./geocode.js";
import type { BlockSafetyReport } from "./safety.js";

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

/** Turn raw Open Data counts into a hangout-style verdict. Counts stay internal. */
export function safetyVerdict(report: BlockSafetyReport): SafetyVerdict {
  const shootHour = report.shootings.hourNeighborhoodCount;
  const shootArea = report.shootings.neighborhoodCount;
  const feloniesHour = report.hourNeighborhoodFelonies;
  const complaintsHour = report.hourNeighborhoodCount;
  const crashesHour = report.collisions.hourNeighborhoodCount;
  const late = report.hourEt >= 22 || report.hourEt <= 5;

  if (shootHour > 0 || feloniesHour >= 3) return "extra caution";
  if (shootArea >= 8 || (late && shootArea >= 3) || complaintsHour >= 8) return "extra caution";
  if (shootArea >= 3 || feloniesHour >= 1 || complaintsHour >= 3 || crashesHour >= 5) return "mixed";
  return "relatively safe";
}

function verdictLine(place: GeocodedPlace, report: BlockSafetyReport): string {
  const hour = hourLabel(report.hourEt);
  const window = windowLabel(report.hourEt);
  const years = report.years;
  const verdict = safetyVerdict(report);

  if (verdict === "relatively safe") {
    return `Around ${hour} (${window}) near ${place.label}, this area is considered relatively safe based on public records from the past ${years} years.`;
  }
  if (verdict === "mixed") {
    return `Around ${hour} (${window}) near ${place.label}, this area is mixed — typical city activity, so stay aware, based on public records from the past ${years} years.`;
  }
  return `Around ${hour} (${window}) near ${place.label}, extra caution is a good idea based on public records from the past ${years} years.`;
}

export function formatSafetyReply(place: GeocodedPlace, report: BlockSafetyReport): string {
  return [
    verdictLine(place, report),
    "NYPD maps these to a block midpoint or intersection — not live 911 and not a personal-risk score.",
  ].join("\n");
}
