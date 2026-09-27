import type {
  Budget,
  FoodRecommendation,
  Location,
  SkillResult,
} from "../domain/contracts.js";
import { logIntegration } from "../integrations/log.js";
import { createGeminiMapsClient } from "../transport/gemini.js";
import { distanceMeters } from "./geo.js";

export interface MapsFoodHit {
  name: string;
  placeId: string;
  latitude: number;
  longitude: number;
  address?: string;
  url?: string;
}

export interface FoodInput {
  origin: Location;
  cuisine?: string[];
  budget?: Budget;
  openNow?: boolean;
  apiKey?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  fetcher?: typeof fetch;
  /** Injected Maps grounding search; used when Places is missing or empty. */
  mapsSearch?: (query: string, origin: Location) => Promise<MapsFoodHit[]>;
  /** When set, the provider error is returned instead of a generic unavailable line. */
  strict?: boolean;
}

interface PlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    priceLevel?: string;
    rating?: number;
    currentOpeningHours?: { openNow?: boolean };
    googleMapsUri?: string;
    websiteUri?: string;
    primaryTypeDisplayName?: { text?: string };
  }>;
}

const priceLevels: Partial<Record<Budget, string[]>> = {
  free: ["PRICE_LEVEL_FREE"],
  low: ["PRICE_LEVEL_INEXPENSIVE"],
  medium: ["PRICE_LEVEL_MODERATE"],
  high: ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"],
};

function foodQuery(input: FoodInput): string {
  const cuisine = input.cuisine?.length ? `${input.cuisine.join(" or ")} ` : "";
  return `${cuisine}restaurants near ${input.origin.label}, New York City`;
}

function hitsToRecommendations(input: FoodInput, hits: MapsFoodHit[]): FoodRecommendation[] {
  return hits.flatMap((hit): FoodRecommendation[] => {
    if (!hit.name || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return [];
    const location: Location = {
      label: hit.address ?? hit.name,
      latitude: hit.latitude,
      longitude: hit.longitude,
    };
    const mapsUrl =
      hit.url ||
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hit.name)}&query_place_id=${encodeURIComponent(hit.placeId)}`;
    return [{
      id: `food:${hit.placeId}`,
      kind: "food",
      placeId: hit.placeId,
      name: hit.name,
      location,
      distanceMeters: Math.round(distanceMeters(input.origin, location)),
      categories: ["restaurant"],
      url: mapsUrl,
      source: { name: "Google Maps", url: mapsUrl },
    }];
  }).slice(0, 5);
}

async function defaultMapsSearch(input: FoodInput, query: string): Promise<MapsFoodHit[]> {
  const key = input.geminiApiKey?.trim();
  if (!key) return [];
  const client = createGeminiMapsClient({ apiKey: key, model: input.geminiModel });
  const resolved = await client.resolvePlaces(query, {
    latitude: input.origin.latitude,
    longitude: input.origin.longitude,
  });
  const byName = new Map((resolved.sources ?? []).map((source) => [source.title.toLowerCase(), source]));
  return resolved.places.flatMap((place) => {
    if (place.latitude == null || place.longitude == null) return [];
    const source = byName.get(place.name.toLowerCase());
    const placeId = source?.placeId || `maps:${place.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return [{
      name: place.name,
      placeId,
      latitude: place.latitude,
      longitude: place.longitude,
      address: place.address,
      url: source?.uri,
    }];
  });
}

async function findFoodFromMaps(input: FoodInput): Promise<SkillResult<FoodRecommendation[]>> {
  const query = foodQuery(input);
  try {
    const hits = input.mapsSearch
      ? await input.mapsSearch(query, input.origin)
      : await defaultMapsSearch(input, query);
    const data = hitsToRecommendations(input, hits);
    if (!data.length) {
      return {
        status: "unavailable",
        data: [],
        sources: [],
        warnings: input.apiKey ? ["No matching restaurants were returned."] : ["Google Places is not configured."],
      };
    }
    logIntegration("GEMINI", "LIVE", `${data.length} restaurants from Maps grounding`);
    return {
      status: "ok",
      data,
      sources: [{ name: "Google Maps" }],
      warnings: [],
    };
  } catch (error) {
    console.error("food skill maps fallback failed:", error);
    return {
      status: "unavailable",
      data: [],
      sources: [],
      warnings: [input.apiKey ? "Restaurant search is temporarily unavailable." : "Google Places is not configured."],
    };
  }
}

export async function findFood(input: FoodInput): Promise<SkillResult<FoodRecommendation[]>> {
  if (!input.apiKey) {
    if (input.mapsSearch || input.geminiApiKey) return findFoodFromMaps(input);
    return { status: "unavailable", data: [], sources: [], warnings: ["Google Places is not configured."] };
  }
  const fetcher = input.fetcher ?? fetch;
  const cuisine = input.cuisine?.length ? `${input.cuisine.join(" or ")} ` : "";
  const body: Record<string, unknown> = {
    textQuery: `${cuisine}restaurants near ${input.origin.label}, New York City`,
    locationBias: {
      circle: {
        center: { latitude: input.origin.latitude, longitude: input.origin.longitude },
        radius: 3000,
      },
    },
    includedType: "restaurant",
    openNow: input.openNow ?? true,
    pageSize: 10,
  };
  if (input.budget && priceLevels[input.budget]) body.priceLevels = priceLevels[input.budget];

  const started = Date.now();
  try {
    const response = await fetcher("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": input.apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.location",
          "places.priceLevel",
          "places.rating",
          "places.currentOpeningHours.openNow",
          "places.googleMapsUri",
          "places.websiteUri",
          "places.primaryTypeDisplayName",
        ].join(","),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Places API returned ${response.status}`);
    const payload = (await response.json()) as PlacesResponse;
    const data = (payload.places ?? []).flatMap((place): FoodRecommendation[] => {
      const latitude = place.location?.latitude;
      const longitude = place.location?.longitude;
      const name = place.displayName?.text;
      if (!place.id || !name || latitude == null || longitude == null) return [];
      const location: Location = {
        label: place.formattedAddress ?? name,
        latitude,
        longitude,
      };
      return [{
        id: `food:${place.id}`,
        kind: "food",
        placeId: place.id,
        name,
        location,
        distanceMeters: Math.round(distanceMeters(input.origin, location)),
        priceLevel: place.priceLevel,
        rating: place.rating,
        openNow: place.currentOpeningHours?.openNow,
        categories: [place.primaryTypeDisplayName?.text ?? "restaurant"],
        url: place.websiteUri || place.googleMapsUri,
        source: { name: "Google Places", url: place.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(place.id)}` },
      }];
    });
    data.sort((a, b) => (Number(b.openNow) - Number(a.openNow)) || ((b.rating ?? 0) - (a.rating ?? 0)) || (a.distanceMeters - b.distanceMeters));
    logIntegration("GOOGLE", "LIVE", `${data.length} restaurants returned in ${Date.now() - started}ms`);
    if (data.length) {
      return {
        status: "ok",
        data: data.slice(0, 5),
        sources: [{ name: "Google Places" }],
        warnings: [],
      };
    }
    return findFoodFromMaps(input);
  } catch (error) {
    console.error("food skill failed:", error);
    const mapped = await findFoodFromMaps(input);
    if (mapped.data.length) return mapped;
    const warning = input.strict && error instanceof Error ? error.message : "Restaurant search is temporarily unavailable.";
    return { status: "unavailable", data: [], sources: [], warnings: [warning] };
  }
}
