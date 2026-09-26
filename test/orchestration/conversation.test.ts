import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationContextStore } from "../../src/orchestration/context.js";
import { CrossDomainOrchestrator } from "../../src/orchestration/orchestrator.js";
import { createMemoryStateStore } from "../../src/store/state.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import {
  BOX_OFFICE,
  conversation,
  depositSends,
  fakeRestaurants,
  MERCHANT,
  NOW,
  SPACE,
} from "./support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cross-domain orchestration", () => {
  it("1. happy path: tickets → XRPL demo settle → dinner near venue → deposit → directions", async () => {
    const session = conversation();
    const { say, ticketLedger, depositProvider, bistro, routeCalls, context, ticketing, reservations } = session;

    const search = await say("Find something fun tonight");
    expect(search.outcome).toBe("ticketing");
    expect(search.reply).toMatch(/Phoebe Bridgers/);
    expect(search.reply).toMatch(/Brooklyn Steel/);

    const price = await say("How much is the second one?");
    expect(price.reply).toBe("Tickets for Phoebe Bridgers currently start at $62 all-in. I found options at $62 and $75.");
    expect(context.peek(SPACE)?.event?.name).toBe("Phoebe Bridgers");

    const quote = await say("Get us two under $120 each");
    expect(quote.reply).toContain("I found 2 tickets for Phoebe Bridgers at $62 each");
    expect(quote.reply).toContain("Want me to purchase them?");
    expect(quote.reply).toContain("Demo checkout");
    expect(ticketLedger.submitted).toHaveLength(0);
    expect(ticketing.store.pending(SPACE)?.status).toBe("AWAITING_CONFIRMATION");

    const buy = await say("yes");
    expect(buy.outcome).toBe("ticketing");
    expect(buy.reply).toContain("Booked — 2 tickets to Phoebe Bridgers for $124 total.");
    expect(buy.reply).toContain("Payment: validated on XRPL Testnet");
    expect(buy.reply).toContain("Demo settlement only");
    expect(ticketLedger.submitted).toEqual([
      expect.objectContaining({ destination: BOX_OFFICE, drops: "124000000" }),
    ]);
    expect(ticketing.store.purchasesFor(SPACE).some((row) => row.status === "COMPLETED")).toBe(true);

    const dinner = await say("Find dinner nearby beforehand");
    expect(dinner.outcome).toBe("orchestration");
    expect(dinner.reply).toContain("Dinner near Brooklyn Steel before Phoebe Bridgers (8pm)");
    expect(dinner.reply).toContain("1. Ripple Bistro");
    expect(dinner.reply).toContain('Say "book the first one"');
    expect(dinner.reply).toMatch(/around 6pm/);
    expect(context.peek(SPACE)?.dining?.partySize).toBe(2);
    expect(depositSends(depositProvider)).toBe(0);

    const book = await say("Book the first one");
    expect(book.outcome).toBe("reservation");
    expect(book.reply).toBe(
      "Ripple Bistro has a 6:00 PM table for 2 tonight. They require a $50 deposit ($25/person). Want me to pay the $50 deposit and book it?",
    );
    expect(reservations.reservations.active(SPACE)?.status).toBe("AWAITING_DEPOSIT");
    expect(depositSends(depositProvider)).toBe(0);
    expect(bistro.confirmations).toHaveLength(0);

    const deposit = await say("yes");
    expect(deposit.outcome).toBe("reservation");
    expect(deposit.reply).toMatch(/^Booked Ripple Bistro for 2 tonight at 6:00 PM/);
    expect(deposit.reply).toMatch(/\$50 deposit was paid successfully on XRPL Testnet/);
    expect(depositSends(depositProvider)).toBe(1);
    expect(depositProvider.sendPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destination: MERCHANT, amountUsd: 50 }),
    );
    expect(bistro.confirmations).toHaveLength(1);
    expect(reservations.reservations.active(SPACE)?.status).toBe("BOOKED");

    const directions = await say("How do we get from dinner to the concert?");
    expect(directions.outcome).toBe("transport");
    expect(directions.reply).toMatch(/28 min|L\b|Bedford/);
    expect(routeCalls.some((call) => call.origin === "Ripple Bistro" && call.destination === "Brooklyn Steel")).toBe(
      true,
    );

    const status = await say("Did that go through?");
    expect(status.outcome).toBe("orchestration");
    expect(status.reply).toMatch(/\$50|deposit|Ripple Bistro|XRPL Testnet/i);
  });

  it("2. reference resolution: the second one, the first restaurant, dinner → concert", async () => {
    const { say, context, routeCalls } = conversation();
    await say("Find something fun tonight");
    expect((await say("How much is the second one?")).reply).toContain("Phoebe Bridgers");
    await say("Get us two under $120 each");
    await say("yes");
    await say("Find dinner nearby beforehand");
    const book = await say("Book the first one");
    expect(book.reply).toContain("Ripple Bistro");
    expect(context.peek(SPACE)?.restaurant?.name).toBe("Ripple Bistro");
    await say("yes");
    const directions = await say("How do we get from dinner to the concert?");
    expect(directions.outcome).toBe("transport");
    expect(routeCalls[0]?.origin).toBe("Ripple Bistro");
    expect(routeCalls[0]?.destination).toBe("Brooklyn Steel");
  });

  it("3. payment ambiguity: yes with tickets and a deposit pending asks which, and pays nothing", async () => {
    const { say, ticketLedger, depositProvider, ticketing, reservations, bistro } = conversation();
    await say("Find something fun tonight");
    await say("How much is the second one?");
    await say("Get us two under $120 each");
    expect(ticketing.store.pending(SPACE)?.status).toBe("AWAITING_CONFIRMATION");

    const depositAsk = await say("Book Ripple Bistro for 2 tonight at 6.");
    expect(depositAsk.outcome).toBe("reservation");
    expect(depositAsk.reply).toMatch(/Want me to pay the \$50 deposit/);
    expect(reservations.reservations.active(SPACE)?.status).toBe("AWAITING_DEPOSIT");

    const ambiguous = await say("yes");
    expect(ambiguous.outcome).toBe("orchestration");
    expect(ambiguous.reply).toMatch(/2 things waiting/);
    expect(ambiguous.reply).toMatch(/tickets for Phoebe Bridgers/);
    expect(ambiguous.reply).toMatch(/\$50 deposit/);
    expect(ambiguous.reply).toContain("I haven't done anything yet");
    expect(ticketLedger.submitted).toHaveLength(0);
    expect(depositSends(depositProvider)).toBe(0);
    expect(bistro.confirmations).toHaveLength(0);

    const tickets = await say("the tickets");
    expect(tickets.outcome).toBe("ticketing");
    expect(tickets.reply).toContain("XRPL Testnet");
    expect(ticketLedger.submitted).toHaveLength(1);
    expect(depositSends(depositProvider)).toBe(0);

    const deposit = await say("yes");
    expect(deposit.outcome).toBe("reservation");
    expect(deposit.reply).toMatch(/Booked Ripple Bistro/);
    expect(depositSends(depositProvider)).toBe(1);
  });

  it("4. no pending payment: bare yes does not pay", async () => {
    const { say, ticketLedger, depositProvider } = conversation();
    await say("Find something fun tonight");
    const yes = await say("yes");
    expect(yes.reply).not.toMatch(/Paid|deposit|Booked|XRPL/i);
    expect(ticketLedger.submitted).toHaveLength(0);
    expect(depositSends(depositProvider)).toBe(0);
  });

  it("5. quote change: yes re-quotes instead of buying, and the ledger stays quiet", async () => {
    const provider = new MockTicketProvider({ now: () => NOW, timeZone: "America/New_York" });
    const { say, ticketLedger, ticketing } = conversation({ ticketProvider: provider });
    await say("Find something fun tonight");
    await say("How much is the second one?");
    await say("Get us two under $120 each");
    const original = provider.getOffers.bind(provider);
    provider.getOffers = async (event) =>
      (await original(event)).map((item) => ({ ...item, allInUnitPrice: (item.allInUnitPrice ?? 0) + 5 }));

    const requote = await say("yes");
    expect(requote.reply).toContain("The price changed from $124 to $134");
    expect(requote.reply).toContain("Want me to continue at the new price?");
    expect(provider.purchases).toHaveLength(0);
    expect(ticketLedger.submitted).toHaveLength(0);
    expect(ticketing.store.pending(SPACE)?.total).toBe(134);
  });

  it("6. missing event location: dinner search asks instead of inventing a place", async () => {
    const restaurants = fakeRestaurants();
    const { say, context, orchestration } = conversation({ restaurants });
    context.update(SPACE, (draft) => {
      draft.event = {
        eventId: "mystery-show",
        provider: "mock",
        name: "Mystery Show",
        venue: "Somewhere Hall",
        focusedAt: NOW.getTime(),
        startTime: new Date("2026-09-24T20:00:00-04:00").toISOString(),
        localDate: "2026-09-24",
        localTime: "20:00:00",
        timeZone: "America/New_York",
      };
    });

    const dinner = await say("Find dinner nearby beforehand");
    expect(dinner.outcome).toBe("orchestration");
    expect(dinner.reply).toContain("I don't have a location for Mystery Show at Somewhere Hall");
    expect(dinner.reply).toContain("Which neighborhood or address");
    expect(restaurants.calls).toHaveLength(0);
    expect(orchestration).toBeInstanceOf(CrossDomainOrchestrator);
  });

  it("7. missing restaurant selection: book the first one does not invent a restaurant", async () => {
    const { say, reservations, depositProvider } = conversation();
    await say("Find something fun tonight");
    await say("How much is the second one?");
    const book = await say("Book the first one");
    expect(reservations.reservations.active(SPACE)).toBeUndefined();
    expect(depositSends(depositProvider)).toBe(0);
    expect(book.reply).not.toMatch(/Ripple Bistro|deposit/i);
  });

  it("8. provider failure: Places unavailable is reported honestly", async () => {
    const restaurants = fakeRestaurants({ status: "unavailable", reason: "quota" });
    const { say, ticketLedger } = conversation({ restaurants });
    await say("Find something fun tonight");
    await say("How much is the second one?");
    await say("Get us two under $120 each");
    await say("yes");
    expect(ticketLedger.submitted).toHaveLength(1);

    const dinner = await say("Find dinner nearby beforehand");
    expect(dinner.outcome).toBe("orchestration");
    expect(dinner.reply).toContain("I couldn't reach Google Places right now");
    expect(dinner.reply).toContain("Brooklyn Steel");
    expect(dinner.reply).not.toMatch(/Ripple Bistro|1\./);
  });

  it("9. restart: orchestration and reservation books restore from agent state", async () => {
    const agent = createMemoryStateStore();
    const first = conversation({ agent });
    await first.say("Find something fun tonight");
    await first.say("How much is the second one?");
    await first.say("Get us two under $120 each");
    await first.say("yes");
    await first.say("Find dinner nearby beforehand");
    await first.say("Book the first one");
    await first.say("yes");

    const snapshot = agent.getState();
    expect(snapshot.orchestration?.[SPACE]).toMatchObject({
      spaceId: SPACE,
      event: expect.objectContaining({ name: "Phoebe Bridgers", venue: "Brooklyn Steel" }),
      restaurant: expect.objectContaining({ name: "Ripple Bistro" }),
    });
    expect(Object.keys(snapshot.reservations.records).length).toBeGreaterThan(0);

    const restoredAgent = createMemoryStateStore(snapshot);
    const context = ConversationContextStore.open(restoredAgent);
    expect(context.peek(SPACE)?.event?.name).toBe("Phoebe Bridgers");
    expect(context.peek(SPACE)?.restaurant?.name).toBe("Ripple Bistro");

    const second = conversation({ agent: restoredAgent });
    const status = await second.say("Did the deposit go through?");
    expect(status.reply).toMatch(/\$50|deposit|Ripple Bistro|paid/i);
  });
});

describe("orchestration safety edges", () => {
  it("directions without a restaurant ask instead of geocoding the word dinner", async () => {
    const { say, routeCalls } = conversation();
    await say("Find something fun tonight");
    await say("How much is the second one?");
    const directions = await say("How do we get from dinner to the concert?");
    expect(directions.outcome).toBe("orchestration");
    expect(directions.reply).toContain("Which restaurant are you going from?");
    expect(directions.reply).toContain("won't guess");
    expect(routeCalls).toHaveLength(0);
  });

  it("expired ticket quote is not a pending action a yes can bind to", async () => {
    const clock = { now: new Date(NOW.getTime()) };
    const { say, ticketLedger, ticketing } = conversation({ clock });
    await say("Find something fun tonight");
    await say("How much is the second one?");
    await say("Get us two under $120 each");
    clock.now = new Date(NOW.getTime() + 11 * 60_000);
    const yes = await say("yes");
    expect(ticketLedger.submitted).toHaveLength(0);
    expect(ticketing.store.purchasesFor(SPACE).some((row) => row.status === "COMPLETED")).toBe(false);
    expect(yes.reply).toMatch(/expired|didn't buy|gemini-fallback|Want me to check/i);
  });
});
