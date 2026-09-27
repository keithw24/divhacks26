import type {
  Budget,
  EventRecommendation,
  Location,
  SkillResult,
  Source,
} from "../domain/contracts.js";
import { getPool } from "../safety.js";
import { createGeminiMapsClient } from "../transport/gemini.js";

export interface EventsInput {
  origin: Location;
  from: string;
  to: string;
  radiusMeters: number;
  categories: string[];
  budget?: Budget;
  databaseUrl?: string;
  tavilyApiKey?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  fetcher?: typeof fetch;
  query?: (sql: string, values: unknown[]) => Promise<{ rows: EventRow[] }>;
  /** Injected Gemini nearby lookup so tests do not hit the network. */
  geminiNearby?: (origin: Location, query: string) => Promise<{ text: string; sources?: Source[] }>;
}

export interface EventsResult extends SkillResult<EventRecommendation[]> {
  /** Ungraphable Gemini / Maps nearby answer. Official Tiger rows stay in `data`. */
  geminiReply?: string;
}

interface EventRow {
  source: string;
  source_id: string;
  title: string;
  description: string | null;
  category: string | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  venue: string | null;
  latitude: number;
  longitude: number;
  source_url: string | null;
  registration_url?: string | null;
  updated_at: Date | string;
  distance_meters: number;
}

const EVENTS_SQL = `
WITH origin AS (
  SELECT $1::float8 AS lat, $2::float8 AS lon
), nearby AS (
  SELECT e.*,
    6371000 * 2 * asin(sqrt(
      power(sin(radians(e.latitude - o.lat) / 2), 2)
      + cos(radians(o.lat)) * cos(radians(e.latitude))
        * power(sin(radians(e.longitude - o.lon) / 2), 2)
    )) AS distance_meters
  FROM city_events e CROSS JOIN origin o
  WHERE e.latitude IS NOT NULL AND e.longitude IS NOT NULL
    AND e.starts_at >= $3::timestamptz AND e.starts_at <= $4::timestamptz
    AND e.latitude BETWEEN o.lat - ($5::float8 / 111000.0) AND o.lat + ($5::float8 / 111000.0)
    AND e.longitude BETWEEN o.lon - ($5::float8 / 85000.0) AND o.lon + ($5::float8 / 85000.0)
    AND (
      cardinality($6::text[]) = 0
      OR EXISTS (
        SELECT 1 FROM unnest($6::text[]) requested
        WHERE lower(COALESCE(e.category, '')) LIKE '%' || requested || '%'
      )
    )
)
SELECT * FROM nearby
WHERE distance_meters <= $5
ORDER BY starts_at ASC, distance_meters ASC, updated_at DESC
LIMIT 20
`;

export function normalizeEvent(row: EventRow): EventRecommendation {
  const location: Location = {
    label: row.venue || row.title,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  };
  return {
    id: `event:${row.source}:${row.source_id}`,
    kind: "event",
    name: row.title,
    location,
    distanceMeters: Math.round(Number(row.distance_meters)),
    description: row.description ?? undefined,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : undefined,
    categories: row.category ? [row.category] : [],
    url: row.registration_url || row.source_url || undefined,
    source: {
      name: row.source,
      url: row.source_url || undefined,
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedAtKind: "ingested",
    },
  };
}

async function tavilySources(input: EventsInput, events: EventRecommendation[]): Promise<Source[]> {
  if (!input.tavilyApiKey || !events.length) return [];
  const fetcher = input.fetcher ?? fetch;
  try {
    const titles = events.slice(0, 3).map((event) => `"${event.name}"`).join(" OR ");
    const response = await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.tavilyApiKey}`,
      },
      body: JSON.stringify({
        query: `New York City event ${titles}`,
        search_depth: "basic",
        max_results: 3,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Tavily returned ${response.status}`);
    const payload = (await response.json()) as { results?: Array<{ title?: string; url?: string }> };
    return (payload.results ?? []).flatMap((result): Source[] =>
      result.url ? [{ name: result.title ? `Tavily: ${result.title}` : "Tavily", url: result.url }] : [],
    );
  } catch (error) {
    console.error("Tavily enrichment failed:", error);
    return [];
  }
}

async function loadOfficialEvents(input: EventsInput): Promise<{
  events: EventRecommendation[];
  sources: Source[];
  warnings: string[];
  status: SkillResult<EventRecommendation[]>["status"];
}> {
  if (!input.databaseUrl && !input.query) {
    return {
      events: [],
      sources: [],
      warnings: ["Tiger Data is not configured."],
      status: "unavailable",
    };
  }
  try {
    const values = [
      input.origin.latitude,
      input.origin.longitude,
      input.from,
      input.to,
      Math.min(Math.max(input.radiusMeters, 250), 20_000),
      input.categories,
    ];
    const result = input.query
      ? await input.query(EVENTS_SQL, values)
      : await getPool(input.databaseUrl!).query<EventRow>(EVENTS_SQL, values);
    const seen = new Set<string>();
    const events = result.rows
      .map(normalizeEvent)
      .filter((event) => {
        const key = `${event.name.toLowerCase()}|${event.startsAt}|${event.location.latitude.toFixed(4)}|${event.location.longitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
    const enrichment = await tavilySources(input, events);
    const officialSources: Source[] = [
      { name: "NYC Parks Upcoming Events", url: "https://data.cityofnewyork.us/d/w3wp-dpdi" },
      { name: "NYC Permitted Event Information", url: "https://data.cityofnewyork.us/d/tvpp-9vvx" },
    ];
    return {
      events,
      sources: [...officialSources, ...enrichment],
      warnings: events.length ? [] : ["No official NYC Parks or permitted events matched this time window."],
      status: events.length ? "ok" : "partial",
    };
  } catch (error) {
    console.error("events skill failed:", error);
    return {
      events: [],
      sources: [],
      warnings: ["Event search is temporarily unavailable."],
      status: "unavailable",
    };
  }
}

function eventsGeminiQuery(input: EventsInput): string {
  const categories = input.categories.length ? input.categories.join(", ") : "any";
  return [
    "What public events and activities are happening near this NYC location in the requested window?",
    `Window: ${input.from} to ${input.to}.`,
    `Categories: ${categories}.`,
    "Answer in a few short iMessage lines. Name venues and times only when Maps grounding supports them.",
  ].join(" ");
}

async function loadGeminiEvents(input: EventsInput): Promise<{ text?: string; sources: Source[] }> {
  try {
    if (input.geminiNearby) {
      const result = await input.geminiNearby(input.origin, eventsGeminiQuery(input));
      const text = result.text.trim();
      return { ...(text && { text }), sources: result.sources ?? [] };
    }
    const key = input.geminiApiKey?.trim();
    if (!key) return { sources: [] };
    const client = createGeminiMapsClient({ apiKey: key, model: input.geminiModel });
    const grounded = await client.nearby(
      {
        name: input.origin.label,
        latitude: input.origin.latitude,
        longitude: input.origin.longitude,
        source: "user",
        confidence: 1,
      },
      eventsGeminiQuery(input),
    );
    const text = grounded.text.trim();
    return {
      ...(text && { text }),
      sources: grounded.sources.flatMap((source) =>
        source.uri || source.title ? [{ name: source.title || "Google Maps", url: source.uri }] : [],
      ),
    };
  } catch (error) {
    console.error("events Gemini nearby failed:", error);
    return { sources: [] };
  }
}

export function mergeOfficialAndGeminiReply(
  official: string,
  geminiReply?: string,
  hasOfficialEvent = false,
): string {
  const extra = geminiReply?.trim();
  if (!extra) return official;
  if (!hasOfficialEvent && /couldn't find a verified match/i.test(official)) return extra;
  return `${official}\n\n${extra}`;
}

export async function findEvents(input: EventsInput): Promise<EventsResult> {
  const [official, gemini] = await Promise.all([loadOfficialEvents(input), loadGeminiEvents(input)]);
  const status = official.events.length
    ? "ok"
    : gemini.text
      ? official.status === "unavailable"
        ? "partial"
        : official.status
      : official.status;
  return {
    status,
    data: official.events,
    sources: [...official.sources, ...gemini.sources],
    warnings: official.warnings,
    ...(gemini.text && { geminiReply: gemini.text }),
  };
}
