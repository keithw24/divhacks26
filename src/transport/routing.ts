import { logIntegration } from "../integrations/log.js";
import { hasCoordinates } from "./locations.js";
import { logTransportError } from "./log.js";
import type { PlaceLocation, RouteResult, RouteStep, RoutingProvider, TravelMode } from "./types.js";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ROUTES_TIMEOUT_MS = 10_000;

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.description",
  "routes.localizedValues",
  "routes.legs.duration",
  "routes.legs.distanceMeters",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.transitDetails",
].join(",");

interface ComputeRoutesResponse {
  routes?: Array<{
    duration?: string;
    distanceMeters?: number;
    description?: string;
    localizedValues?: { duration?: { text?: string }; distance?: { text?: string } };
    legs?: Array<{
      steps?: Array<{
        travelMode?: string;
        staticDuration?: string;
        navigationInstruction?: { instructions?: string };
        transitDetails?: {
          headsign?: string;
          stopCount?: number;
          stopDetails?: {
            departureStop?: { name?: string };
            arrivalStop?: { name?: string };
          };
          transitLine?: {
            name?: string;
            nameShort?: string;
            vehicle?: { name?: { text?: string }; type?: string };
          };
        };
      }>;
    }>;
  }>;
  error?: { message?: string; status?: string };
}

function parseDurationSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match?.[1]) return undefined;
  return Math.round(Number(match[1]));
}

function waypoint(place: PlaceLocation): Record<string, unknown> {
  if (hasCoordinates(place)) {
    return {
      location: {
        latLng: {
          latitude: place.latitude,
          longitude: place.longitude,
        },
      },
    };
  }
  return { address: place.address || `${place.name}, New York, NY` };
}

function stepsFromRoute(route: NonNullable<ComputeRoutesResponse["routes"]>[number]): RouteStep[] {
  const steps: RouteStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const transit = step.transitDetails;
      steps.push({
        mode: step.travelMode ?? "WALK",
        instruction: step.navigationInstruction?.instructions,
        lineName: transit?.transitLine?.name,
        lineShortName: transit?.transitLine?.nameShort,
        vehicleType: transit?.transitLine?.vehicle?.type ?? transit?.transitLine?.vehicle?.name?.text,
        departureStop: transit?.stopDetails?.departureStop?.name,
        arrivalStop: transit?.stopDetails?.arrivalStop?.name,
        headsign: transit?.headsign,
      });
    }
  }
  return steps;
}

export function createGoogleRoutesProvider(apiKey: string, options?: { timeoutMs?: number }): RoutingProvider {
  const timeoutMs = options?.timeoutMs ?? ROUTES_TIMEOUT_MS;
  return {
    async getRoute(origin, destination, mode): Promise<RouteResult | undefined> {
      const started = Date.now();
      const body: Record<string, unknown> = {
        origin: waypoint(origin),
        destination: waypoint(destination),
        travelMode: mode === "BIKE" ? "BICYCLE" : mode,
        languageCode: "en-US",
        units: "IMPERIAL",
      };
      if (mode === "TRANSIT") {
        body.transitPreferences = {
          allowedTravelModes: ["SUBWAY", "BUS", "TRAIN", "RAIL"],
        };
      }

      const pending = fetch(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      pending.catch(() => undefined);
      const response = await Promise.race([
        pending,
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error("Routes request timed out")), timeoutMs);
        }),
      ]);

      const payload = (await response.json()) as ComputeRoutesResponse;
      if (!response.ok) {
        const message = payload.error?.message ?? `Routes API HTTP ${response.status}`;
        throw new Error(message);
      }

      const route = payload.routes?.[0];
      if (!route) return undefined;

      const durationSeconds = parseDurationSeconds(route.duration);
      const legs = route.legs ?? [];
      const stepsAreObjects = legs.every((leg) => !leg.steps || Array.isArray(leg.steps));
      const steps = stepsAreObjects ? stepsFromRoute(route) : [];
      if (durationSeconds === undefined && steps.length === 0) return undefined;

      logIntegration("GOOGLE", "LIVE", `route returned in ${Date.now() - started}ms`);
      return {
        mode,
        durationSeconds,
        distanceMeters: typeof route.distanceMeters === "number" ? route.distanceMeters : undefined,
        summary: route.description ?? route.localizedValues?.duration?.text,
        steps,
      };
    },
  };
}

export function createPlacesResolver(apiKey: string): {
  resolve(query: string, bias?: { latitude: number; longitude: number }): Promise<import("./types.js").PlaceResolveResult>;
} {
  return {
    async resolve(query, bias) {
      const started = Date.now();
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
        },
        body: JSON.stringify({
          textQuery: `${query} New York`,
          regionCode: "US",
          maxResultCount: 5,
          locationBias: {
            circle: {
              center: {
                latitude: bias?.latitude ?? 40.758,
                longitude: bias?.longitude ?? -73.9855,
              },
              radius: 25000,
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const payload = (await response.json()) as {
        places?: Array<{
          id?: string;
          displayName?: { text?: string };
          formattedAddress?: string;
          location?: { latitude?: number; longitude?: number };
        }>;
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `Places API HTTP ${response.status}`);
      }

      const places = (payload.places ?? [])
        .filter((place) => place.displayName?.text)
        .map((place, index) => ({
          name: place.displayName?.text ?? query,
          address: place.formattedAddress,
          latitude: place.location?.latitude,
          longitude: place.location?.longitude,
          source: "places" as const,
          confidence: Math.max(0.45, 0.88 - index * 0.12),
        }));

      if (places.length > 0) logIntegration("GOOGLE", "LIVE", `place returned in ${Date.now() - started}ms`);
      if (places.length === 0) return { status: "unknown", query, places: [] };
      if (places.length === 1) return { status: "resolved", query, places };
      const top = places[0];
      const second = places[1];
      if (top && second && top.confidence - second.confidence < 0.16) {
        return { status: "ambiguous", query, places };
      }
      return { status: "resolved", query, places: top ? [top] : places };
    },
  };
}

export async function collectRoutes(
  provider: RoutingProvider | undefined,
  origin: PlaceLocation,
  destination: PlaceLocation,
  modes: TravelMode[],
): Promise<{ routes: RouteResult[]; failed: boolean }> {
  if (!provider) return { routes: [], failed: false };

  const uniqueModes = modes.length > 0 ? [...new Set(modes)] : (["WALK", "TRANSIT"] as TravelMode[]);
  const settled = await Promise.all(
    uniqueModes.map(async (mode) => {
      try {
        return { route: await provider.getRoute(origin, destination, mode), failed: false };
      } catch (error) {
        logTransportError(`routing.${mode}`, error);
        return { route: undefined, failed: true };
      }
    }),
  );

  return {
    routes: settled.flatMap((item) => (item.route ? [item.route] : [])),
    failed: settled.some((item) => item.failed),
  };
}
