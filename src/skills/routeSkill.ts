import type { Location, RouteResult, SkillResult, TravelMode } from "../domain/contracts.js";
import { mapsDirectionsUrl } from "./geo.js";

export interface RouteInput {
  origin: Location;
  destination: Location;
  travelMode: TravelMode;
  departureTime?: string;
  apiKey?: string;
  fetcher?: typeof fetch;
}

interface RoutesResponse {
  routes?: Array<{
    duration?: string;
    distanceMeters?: number;
    description?: string;
    polyline?: { encodedPolyline?: string };
  }>;
}

const durationMinutes = (duration?: string) => {
  const seconds = Number(duration?.replace(/s$/, ""));
  return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : undefined;
};

export async function getRoute(input: RouteInput): Promise<SkillResult<RouteResult>> {
  const directionsUrl = mapsDirectionsUrl(input.origin, input.destination, input.travelMode);
  const fallback: RouteResult = {
    mode: input.travelMode,
    summary: `Open directions to ${input.destination.label}`,
    directionsUrl,
  };

  if (!input.apiKey) {
    console.info("duration_source=none");
    console.error("[route] GOOGLE_MAPS_API_KEY is not set");
    return {
      status: "partial",
      data: fallback,
      sources: [{ name: "Google Maps", url: directionsUrl }],
      warnings: [],
    };
  }

  const fetcher = input.fetcher ?? fetch;
  try {
    const body: Record<string, unknown> = {
      origin: { location: { latLng: { latitude: input.origin.latitude, longitude: input.origin.longitude } } },
      destination: {
        location: { latLng: { latitude: input.destination.latitude, longitude: input.destination.longitude } },
      },
      travelMode: input.travelMode,
      languageCode: "en-US",
      units: "IMPERIAL",
    };
    if (input.departureTime) body.departureTime = input.departureTime;
    if (input.travelMode === "DRIVE") body.routingPreference = "TRAFFIC_AWARE";

    const response = await fetcher("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": input.apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.description,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Routes API returned ${response.status}`);
    const payload = (await response.json()) as RoutesResponse;
    const route = payload.routes?.[0];
    if (!route) throw new Error("Routes API returned no route");
    const minutes = durationMinutes(route.duration);
    const data: RouteResult = {
      mode: input.travelMode,
      durationMinutes: minutes,
      distanceMeters: route.distanceMeters,
      summary: minutes
        ? `${minutes} min ${input.travelMode.toLowerCase()} to ${input.destination.label}`
        : `Route to ${input.destination.label}`,
      directionsUrl,
      ...(route.polyline?.encodedPolyline && { encodedPolyline: route.polyline.encodedPolyline }),
    };
    return {
      status: "ok",
      data,
      sources: [{ name: "Google Routes", url: directionsUrl }],
      warnings: [],
    };
  } catch (error) {
    console.info("duration_source=none");
    console.error("route skill failed:", error);
    return {
      status: "partial",
      data: fallback,
      sources: [{ name: "Google Maps", url: directionsUrl }],
      warnings: [],
    };
  }
}
