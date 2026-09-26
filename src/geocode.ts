import { logIntegration } from "./integrations/log.js";

export interface GeocodedPlace {
  label: string;
  latitude: number;
  longitude: number;
  locality: string | null;
}

const PHOTON_URL = "https://photon.komoot.io/api";
const NYC_BIAS = { lat: 40.758, lon: -73.985 };

const COORD_RE = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

export function parseCoordinates(text: string): { latitude: number; longitude: number } | null {
  const match = text.match(COORD_RE);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < 40.4 || latitude > 41.0 || longitude < -74.4 || longitude > -73.6) {
    return null;
  }
  return { latitude, longitude };
}

const TIME_RE =
  /\b(?:at|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\btonight\b|\btoday\b|\bthis (?:morning|afternoon|evening|weekend)\b/gi;

/**
 * Pull a geocodable place out of chat. Ignores clock phrases so
 * "is Columbia safe at 11pm" does not geocode as "11pm".
 */
export function locationQueryFromMessage(text: string): string {
  let q = text.replace(TIME_RE, " ");
  const named = q.match(/\b(?:near|around|in)\s+(.+)/i);
  const rest = named?.[1]?.trim() ?? "";
  if (rest && !/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(rest)) {
    q = rest;
  }
  q = q.replace(/\b(?:is|how's|how is|how|what's|what is)\b/gi, " ");
  q = q.replace(
    /\b(?:un)?safe(?:ty|r|st)?\b|\bsketchy\b|\bdangerous\b|\bcrime\b|\bthis\b|\barea\b|\bblock\b|\bneighborhood\b|\bwalk(?:ing)?(?:\s+home|\s+alone)?\b/gi,
    " ",
  );
  q = q.replace(/[?!.]/g, " ");
  const cleaned = q.replace(/\s+/g, " ").trim();
  if (/^columbia$/i.test(cleaned)) return "Columbia University";
  return cleaned;
}

export async function geocodeNyc(query: string): Promise<GeocodedPlace | null> {
  const coords = parseCoordinates(query);
  if (coords) {
    return {
      label: `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`,
      latitude: coords.latitude,
      longitude: coords.longitude,
      locality: null,
    };
  }

  const q = locationQueryFromMessage(query);
  if (q.length < 3) return null;
  const geocodeQ = /new york|nyc|manhattan|brooklyn|bronx|queens|staten/i.test(q)
    ? q
    : `${q}, New York`;

  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", geocodeQ);
  url.searchParams.set("limit", "5");
  url.searchParams.set("lat", String(NYC_BIAS.lat));
  url.searchParams.set("lon", String(NYC_BIAS.lon));

  const started = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": "BoroughOS-DivHacks26/0.1 (hackathon; nyc safety lookup)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as {
    features?: Array<{
      geometry?: { coordinates?: number[] };
      properties?: Record<string, string | number | undefined>;
    }>;
  };

  for (const feature of body.features ?? []) {
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    const props = feature.properties ?? {};
    const city = String(props.city ?? props.state ?? "");
    const country = String(props.countrycode ?? props.country ?? "");
    const inNyc =
      /new york/i.test(city) ||
      props.state === "New York" ||
      country === "US";
    if (!inNyc || lat == null || lon == null) continue;
    if (lat < 40.4 || lat > 41.0 || lon < -74.4 || lon > -73.6) continue;

    logIntegration("GEOCODER", "LIVE", `place returned in ${Date.now() - started}ms`);
    const parts = [props.name, props.street, props.locality, props.district, props.city]
      .map((part) => (part == null ? "" : String(part)))
      .filter(Boolean);
    return {
      label: [...new Set(parts)].slice(0, 4).join(", ") || q,
      latitude: lat,
      longitude: lon,
      locality: props.locality ? String(props.locality) : null,
    };
  }
  return null;
}
