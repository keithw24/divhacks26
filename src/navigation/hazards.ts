import { currentHourEt, getPool, parseRequestedHour } from "../safety.js";
import type { HazardQuery, NavHazard, NavHazardKind } from "./types.js";

const CORRIDOR_METERS = 450;
const LIGHTS_SQL = `
WITH pts AS (
  SELECT * FROM unnest($1::float8[], $2::float8[]) AS t(lat, lon)
)
SELECT
  CASE
    WHEN L.complaint_type ILIKE '%signal%' THEN 'signal'
    WHEN L.complaint_type ILIKE '%street condition%'
      OR L.complaint_type ILIKE '%construction%'
      OR L.descriptor ILIKE '%closed%'
      OR L.descriptor ILIKE '%blocked%' THEN 'street_closed'
    ELSE 'streetlight'
  END AS kind,
  COALESCE(L.descriptor, L.complaint_type, '311 report') AS label,
  COALESCE(L.street_name, L.descriptor) AS street,
  L.latitude,
  L.longitude
FROM nyc_311_lights L
CROSS JOIN pts
WHERE L.status ILIKE 'open%'
  AND L.latitude BETWEEN pts.lat - 0.004 AND pts.lat + 0.004
  AND L.longitude BETWEEN pts.lon - 0.004 AND pts.lon + 0.004
  AND nyc_meters(pts.lat, pts.lon, L.latitude, L.longitude) < $3
  AND (
    (
      (L.complaint_type ILIKE '%signal%' OR L.complaint_type ILIKE '%street light%')
      AND L.occurred_at >= now() - interval '21 days'
    )
    OR (
      (
        L.complaint_type ILIKE '%street condition%'
        OR L.complaint_type ILIKE '%construction%'
        OR L.complaint_type ILIKE '%blocked%'
        OR L.descriptor ILIKE '%closed%'
        OR L.descriptor ILIKE '%blocked%'
      )
      AND L.occurred_at >= now() - interval '6 hours'
    )
  )
LIMIT 30
`;

const EVENTS_SQL = `
WITH pts AS (
  SELECT * FROM unnest($1::float8[], $2::float8[]) AS t(lat, lon)
)
SELECT DISTINCT
  'film_shoot' AS kind,
  COALESCE(e.title, e.venue, 'city event') AS label,
  e.venue AS street,
  e.latitude,
  e.longitude
FROM city_events e
CROSS JOIN pts
WHERE e.latitude IS NOT NULL AND e.longitude IS NOT NULL
  AND e.starts_at <= now() + interval '6 hours'
  AND (e.ends_at IS NULL OR e.ends_at >= now() - interval '1 hour')
  AND (
    e.title ~* 'film|filming|shoot|street closure|block party'
    OR COALESCE(e.category, '') ~* 'film|shoot|street'
  )
  AND nyc_meters(pts.lat, pts.lon, e.latitude, e.longitude) < $3
LIMIT 20
`;

const FILM_SQL = `
WITH clock AS (
  SELECT
    CASE
      WHEN COALESCE(max(end_at), now()) < now() - interval '2 days' THEN max(end_at)
      ELSE now()
    END AS t,
    CASE
      WHEN COALESCE(max(end_at), now()) < now() - interval '2 days' THEN interval '45 days'
      ELSE interval '30 minutes'
    END AS lookback
  FROM nyc_film_permits
)
SELECT
  'film_shoot' AS kind,
  COALESCE(event_type, category, 'film permit') AS label,
  parking_held AS street,
  NULL::float8 AS latitude,
  NULL::float8 AS longitude
FROM nyc_film_permits, clock
WHERE parking_held IS NOT NULL
  AND start_at <= clock.t + interval '4 hours'
  AND end_at >= clock.t - clock.lookback
LIMIT 80
`;

const CRASH_SQL = `
WITH pts AS (
  SELECT * FROM unnest($1::float8[], $2::float8[]) AS t(lat, lon)
)
SELECT
  'crash' AS kind,
  'recent collision report' AS label,
  COALESCE(C.on_street, C.off_street) AS street,
  C.latitude,
  C.longitude
FROM nyc_collisions C
CROSS JOIN pts
WHERE C.occurred_at >= now() - interval '6 hours'
  AND C.latitude BETWEEN pts.lat - 0.004 AND pts.lat + 0.004
  AND C.longitude BETWEEN pts.lon - 0.004 AND pts.lon + 0.004
  AND nyc_meters(pts.lat, pts.lon, C.latitude, C.longitude) < $3
LIMIT 20
`;

function isSchemaGap(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code: string }).code;
  return code === "42P01" || code === "42703";
}

function asKind(value: string): NavHazardKind {
  if (value === "signal" || value === "street_closed" || value === "film_shoot" || value === "crash") return value;
  return "streetlight";
}

function corridorPoints(points: Array<{ latitude: number; longitude: number }>) {
  const usable = points.filter(
    (point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude),
  );
  if (usable.length >= 2) {
    const first = usable[0]!;
    const last = usable[usable.length - 1]!;
    usable.push({
      latitude: (first.latitude + last.latitude) / 2,
      longitude: (first.longitude + last.longitude) / 2,
    });
  }
  return usable;
}

async function run(
  query: HazardQuery,
  sql: string,
  values: unknown[],
  nearCorridor = true,
): Promise<NavHazard[]> {
  try {
    const result = await query(sql, values);
    return result.rows.map((row) => ({
      kind: asKind(row.kind),
      label: row.label,
      ...(row.street && { street: row.street }),
      ...(row.latitude != null && { latitude: Number(row.latitude) }),
      ...(row.longitude != null && { longitude: Number(row.longitude) }),
      nearCorridor,
    }));
  } catch (error) {
    if (isSchemaGap(error)) return [];
    throw error;
  }
}

export async function lookupNavHazards(input: {
  points: Array<{ latitude: number; longitude: number }>;
  databaseUrl?: string;
  query?: HazardQuery;
  now?: Date;
  when?: string;
  radiusMeters?: number;
}): Promise<NavHazard[]> {
  const points = corridorPoints(input.points);
  if (!points.length) return [];
  const query =
    input.query ??
    (input.databaseUrl
      ? async (sql, values) => getPool(input.databaseUrl!).query(sql, values)
      : undefined);
  if (!query) return [];

  const lats = points.map((point) => point.latitude);
  const lons = points.map((point) => point.longitude);
  const radius = input.radiusMeters ?? CORRIDOR_METERS;
  const [lights, events, films, crashes] = await Promise.all([
    run(query, LIGHTS_SQL, [lats, lons, radius]),
    run(query, EVENTS_SQL, [lats, lons, Math.max(radius, 450)]),
    run(query, FILM_SQL, [], false),
    run(query, CRASH_SQL, [lats, lons, radius]),
  ]);
  const merged = [...lights, ...events, ...films, ...crashes];
  const unique = new Map<string, NavHazard>();
  for (const hazard of merged) {
    const key = `${hazard.kind}:${hazard.street ?? hazard.label}:${hazard.latitude ?? ""}`;
    if (!unique.has(key)) unique.set(key, hazard);
  }
  const list = [...unique.values()];
  console.info(`tiger: nav hazards ${list.length} (311/events/film/crashes)`);
  return list;
}

/** One operational sentence. Not a crime forecast. */
export function recentOpsNote(hazards: NavHazard[]): string | undefined {
  const fresh = hazards.filter(
    (hazard) => hazard.kind === "crash" || hazard.kind === "street_closed" || hazard.kind === "film_shoot",
  );
  if (!fresh.length) return undefined;
  const bits = [
    fresh.some((hazard) => hazard.kind === "crash") ? "collision reports" : "",
    fresh.some((hazard) => hazard.kind === "street_closed") ? "open 311 street issues" : "",
    fresh.some((hazard) => hazard.kind === "film_shoot") ? "film/street holds" : "",
  ].filter(Boolean);
  return `Last few hours on this stretch (city ops, not a live crime feed): ${bits.join(", ")}. I’d route around walking those blocks.`;
}

export function nightHourEt(when: string, now = new Date()): number {
  return parseRequestedHour(when, currentHourEt(now).hourEt);
}

export function isNightHour(hourEt: number): boolean {
  return hourEt >= 19 || hourEt < 6;
}
