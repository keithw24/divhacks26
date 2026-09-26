import { describe, expect, it } from "vitest";
import { selectOffer } from "../../src/ticketing/pricing.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { parseCommerceOffers, parsePartnerOffers, TicketmasterProvider } from "../../src/ticketing/providers/ticketmaster.js";
import type { TicketOffer } from "../../src/ticketing/types.js";
import { NOW, ticketing, ticketmasterFetch, TM_EVENT } from "./support.js";

function offer(id: string, price: number, available?: number, allIn = true): TicketOffer {
  return {
    id,
    eventId: "e",
    provider: "mock",
    unitPrice: allIn ? price - 10 : price,
    allInUnitPrice: allIn ? price : undefined,
    currency: "USD",
    availableQuantity: available,
    purchasable: true,
  };
}

describe("ticket price lookup", () => {
  it("quotes live all-in prices from provider inventory", async () => {
    const { say, service, traces } = ticketing();
    await say("space-a", "anything fun happening tonight?");
    const result = await say("space-a", "How much are Knicks tickets?");
    expect(result.reply).toBe(
      "Tickets for New York Knicks vs. Boston Celtics currently start at $84 all-in. I found options at $84, $97, $108, and $126.",
    );
    const quote = service.store.get("space-a").lastQuote!;
    expect(quote).toMatchObject({ eventId: "mock-knicks-celtics", provider: "mock", currency: "USD", minPrice: 84, maxPrice: 189, allIn: true });
    expect(quote.fetchedAt).toBe(NOW.toISOString());
    expect(quote.offers.length).toBeGreaterThan(0);
    expect(traces.find((trace) => trace.event === "ticket.price_lookup")?.fields).toMatchObject({
      spaceId: "space-a",
      eventId: "mock-knicks-celtics",
      provider: "mock",
      currency: "USD",
    });
  });

  it("says so plainly when the provider lists no price", async () => {
    const { say } = ticketing();
    const result = await say("space-a", "how much are tickets for Chelsea Gallery?");
    expect(result.reply).toContain("I couldn't get ticket prices for Chelsea Gallery Night right now");
    expect(result.reply).toContain("https://tickets.example.test/demo/mock-gallery-night");
    expect(result.reply).not.toMatch(/\$\d/);
  });

  it("does not invent prices when the price lookup fails", async () => {
    const provider = new MockTicketProvider({ now: () => NOW });
    const { say } = ticketing({ provider });
    await say("space-a", "anything fun happening tonight?");
    provider.failPrices = true;
    const result = await say("space-a", "how much is the first one?");
    expect(result.reply).toBe("I couldn't get live ticket prices right now, so I don't want to guess.");
  });

  it("does not invent prices when every Ticketmaster price source fails", async () => {
    const { fetcher } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [{ ...TM_EVENT, priceRanges: undefined }] } } },
      "/discovery/v2/events/": { status: 503 },
      "/commerce/v2/": { status: 503 },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say } = ticketing({ provider, purchaseMode: "link" });
    await say("space-a", "any games tonight?");
    const result = await say("space-a", "how much are tickets?");
    expect(result.reply).toBe("I couldn't get live ticket prices right now, so I don't want to guess.");
    expect(result.reply).not.toMatch(/\$\d/);
  });

  it("uses the Discovery price range when offers are not accessible and does not call it seat inventory", async () => {
    const { fetcher } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
      "/discovery/v2/events/": { status: 200, body: TM_EVENT },
      "/commerce/v2/": { status: 403 },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say } = ticketing({ provider, purchaseMode: "link" });
    await say("space-a", "any games tonight?");
    const result = await say("space-a", "how much are tickets?");
    expect(result.reply).toContain("currently start around $84 all-in (up to $455)");
    expect(result.reply).toContain("choose seats on the official listing: https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics");
    expect(result.reply).not.toMatch(/Section|Row/);
  });

  it("labels face-value prices as before fees for U.S. events", async () => {
    const baseOnly = { ...TM_EVENT, priceRanges: [{ type: "standard", currency: "USD", min: 72, max: 410 }] };
    const { fetcher } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [baseOnly] } } },
      "/discovery/v2/events/": { status: 200, body: baseOnly },
      "/commerce/v2/": { status: 403 },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say } = ticketing({ provider, purchaseMode: "link" });
    await say("space-a", "any games tonight?");
    const result = await say("space-a", "how much are tickets?");
    expect(result.reply).toContain("$72 before fees");
    expect(result.reply).not.toContain("all-in");
  });

  it("parses Commerce offers into face value and all-in totals", () => {
    const offers = parseCommerceOffers(
      {
        offers: [
          { id: "000000000001", attributes: { name: "Standard", currency: "USD", prices: [{ priceZone: "1", value: "72.00", total: "84.10" }] } },
          { id: "000000000002", attributes: { name: "Standard", currency: "USD", prices: [{ priceZone: "2", value: "95.00" }] } },
        ],
      },
      "e",
      "ticketmaster",
    );
    expect(offers[0]).toMatchObject({ unitPrice: 72, allInUnitPrice: 84.1, purchasable: false });
    expect(offers[1]?.allInUnitPrice).toBeUndefined();
  });

  it("parses Partner availability charges into an all-in price", () => {
    const offers = parsePartnerOffers(
      { currency: "USD", offers: [{ offer_id: "A1", name: "Upper", section: "224", prices: [{ face_value: 72, charges: [{ amount: 9.5 }, { amount: 2.5 }] }] }] },
      "e",
      "ticketmaster",
    );
    expect(offers[0]).toMatchObject({ id: "A1", unitPrice: 72, allInUnitPrice: 84, section: "224", purchasable: true });
  });
});

describe("offer selection", () => {
  it("picks the cheapest offer that covers the quantity under the cap", () => {
    const result = selectOffer([offer("a", 84, 1), offer("b", 97, 6), offer("c", 108, 2)], { quantity: 2, maxUnitPrice: 120 });
    expect(result).toMatchObject({ status: "selected", offer: { id: "b" } });
  });

  it("reports the cheapest alternative when nothing fits the budget", () => {
    const result = selectOffer([offer("a", 126, 4), offer("b", 189, 2)], { quantity: 2, maxUnitPrice: 120 });
    expect(result).toMatchObject({ status: "over_budget", alternative: { id: "a" } });
  });

  it("does not claim availability it cannot see", () => {
    expect(selectOffer([offer("a", 84, 1)], { quantity: 2 })).toEqual({ status: "not_enough", maxAvailable: 1 });
    expect(selectOffer([], { quantity: 2 })).toEqual({ status: "no_offers" });
  });
});
