import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupGazetteer } from "../../src/transport/locations.js";
import { createGoogleRoutesProvider, createPlacesResolver } from "../../src/transport/routing.js";
import { coordinateIssues, durationIssues } from "./support.js";

const columbia = lookupGazetteer("Columbia University").places[0]!;
const timesSquare = lookupGazetteer("Times Square").places[0]!;

describe("maps provider contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends origin, destination, and mode to computeRoutes", async () => {
    let body: Record<string, unknown> | undefined;
    let apiKey: string | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      apiKey = new Headers(init?.headers).get("X-Goog-Api-Key") ?? undefined;
      return new Response(
        JSON.stringify({
          routes: [{ duration: "1200s", distanceMeters: 5000, description: "via Broadway", legs: [] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const route = await createGoogleRoutesProvider("maps-test-SENTINEL-key").getRoute(columbia, timesSquare, "TRANSIT");
    const origin = body?.origin as { location?: { latLng?: { latitude?: number; longitude?: number } } };
    const destination = body?.destination as { location?: { latLng?: { latitude?: number; longitude?: number } } };

    expect(apiKey).toBe("maps-test-SENTINEL-key");
    expect(body?.travelMode).toBe("TRANSIT");
    expect(origin?.location?.latLng?.latitude).toBeCloseTo(columbia.latitude!);
    expect(destination?.location?.latLng?.latitude).toBeCloseTo(timesSquare.latitude!);
    expect(route?.durationSeconds).toBe(1200);
    expect(route?.summary).toBe("via Broadway");
    expect(JSON.stringify(route)).not.toContain("maps-test-SENTINEL-key");
    expect(durationIssues(route?.durationSeconds)).toEqual([]);
  });

  it("marks two close Joe's Pizza results ambiguous", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          places: [
            {
              displayName: { text: "Joe's Pizza" },
              formattedAddress: "7 Carmine St, New York, NY",
              location: { latitude: 40.7303, longitude: -74.003 },
            },
            {
              displayName: { text: "Joe's Pizza" },
              formattedAddress: "1435 Broadway, New York, NY",
              location: { latitude: 40.7547, longitude: -73.987 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await createPlacesResolver("maps-test-SENTINEL-key").resolve("Joe's Pizza");
    expect(result.status).toBe("ambiguous");
    expect(result.places).toHaveLength(2);
    expect(result.places.map((place) => place.address)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Carmine/), expect.stringMatching(/Broadway/)]),
    );
  });

  it("flags impossible coordinates and durations, and accepts gazetteer NYC places", () => {
    expect(coordinateIssues(0, 0)).toContain("zero coordinate");
    expect(coordinateIssues(Number.NaN, -73.9).some((issue) => issue.includes("non-finite"))).toBe(true);
    expect(coordinateIssues(undefined, -73.9)).toContain("missing coordinates");
    expect(coordinateIssues(51.5, -0.12).some((issue) => issue.includes("outside NYC"))).toBe(true);
    expect(durationIssues(0)).toContain("non-positive duration");
    expect(durationIssues(Number.NaN)).toContain("non-finite duration");
    expect(durationIssues(7 * 60 * 60)).toContain("duration over 6 hours");
    expect(durationIssues(20 * 60)).toEqual([]);

    for (const query of ["Columbia University", "Times Square", "Washington Square Park", "Grand Central", "Katz's"]) {
      const place = lookupGazetteer(query).places[0];
      expect(coordinateIssues(place?.latitude, place?.longitude), query).toEqual([]);
    }
  });
});
