import { NYC_BOUNDS, type LatLng, type PlaceLocation, type PlaceResolveResult } from "./types.js";

interface GazetteerEntry {
  aliases: string[];
  place: Omit<PlaceLocation, "source" | "confidence"> & { confidence?: number };
}

const GAZETTEER: GazetteerEntry[] = [
  {
    aliases: ["columbia university", "columbia uni", "columbia", "116th street"],
    place: {
      name: "Columbia University",
      address: "116th St & Broadway, New York, NY",
      latitude: 40.8075,
      longitude: -73.9626,
    },
  },
  {
    aliases: ["times square", "42nd street times square"],
    place: {
      name: "Times Square",
      address: "Times Square, New York, NY",
      latitude: 40.758,
      longitude: -73.9855,
    },
  },
  {
    aliases: ["soho"],
    place: {
      name: "SoHo",
      address: "SoHo, New York, NY",
      latitude: 40.7233,
      longitude: -74.003,
    },
  },
  {
    aliases: ["washington square park", "washington square", "wsp"],
    place: {
      name: "Washington Square Park",
      address: "Washington Square, New York, NY",
      latitude: 40.7308,
      longitude: -73.9973,
    },
  },
  {
    aliases: ["central park"],
    place: {
      name: "Central Park",
      address: "Central Park, New York, NY",
      latitude: 40.7829,
      longitude: -73.9654,
    },
  },
  {
    aliases: ["union square", "union square park"],
    place: {
      name: "Union Square",
      address: "Union Square, New York, NY",
      latitude: 40.7359,
      longitude: -73.9911,
    },
  },
  {
    aliases: ["brooklyn bridge"],
    place: {
      name: "Brooklyn Bridge",
      address: "Brooklyn Bridge, New York, NY",
      latitude: 40.7061,
      longitude: -73.9969,
    },
  },
  {
    aliases: ["penn station", "nyc penn station", "pennsylvania station"],
    place: {
      name: "Penn Station",
      address: "Penn Station, New York, NY",
      latitude: 40.7506,
      longitude: -73.9935,
    },
  },
  {
    aliases: ["grand central", "grand central terminal", "grand central station"],
    place: {
      name: "Grand Central Terminal",
      address: "89 E 42nd St, New York, NY",
      latitude: 40.7527,
      longitude: -73.9772,
    },
  },
  {
    aliases: ["katz's", "katz's deli", "katzs", "katz’s", "katz’s deli"],
    place: {
      name: "Katz's Delicatessen",
      address: "205 E Houston St, New York, NY",
      latitude: 40.7223,
      longitude: -73.9874,
    },
  },
  {
    aliases: ["brooklyn"],
    place: {
      name: "Downtown Brooklyn",
      address: "Downtown Brooklyn, NY",
      latitude: 40.6929,
      longitude: -73.987,
      confidence: 0.6,
    },
  },
];

export function isInNyc(point: LatLng): boolean {
  return (
    point.latitude >= NYC_BOUNDS.minLat &&
    point.latitude <= NYC_BOUNDS.maxLat &&
    point.longitude >= NYC_BOUNDS.minLng &&
    point.longitude <= NYC_BOUNDS.maxLng
  );
}

export function hasCoordinates(place: PlaceLocation): place is PlaceLocation & LatLng {
  return typeof place.latitude === "number" && typeof place.longitude === "number";
}

export function normalizePlaceQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9\s.'&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function lookupGazetteer(query: string): PlaceResolveResult {
  const normalized = normalizePlaceQuery(query);
  if (!normalized) {
    return { status: "unknown", query, places: [] };
  }

  let best: { score: number; place: PlaceLocation } | undefined;
  for (const entry of GAZETTEER) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizePlaceQuery(alias);
      if (
        normalized === normalizedAlias ||
        normalized.includes(normalizedAlias) ||
        normalizedAlias.includes(normalized)
      ) {
        const score =
          normalizedAlias === normalized
            ? 1
            : normalizedAlias.length / Math.max(normalized.length, normalizedAlias.length);
        const place: PlaceLocation = {
          ...entry.place,
          source: "gazetteer",
          confidence: entry.place.confidence ?? (score >= 0.9 ? 0.93 : 0.8),
        };
        if (!best || score > best.score) best = { score, place };
      }
    }
  }

  if (!best) return { status: "unknown", query, places: [] };
  return { status: "resolved", query, places: [best.place] };
}

export function looksAmbiguous(result: PlaceResolveResult): boolean {
  if (result.status === "ambiguous") return true;
  if (result.places.length < 2) return false;
  const [first, second] = result.places;
  if (!first || !second) return false;
  const closeConfidence = Math.abs(first.confidence - second.confidence) <= 0.15;
  const differentPlace =
    first.address !== second.address ||
    (first.latitude !== second.latitude && first.longitude !== second.longitude);
  return closeConfidence && differentPlace && first.confidence < 0.9;
}

export function displayName(place: PlaceLocation): string {
  return place.name || place.address || "that place";
}
