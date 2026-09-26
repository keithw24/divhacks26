import { describe, expect, it } from "vitest";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { createRippleTestProvider } from "../../src/payments/ripple.js";
import { executeTicketPurchase } from "../../src/ticketing/execute.js";
import { createSharedTicketPayments } from "../../src/ticketing/payment.js";
import { ticketPurchaseIdempotencyKey } from "../../src/ticketing/provider-purchase.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { TicketmasterProvider } from "../../src/ticketing/providers/ticketmaster.js";
import { publicTicketPurchase } from "../../src/ticketing/service.js";
import { BOX_OFFICE, FakeLedger, NOW, TESTNET, TX_HASH, ticketing, ticketmasterFetch, TM_EVENT, testnetPayments } from "./support.js";

describe("end-to-end ticket purchase (A)", () => {
  it("discovery → quote → confirmation → purchase", async () => {
    const { say, service, provider, traces } = ticketing();
    const discovery = await say("space-a", "anything fun happening tonight?");
    expect(discovery.reply).toContain("Phoebe Bridgers");
    const price = await say("space-a", "How much is the second one?");
    expect(price.reply).toContain("$62");
    const quote = await say("space-a", "Get me two.");
    expect(quote.reply).toContain("$124 total");
    expect(quote.reply).toMatch(/Want me to purchase them/);
    expect(service.store.pending("space-a")?.status).toBe("AWAITING_CONFIRMATION");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
    const done = await say("space-a", "Yes, buy them.");
    expect(done.reply).toMatch(/Done — 2 demo tickets/);
    expect((provider as MockTicketProvider).purchases).toHaveLength(1);
    const record = service.store.purchasesFor("space-a").find((item) => item.status === "COMPLETED")!;
    expect(record).toMatchObject({
      eventId: "mock-brooklyn-steel",
      offerId: "mock-brooklyn-steel-offer-1",
      quantity: 2,
      total: 124,
      quoteId: record.id,
    });
    expect(record.confirmedAt).toBeTruthy();
    expect(Date.parse(record.confirmedAt!) >= Date.parse(record.quotedAt)).toBe(true);
    expect(traces.map((t) => t.event)).toEqual(
      expect.arrayContaining(["TICKET_DISCOVERED", "TICKET_QUOTED", "TICKET_PURCHASE_REQUESTED", "TICKET_PURCHASE_CONFIRMED", "TICKET_PURCHASED"]),
    );
  });
});

describe("purchase authorization safeguards (B, C, D, E, M)", () => {
  it("cannot purchase before confirmation (B)", async () => {
    const { say, provider, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "COMPLETED")).toBe(false);
  });

  it("confirmation must occur after the final price is shown (C)", async () => {
    const { say, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    const quote = await say("space-a", "get two");
    const pending = service.store.pending("space-a")!;
    expect(quote.reply).toContain(String(pending.total));
    expect(pending.status).toBe("AWAITING_CONFIRMATION");
    const done = await say("space-a", "yes");
    const completed = service.store.purchase(pending.id)!;
    expect(completed.confirmedAt).toBeTruthy();
    expect(Date.parse(completed.confirmedAt!) >= Date.parse(completed.quotedAt)).toBe(true);
    expect(done.reply).toContain("Order DEMO-");
  });

  it("duplicate yes does not double purchase (D)", async () => {
    const { say, provider } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "yes");
    const again = await say("space-a", "yes");
    expect(again.handled).toBe(false);
    expect((provider as MockTicketProvider).purchases).toHaveLength(1);
  });

  it("expired quote is rejected (E)", async () => {
    let now = NOW;
    const { say, provider } = ticketing({ now: () => now });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    now = new Date(NOW.getTime() + 11 * 60_000);
    const result = await say("space-a", "yes");
    expect(result.reply).toContain("quote expired");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("second user cannot confirm first user's quote (M)", async () => {
    const { say, provider, service } = ticketing();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const pending = service.store.pending("space-a")!;
    const other = await executeTicketPurchase(
      { spaceId: "space-a", userId: "bob", quoteId: pending.id },
      {
        store: service.store,
        provider: service.provider,
        executor: service.executor,
        now: () => NOW,
      },
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe("wrong_user");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });
});

describe("price and availability (F, G)", () => {
  it("price increase requires new confirmation (F)", async () => {
    const provider = new MockTicketProvider({ now: () => NOW });
    const { say, service } = ticketing({ provider });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const original = provider.getOffers.bind(provider);
    provider.getOffers = async (event) => (await original(event)).map((item) => ({ ...item, allInUnitPrice: (item.allInUnitPrice ?? 0) + 5 }));
    const result = await say("space-a", "yes");
    expect(result.reply).toContain("The price changed from $168 to $178");
    expect(result.reply).toContain("Want me to continue at the new price?");
    expect(provider.purchases).toHaveLength(0);
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "PRICE_CHANGED")).toBe(true);
    expect(service.store.pending("space-a")?.total).toBe(178);
    // New confirmation at the new price is required.
    const again = await say("space-a", "yes");
    expect(again.reply).toMatch(/Done|Order DEMO-/);
    expect(provider.purchases).toHaveLength(1);
  });

  it("sold-out ticket causes no payment (G)", async () => {
    const provider = new MockTicketProvider({ now: () => NOW });
    const ledger = new FakeLedger();
    const { say, service } = ticketing({ provider, payments: testnetPayments(ledger) });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    provider.getOffers = async () => [];
    const result = await say("space-a", "yes");
    expect(result.reply).toBe("Those tickets are no longer available, so I didn't charge you.");
    expect(ledger.submitted).toHaveLength(0);
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "SOLD_OUT")).toBe(true);
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "COMPLETED")).toBe(false);
  });
});

describe("XRPL settlement evidence (H, J, K, L)", () => {
  it("failed payment causes no PURCHASED state (H)", async () => {
    const ledger = new FakeLedger({ hash: "B".repeat(64), engineResult: "tecUNFUNDED_PAYMENT" });
    const { say, service, provider } = ticketing({ payments: testnetPayments(ledger) });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "yes");
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "COMPLETED")).toBe(false);
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("validated XRPL transaction produces PURCHASED (J)", async () => {
    const ledger = new FakeLedger();
    const { say, service } = ticketing({ payments: testnetPayments(ledger) });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const done = await say("space-a", "yes");
    expect(done.reply).toContain("Payment: validated on XRPL Testnet");
    const record = service.store.purchasesFor("space-a").find((r) => r.status === "COMPLETED")!;
    expect(record.settlement?.independentlyVerified).toBe(true);
    expect(record.paymentTransactionId).toBe(TX_HASH);
    expect(ledger.submitted[0]?.idempotencyKey).toBe(ticketPurchaseIdempotencyKey("space-a", record.quoteId));
  });

  it("submitted-but-unvalidated XRPL transaction does NOT produce PURCHASED (K)", async () => {
    const payments = createSharedTicketPayments({
      provider: createRippleTestProvider({
        serverUrl: TESTNET,
        seed: "sEdTestSeed",
        xrpPerUsd: 1,
        session: new FakeLedger({ hash: TX_HASH, engineResult: "tesSUCCESS" }),
      }),
      mode: "ripple_test",
      merchants: createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Demo Box Office": BOX_OFFICE }) }),
      merchantName: "Demo Box Office",
      xrpPerUsd: 1,
      maxUsd: 500,
      timeoutMs: 5_000,
      verifyLedger: async () => ({
        hash: TX_HASH,
        validated: false,
        engineResult: "tesSUCCESS",
        amountDrops: "168000000",
        destination: BOX_OFFICE,
      }),
    });
    const { say, service, provider } = ticketing({ payments });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    const result = await say("space-a", "yes");
    expect(result.reply).toContain("haven't marked the tickets as purchased");
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "COMPLETED")).toBe(false);
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("wrong XRPL amount fails verification (L)", async () => {
    const payments = createSharedTicketPayments({
      provider: createRippleTestProvider({
        serverUrl: TESTNET,
        seed: "sEdTestSeed",
        xrpPerUsd: 1,
        session: new FakeLedger({ hash: TX_HASH, engineResult: "tesSUCCESS" }),
      }),
      mode: "ripple_test",
      merchants: createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Demo Box Office": BOX_OFFICE }) }),
      merchantName: "Demo Box Office",
      xrpPerUsd: 1,
      maxUsd: 500,
      timeoutMs: 5_000,
      verifyLedger: async () => ({
        hash: TX_HASH,
        validated: true,
        engineResult: "tesSUCCESS",
        amountDrops: "999000000",
        destination: BOX_OFFICE,
      }),
    });
    const { say, service, provider } = ticketing({ payments });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "yes");
    expect(service.store.purchasesFor("space-a").some((r) => r.status === "COMPLETED")).toBe(false);
    expect(service.store.purchasesFor("space-a").find((r) => r.status === "FAILED")?.failureReason).toBe("amount_mismatch");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("wrong XRPL destination fails verification (L)", async () => {
    const payments = createSharedTicketPayments({
      provider: createRippleTestProvider({
        serverUrl: TESTNET,
        seed: "sEdTestSeed",
        xrpPerUsd: 1,
        session: new FakeLedger({ hash: TX_HASH, engineResult: "tesSUCCESS" }),
      }),
      mode: "ripple_test",
      merchants: createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Demo Box Office": BOX_OFFICE }) }),
      merchantName: "Demo Box Office",
      xrpPerUsd: 1,
      maxUsd: 500,
      timeoutMs: 5_000,
      verifyLedger: async () => ({
        hash: TX_HASH,
        validated: true,
        engineResult: "tesSUCCESS",
        amountDrops: "168000000",
        destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyjzbpAYe",
      }),
    });
    const { say, service } = ticketing({ payments });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "yes");
    expect(service.store.purchasesFor("space-a").find((r) => r.status === "FAILED")?.failureReason).toBe("destination_mismatch");
  });
});

describe("checkout vs purchased (I) and provider identity (N, O)", () => {
  it("CHECKOUT_REQUIRED is not presented as PURCHASED (I)", async () => {
    const commerce = {
      offers: [{ id: "000000000001", attributes: { name: "Standard", currency: "USD", prices: [{ priceZone: "1", value: "92.00", total: "108.00" }] } }],
    };
    const { fetcher } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
      "/commerce/v2/": { status: 200, body: commerce },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say, service } = ticketing({ provider, purchaseMode: "link" });
    await say("space-a", "any games tonight?");
    await say("space-a", "get 2");
    const done = await say("space-a", "yes");
    expect(done.reply).toContain("I prepared the checkout");
    expect(done.reply).not.toMatch(/Booked|Payment: validated|purchased/i);
    const record = service.store.purchasesFor("space-a").find((r) => r.status === "CHECKOUT_REQUIRED")!;
    const pub = publicTicketPurchase(record);
    expect(pub.purchased).toBe(false);
    expect(pub.status).toBe("CHECKOUT_REQUIRED");
    expect(pub.checkoutUrl).toBe("https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics");
  });

  it("provider IDs survive from discovery through purchase (N)", async () => {
    const commerce = {
      offers: [{ id: "000000000001", attributes: { name: "Standard", currency: "USD", prices: [{ priceZone: "1", value: "92.00", total: "108.00" }] } }],
    };
    const { fetcher } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
      "/commerce/v2/": { status: 200, body: commerce },
      "/discovery/v2/events/": { status: 200, body: TM_EVENT },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", fetcher, now: () => NOW });
    const { say, service } = ticketing({ provider, purchaseMode: "mock", payments: testnetPayments(new FakeLedger()) });
    await say("space-a", "any games tonight?");
    await say("space-a", "get 2");
    await say("space-a", "yes");
    const record = service.store.purchasesFor("space-a").find((r) => r.status === "COMPLETED")!;
    expect(record.eventId).toBe("vvG1zZ9KnicksCeltics");
    expect(record.provider).toBe("ticketmaster");
    expect(record.offerId).toBe("000000000001:1");
    expect(record.checkoutUrl).toBe("https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics");
  });

  it("confirmation record contains real evidence (O)", async () => {
    const { say, service } = ticketing({ payments: testnetPayments(new FakeLedger()) });
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get two");
    await say("space-a", "yes");
    const record = service.store.purchasesFor("space-a").find((r) => r.status === "COMPLETED")!;
    const types = record.evidence.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["TICKET_QUOTED", "TICKET_PURCHASE_CONFIRMED", "TICKET_PAYMENT_VALIDATED", "TICKET_PURCHASED"]),
    );
    expect(record.evidence.find((e) => e.type === "TICKET_QUOTED")?.details).toMatchObject({
      eventId: "mock-knicks-celtics",
      quantity: 2,
      total: 168,
    });
    expect(record.settlement?.transactionHash).toBe(TX_HASH);
    expect(record.confirmationNumber).toMatch(/^DEMO-/);
  });
});
