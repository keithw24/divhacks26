import {
  TicketProviderError,
  type EventSearchQuery,
  type PriceSource,
  type ProviderPurchaseResult,
  type TicketEvent,
  type TicketHold,
  type TicketOffer,
  type TicketPriceQuote,
  type TicketProvider,
} from "../types.js";

const BASE = "https://app.ticketmaster.com";

export interface TicketmasterProviderOptions {
  /** Discovery API consumer key. */
  apiKey?: string;
  /** Partner API key. Only set when Ticketmaster has approved transaction access. */
  partnerApiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Ticketmaster Discovery API for events and price ranges.
 * Fresher prices come from Partner availability (partner key) or Commerce offers when the key has access.
 * Reserve and purchase exist only with a Partner API key. The public Discovery key never buys anything,
 * and consumer checkout pages are never scraped or automated.
 */
export class TicketmasterProvider implements TicketProvider {
  readonly name = "ticketmaster";
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: TicketmasterProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? (() => new Date());
  }

  get supportsPurchase(): boolean {
    return Boolean(this.options.partnerApiKey);
  }

  async searchEvents(query: EventSearchQuery): Promise<TicketEvent[]> {
    const key = this.requireKey();
    const params = new URLSearchParams({ apikey: key, size: String(Math.min(query.size ?? 20, 50)), sort: "date,asc" });
    if (query.latitude != null && query.longitude != null) {
      params.set("geoPoint", geohash(query.latitude, query.longitude, 9));
      params.set("radius", String(Math.max(1, Math.round(query.radiusMiles ?? 10))));
      params.set("unit", "miles");
    } else if (query.city) {
      params.set("city", query.city);
    }
    if (query.startDateTime) params.set("startDateTime", query.startDateTime);
    if (query.endDateTime) params.set("endDateTime", query.endDateTime);
    const keyword = [query.keyword, query.attraction, query.venue].filter(Boolean).join(" ").trim();
    if (keyword) params.set("keyword", keyword);
    if (query.classificationName) params.set("classificationName", query.classificationName);
    if (query.genre) params.append("classificationName", query.genre);
    const body = await this.getJson(`${BASE}/discovery/v2/events.json?${params}`);
    const events = readArray(readPath(body, ["_embedded", "events"]));
    return events.map((raw) => normalizeDiscoveryEvent(raw)).filter((event): event is TicketEvent => event !== undefined);
  }

  async getEvent(eventId: string): Promise<TicketEvent | undefined> {
    const key = this.requireKey();
    try {
      const body = await this.getJson(`${BASE}/discovery/v2/events/${encodeURIComponent(eventId)}.json?apikey=${encodeURIComponent(key)}`);
      return normalizeDiscoveryEvent(body);
    } catch (error) {
      if (error instanceof TicketProviderError && error.kind === "bad_response") return undefined;
      throw error;
    }
  }

  async getPrices(event: TicketEvent): Promise<TicketPriceQuote> {
    const offers = await this.getOffers(event).catch(() => [] as TicketOffer[]);
    if (offers.length > 0) {
      return quoteFromOffers(event, offers, this.options.partnerApiKey ? "partner_availability" : "commerce_offers", this.now());
    }
    const fresh = await this.getEvent(event.id);
    if (!fresh) throw new TicketProviderError("bad_response", "event not found");
    return {
      eventId: event.id,
      provider: this.name,
      fetchedAt: this.now().toISOString(),
      currency: fresh.currency,
      minPrice: fresh.minPrice,
      maxPrice: fresh.maxPrice,
      allIn: fresh.priceIncludesFees === true,
      source: "discovery_price_range",
      offers: [],
    };
  }

  /** Offer-level prices. Partner availability first, then Commerce offers. Empty when neither is accessible. */
  async getOffers(event: TicketEvent): Promise<TicketOffer[]> {
    if (this.options.partnerApiKey) {
      try {
        const body = await this.getJson(
          `${BASE}/partners/v1/events/${encodeURIComponent(event.id)}/availability?apikey=${encodeURIComponent(this.options.partnerApiKey)}`,
        );
        const offers = parsePartnerOffers(body, event.id, this.name);
        if (offers.length > 0) return offers;
      } catch {
        // Fall through to Commerce offers.
      }
    }
    if (!this.options.apiKey) return [];
    try {
      const body = await this.getJson(
        `${BASE}/commerce/v2/events/${encodeURIComponent(event.id)}/offers.json?apikey=${encodeURIComponent(this.options.apiKey)}`,
      );
      return parseCommerceOffers(body, event.id, this.name);
    } catch {
      return [];
    }
  }

  checkoutUrl(event: TicketEvent): string | undefined {
    return event.url;
  }

  async reserve(input: { event: TicketEvent; offer: TicketOffer; quantity: number }): Promise<TicketHold> {
    const partner = this.options.partnerApiKey;
    if (!partner) throw new TicketProviderError("unconfigured", "partner access required");
    const body = await this.sendJson(
      "POST",
      `${BASE}/partners/v1/events/${encodeURIComponent(input.event.id)}/cart?apikey=${encodeURIComponent(partner)}`,
      { offers: [{ offer: input.offer.id, qty: input.quantity }] },
    );
    const holdId = readString(body, ["cart", "id"]) ?? readString(body, ["cart_id"]) ?? readString(body, ["id"]);
    if (!holdId) throw new TicketProviderError("bad_response", "cart id missing");
    const unit = input.offer.allInUnitPrice ?? input.offer.unitPrice;
    const providerTotal = readNumber(body, ["cart", "totals", "grand_total"]) ?? readNumber(body, ["totals", "grand_total"]);
    return {
      holdId,
      eventId: input.event.id,
      offerId: input.offer.id,
      quantity: input.quantity,
      unitPrice: unit,
      total: providerTotal ?? money(unit * input.quantity),
      currency: readString(body, ["cart", "totals", "currency"]) ?? input.offer.currency,
      expiresAt: readString(body, ["cart", "reserve_expiration"]),
    };
  }

  /**
   * Commits a Partner API cart. Payment and delivery are attached per the partner account agreement.
   * Anything other than a clear order number is a failure. A 202/polling response is not a purchase.
   */
  async purchase(input: { hold: TicketHold; purchaseId: string }): Promise<ProviderPurchaseResult> {
    const partner = this.options.partnerApiKey;
    if (!partner) return { status: "failed", reason: "partner_access_required" };
    try {
      const body = await this.sendJson(
        "PUT",
        `${BASE}/partners/v1/cart/${encodeURIComponent(input.hold.holdId)}/purchase?apikey=${encodeURIComponent(partner)}`,
        { client_reference: input.purchaseId },
      );
      const orderId = readString(body, ["order", "order_number"]) ?? readString(body, ["order_number"]) ?? readString(body, ["order", "id"]);
      if (!orderId) return { status: "failed", reason: "no_order_number" };
      return { status: "completed", orderId };
    } catch (error) {
      return { status: "failed", reason: error instanceof TicketProviderError ? error.kind : "error" };
    }
  }

  private requireKey(): string {
    if (!this.options.apiKey) throw new TicketProviderError("unconfigured", "TICKETMASTER_API_KEY is not set");
    return this.options.apiKey;
  }

  private async getJson(url: string): Promise<unknown> {
    return this.request(url, { method: "GET", headers: { Accept: "application/json" } });
  }

  private async sendJson(method: "POST" | "PUT", url: string, payload: unknown): Promise<unknown> {
    return this.request(url, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new TicketProviderError("unavailable", "request failed");
    }
    if (response.status === 401 || response.status === 403) throw new TicketProviderError("unauthorized", String(response.status));
    if (response.status === 429) throw new TicketProviderError("rate_limited", "429");
    if (response.status === 202) throw new TicketProviderError("unavailable", "pending");
    if (response.status === 404) throw new TicketProviderError("bad_response", "404");
    if (!response.ok) throw new TicketProviderError("unavailable", String(response.status));
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new TicketProviderError("bad_response", "invalid json");
    }
  }
}

/** Discovery API event → TicketEvent. Returns undefined when the payload is not an event. */
export function normalizeDiscoveryEvent(raw: unknown): TicketEvent | undefined {
  const id = readString(raw, ["id"]);
  const name = readString(raw, ["name"]);
  if (!id || !name) return undefined;
  const venue = readArray(readPath(raw, ["_embedded", "venues"]))[0];
  const classification = readArray(readPath(raw, ["classifications"]))[0];
  const ranges = readArray(readPath(raw, ["priceRanges"]));
  const range = pickRange(ranges);
  const lat = Number(readString(venue, ["location", "latitude"]));
  const lng = Number(readString(venue, ["location", "longitude"]));
  const line1 = readString(venue, ["address", "line1"]);
  const city = readString(venue, ["city", "name"]);
  const state = readString(venue, ["state", "stateCode"]);
  const attractions = readArray(readPath(raw, ["_embedded", "attractions"]))
    .map((item) => readString(item, ["name"]))
    .filter((value): value is string => Boolean(value));
  return {
    id,
    provider: "ticketmaster",
    name,
    venue: readString(venue, ["name"]),
    address: [line1, city, state].filter(Boolean).join(", ") || undefined,
    city,
    latitude: Number.isFinite(lat) ? lat : undefined,
    longitude: Number.isFinite(lng) ? lng : undefined,
    startTime: readString(raw, ["dates", "start", "dateTime"]),
    localDate: readString(raw, ["dates", "start", "localDate"]),
    localTime: readString(raw, ["dates", "start", "localTime"]),
    timeZone: readString(raw, ["dates", "timezone"]) ?? readString(venue, ["timezone"]),
    category: readString(classification, ["segment", "name"]),
    genre: readString(classification, ["genre", "name"]),
    attractions,
    url: readString(raw, ["url"]),
    minPrice: range?.min,
    maxPrice: range?.max,
    currency: range?.currency,
    priceIncludesFees: range ? range.includesFees : undefined,
    priceSource: range ? "discovery_price_range" : undefined,
    countryCode: readString(venue, ["country", "countryCode"]),
  };
}

/** Prefer the "standard including fees" range. A plain "standard" range is face value only. */
function pickRange(ranges: unknown[]): { min?: number; max?: number; currency?: string; includesFees: boolean } | undefined {
  const parsed = ranges
    .map((range) => {
      const type = (readString(range, ["type"]) ?? "").toLowerCase();
      const min = readNumber(range, ["min"]);
      const max = readNumber(range, ["max"]);
      if (min == null && max == null) return undefined;
      return { min, max, currency: readString(range, ["currency"]), includesFees: type.includes("including fees") };
    })
    .filter((range): range is NonNullable<typeof range> => range !== undefined);
  return parsed.find((range) => range.includesFees) ?? parsed[0];
}

/** Commerce API offers: price levels, not seats. `total` includes fees when present. */
export function parseCommerceOffers(body: unknown, eventId: string, provider: string): TicketOffer[] {
  const offers: TicketOffer[] = [];
  for (const raw of readArray(readPath(body, ["offers"]))) {
    const id = readString(raw, ["id"]);
    if (!id) continue;
    const label = readString(raw, ["attributes", "name"]);
    const currency = readString(raw, ["attributes", "currency"]) ?? "USD";
    readArray(readPath(raw, ["attributes", "prices"])).forEach((price, index) => {
      const face = readNumber(price, ["value"]);
      if (face == null || face <= 0) return;
      const total = readNumber(price, ["total"]);
      offers.push({
        id: `${id}:${readString(price, ["priceZone"]) ?? index}`,
        eventId,
        provider,
        label,
        unitPrice: face,
        allInUnitPrice: total != null && total >= face ? total : undefined,
        currency,
        purchasable: false,
      });
    });
  }
  return offers;
}

/** Partner API availability. Offers carry face value and, when listed, per-ticket charges or an all-in total. */
export function parsePartnerOffers(body: unknown, eventId: string, provider: string): TicketOffer[] {
  const rootCurrency = readString(body, ["currency"]) ?? readString(body, ["event", "currency"]);
  const offers: TicketOffer[] = [];
  for (const raw of readArray(readPath(body, ["offers"]))) {
    const id = readString(raw, ["offer_id"]) ?? readString(raw, ["offerId"]) ?? readString(raw, ["id"]);
    if (!id) continue;
    const label = readString(raw, ["name"]);
    const currency = readString(raw, ["currency"]) ?? rootCurrency ?? "USD";
    const prices = readArray(readPath(raw, ["prices"]));
    const entries = prices.length ? prices : [raw];
    entries.forEach((price, index) => {
      const face = readNumber(price, ["face_value"]) ?? readNumber(price, ["faceValue"]) ?? readNumber(price, ["value"]);
      if (face == null || face <= 0) return;
      const listedTotal = readNumber(price, ["total"]) ?? readNumber(price, ["total_price"]);
      const charges = readArray(readPath(price, ["charges"]));
      const chargeSum = charges.length
        ? charges.reduce<number>((sum, charge) => sum + (readNumber(charge, ["amount"]) ?? 0), 0)
        : undefined;
      const allIn = listedTotal ?? (chargeSum != null ? money(face + chargeSum) : undefined);
      offers.push({
        id: entries.length > 1 ? `${id}:${index}` : id,
        eventId,
        provider,
        label,
        section: readString(raw, ["section"]),
        row: readString(raw, ["row"]),
        unitPrice: face,
        allInUnitPrice: allIn != null && allIn >= face ? allIn : undefined,
        currency,
        availableQuantity: readNumber(raw, ["available"]) ?? readNumber(raw, ["quantity_available"]),
        purchasable: true,
      });
    });
  }
  return offers;
}

function quoteFromOffers(event: TicketEvent, offers: TicketOffer[], source: PriceSource, now: Date): TicketPriceQuote {
  const allIn = offers.every((offer) => offer.allInUnitPrice != null);
  const prices = offers.map((offer) => (allIn ? offer.allInUnitPrice! : offer.unitPrice));
  return {
    eventId: event.id,
    provider: "ticketmaster",
    fetchedAt: now.toISOString(),
    currency: offers[0]?.currency,
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    allIn,
    source,
    offers,
  };
}

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash, used for the Discovery API geoPoint filter. */
export function geohash(latitude: number, longitude: number, precision = 9): string {
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lonRange : latRange;
    const value = even ? longitude : latitude;
    const mid = (range[0]! + range[1]!) / 2;
    if (value >= mid) {
      ch |= 1 << (4 - bit);
      if (even) lonRange = [mid, lonRange[1]!];
      else latRange = [mid, latRange[1]!];
    } else if (even) {
      lonRange = [lonRange[0]!, mid];
    } else {
      latRange = [latRange[0]!, mid];
    }
    even = !even;
    if (bit < 4) {
      bit += 1;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown, path: string[]): string | undefined {
  const found = readPath(value, path);
  if (typeof found === "string" && found.trim()) return found.trim();
  if (typeof found === "number" && Number.isFinite(found)) return String(found);
  return undefined;
}

function readNumber(value: unknown, path: string[]): number | undefined {
  const found = readPath(value, path);
  const parsed = typeof found === "number" ? found : typeof found === "string" && found.trim() ? Number(found) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}
