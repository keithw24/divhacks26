import { circleKm2, NYC_LAND_KM2, type BlockSafetyReport } from "./safety.js";

export type Uncertainty = "low" | "medium" | "high";
export type Comparison = "below" | "above" | "no clear difference";

export interface SafetyContext {
  /** Reported complaints within the neighborhood radius at the requested hour. */
  reportedComplaintCount: number;
  /** Days the complaint data actually covers (0 when unknown). */
  observationWindowDays: number;
  /** This area's typical hour: all-hours neighborhood count / 24. */
  localBaseline: number;
  /** Citywide complaints at this hour, scaled to the neighborhood circle's area. */
  cityBaseline: number;
  /** Neighborhood complaints across all hours. */
  sampleSize: number;
  dataFreshness: string;
  uncertainty: Uncertainty;
  limitations: string[];
  hourEt: number;
  peakHour: number | null;
  peakHourCount: number;
  /** Null when uncertainty is high — comparisons are not stated then. */
  vsLocal: Comparison | null;
  vsCity: Comparison | null;
}

export const SAFETY_LIMITATIONS: readonly string[] = [
  "These are reported complaints, not actual risk; many incidents are never reported.",
  "An incident with several offenses is recorded only under the most serious one.",
  "The recorded time can differ from when the incident actually happened.",
  "Records can be revised or reclassified after publication.",
  "Locations are approximate, snapped to block midpoints or intersections.",
  "Historical data only, not live conditions.",
];

const DAY_MS = 86_400_000;

/** Poisson 95% interval for an observed count (c ± 1.96·√c; [0, 3.7] for c = 0). */
export function poissonInterval(count: number): [number, number] {
  if (count <= 0) return [0, 3.7];
  const half = 1.96 * Math.sqrt(count);
  return [Math.max(0, count - half), count + half];
}

/** "below"/"above" only when the interval excludes the baseline. */
export function compareToBaseline(count: number, baseline: number): Comparison {
  const [lo, hi] = poissonInterval(count);
  if (hi < baseline) return "below";
  if (lo > baseline) return "above";
  return "no clear difference";
}

export function classifyUncertainty(input: {
  count: number;
  windowDays: number;
  ageDays: number | null;
}): Uncertainty {
  const { count, windowDays, ageDays } = input;
  if (count < 10 || windowDays < 30 || ageDays == null || ageDays > 180) return "high";
  if (count < 40 || windowDays < 180) return "medium";
  return "low";
}

function formatDateEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function ageInDays(end: string | null | undefined, now: Date): number | null {
  if (!end) return null;
  const ms = Date.parse(end);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
}

export function buildSafetyContext(report: BlockSafetyReport, now = new Date()): SafetyContext {
  const count = report.hourNeighborhoodCount ?? 0;
  const sampleSize = report.neighborhoodCount ?? 0;
  const windowDays = report.observation?.days ?? 0;
  const end = report.observation?.end ?? null;
  const ageDays = ageInDays(end, now);
  const localBaseline = sampleSize / 24;
  const cityBaseline =
    ((report.cityHourComplaints ?? 0) * circleKm2(report.neighborhoodMeters ?? 800)) / NYC_LAND_KM2;
  const uncertainty = classifyUncertainty({ count, windowDays, ageDays });
  const dataFreshness =
    end && ageDays != null
      ? `reports through ${formatDateEt(end)} (${ageDays} day${ageDays === 1 ? "" : "s"} ago)`
      : "report dates unavailable";
  const comparable = uncertainty !== "high";
  return {
    reportedComplaintCount: count,
    observationWindowDays: windowDays,
    localBaseline,
    cityBaseline,
    sampleSize,
    dataFreshness,
    uncertainty,
    limitations: [...SAFETY_LIMITATIONS],
    hourEt: report.hourEt,
    peakHour: report.peakHour ?? null,
    peakHourCount: report.peakHourCount ?? 0,
    vsLocal: comparable && localBaseline > 0 ? compareToBaseline(count, localBaseline) : null,
    vsCity: comparable && cityBaseline > 0 ? compareToBaseline(count, cityBaseline) : null,
  };
}

function clock(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

/** "10–11 PM", "11 AM–12 PM". */
export function hourRangeLabel(hour: number): string {
  const [start, startSuffix] = clock(hour).split(" ");
  const [end, endSuffix] = clock(hour + 1).split(" ");
  return startSuffix === endSuffix
    ? `${start}–${end} ${endSuffix}`
    : `${start} ${startSuffix}–${end} ${endSuffix}`;
}

function comparisonPhrase(result: Comparison, target: string): string {
  if (result === "no clear difference") return `shows no clear difference from ${target}`;
  return `is ${result} ${target}`;
}

function evidence(ctx: SafetyContext): string {
  const reports = `${ctx.reportedComplaintCount} report${ctx.reportedComplaintCount === 1 ? "" : "s"}`;
  const window = ctx.observationWindowDays > 0 ? ` over ${ctx.observationWindowDays} days` : "";
  return `${reports}${window}; ${ctx.dataFreshness}`;
}

/** Deterministic, verdict-free safety card text. */
export function renderSafetyContext(ctx: SafetyContext): string {
  const hours = hourRangeLabel(ctx.hourEt);
  if (ctx.uncertainty === "high" || (!ctx.vsLocal && !ctx.vsCity)) {
    const window = ctx.observationWindowDays > 0 ? ` in ${ctx.observationWindowDays} days` : "";
    return (
      `Too few reported complaints near here at ${hours} ` +
      `(${ctx.reportedComplaintCount}${window}; ${ctx.dataFreshness}) to see a reliable pattern. ` +
      "Not live conditions."
    );
  }
  const clauses: string[] = [];
  if (ctx.vsLocal) clauses.push(comparisonPhrase(ctx.vsLocal, "its own typical hour"));
  if (ctx.vsCity) clauses.push(comparisonPhrase(ctx.vsCity, "the citywide rate for that hour"));
  return (
    `From historical reported complaints, this area's ${hours} count ${clauses.join(" and ")} ` +
    `(${evidence(ctx)}). Not live conditions, and it doesn't predict personal safety.`
  );
}

export function safetyContextCard(report: BlockSafetyReport, now = new Date()): string {
  return renderSafetyContext(buildSafetyContext(report, now));
}
