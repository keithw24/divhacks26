import { toE164 } from "./collect.js";
import type { RestaurantIdentity, TrustedPhoneSource } from "./types.js";

export interface RestaurantLookup {
  status: "resolved" | "ambiguous" | "unknown" | "missing_phone";
  restaurant?: RestaurantIdentity;
  candidates?: RestaurantIdentity[];
}

export interface RestaurantDirectory {
  lookup(query: string): Promise<RestaurantLookup>;
  knownNames(): string[];
}

export interface DirectoryEntry {
  name: string;
  address?: string;
  phone?: string;
  placeId?: string;
  phoneSource: TrustedPhoneSource;
  websiteUrl?: string;
  openNow?: boolean;
}

/**
 * Development directory. Numbers are reserved 555 test numbers, not live restaurants.
 * Live dialing uses Google Places unless gazetteer dialing is explicitly enabled.
 */
export const DEMO_RESTAURANTS: DirectoryEntry[] = [
  {
    name: "L'Artusi",
    address: "228 W 10th St, New York, NY 10014",
    phone: "+12125550101",
    placeId: "demo-lartusi",
    phoneSource: "gazetteer",
  },
  {
    name: "Carbone",
    address: "181 Thompson St, New York, NY 10012",
    phone: "+12125550102",
    placeId: "demo-carbone",
    phoneSource: "gazetteer",
  },
  {
    name: "Don Angie",
    address: "103 Greenwich Ave, New York, NY 10014",
    phone: "+12125550103",
    placeId: "demo-don-angie",
    phoneSource: "gazetteer",
  },
  {
    name: "Joe's Pizza",
    address: "7 Carmine St, New York, NY 10014",
    phone: "+12125550104",
    placeId: "demo-joes-carmine",
    phoneSource: "gazetteer",
  },
  {
    name: "Joe's Pizza",
    address: "150 E 14th St, New York, NY 10003",
    phone: "+12125550105",
    placeId: "demo-joes-14",
    phoneSource: "gazetteer",
  },
  {
    name: "No Phone Cafe",
    address: "1 Example St, New York, NY",
    placeId: "demo-no-phone",
    phoneSource: "gazetteer",
  },
];

const TRUSTED = new Set<TrustedPhoneSource>(["places", "gazetteer", "directory"]);

export function normalizePlace(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Remove phone-shaped text so a user cannot steer lookup at an arbitrary number. */
export function restaurantQuery(name: string): string | undefined {
  const stripped = name
    .replace(/\+?\d[\d\s().-]{8,}\d/g, " ")
    .replace(/^(?:please\s+)?(?:call|book|dial)\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 2 || /^(call|book|dial|the|a|an)$/i.test(stripped)) return undefined;
  return stripped;
}

export function assertDialable(restaurant: RestaurantIdentity): RestaurantIdentity & { phone: string; phoneSource: TrustedPhoneSource } {
  if (!restaurant.phone || !restaurant.phoneSource || !TRUSTED.has(restaurant.phoneSource)) {
    throw new Error("unverified_phone");
  }
  const phone = toE164(restaurant.phone);
  if (!phone) throw new Error("invalid_phone");
  return { ...restaurant, phone, phoneSource: restaurant.phoneSource };
}

export function createMemoryDirectory(entries: DirectoryEntry[]): RestaurantDirectory {
  return {
    knownNames() {
      return [...new Set(entries.map((entry) => entry.name))];
    },
    async lookup(query: string) {
      const cleaned = restaurantQuery(query);
      if (!cleaned) return { status: "unknown" };
      const needle = normalizePlace(cleaned);
      const matches = entries.filter((entry) => {
        const name = normalizePlace(entry.name);
        const address = normalizePlace(entry.address ?? "");
        return name === needle || name.includes(needle) || needle.includes(name) || (address && needle.includes(address));
      });
      return classifyMatches(cleaned, matches);
    },
  };
}

const ADDRESS_STOP = new Set(["street", "avenue", "york", "new", "united", "states", "restaurant", "phone"]);

function addressSpecific(needle: string, matches: DirectoryEntry[]): DirectoryEntry[] {
  return matches.filter((entry) => {
    const address = normalizePlace(entry.address ?? "");
    if (!address) return false;
    if (needle.includes(address)) return true;
    const name = normalizePlace(entry.name);
    return address.split(" ").some((token) => token.length > 5 && !ADDRESS_STOP.has(token) && !name.includes(token) && needle.includes(token));
  });
}

function classifyMatches(query: string, matches: DirectoryEntry[]): RestaurantLookup {
  if (matches.length === 0) return { status: "unknown" };
  const needle = normalizePlace(query);
  const specific = addressSpecific(needle, matches);
  const narrowed = specific.length > 0 ? specific : matches;
  const exact = narrowed.filter((entry) => normalizePlace(entry.name) === needle);
  const pool = exact.length > 0 ? exact : narrowed;
  if (pool.length > 1) {
    return {
      status: "ambiguous",
      candidates: pool.map(toIdentity),
    };
  }
  const only = pool[0];
  if (!only) return { status: "unknown" };
  if (!only.phone || !toE164(only.phone)) {
    return { status: "missing_phone", restaurant: toIdentity(only) };
  }
  return { status: "resolved", restaurant: { ...toIdentity(only), phone: toE164(only.phone) } };
}

function toIdentity(entry: DirectoryEntry): RestaurantIdentity {
  return {
    name: entry.name,
    address: entry.address,
    phone: entry.phone ? toE164(entry.phone) : undefined,
    placeId: entry.placeId,
    phoneSource: entry.phone ? entry.phoneSource : undefined,
    websiteUrl: entry.websiteUrl,
    openNow: entry.openNow,
  };
}

interface PlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    currentOpeningHours?: { openNow?: boolean };
  }>;
  error?: { message?: string };
}

export function createPlacesDirectory(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): RestaurantDirectory {
  const discovered: string[] = [];
  return {
    knownNames() {
      return [...new Set([...DEMO_RESTAURANTS.map((entry) => entry.name), ...discovered])];
    },
    async lookup(query: string) {
      const cleaned = restaurantQuery(query);
      if (!cleaned) return { status: "unknown" };
      const response = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.currentOpeningHours.openNow",
        },
        body: JSON.stringify({
          textQuery: `${cleaned} restaurant New York`,
          regionCode: "US",
          maxResultCount: 5,
          locationBias: {
            circle: { center: { latitude: 40.735, longitude: -74.0 }, radius: 20000 },
          },
        }),
      });
      const payload = (await response.json()) as PlacesResponse;
      if (!response.ok) throw new Error(payload.error?.message ?? `Places API HTTP ${response.status}`);
      const entries: DirectoryEntry[] = (payload.places ?? [])
        .filter((place) => place.displayName?.text)
        .map((place) => {
          const phone = toE164(place.internationalPhoneNumber ?? "") ?? toE164(place.nationalPhoneNumber ?? "");
          return {
            name: place.displayName?.text ?? cleaned,
            address: place.formattedAddress,
            phone,
            placeId: place.id,
            phoneSource: "places" as const,
            websiteUrl: place.websiteUri,
            openNow: place.currentOpeningHours?.openNow,
          };
        });
      for (const entry of entries) discovered.push(entry.name);
      return classifyMatches(cleaned, entries);
    },
  };
}

export function createRestaurantDirectory(options: {
  googleMapsApiKey?: string;
  allowGazetteerFallback: boolean;
  entries?: DirectoryEntry[];
  fetchImpl?: typeof fetch;
}): RestaurantDirectory {
  const gazetteer = createMemoryDirectory(options.entries ?? DEMO_RESTAURANTS);
  const places = options.googleMapsApiKey
    ? createPlacesDirectory(options.googleMapsApiKey, options.fetchImpl)
    : undefined;
  return {
    knownNames() {
      return [...new Set([...gazetteer.knownNames(), ...(places?.knownNames() ?? [])])];
    },
    async lookup(query: string) {
      if (places) {
        try {
          const remote = await places.lookup(query);
          if (remote.status !== "unknown") return remote;
        } catch {
          if (!options.allowGazetteerFallback) return { status: "unknown" };
        }
        if (!options.allowGazetteerFallback) return { status: "unknown" };
      }
      return gazetteer.lookup(query);
    },
  };
}
