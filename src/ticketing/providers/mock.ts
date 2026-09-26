import { createHash } from "node:crypto";
import { addIsoDays, zonedDateISO, zonedToUtc, zonedWeekday } from "../time.js";
import {
  TicketProviderError,
  type EventSearchQuery,
  type ProviderPurchaseResult,
  type TicketEvent,
  type TicketHold,
  type TicketOffer,
  type TicketPriceQuote,
  type TicketProvider,
} from "../types.js";

interface MockEventSeed {
  id: string;
  name: string;
  venue: string;
  address: string;
  latitude: number;
  longitude: number;
  /** Days from today in the provider zone. */
  dayOffset: number | "saturday";
  time: string;
  category: string;
  genre: string;
  attractions: string[];
  /** All-in per-ticket prices and how many seats remain at each. Empty means the listing has no price data. */
  offers: { label: string; section?: string; row?: string; price: number; available: number }[];
}

/** Demo catalog. Clearly fake ids and URLs; nothing here is a real listing. */
const SEEDS: MockEventSeed[] = [
  {
    id: "mock-knicks-celtics",
    name: "New York Knicks vs. Boston Celtics",
    venue: "Madison Square Garden",
    address: "4 Pennsylvania Plaza, New York, NY",
    latitude: 40.7505,
    longitude: -73.9934,
    dayOffset: 0,
    time: "19:30",
    category: "Sports",
    genre: "Basketball",
    attractions: ["New York Knicks", "Boston Celtics"],
    offers: [
      { label: "Upper Level", section: "224", row: "18", price: 84, available: 4 },
      { label: "Upper Level", section: "210", row: "9", price: 97, available: 6 },
      { label: "Upper Level", section: "205", row: "3", price: 108, available: 2 },
      { label: "Lower Level Corner", section: "112", row: "22", price: 126, available: 4 },
      { label: "Lower Level Sideline", section: "105", row: "14", price: 189, available: 2 },
    ],
  },
  {
    id: "mock-brooklyn-steel",
    name: "Phoebe Bridgers",
    venue: "Brooklyn Steel",
    address: "319 Frost St, Brooklyn, NY",
    latitude: 40.7193,
    longitude: -73.9383,
    dayOffset: 0,
    time: "20:00",
    category: "Music",
    genre: "Indie",
    attractions: ["Phoebe Bridgers"],
    offers: [
      { label: "General Admission", price: 62, available: 10 },
      { label: "General Admission", price: 75, available: 8 },
    ],
  },
  {
    id: "mock-comedy-cellar",
    name: "Comedy Cellar Late Show",
    venue: "Comedy Cellar",
    address: "117 MacDougal St, New York, NY",
    latitude: 40.7302,
    longitude: -74.0005,
    dayOffset: 0,
    time: "21:00",
    category: "Comedy",
    genre: "Stand-Up",
    attractions: ["Comedy Cellar"],
    offers: [{ label: "General Admission", price: 28, available: 12 }],
  },
  {
    id: "mock-yankees-red-sox",
    name: "New York Yankees vs. Boston Red Sox",
    venue: "Yankee Stadium",
    address: "1 E 161st St, Bronx, NY",
    latitude: 40.8296,
    longitude: -73.9262,
    dayOffset: 1,
    time: "19:05",
    category: "Sports",
    genre: "Baseball",
    attractions: ["New York Yankees", "Boston Red Sox"],
    offers: [
      { label: "Grandstand", section: "420B", row: "7", price: 45, available: 8 },
      { label: "Main Level", section: "229", row: "12", price: 92, available: 4 },
      { label: "Field Level", section: "114", row: "20", price: 165, available: 2 },
    ],
  },
  {
    id: "mock-bowery-ballroom",
    name: "Mitski",
    venue: "Bowery Ballroom",
    address: "6 Delancey St, New York, NY",
    latitude: 40.7204,
    longitude: -73.9934,
    dayOffset: 2,
    time: "20:30",
    category: "Music",
    genre: "Indie",
    attractions: ["Mitski"],
    offers: [{ label: "General Admission", price: 38, available: 20 }],
  },
  {
    id: "mock-miller-theatre",
    name: "Jazz at Miller Theatre",
    venue: "Miller Theatre at Columbia University",
    address: "2960 Broadway, New York, NY",
    latitude: 40.8075,
    longitude: -73.9626,
    dayOffset: "saturday",
    time: "20:00",
    category: "Music",
    genre: "Jazz",
    attractions: ["Columbia Jazz Ensemble"],
    offers: [
      { label: "Orchestra", price: 35, available: 30 },
      { label: "Balcony", price: 22, available: 40 },
    ],
  },
  {
    id: "mock-gallery-night",
    name: "Chelsea Gallery Night",
    venue: "Chelsea Arts Collective",
    address: "530 W 25th St, New York, NY",
    latitude: 40.7488,
    longitude: -74.0047,
    dayOffset: 1,
    time: "18:00",
    category: "Arts & Theatre",
    genre: "Fine Art",
    attractions: [],
    offers: [],
  },
];

export interface MockTicketProviderOptions {
  now?: () => Date;
  timeZone?: string;
}

/**
 * Local demo provider. Realistic events and multiple all-in prices, relative to today.
 * Failure switches exist so tests can prove nothing is invented when a provider fails.
 */
export class MockTicketProvider implements TicketProvider {
  readonly name = "mock";
  readonly supportsPurchase = true;
  failSearch = false;
  failPrices = false;
  failPurchase = false;
  readonly purchases: { holdId: string; purchaseId: string; orderId: string }[] = [];
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly sold = new Map<string, number>();

  constructor(options: MockTicketProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "America/New_York";
  }

  async searchEvents(query: EventSearchQuery): Promise<TicketEvent[]> {
    if (this.failSearch) throw new TicketProviderError("unavailable");
    const start = query.startDateTime ? Date.parse(query.startDateTime) : this.now().getTime();
    const end = query.endDateTime ? Date.parse(query.endDateTime) : Number.POSITIVE_INFINITY;
    const radius = query.radiusMiles ?? 10;
    return this.catalog()
      .filter((event) => {
        const at = Date.parse(event.startTime ?? "");
        if (!Number.isFinite(at) || at < start || at > end) return false;
        if (query.classificationName && !sameCategory(event.category, query.classificationName)) return false;
        if (query.keyword && !matchesText(event, query.keyword)) return false;
        if (query.venue && !(event.venue ?? "").toLowerCase().includes(query.venue.toLowerCase())) return false;
        if (query.attraction && !matchesText(event, query.attraction)) return false;
        if (query.latitude != null && query.longitude != null && event.latitude != null && event.longitude != null) {
          if (milesBetween(query.latitude, query.longitude, event.latitude, event.longitude) > radius) return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(a.startTime ?? "") - Date.parse(b.startTime ?? ""))
      .slice(0, query.size ?? 20);
  }

  async getEvent(eventId: string): Promise<TicketEvent | undefined> {
    return this.catalog().find((event) => event.id === eventId);
  }

  async getPrices(event: TicketEvent): Promise<TicketPriceQuote> {
    if (this.failPrices) throw new TicketProviderError("unavailable");
    const offers = await this.getOffers(event);
    const prices = offers.map((offer) => offer.allInUnitPrice ?? offer.unitPrice);
    return {
      eventId: event.id,
      provider: this.name,
      fetchedAt: this.now().toISOString(),
      currency: offers[0]?.currency,
      minPrice: prices.length ? Math.min(...prices) : undefined,
      maxPrice: prices.length ? Math.max(...prices) : undefined,
      allIn: offers.length > 0,
      source: "mock_inventory",
      offers,
    };
  }

  async getOffers(event: TicketEvent): Promise<TicketOffer[]> {
    if (this.failPrices) throw new TicketProviderError("unavailable");
    const seed = SEEDS.find((item) => item.id === event.id);
    if (!seed) return [];
    return seed.offers
      .map((offer, index) => {
        const id = `${seed.id}-offer-${index + 1}`;
        return {
          id,
          eventId: seed.id,
          provider: this.name,
          label: offer.label,
          section: offer.section,
          row: offer.row,
          unitPrice: offer.price,
          allInUnitPrice: offer.price,
          currency: "USD",
          availableQuantity: Math.max(0, offer.available - (this.sold.get(id) ?? 0)),
          purchasable: true,
        };
      })
      .filter((offer) => offer.availableQuantity > 0);
  }

  checkoutUrl(event: TicketEvent): string | undefined {
    return event.url;
  }

  async reserve(input: { event: TicketEvent; offer: TicketOffer; quantity: number }): Promise<TicketHold> {
    const unit = input.offer.allInUnitPrice ?? input.offer.unitPrice;
    return {
      holdId: `mock-hold-${createHash("sha256").update(`${input.offer.id}:${input.quantity}:${this.now().toISOString()}`).digest("hex").slice(0, 10)}`,
      eventId: input.event.id,
      offerId: input.offer.id,
      quantity: input.quantity,
      unitPrice: unit,
      total: Math.round(unit * input.quantity * 100) / 100,
      currency: input.offer.currency,
    };
  }

  async purchase(input: { hold: TicketHold; purchaseId: string }): Promise<ProviderPurchaseResult> {
    if (this.failPurchase) return { status: "failed", reason: "demo_purchase_failed" };
    const orderId = `DEMO-${createHash("sha256").update(input.purchaseId).digest("hex").slice(0, 8).toUpperCase()}`;
    this.sold.set(input.hold.offerId, (this.sold.get(input.hold.offerId) ?? 0) + input.hold.quantity);
    this.purchases.push({ holdId: input.hold.holdId, purchaseId: input.purchaseId, orderId });
    return { status: "completed", orderId };
  }

  private catalog(): TicketEvent[] {
    const now = this.now();
    const today = zonedDateISO(now, this.timeZone);
    return SEEDS.map((seed) => {
      const date = seed.dayOffset === "saturday" ? addIsoDays(today, (6 - zonedWeekday(now, this.timeZone) + 7) % 7) : addIsoDays(today, seed.dayOffset);
      const prices = seed.offers.map((offer) => offer.price);
      return {
        id: seed.id,
        provider: this.name,
        name: seed.name,
        venue: seed.venue,
        address: seed.address,
        city: "New York",
        latitude: seed.latitude,
        longitude: seed.longitude,
        startTime: zonedToUtc(date, seed.time, this.timeZone).toISOString(),
        localDate: date,
        localTime: `${seed.time}:00`,
        timeZone: this.timeZone,
        category: seed.category,
        genre: seed.genre,
        attractions: seed.attractions,
        url: `https://tickets.example.test/demo/${seed.id}`,
        minPrice: prices.length ? Math.min(...prices) : undefined,
        maxPrice: prices.length ? Math.max(...prices) : undefined,
        currency: prices.length ? "USD" : undefined,
        priceIncludesFees: prices.length ? true : undefined,
        priceSource: prices.length ? "mock_inventory" : undefined,
        countryCode: "US",
      } satisfies TicketEvent;
    });
  }
}

function sameCategory(category: string | undefined, wanted: string): boolean {
  const have = (category ?? "").toLowerCase();
  const want = wanted.toLowerCase();
  if (want.startsWith("arts") || want.startsWith("theat")) return have.startsWith("arts") || have.startsWith("theat");
  return have === want;
}

function matchesText(event: TicketEvent, needle: string): boolean {
  const hay = [event.name, event.venue, event.genre, event.category, ...(event.attractions ?? [])].join(" ").toLowerCase();
  const tokens = needle.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  return tokens.length > 0 && tokens.every((token) => hay.includes(token));
}

function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}
