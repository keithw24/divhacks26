import { describe, expect, it, vi } from "vitest";
import { renderResponse } from "../src/agent/compose.js";
import { findEvents } from "../src/skills/eventsSkill.js";
import { findFood } from "../src/skills/foodSkill.js";
import { getRoute } from "../src/skills/routeSkill.js";

const origin = { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 };

describe("events skill", () => {
  it("deduplicates normalized Tiger results", async () => {
    const row = {
      source: "NYC Parks",
      source_id: "42",
      title: "Outdoor Movie",
      description: "A free movie",
      category: "Movies",
      starts_at: "2026-09-26T23:00:00Z",
      ends_at: "2026-09-27T01:00:00Z",
      venue: "Riverside Park",
      latitude: 40.805,
      longitude: -73.97,
      source_url: "https://example.test/event",
      updated_at: "2026-09-26T12:00:00Z",
      distance_meters: 700,
    };
    const result = await findEvents({
      origin,
      from: "2026-09-26T12:00:00Z",
      to: "2026-09-27T12:00:00Z",
      radiusMeters: 3000,
      categories: [],
      databaseUrl: "postgres://test",
      query: async () => ({ rows: [row, row] }),
    });
    expect(result.status).toBe("ok");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.name).toBe("Outdoor Movie");
  });

  it("returns Tiger rows and a Gemini nearby reply together", async () => {
    const row = {
      source: "NYC Parks",
      source_id: "42",
      title: "Outdoor Movie",
      description: "A free movie",
      category: "Movies",
      starts_at: "2026-09-26T23:00:00Z",
      ends_at: "2026-09-27T01:00:00Z",
      venue: "Riverside Park",
      latitude: 40.805,
      longitude: -73.97,
      source_url: "https://example.test/event",
      updated_at: "2026-09-26T12:00:00Z",
      distance_meters: 700,
    };
    const geminiNearby = vi.fn(async () => ({ text: "Jazz at Lincoln Center at 8pm." }));
    const result = await findEvents({
      origin,
      from: "2026-09-26T12:00:00Z",
      to: "2026-09-27T12:00:00Z",
      radiusMeters: 3000,
      categories: [],
      databaseUrl: "postgres://test",
      query: async () => ({ rows: [row] }),
      geminiNearby,
    });
    expect(result.data).toHaveLength(1);
    expect(result.geminiReply).toBe("Jazz at Lincoln Center at 8pm.");
    expect(geminiNearby).toHaveBeenCalledOnce();
  });

  it("still returns Gemini when Tiger has no matching events", async () => {
    const result = await findEvents({
      origin,
      from: "2026-09-26T12:00:00Z",
      to: "2026-09-27T12:00:00Z",
      radiusMeters: 3000,
      categories: [],
      databaseUrl: "postgres://test",
      query: async () => ({ rows: [] }),
      geminiNearby: async () => ({ text: "A comedy show in the Village tonight." }),
    });
    expect(result.data).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.geminiReply).toBe("A comedy show in the Village tonight.");
  });

  it("authenticates Tavily enrichment with a bearer token", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tvly-test");
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("api_key");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;

    await findEvents({
      origin,
      from: "2026-09-26T12:00:00Z",
      to: "2026-09-27T12:00:00Z",
      radiusMeters: 3000,
      categories: [],
      databaseUrl: "postgres://test",
      tavilyApiKey: "tvly-test",
      query: async () => ({ rows: [{
        source: "NYC Parks",
        source_id: "42",
        title: "Outdoor Movie",
        description: "A free movie",
        category: "Movies",
        starts_at: "2026-09-26T23:00:00Z",
        ends_at: "2026-09-27T01:00:00Z",
        venue: "Riverside Park",
        latitude: 40.805,
        longitude: -73.97,
        source_url: "https://example.test/event",
        updated_at: "2026-09-26T12:00:00Z",
        distance_meters: 700,
      }] }),
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("food skill", () => {
  it("returns routable places with a place id and coordinates", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      places: [{
        id: "place-1",
        displayName: { text: "Jin Ramen" },
        formattedAddress: "Broadway, New York",
        location: { latitude: 40.81, longitude: -73.96 },
        rating: 4.5,
        currentOpeningHours: { openNow: true },
        googleMapsUri: "https://maps.google.com/?cid=1",
        websiteUri: "https://jinramen.example",
      }],
    }), { status: 200 })) as typeof fetch;
    const result = await findFood({ origin, apiKey: "test", fetcher });
    expect(result.data[0]?.placeId).toBe("place-1");
    expect(result.data[0]?.location.latitude).toBe(40.81);
    expect(result.data[0]?.url).toBe("https://jinramen.example");
    expect(result.data[0]?.openNow).toBe(true);
  });

  it("uses Maps grounding when Places is not configured", async () => {
    const mapsSearch = vi.fn(async () => [{
      name: "Jin Ramen",
      placeId: "place-maps",
      latitude: 40.81,
      longitude: -73.96,
      address: "Broadway, New York",
    }]);
    const result = await findFood({ origin, mapsSearch });
    expect(result.status).toBe("ok");
    expect(result.data[0]?.placeId).toBe("place-maps");
    expect(result.data[0]?.source.name).toBe("Google Maps");
    expect(mapsSearch).toHaveBeenCalledOnce();
  });
});

describe("route skill", () => {
  it("uses Routes duration and always returns a Maps link", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      routes: [{ duration: "1080s", distanceMeters: 2100 }],
    }), { status: 200 })) as typeof fetch;
    const result = await getRoute({
      origin,
      destination: { label: "Bryant Park", latitude: 40.7536, longitude: -73.9832 },
      travelMode: "TRANSIT",
      apiKey: "test",
      fetcher,
    });
    expect(result.data.durationMinutes).toBe(18);
    expect(result.data.directionsUrl).toContain("google.com/maps/dir");
  });

  it("degrades to a directions link when Routes is unavailable", async () => {
    const result = await getRoute({
      origin,
      destination: { label: "Bryant Park", latitude: 40.7536, longitude: -73.9832 },
      travelMode: "WALK",
    });
    expect(result.status).toBe("partial");
    expect(result.data.durationMinutes).toBeUndefined();
  });

  it("surfaces a missing Routes key instead of a stand-in when strict", async () => {
    const result = await getRoute({
      origin,
      destination: { label: "Bryant Park", latitude: 40.7536, longitude: -73.9832 },
      travelMode: "WALK",
      strict: true,
    });
    expect(result.status).toBe("unavailable");
    expect(result.warnings[0]).toContain("GOOGLE_MAPS_API_KEY");
    expect(result.data.durationMinutes).toBeUndefined();
  });

  it("displays Google's beta caveat for a walking route", () => {
    const text = renderResponse({
      picks: [],
      route: {
        status: "ok",
        data: {
          mode: "WALK",
          durationMinutes: 12,
          summary: "12 min walk to Riverside Park",
          directionsUrl: "https://google.com/maps/dir/test",
        },
        sources: [],
        warnings: [],
      },
      warnings: [],
    });
    expect(text).toContain("walking and cycling routes are beta");
  });
});

describe("response renderer", () => {
  it("renders only verified candidate facts", () => {
    const text = renderResponse({
      picks: [{
        item: {
          id: "event:parks:42",
          kind: "event",
          name: "Outdoor Movie",
          location: { label: "Riverside Park", latitude: 40.805, longitude: -73.97 },
          distanceMeters: 700,
          startsAt: "2026-09-26T23:00:00Z",
          categories: ["Movies"],
          url: "https://example.test/event",
          source: { name: "NYC Parks" },
        },
        reason: "free and nearby",
      }],
      warnings: [],
    });
    expect(text).toContain("Outdoor Movie");
    expect(text).toContain("https://example.test/event");
    expect(text).toContain("Riverside Park");
    expect(text).toMatch(/Sep 26/);
    expect(text).not.toContain("restaurant");
  });

  it("ignores unsupported free-form safety summaries", () => {
    const text = renderResponse({
      picks: [],
      safetyLine: "Looks safer than typical NYC — everyday awareness is enough.",
      warnings: [],
    });
    expect(text).not.toContain("everyday awareness");
    expect(text).not.toMatch(/reports at this hour/i);
  });

  it("does not invent listings when official events are empty", () => {
    const text = renderResponse({
      picks: [],
      warnings: ["No official NYC Parks or permitted events matched this time window."],
    });
    expect(text).toMatch(/couldn't find a verified match|No official NYC Parks/i);
    expect(text).not.toMatch(/resy|opentable/i);
  });
});
