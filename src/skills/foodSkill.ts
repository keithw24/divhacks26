import type {
  Budget,
  FoodRecommendation,
  Location,
  SkillResult,
} from "../domain/contracts.js";
import { logIntegration } from "../integrations/log.js";
import { distanceMeters } from "./geo.js";

export interface FoodInput {
  origin: Location;
  cuisine?: string[];
  budget?: Budget;
  openNow?: boolean;
  apiKey?: string;
  fetcher?: typeof fetch;
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

export async function findFood(input: FoodInput): Promise<SkillResult<FoodRecommendation[]>> {
  if (!input.apiKey) {
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
        source: { name: "Google Places", url: place.websiteUri || place.googleMapsUri },
      }];
    });
    data.sort((a, b) => (Number(b.openNow) - Number(a.openNow)) || ((b.rating ?? 0) - (a.rating ?? 0)) || (a.distanceMeters - b.distanceMeters));
    logIntegration("GOOGLE", "LIVE", `${data.length} restaurants returned in ${Date.now() - started}ms`);
    return {
      status: data.length ? "ok" : "partial",
      data: data.slice(0, 5),
      sources: [{ name: "Google Places" }],
      warnings: data.length ? [] : ["No matching restaurants were returned."],
    };
  } catch (error) {
    console.error("food skill failed:", error);
    const warning = input.strict && error instanceof Error ? error.message : "Restaurant search is temporarily unavailable.";
    return { status: "unavailable", data: [], sources: [], warnings: [warning] };
  }
}
