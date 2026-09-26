import pg from "pg";

export interface HourBucket {
  hourEt: number;
  complaints: number;
  felonies: number;
}

export interface OffenseCount {
  offense: string;
  lawCategory: string;
  n: number;
}

export interface LayerCounts {
  blockCount: number;
  neighborhoodCount: number;
  hourBlockCount: number;
  hourNeighborhoodCount: number;
}

export interface BlockSafetyReport {
  latitude: number;
  longitude: number;
  hourEt: number;
  asOfEt: string;
  blockMeters: number;
  neighborhoodMeters: number;
  blockCount: number;
  neighborhoodCount: number;
  hourBlockCount: number;
  hourNeighborhoodCount: number;
  peakHour: number | null;
  peakHourCount: number;
  years: number;
  hourNeighborhoodFelonies: number;
  neighborhoodByHour: HourBucket[];
  topOffenses: OffenseCount[];
  precincts: Array<{ precinct: number | null; borough: string | null; n: number }>;
  placeLabel?: string;
  shootings: LayerCounts;
  collisions: LayerCounts & { pedCycHurt: number };
  lights: LayerCounts & { openNeighborhood: number };
  baselines: SafetyBaselines;
  /** Complaints citywide at this hour, same window (for the city baseline). */
  cityHourComplaints?: number;
  /** The date range the complaint data actually covers inside the query window. */
  observation?: { start: string | null; end: string | null; days: number };
}

/** Complaint density here vs NYC / this borough / this area's typical hour (1 = even). */
export interface SafetyBaselines {
  borough: string | null;
  areaVsNyc: number | null;
  hourVsNyc: number | null;
  hourVsArea: number | null;
  areaVsBorough: number | null;
  hourVsBorough: number | null;
}

export const NYC_LAND_KM2 = 778.2;
export const BOROUGH_LAND_KM2: Record<string, number> = {
  MANHATTAN: 59.13,
  BROOKLYN: 179.7,
  QUEENS: 281.5,
  BRONX: 109.04,
  "STATEN ISLAND": 151.47,
};

export function circleKm2(meters: number): number {
  const km = meters / 1000;
  return Math.PI * km * km;
}

function densityRatio(local: number, localKm2: number, ref: number, refKm2: number): number | null {
  if (!(localKm2 > 0) || !(refKm2 > 0) || ref <= 0) return null;
  return local / localKm2 / (ref / refKm2);
}

export function computeBaselines(input: {
  neighborhoodMeters: number;
  neighborhoodCount: number;
  hourNeighborhoodCount: number;
  cityComplaints: number;
  cityHourComplaints: number;
  borough: string | null;
  boroughComplaints: number;
  boroughHourComplaints: number;
}): SafetyBaselines {
  const localKm2 = circleKm2(input.neighborhoodMeters);
  const boroughKey = (input.borough ?? "").toUpperCase().replace(/_/g, " ");
  const boroughKm2 = BOROUGH_LAND_KM2[boroughKey];
  const typicalHourHere = input.neighborhoodCount / 24;
  return {
    borough: input.borough,
    areaVsNyc: densityRatio(input.neighborhoodCount, localKm2, input.cityComplaints, NYC_LAND_KM2),
    hourVsNyc: densityRatio(input.hourNeighborhoodCount, localKm2, input.cityHourComplaints, NYC_LAND_KM2),
    hourVsArea: typicalHourHere > 0 ? input.hourNeighborhoodCount / typicalHourHere : null,
    areaVsBorough: boroughKm2
      ? densityRatio(input.neighborhoodCount, localKm2, input.boroughComplaints, boroughKm2)
      : null,
    hourVsBorough: boroughKm2
      ? densityRatio(input.hourNeighborhoodCount, localKm2, input.boroughHourComplaints, boroughKm2)
      : null,
  };
}

const BLOCK_METERS = 250;
const NEIGHBORHOOD_METERS = 800;
const SAMPLE_YEARS = 2;

const REPORT_SQL = `
WITH pt AS (
  SELECT $1::float8 AS lat, $2::float8 AS lon, $3::int AS hour_et
), nearby AS (
  SELECT
    c.offense,
    c.law_category,
    c.precinct,
    c.borough,
    extract(hour from c.occurred_at AT TIME ZONE 'America/New_York')::int AS hour_et,
    nyc_meters(pt.lat, pt.lon, c.latitude, c.longitude) AS meters
  FROM nypd_complaints c
  CROSS JOIN pt
  WHERE c.occurred_at >= now() - interval '2 years'
    AND c.latitude BETWEEN pt.lat - 0.012 AND pt.lat + 0.012
    AND c.longitude BETWEEN pt.lon - 0.012 AND pt.lon + 0.012
), shoot AS (
  SELECT
    extract(hour from s.occurred_at AT TIME ZONE 'America/New_York')::int AS hour_et,
    nyc_meters(pt.lat, pt.lon, s.latitude, s.longitude) AS meters
  FROM nypd_shootings s CROSS JOIN pt
  WHERE s.occurred_at >= now() - interval '2 years'
    AND s.latitude BETWEEN pt.lat - 0.012 AND pt.lat + 0.012
    AND s.longitude BETWEEN pt.lon - 0.012 AND pt.lon + 0.012
), crash AS (
  SELECT
    extract(hour from x.occurred_at AT TIME ZONE 'America/New_York')::int AS hour_et,
    nyc_meters(pt.lat, pt.lon, x.latitude, x.longitude) AS meters,
    x.ped_injured, x.cyc_injured
  FROM nyc_collisions x CROSS JOIN pt
  WHERE x.occurred_at >= now() - interval '2 years'
    AND x.latitude BETWEEN pt.lat - 0.012 AND pt.lat + 0.012
    AND x.longitude BETWEEN pt.lon - 0.012 AND pt.lon + 0.012
), lamp AS (
  SELECT
    extract(hour from L.occurred_at AT TIME ZONE 'America/New_York')::int AS hour_et,
    nyc_meters(pt.lat, pt.lon, L.latitude, L.longitude) AS meters,
    L.status
  FROM nyc_311_lights L CROSS JOIN pt
  WHERE L.occurred_at >= now() - interval '2 years'
    AND L.latitude BETWEEN pt.lat - 0.012 AND pt.lat + 0.012
    AND L.longitude BETWEEN pt.lon - 0.012 AND pt.lon + 0.012
), area_borough AS (
  SELECT borough
  FROM nearby
  WHERE meters < $5 AND borough IS NOT NULL
  GROUP BY borough
  ORDER BY count(*) DESC
  LIMIT 1
), citywide AS (
  SELECT
    count(*)::int AS complaints,
    count(*) FILTER (
      WHERE extract(hour from occurred_at AT TIME ZONE 'America/New_York')::int = (SELECT hour_et FROM pt)
    )::int AS hour_complaints,
    count(*) FILTER (
      WHERE (SELECT borough FROM area_borough) IS NOT NULL
        AND borough = (SELECT borough FROM area_borough)
    )::int AS borough_complaints,
    count(*) FILTER (
      WHERE (SELECT borough FROM area_borough) IS NOT NULL
        AND borough = (SELECT borough FROM area_borough)
        AND extract(hour from occurred_at AT TIME ZONE 'America/New_York')::int = (SELECT hour_et FROM pt)
    )::int AS borough_hour_complaints,
    min(occurred_at) AS window_start,
    max(occurred_at) AS window_end
  FROM nypd_complaints
  WHERE occurred_at >= now() - interval '2 years'
)
SELECT jsonb_build_object(
  'blockCount', (SELECT count(*) FROM nearby WHERE meters < $4),
  'neighborhoodCount', (SELECT count(*) FROM nearby WHERE meters < $5),
  'hourBlockCount', (SELECT count(*) FROM nearby, pt WHERE meters < $4 AND nearby.hour_et = pt.hour_et),
  'hourNeighborhoodCount', (SELECT count(*) FROM nearby, pt WHERE meters < $5 AND nearby.hour_et = pt.hour_et),
  'hourNeighborhoodFelonies', (SELECT count(*) FROM nearby, pt WHERE meters < $5 AND nearby.hour_et = pt.hour_et AND law_category = 'FELONY'),
  'byHour', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('hourEt', hour_et, 'complaints', n, 'felonies', felonies) ORDER BY hour_et)
    FROM (
      SELECT hour_et, count(*)::int AS n,
             count(*) FILTER (WHERE law_category = 'FELONY')::int AS felonies
      FROM nearby WHERE meters < $5 GROUP BY hour_et
    ) h
  ), '[]'::jsonb),
  'topOffenses', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('offense', offense, 'lawCategory', law_category, 'n', n) ORDER BY n DESC)
    FROM (
      SELECT COALESCE(offense, '(unspecified)') AS offense,
             COALESCE(law_category, '(none)') AS law_category,
             count(*)::int AS n
      FROM nearby WHERE meters < $5 GROUP BY 1, 2 ORDER BY n DESC LIMIT 8
    ) o
  ), '[]'::jsonb),
  'precincts', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('precinct', precinct, 'borough', borough, 'n', n) ORDER BY n DESC)
    FROM (
      SELECT precinct, borough, count(*)::int AS n
      FROM nearby WHERE meters < $5 GROUP BY 1, 2 ORDER BY n DESC LIMIT 4
    ) p
  ), '[]'::jsonb),
  'shootings', jsonb_build_object(
    'neighborhoodCount', (SELECT count(*) FROM shoot WHERE meters < $5),
    'hourNeighborhoodCount', (SELECT count(*) FROM shoot, pt WHERE meters < $5 AND shoot.hour_et = pt.hour_et)
  ),
  'collisions', jsonb_build_object(
    'neighborhoodCount', (SELECT count(*) FROM crash WHERE meters < $5),
    'hourNeighborhoodCount', (SELECT count(*) FROM crash, pt WHERE meters < $5 AND crash.hour_et = pt.hour_et),
    'pedCycHurt', (SELECT coalesce(sum(ped_injured + cyc_injured), 0) FROM crash WHERE meters < $5)
  ),
  'lights', jsonb_build_object(
    'neighborhoodCount', (SELECT count(*) FROM lamp WHERE meters < $5),
    'hourNeighborhoodCount', (SELECT count(*) FROM lamp, pt WHERE meters < $5 AND lamp.hour_et = pt.hour_et),
    'openNeighborhood', (SELECT count(*) FROM lamp WHERE meters < $5 AND status ILIKE 'open%')
  ),
  'areaBorough', (SELECT borough FROM area_borough),
  'cityComplaints', (SELECT complaints FROM citywide),
  'cityHourComplaints', (SELECT hour_complaints FROM citywide),
  'boroughComplaints', (SELECT borough_complaints FROM citywide),
  'boroughHourComplaints', (SELECT borough_hour_complaints FROM citywide),
  'windowStart', (SELECT window_start FROM citywide),
  'windowEnd', (SELECT window_end FROM citywide)
) AS report
`;

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    const connectionString = databaseUrl.replace(/[?&]sslmode=[^&]*/g, "");
    pool = new pg.Pool({
      connectionString,
      max: 4,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export function currentHourEt(now = new Date()): { hourEt: number; asOfEt: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const hour12 = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value ?? "AM";
  let hourEt = hour12 % 12;
  if (/pm/i.test(dayPeriod)) hourEt += 12;
  if (/am/i.test(dayPeriod) && hour12 === 12) hourEt = 0;
  const asOfEt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(now);
  return { hourEt, asOfEt };
}

export function parseRequestedHour(text: string, fallbackHour: number): number {
  const match = text.match(/\b(?:at|around)?\s*(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i);
  const rawHour = match?.[1];
  const period = match?.[2];
  if (rawHour == null || period == null) return fallbackHour;
  let hour = Number(rawHour) % 12;
  if (/pm/i.test(period)) hour += 12;
  return hour;
}

export async function lookupBlockSafety(
  databaseUrl: string,
  latitude: number,
  longitude: number,
  hourEt: number,
  asOfEt: string,
): Promise<BlockSafetyReport> {
  const client = getPool(databaseUrl);
  const result = await client.query(REPORT_SQL, [
    latitude,
    longitude,
    hourEt,
    BLOCK_METERS,
    NEIGHBORHOOD_METERS,
  ]);
  const payload = result.rows[0]?.report ?? {};
  const byHour = (payload.byHour ?? []) as HourBucket[];
  let peakHour: number | null = null;
  let peakHourCount = 0;
  for (const bucket of byHour) {
    if (bucket.complaints > peakHourCount) {
      peakHourCount = bucket.complaints;
      peakHour = bucket.hourEt;
    }
  }
  const emptyLayer = (): LayerCounts => ({
    blockCount: 0,
    neighborhoodCount: 0,
    hourBlockCount: 0,
    hourNeighborhoodCount: 0,
  });
  const shoot = payload.shootings ?? {};
  const crash = payload.collisions ?? {};
  const lamp = payload.lights ?? {};
  const neighborhoodCount = Number(payload.neighborhoodCount ?? 0);
  const hourNeighborhoodCount = Number(payload.hourNeighborhoodCount ?? 0);
  const baselines = computeBaselines({
    neighborhoodMeters: NEIGHBORHOOD_METERS,
    neighborhoodCount,
    hourNeighborhoodCount,
    cityComplaints: Number(payload.cityComplaints ?? 0),
    cityHourComplaints: Number(payload.cityHourComplaints ?? 0),
    borough: payload.areaBorough ?? payload.precincts?.[0]?.borough ?? null,
    boroughComplaints: Number(payload.boroughComplaints ?? 0),
    boroughHourComplaints: Number(payload.boroughHourComplaints ?? 0),
  });

  return {
    latitude,
    longitude,
    hourEt,
    asOfEt,
    years: SAMPLE_YEARS,
    hourNeighborhoodFelonies: Number(payload.hourNeighborhoodFelonies ?? 0),
    blockMeters: BLOCK_METERS,
    neighborhoodMeters: NEIGHBORHOOD_METERS,
    blockCount: Number(payload.blockCount ?? 0),
    neighborhoodCount,
    hourBlockCount: Number(payload.hourBlockCount ?? 0),
    hourNeighborhoodCount,
    peakHour,
    peakHourCount,
    neighborhoodByHour: byHour,
    topOffenses: (payload.topOffenses ?? []) as OffenseCount[],
    precincts: payload.precincts ?? [],
    shootings: {
      ...emptyLayer(),
      neighborhoodCount: Number(shoot.neighborhoodCount ?? 0),
      hourNeighborhoodCount: Number(shoot.hourNeighborhoodCount ?? 0),
    },
    collisions: {
      ...emptyLayer(),
      neighborhoodCount: Number(crash.neighborhoodCount ?? 0),
      hourNeighborhoodCount: Number(crash.hourNeighborhoodCount ?? 0),
      pedCycHurt: Number(crash.pedCycHurt ?? 0),
    },
    lights: {
      ...emptyLayer(),
      neighborhoodCount: Number(lamp.neighborhoodCount ?? 0),
      hourNeighborhoodCount: Number(lamp.hourNeighborhoodCount ?? 0),
      openNeighborhood: Number(lamp.openNeighborhood ?? 0),
    },
    baselines,
    cityHourComplaints: Number(payload.cityHourComplaints ?? 0),
    observation: observationWindow(payload.windowStart, payload.windowEnd),
  };
}

/** Days actually covered by the data (at least 1 when there is any data). */
export function observationWindow(start: unknown, end: unknown): { start: string | null; end: string | null; days: number } {
  const from = typeof start === "string" ? start : null;
  const to = typeof end === "string" ? end : null;
  if (!from || !to) return { start: from, end: to, days: 0 };
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
  return { start: from, end: to, days };
}
