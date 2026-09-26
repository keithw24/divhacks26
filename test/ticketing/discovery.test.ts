import { describe, expect, it, vi } from "vitest";
import { classifyTicketingMessage } from "../../src/ticketing/intent.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { geohash, normalizeDiscoveryEvent, TicketmasterProvider } from "../../src/ticketing/providers/ticketmaster.js";
import { NOW, ticketing, ticketmasterFetch, TM_EVENT } from "./support.js";

const MSG = { latitude: 40.7505, longitude: -73.9934 };
const EMPTY = { results: [], hasPending: false, fresh: false };

describe("event discovery", () => {
  it("answers 'anything fun tonight?' with tonight's real provider events", async () => {
    const { say, traces } = ticketing();
    const result = await say("space-a", "anything fun happening tonight?");
    expect(result.handled).toBe(true);
    expect(result.reply).toContain("New York Knicks vs. Boston Celtics at Madison Square Garden tonight at 7:30");
    expect(result.reply).toContain("Phoebe Bridgers at Brooklyn Steel tonight at 8");
    expect(result.reply).toContain("Comedy Cellar Late Show");
    expect(result.reply).not.toMatch(/Yankees|Mitski/);
    expect(traces.map((trace) => trace.event)).toContain("ticket.search");
  });

  it("uses the chat's shared location for nearby searches", async () => {
    const provider = new MockTicketProvider({ now: () => NOW });
    const spy = vi.spyOn(provider, "searchEvents");
    const { say } = ticketing({ provider });
    const result = await say("space-a", "what concerts are nearby?", { location: MSG });
    const query = spy.mock.calls[0]?.[0];
    expect(query).toMatchObject({ latitude: MSG.latitude, longitude: MSG.longitude, radiusMiles: 3, classificationName: "Music" });
    expect(query?.city).toBeUndefined();
    expect(result.reply).toContain("Mitski");
    expect(result.reply).not.toContain("Brooklyn Steel");
  });

  it("geocodes a named place like Columbia and searches around it", async () => {
    const resolvePlace = vi.fn(async () => ({ latitude: 40.8075, longitude: -73.9626, label: "Columbia University" }));
    const { say } = ticketing({ resolvePlace });
    const result = await say("space-a", "what's happening near Columbia this weekend?");
    expect(resolvePlace).toHaveBeenCalledWith("Columbia");
    expect(result.reply).toContain("Jazz at Miller Theatre");
  });

  it("searches by artist or team", async () => {
    const { say } = ticketing();
    const artist = await say("space-a", "is Mitski playing this week?");
    expect(artist.reply).toContain("Mitski at Bowery Ballroom");
    expect(artist.reply).not.toContain("Knicks");

    const team = await say("space-b", "how much are Yankees tickets?");
    expect(team.reply).toContain("New York Yankees vs. Boston Red Sox");
    expect(team.reply).toContain("$45 all-in");
  });

  it("searches by date", async () => {
    const { say } = ticketing();
    const tomorrow = await say("space-a", "what games are happening tomorrow?");
    expect(tomorrow.reply).toContain("New York Yankees vs. Boston Red Sox at Yankee Stadium tomorrow at 7:05");
    expect(tomorrow.reply).not.toContain("Knicks");

    const weekend = await say("space-b", "find something fun this weekend");
    expect(weekend.reply).not.toContain("Knicks");
    expect(weekend.reply).toMatch(/Yankees|Miller Theatre|Mitski/);
  });

  it("filters by price and leaves out events without a listed price", async () => {
    const { say } = ticketing();
    const cheap = await say("space-a", "any shows under $50 tonight?");
    expect(cheap.reply).toContain("Comedy Cellar Late Show");
    expect(cheap.reply).not.toMatch(/Knicks|Phoebe/);

    await say("space-b", "anything fun happening tonight?");
    const followUp = await say("space-b", "anything under $70?");
    expect(followUp.reply).toContain("Phoebe Bridgers");
    expect(followUp.reply).not.toContain("Knicks");
    expect(followUp.reply).not.toContain("Yankees");

    const none = await say("space-c", "any concerts under $10 tomorrow?");
    expect(none.reply).toMatch(/didn't find anything with tickets under \$10/);
  });

  it("does not invent events when Ticketmaster fails", async () => {
    const { fetcher } = ticketmasterFetch({ "/discovery/v2/events.json": { status: 500 } });
    const provider = new TicketmasterProvider({ apiKey: "tm-secret-key", fetcher, now: () => NOW });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { say, service } = ticketing({ provider, purchaseMode: "link" });
    const result = await say("space-a", "any concerts tonight?");
    expect(result.reply).toBe("I couldn't reach the ticket listings right now, so I can't say what's on. Try again in a bit?");
    expect(result.reply).not.toContain("$");
    expect(service.store.get("space-a").lastSearchResults).toEqual([]);
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("tm-secret-key");
    log.mockRestore();
  });

  it("returns no events when Ticketmaster returns none", async () => {
    const { fetcher } = ticketmasterFetch({ "/discovery/v2/events.json": { status: 200, body: { page: { totalElements: 0 } } } });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say } = ticketing({ provider, purchaseMode: "link" });
    const result = await say("space-a", "any comedy tonight?");
    expect(result.reply).toMatch(/didn't find any ticketed events/);
  });
});

describe("Ticketmaster Discovery API", () => {
  it("sends location, radius, dates, keyword, and classification filters", async () => {
    const { fetcher, calls } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher });
    const events = await provider.searchEvents({
      latitude: 40.7505,
      longitude: -73.9934,
      radiusMiles: 3,
      startDateTime: "2026-09-24T16:00:00Z",
      endDateTime: "2026-09-25T03:59:59Z",
      keyword: "Knicks",
      classificationName: "Sports",
    });
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/discovery/v2/events.json");
    expect(url.searchParams.get("geoPoint")).toBe(geohash(40.7505, -73.9934, 9));
    expect(url.searchParams.get("radius")).toBe("3");
    expect(url.searchParams.get("unit")).toBe("miles");
    expect(url.searchParams.get("startDateTime")).toBe("2026-09-24T16:00:00Z");
    expect(url.searchParams.get("keyword")).toBe("Knicks");
    expect(url.searchParams.get("classificationName")).toBe("Sports");
    expect(events).toHaveLength(1);
  });

  it("uses city when no coordinates are known", async () => {
    const { fetcher, calls } = ticketmasterFetch({ "/discovery/v2/events.json": { status: 200, body: {} } });
    await new TicketmasterProvider({ apiKey: "k", fetcher }).searchEvents({ city: "New York", venue: "Madison Square Garden" });
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("city")).toBe("New York");
    expect(url.searchParams.get("keyword")).toBe("Madison Square Garden");
  });

  it("normalizes venue, time, category, and prefers the all-in price range", () => {
    const event = normalizeDiscoveryEvent(TM_EVENT)!;
    expect(event).toMatchObject({
      id: "vvG1zZ9KnicksCeltics",
      provider: "ticketmaster",
      venue: "Madison Square Garden",
      address: "4 Pennsylvania Plaza, New York, NY",
      latitude: 40.7505,
      longitude: -73.9934,
      localTime: "19:30:00",
      category: "Sports",
      minPrice: 84,
      maxPrice: 455,
      currency: "USD",
      priceIncludesFees: true,
      priceSource: "discovery_price_range",
    });
  });

  it("refuses to search without an API key instead of guessing", async () => {
    await expect(new TicketmasterProvider({}).searchEvents({ city: "New York" })).rejects.toMatchObject({ kind: "unconfigured" });
  });
});

describe("ticketing intent", () => {
  it("routes discovery, price, and purchase phrasing", () => {
    expect(classifyTicketingMessage("what concerts are nearby?", EMPTY).kind).toBe("search");
    expect(classifyTicketingMessage("anything fun tonight?", EMPTY).kind).toBe("search");
    expect(classifyTicketingMessage("how much are Yankees tickets?", EMPTY).kind).toBe("price");
    expect(classifyTicketingMessage("Are Knicks tickets expensive?", EMPTY).kind).toBe("price");
    expect(classifyTicketingMessage("buy tickets to the Knicks game", EMPTY).kind).toBe("purchase");
  });

  it("never treats research or chatter as a purchase", () => {
    for (const text of ["How much are tickets?", "Find tickets.", "What's happening tonight?", "Are Knicks tickets expensive?", "I heard the concert is good."]) {
      expect(classifyTicketingMessage(text, EMPTY).kind).not.toBe("purchase");
    }
    expect(classifyTicketingMessage("I heard the concert is good.", EMPTY).kind).toBe("none");
  });

  it("leaves directions and restaurants alone", () => {
    for (const text of [
      "How do I get to Madison Square Garden?",
      "How do we get there?",
      "Get us a table near Madison Square Garden.",
      "book a table for 4 at Carbone",
      "what's near me",
    ]) {
      expect(classifyTicketingMessage(text, EMPTY).kind).toBe("none");
    }
  });
});
