import { describe, expect, it } from "vitest";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { TicketmasterProvider } from "../../src/ticketing/providers/ticketmaster.js";
import { NOW, ticketing, ticketmasterFetch, TM_EVENT } from "./support.js";

describe("ticketing follow-ups", () => {
  it("answers 'how much is the second one?' from the last results", async () => {
    const { say } = ticketing();
    await say("space-a", "anything fun happening tonight?");
    const result = await say("space-a", "how much is the second one?");
    expect(result.reply).toBe("Tickets for Phoebe Bridgers currently start at $62 all-in. I found options at $62 and $75.");
  });

  it("'get two' quotes the selected event and waits for a yes", async () => {
    const { say, service, provider } = ticketing();
    await say("space-a", "anything fun happening tonight?");
    await say("space-a", "how much is the second one?");
    const result = await say("space-a", "get two");
    expect(result.reply).toBe(
      "I found 2 tickets for Phoebe Bridgers at $62 each (General Admission), $124 total. Want me to purchase them? (Demo checkout: no real tickets, paid with test funds on XRPL Testnet.)",
    );
    const pending = service.store.pending("space-a")!;
    expect(pending).toMatchObject({ eventId: "mock-brooklyn-steel", quantity: 2, unitPrice: 62, total: 124, currency: "USD", status: "AWAITING_CONFIRMATION" });
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("asks which event when 'get two' is ambiguous, then continues with the pick", async () => {
    const { say, service } = ticketing();
    await say("space-a", "anything fun happening tonight?");
    const ask = await say("space-a", "get two");
    expect(ask.reply).toMatch(/^Which one — New York Knicks vs\. Boston Celtics, Phoebe Bridgers, or Comedy Cellar Late Show\?$/);
    const picked = await say("space-a", "the comedy one");
    expect(picked.reply).toContain("2 tickets for Comedy Cellar Late Show at $28 each");
    expect(service.store.pending("space-a")?.quantity).toBe(2);
  });

  it("handles the full Knicks conversation: price, budget quote, yes", async () => {
    const { say, provider, service } = ticketing();
    await say("space-a", "anything fun happening tonight?");
    expect((await say("space-a", "How much are Knicks tickets?")).reply).toContain("start at $84 all-in");
    const quote = await say("space-a", "Get me 2 under $120 each.");
    expect(quote.reply).toContain("I found 2 tickets for New York Knicks vs. Boston Celtics at $84 each (Section 224, Row 18), $168 total. Want me to purchase them?");
    const done = await say("space-a", "yes");
    expect(done.reply).toMatch(/^Done — 2 demo tickets for New York Knicks vs\. Boston Celtics, \$168 total\. Order DEMO-[0-9A-F]{8}\./);
    expect((provider as MockTicketProvider).purchases).toHaveLength(1);
    const [record] = service.store.purchasesFor("space-a").filter((item) => item.status === "COMPLETED");
    expect(record).toMatchObject({ quantity: 2, unitPrice: 84, total: 168, currency: "USD", isDemo: true, eventName: "New York Knicks vs. Boston Celtics" });
    expect(record?.orderId).toMatch(/^DEMO-/);
    expect(record?.completedAt).toBe(NOW.toISOString());
  });

  it("offers the cheapest option when nothing fits the budget, still behind a yes", async () => {
    const { say, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    const result = await say("space-a", "get 4 under $80");
    expect(result.reply).toContain("Nothing under $80 each right now. The cheapest I see is $84 each (Section 224, Row 18), $336 total for 4. Want those instead?");
    expect(service.store.pending("space-a")?.status).toBe("AWAITING_CONFIRMATION");
  });

  it("asks how many when the quantity is missing", async () => {
    const { say, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    expect((await say("space-a", "buy tickets")).reply).toBe("How many tickets for New York Knicks vs. Boston Celtics?");
    const quote = await say("space-a", "3");
    expect(quote.reply).toContain("I found 3 tickets");
    expect(service.store.pending("space-a")?.quantity).toBe(3);
  });

  it("answers 'yes' after 'Want ticket prices?' with actual prices for the event", async () => {
    const { say } = ticketing();
    const search = await say("space-a", "Phoebe Bridgers tickets");
    expect(search.reply).toContain("Want ticket prices?");
    const prices = await say("space-a", "Yes");
    expect(prices.handled).toBe(true);
    expect(prices.reply).toContain("start at $62");
  });
});

describe("purchase confirmation", () => {
  it("never buys without an explicit yes", async () => {
    const { say, provider, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "how much are tickets?");
    expect((await say("space-a", "ok")).reply).toContain("I won't buy anything unless you're sure");
    expect((await say("space-a", "sounds good")).reply).toContain("I won't buy anything unless you're sure");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
    expect(service.store.purchasesFor("space-a").some((record) => record.status === "COMPLETED")).toBe(false);
  });

  it("only the person who asked can confirm", async () => {
    const { say, provider } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const other = await say("space-a", "yes", { senderId: "bob" });
    expect(other.reply).toBe("Only Alice can confirm that ticket purchase.");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("an expired quote does not buy", async () => {
    let now = NOW;
    const { say, provider } = ticketing({ now: () => now });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    now = new Date(NOW.getTime() + 11 * 60_000);
    const result = await say("space-a", "yes");
    expect(result.reply).toBe("That quote expired, so I didn't buy anything. Want me to check prices again?");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("a second yes does not buy twice", async () => {
    const { say, provider } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "yes");
    const again = await say("space-a", "yes");
    expect(again.handled).toBe(false);
    expect((provider as MockTicketProvider).purchases).toHaveLength(1);
  });

  it("'no' cancels the pending purchase", async () => {
    const { say, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    expect((await say("space-a", "no")).reply).toBe("Okay, I won't buy them.");
    expect(service.store.pending("space-a")).toBeUndefined();
  });

  it("the priority pass never consumes a yes, so reservations and payments see it first", async () => {
    const { say, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const priority = await service.handleTurn({ spaceId: "space-a", senderId: "alice", text: "yes", phase: "priority" });
    expect(priority.handled).toBe(false);
    expect(service.store.pending("space-a")?.status).toBe("AWAITING_CONFIRMATION");
  });

  it("re-quotes instead of buying when the live price changed", async () => {
    const provider = new MockTicketProvider({ now: () => NOW });
    const { say, service } = ticketing({ provider });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const original = provider.getOffers.bind(provider);
    provider.getOffers = async (event) => (await original(event)).map((item) => ({ ...item, allInUnitPrice: (item.allInUnitPrice ?? 0) + 5 }));
    const result = await say("space-a", "yes");
    expect(result.reply).toContain("The price changed from $168 to $178, so I didn't purchase anything.");
    expect(provider.purchases).toHaveLength(0);
    expect(service.store.pending("space-a")?.total).toBe(178);
  });

  it("a failed purchase returns a clean message and is not marked purchased", async () => {
    const provider = new MockTicketProvider({ now: () => NOW });
    provider.failPurchase = true;
    const { say, service, traces } = ticketing({ provider });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const result = await say("space-a", "yes");
    expect(result.reply).toBe("I couldn't complete that purchase, so nothing was bought. Want me to try again or send the official link?");
    const records = service.store.purchasesFor("space-a");
    expect(records.some((record) => record.status === "COMPLETED")).toBe(false);
    expect(records.find((record) => record.status === "FAILED")?.orderId).toBeUndefined();
    expect(traces.map((trace) => trace.event)).toContain("ticket.purchase_failed");
  });
});

describe("providers without purchasing", () => {
  it("quotes first, then returns the official checkout URL after yes — never pretends to buy", async () => {
    const commerce = {
      offers: [
        { id: "000000000001", attributes: { name: "Standard", currency: "USD", prices: [{ priceZone: "1", value: "92.00", total: "108.00" }] } },
      ],
    };
    const { fetcher, calls } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
      "/commerce/v2/": { status: 200, body: commerce },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say, service } = ticketing({ provider, purchaseMode: "provider" });
    expect(service.effectiveMode).toBe("link");
    await say("space-a", "any games tonight?");
    const quote = await say("space-a", "get 2 under $120");
    expect(quote.reply).toBe(
      "2 tickets to New York Knicks vs. Boston Celtics are $216 total (Standard). Want me to prepare the checkout?",
    );
    expect(service.store.pending("space-a")?.status).toBe("AWAITING_CONFIRMATION");
    expect(service.store.pending("space-a")?.total).toBe(216);
    const done = await say("space-a", "yes");
    expect(done.reply).toContain("still available for $216");
    expect(done.reply).toContain("https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics");
    expect(done.reply).not.toMatch(/Booked|purchased|Confirmation:/i);
    const record = service.store.purchasesFor("space-a").find((item) => item.status === "CHECKOUT_REQUIRED");
    expect(record).toMatchObject({
      status: "CHECKOUT_REQUIRED",
      checkoutUrl: "https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics",
      eventId: "vvG1zZ9KnicksCeltics",
      quantity: 2,
      total: 216,
    });
    expect(calls.some((url) => url.includes("/partners/") || url.includes("/cart"))).toBe(false);
  });

  it("falls back to the link when only a price range is available", async () => {
    const { fetcher } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
      "/discovery/v2/events/": { status: 200, body: TM_EVENT },
      "/commerce/v2/": { status: 403 },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say } = ticketing({ provider, purchaseMode: "mock" });
    await say("space-a", "any games tonight?");
    const result = await say("space-a", "buy 2 tickets");
    expect(result.reply).toContain("start around $84 all-in");
    expect(result.reply).toContain("https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics");
    expect(result.reply).not.toMatch(/Want me to (buy|purchase|prepare)/);
  });
});

describe("space isolation", () => {
  it("keeps results, selection, and pending purchases per Photon space", async () => {
    const { say, service, provider } = ticketing();
    await say("space-a", "anything fun happening tonight?");
    const leaked = await say("space-b", "how much is the second one?");
    expect(leaked.handled).toBe(false);

    await say("space-a", "how much is the second one?");
    await say("space-a", "get two");
    const otherYes = await say("space-b", "yes");
    expect(otherYes.handled).toBe(false);
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
    expect(service.store.get("space-b").lastSearchResults).toEqual([]);
    expect(service.store.pending("space-b")).toBeUndefined();
    expect(service.store.pending("space-a")?.eventId).toBe("mock-brooklyn-steel");
  });
});
