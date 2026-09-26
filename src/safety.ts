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
  neighborhoodByHour: HourBucket[];
  topOffenses: OffenseCount[];
  precincts: Array<{ precinct: number | null; borough: string | null; n: number }>;
}

const BLOCK_METERS = 250;
const NEIGHBORHOOD_METERS = 800;

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
    6371000 * 2 * asin(sqrt(
      power(sin(radians(c.latitude - pt.lat) / 2), 2)
      + cos(radians(pt.lat)) * cos(radians(c.latitude))
        * power(sin(radians(c.longitude - pt.lon) / 2), 2)
    )) AS meters
  FROM nypd_complaints c
  CROSS JOIN pt
  WHERE c.latitude BETWEEN pt.lat - 0.012 AND pt.lat + 0.012
    AND c.longitude BETWEEN pt.lon - 0.012 AND pt.lon + 0.012
)
SELECT jsonb_build_object(
  'blockCount', (SELECT count(*) FROM nearby WHERE meters < $4),
  'neighborhoodCount', (SELECT count(*) FROM nearby WHERE meters < $5),
  'hourBlockCount', (
    SELECT count(*) FROM nearby, pt
    WHERE meters < $4 AND nearby.hour_et = pt.hour_et
  ),
  'hourNeighborhoodCount', (
    SELECT count(*) FROM nearby, pt
    WHERE meters < $5 AND nearby.hour_et = pt.hour_et
  ),
  'byHour', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'hourEt', hour_et,
      'complaints', n,
      'felonies', felonies
    ) ORDER BY hour_et)
    FROM (
      SELECT hour_et,
             count(*)::int AS n,
             count(*) FILTER (WHERE law_category = 'FELONY')::int AS felonies
      FROM nearby
      WHERE meters < $5
      GROUP BY hour_et
    ) h
  ), '[]'::jsonb),
  'topOffenses', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'offense', offense,
      'lawCategory', law_category,
      'n', n
    ) ORDER BY n DESC)
    FROM (
      SELECT COALESCE(offense, '(unspecified)') AS offense,
             COALESCE(law_category, '(none)') AS law_category,
             count(*)::int AS n
      FROM nearby
      WHERE meters < $5
      GROUP BY 1, 2
      ORDER BY n DESC
      LIMIT 8
    ) o
  ), '[]'::jsonb),
  'precincts', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'precinct', precinct,
      'borough', borough,
      'n', n
    ) ORDER BY n DESC)
    FROM (
      SELECT precinct, borough, count(*)::int AS n
      FROM nearby
      WHERE meters < $5
      GROUP BY 1, 2
      ORDER BY n DESC
      LIMIT 4
    ) p
  ), '[]'::jsonb)
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

  return {
    latitude,
    longitude,
    hourEt,
    asOfEt,
    blockMeters: BLOCK_METERS,
    neighborhoodMeters: NEIGHBORHOOD_METERS,
    blockCount: Number(payload.blockCount ?? 0),
    neighborhoodCount: Number(payload.neighborhoodCount ?? 0),
    hourBlockCount: Number(payload.hourBlockCount ?? 0),
    hourNeighborhoodCount: Number(payload.hourNeighborhoodCount ?? 0),
    peakHour,
    peakHourCount,
    neighborhoodByHour: byHour,
    topOffenses: (payload.topOffenses ?? []) as OffenseCount[],
    precincts: payload.precincts ?? [],
  };
}
