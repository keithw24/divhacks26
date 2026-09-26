import { metersBetween, nycLocalToDate, type Point } from "./geo.js";

/** NYC permitted events (street fairs, block parties, parades). Updated daily, published ahead of time. */
export const PERMITTED_EVENTS_URL = "https://data.cityofnewyork.us/resource/tvpp-9vvx.json";
/** NYC street centerline (CSCL), used to place "X between Y and Z" on the map. */
export const CENTERLINE_URL = "https://data.cityofnewyork.us/resource/inkn-q76z.json";
export const PERMITTED_EVENTS_PAGE = "https://data.cityofnewyork.us/d/tvpp-9vvx";

export interface StreetEvent {
  id: string;
  name: string;
  type: string;
  location: string;
  borough: string;
  closure?: string;
  startsAt: Date;
  endsAt?: Date;
  point?: Point;
}

/** Things that happen on the street. Youth/adult sports permits are park fields, so they are left out. */
const STREET_TYPES = new Set([
  "Block Party",
  "Street Event",
  "Street Festival",
  "Single Block Festival",
  "Parade",
  "Athletic Race / Tour",
  "Farmers Market",
  "Open Street Partner Event",
  "Plaza Event",
  "Plaza Partner Event",
  "Special Event",
]);

/** Standing permits that close nothing new today (pedestrian malls, curb bump-outs, storage). */
const ROUTINE = /bump ?-?outs?|pedestrian mall|storage|\bstock\b|sukkah|seating|cafe/i;

const BOROUGH_CODES: Record<string, string> = {
  manhattan: "1",
  bronx: "2",
  brooklyn: "3",
  queens: "4",
  "staten island": "5",
};

const SUFFIXES: Record<string, string> = {
  STREET: "ST",
  AVENUE: "AVE",
  ROAD: "RD",
  BOULEVARD: "BLVD",
  PLACE: "PL",
  DRIVE: "DR",
  PARKWAY: "PKWY",
  LANE: "LN",
  COURT: "CT",
  TERRACE: "TER",
  EXPRESSWAY: "EXPY",
  SQUARE: "SQ",
  HIGHWAY: "HWY",
  PLAZA: "PLZ",
};
const DIRECTIONS: Record<string, string> = { WEST: "W", EAST: "E", NORTH: "N", SOUTH: "S" };

/** "WEST 100 STREET" → "W 100 ST", matching the centerline's street labels. */
export function centerlineName(street: string): string {
  const words = street
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^(\d+)(ST|ND|RD|TH)$/, "$1"));
  if (words.length > 1) {
    const last = words.length - 1;
    words[last] = SUFFIXES[words[last]!] ?? words[last]!;
    if (DIRECTIONS[words[0]!] && /^\d+$/.test(words[1]!)) words[0] = DIRECTIONS[words[0]!]!;
    if (words[0] === "SAINT") words[0] = "ST";
  }
  return words.join(" ");
}

/** "VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET" → the three street names. */
export function parseSegment(location: string): { street: string; from: string; to: string } | null {
  const first = location.split(",")[0] ?? "";
  const match = first.match(/^\s*(.+?)\s+between\s+(.+?)\s+and\s+(.+?)\s*$/i);
  if (!match) return null;
  return { street: match[1]!, from: match[2]!, to: match[3]! };
}

type Geometry = { type?: string; coordinates?: number[][][] | number[][] };

function endpoints(geometry: Geometry | undefined): Array<[number, number]> {
  const lines = (geometry?.type === "LineString" ? [geometry.coordinates] : geometry?.coordinates) as
    | number[][][]
    | undefined;
  const out: Array<[number, number]> = [];
  for (const line of lines ?? []) {
    const first = line[0];
    const last = line[line.length - 1];
    if (first) out.push([first[0]!, first[1]!]);
    if (last) out.push([last[0]!, last[1]!]);
  }
  return out;
}

function meeting(a: Array<[number, number]>, b: Array<[number, number]>): Point | null {
  let best: { meters: number; point: Point } | null = null;
  for (const [lonA, latA] of a) {
    for (const [lonB, latB] of b) {
      const meters = metersBetween({ latitude: latA, longitude: lonA }, { latitude: latB, longitude: lonB });
      if (meters < 30 && (!best || meters < best.meters)) {
        best = { meters, point: { latitude: (latA + latB) / 2, longitude: (lonA + lonB) / 2 } };
      }
    }
  }
  return best?.point ?? null;
}

const placeCache = new Map<string, Point | null>();

/** Midpoint of the block, from where the street meets its two cross streets. Cached per location. */
export async function placeStreetSegment(
  location: string,
  borough: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Point | null> {
  const key = `${borough}|${location}`.toUpperCase();
  if (placeCache.has(key)) return placeCache.get(key) ?? null;
  const segment = parseSegment(location);
  const code = BOROUGH_CODES[borough.trim().toLowerCase()];
  if (!segment || !code) {
    placeCache.set(key, null);
    return null;
  }
  const names = [segment.street, segment.from, segment.to].map(centerlineName);
  const url = new URL(CENTERLINE_URL);
  url.searchParams.set("$select", "stname_label,the_geom");
  url.searchParams.set(
    "$where",
    `boroughcode='${code}' AND stname_label in (${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")})`,
  );
  url.searchParams.set("$limit", "2000");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`centerline HTTP ${response.status}`);
  const rows = (await response.json()) as Array<{ stname_label?: string; the_geom?: Geometry }>;
  const ends = (name: string) => rows.filter((r) => r.stname_label === name).flatMap((r) => endpoints(r.the_geom));
  const main = ends(names[0]!);
  const corners = [meeting(main, ends(names[1]!)), meeting(main, ends(names[2]!))].filter((p): p is Point => !!p);
  const point = corners.length
    ? {
        latitude: corners.reduce((sum, p) => sum + p.latitude, 0) / corners.length,
        longitude: corners.reduce((sum, p) => sum + p.longitude, 0) / corners.length,
      }
    : null;
  if (placeCache.size > 5000) placeCache.clear();
  placeCache.set(key, point);
  return point;
}

export function resetStreetEventCaches(): void {
  placeCache.clear();
  eventsCache = undefined;
}

type RawPermit = {
  event_id?: string;
  event_name?: string;
  event_type?: string;
  event_location?: string;
  event_borough?: string;
  street_closure_type?: string;
  start_date_time?: string;
  end_date_time?: string;
};

export function parsePermit(raw: RawPermit): StreetEvent | null {
  if (!raw.event_id || !raw.event_name || !raw.event_type || !STREET_TYPES.has(raw.event_type)) return null;
  if (!raw.event_location || !raw.event_borough || !raw.start_date_time) return null;
  if (ROUTINE.test(raw.event_name)) return null;
  const startsAt = nycLocalToDate(raw.start_date_time);
  if (!startsAt) return null;
  const closure = raw.street_closure_type?.trim();
  // Most "Special Event" permits are inside parks; keep only the ones that close a street.
  if (raw.event_type === "Special Event" && (!closure || /^(n\/?a|none)$/i.test(closure))) return null;
  const endsAt = raw.end_date_time ? nycLocalToDate(raw.end_date_time) ?? undefined : undefined;
  // Season-long permits (weekly markets, standing closures) have no "happening now" to report.
  if (endsAt && endsAt.getTime() - startsAt.getTime() > 24 * 3_600_000) return null;
  return {
    id: `permit:${raw.event_id}:${raw.start_date_time}`,
    name: raw.event_name.trim(),
    type: raw.event_type,
    location: raw.event_location.trim(),
    borough: raw.event_borough.trim(),
    closure: closure && !/^(n\/?a|none)$/i.test(closure) ? closure : undefined,
    startsAt,
    endsAt,
  };
}

function sodaLocal(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

let eventsCache: { key: string; at: number; events: StreetEvent[] } | undefined;

/**
 * Street events overlapping [now, now + hours], placed on the map.
 * Refetched at most every 20 minutes; events whose block can't be placed are dropped.
 */
export async function fetchStreetEvents(
  now = new Date(),
  hours = 12,
  fetchImpl: typeof fetch = fetch,
): Promise<StreetEvent[]> {
  const key = `${hours}`;
  if (eventsCache && eventsCache.key === key && now.getTime() - eventsCache.at < 20 * 60_000) {
    return eventsCache.events.filter((e) => (e.endsAt ?? e.startsAt).getTime() >= now.getTime());
  }
  const url = new URL(PERMITTED_EVENTS_URL);
  const from = sodaLocal(now);
  const to = sodaLocal(new Date(now.getTime() + hours * 3_600_000));
  url.searchParams.set(
    "$where",
    `start_date_time <= '${to}' AND end_date_time >= '${from}' AND event_type in (${[...STREET_TYPES]
      .map((t) => `'${t.replace(/'/g, "''")}'`)
      .join(",")})`,
  );
  url.searchParams.set("$order", "start_date_time ASC");
  url.searchParams.set("$limit", "500");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`permitted events HTTP ${response.status}`);
  const raws = (await response.json()) as RawPermit[];
  const seen = new Set<string>();
  const parsed: StreetEvent[] = [];
  for (const raw of raws) {
    const event = parsePermit(raw);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    parsed.push(event);
  }
  // Five centerline lookups at a time; each block is cached for the life of the process.
  for (let i = 0; i < parsed.length; i += 5) {
    await Promise.all(
      parsed.slice(i, i + 5).map(async (event) => {
        event.point = (await placeStreetSegment(event.location, event.borough, fetchImpl).catch(() => null)) ?? undefined;
      }),
    );
  }
  const events = parsed.filter((e) => e.point);
  eventsCache = { key, at: now.getTime(), events };
  return events;
}

export function streetEventsNear(
  point: Point,
  events: StreetEvent[],
  radiusMeters = 800,
): Array<StreetEvent & { meters: number }> {
  return events
    .flatMap((e) => (e.point ? [{ ...e, meters: metersBetween(point, e.point) }] : []))
    .filter((e) => e.meters <= radiusMeters)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.meters - b.meters);
}

/** "VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET" → "Varet St between Graham Ave and Humboldt St". */
export function prettyLocation(location: string): string {
  const segment = parseSegment(location);
  const title = (s: string) =>
    centerlineName(s)
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return segment
    ? `${title(segment.street)} between ${title(segment.from)} and ${title(segment.to)}`
    : location.split(",")[0]!.trim();
}
