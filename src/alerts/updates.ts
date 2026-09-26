import { timeRange, walkMinutes, type Point } from "./geo.js";
import {
  fetchStreetEvents,
  prettyLocation,
  streetEventsNear,
  type StreetEvent,
} from "./streetEvents.js";
import { fetchSubwayAlerts, subwayAlertsNear, type NearbyStation, type SubwayAlert } from "./subway.js";

export const RADIUS_METERS = 800;

export type NearbyStreetEvent = StreetEvent & { meters: number };
export type NearbySubwayAlert = SubwayAlert & { station?: NearbyStation };

export interface AreaUpdates {
  street: NearbyStreetEvent[];
  subway: NearbySubwayAlert[];
  /** Sources that failed this time. The rest still count. */
  unavailable: Array<"street" | "subway">;
}

export interface UpdateSources {
  streetEvents?: (now: Date, hours: number) => Promise<StreetEvent[]>;
  subwayAlerts?: (now: Date) => Promise<SubwayAlert[]>;
}

/**
 * Permitted street events and MTA subway alerts within ~½ mile.
 * `push` keeps only what's worth an unprompted text: events starting within `hours`
 * and subway alerts at a nearby station or line-wide suspensions.
 */
export async function collectUpdates(
  point: Point,
  options: { now?: Date; hours?: number; mode?: "pull" | "push"; sources?: UpdateSources } = {},
): Promise<AreaUpdates> {
  const now = options.now ?? new Date();
  const hours = options.hours ?? 6;
  const push = options.mode === "push";
  const loadStreet = options.sources?.streetEvents ?? ((at: Date, h: number) => fetchStreetEvents(at, h));
  const loadSubway = options.sources?.subwayAlerts ?? ((at: Date) => fetchSubwayAlerts(at));
  const [street, subway] = await Promise.allSettled([loadStreet(now, hours), loadSubway(now)]);
  const unavailable: AreaUpdates["unavailable"] = [];
  if (street.status === "rejected") {
    unavailable.push("street");
    console.warn(`alerts: street events unavailable: ${String(street.reason)}`);
  }
  if (subway.status === "rejected") {
    unavailable.push("subway");
    console.warn(`alerts: subway alerts unavailable: ${String(subway.reason)}`);
  }
  const horizon = now.getTime() + hours * 3_600_000;
  const events = street.status === "fulfilled" ? streetEventsNear(point, street.value, RADIUS_METERS) : [];
  return {
    street: events.filter(
      (e) => e.startsAt.getTime() <= horizon && (e.endsAt ?? e.startsAt).getTime() >= now.getTime(),
    ),
    subway:
      subway.status === "fulfilled"
        ? subwayAlertsNear(point, subway.value, { radiusMeters: RADIUS_METERS, major: push })
        : [],
    unavailable,
  };
}

const KIND: Record<string, string> = {
  "Block Party": "Block party",
  "Street Festival": "Street festival",
  "Single Block Festival": "Street festival",
  Parade: "Parade",
  "Athletic Race / Tour": "Race",
  "Farmers Market": "Farmers market",
  "Open Street Partner Event": "Open street",
  "Plaza Event": "Plaza event",
  "Plaza Partner Event": "Plaza event",
  "Street Event": "Street event",
  "Special Event": "Street event",
};

function tidyName(name: string): string {
  return name === name.toUpperCase() ? name.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : name;
}

export function streetLine(event: NearbyStreetEvent, now = new Date()): string {
  const kind = KIND[event.type] ?? "Street event";
  const when = event.startsAt.getTime() <= now.getTime() && event.endsAt
    ? `now until ${timeRange(event.endsAt).replace(/^from /, "")}`
    : timeRange(event.startsAt, event.endsAt);
  const closure = event.closure && /full/i.test(event.closure) ? ", street closed" : "";
  const name = tidyName(event.name);
  const label = name.toLowerCase().includes(kind.toLowerCase()) ? name : `${kind}: ${name}`;
  return `${label}, ${prettyLocation(event.location)}, ${when}${closure} (~${walkMinutes(event.meters)} min walk)`;
}

export function subwayLine(alert: NearbySubwayAlert): string {
  const at = alert.station && !alert.text.includes(alert.station.name) ? ` (at ${alert.station.name})` : "";
  return `${alert.text.replace(/\.$/, "")}${at}`;
}

function sourcesLine(updates: AreaUpdates): string {
  const names = [
    updates.street.length ? "NYC permitted events" : "",
    updates.subway.length ? "MTA service alerts" : "",
  ].filter(Boolean);
  return names.length ? `Sources: ${names.join(", ")}.` : "";
}

function missingLine(updates: AreaUpdates): string {
  const missing = updates.unavailable.map((s) => (s === "street" ? "NYC street events" : "MTA alerts"));
  return missing.length ? `(${missing.join(" and ")} unavailable right now.)` : "";
}

/** Answer to "anything going on near me?" */
export function formatStatus(label: string, updates: AreaUpdates, hours: number, now = new Date()): string {
  const street = updates.street.slice(0, 3).map((e) => `• ${streetLine(e, now)}`);
  const subway = updates.subway.slice(0, 2).map((a) => `• ${subwayLine(a)}`);
  if (!street.length && !subway.length) {
    const checked = [
      updates.unavailable.includes("street") ? "" : `no permitted street events in the next ${hours} hours`,
      updates.unavailable.includes("subway") ? "" : "no subway alerts at nearby stations",
    ].filter(Boolean);
    const body = checked.length ? `Nothing unusual around ${label}: ${checked.join(" and ")}.` : "";
    return [body, missingLine(updates)].filter(Boolean).join(" ") || "I couldn't reach the city or MTA feeds right now.";
  }
  return [`Around ${label}:`, ...street, ...subway, sourcesLine(updates), missingLine(updates)]
    .filter(Boolean)
    .join("\n");
}

/** Unprompted heads-up for a watched area. */
export function formatPush(label: string, updates: AreaUpdates, now = new Date()): string {
  const lines = [
    ...updates.street.slice(0, 3).map((e) => `• ${streetLine(e, now)}`),
    ...updates.subway.slice(0, 2).map((a) => `• ${subwayLine(a)}`),
  ];
  return [`Heads up near ${label}:`, ...lines, sourcesLine(updates), 'Reply "stop alerts" to turn these off.']
    .filter(Boolean)
    .join("\n");
}

export function updateIds(updates: AreaUpdates): string[] {
  return [...updates.street.map((e) => e.id), ...updates.subway.map((a) => `mta:${a.id}`)];
}
