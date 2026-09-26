import { describe, expect, it } from "vitest";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { createSharedTicketPayments } from "../../src/ticketing/payment.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { TicketmasterProvider } from "../../src/ticketing/providers/ticketmaster.js";
import { BOX_OFFICE, FakeLedger, NOW, testnetPayments, ticketing, ticketmasterFetch, TM_EVENT, TX_HASH } from "./support.js";

async function buyKnicks(options: Parameters<typeof ticketing>[0]) {
  const session = ticketing(options);
  await session.say("space-a", "how much are Knicks tickets?");
  await session.say("space-a", "Get me 2 under $120 each");
  const reply = await session.say("space-a", "yes");
  return { ...session, reply };
}

describe("XRPL Testnet ticket payments", () => {
  it("settles through the shared XRPL provider and attaches the validated tx hash", async () => {
    const ledger = new FakeLedger();
    const { reply, service, traces, provider } = await buyKnicks({ payments: testnetPayments(ledger) });

    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.submitted[0]).toMatchObject({ destination: BOX_OFFICE, drops: "168000000" });
    const record = service.store.purchasesFor("space-a").find((item) => item.status === "COMPLETED")!;
    expect(record).toMatchObject({
      spaceId: "space-a",
      eventId: "mock-knicks-celtics",
      offerId: "mock-knicks-celtics-offer-1",
      quantity: 2,
      total: 168,
      paymentNetwork: "xrpl-testnet",
      isTestTransaction: true,
      paymentTransactionId: TX_HASH,
      isDemo: true,
      ticketTotal: { amount: 168, currency: "USD" },
      settlement: {
        network: "xrpl-testnet",
        asset: "XRP",
        amount: "168",
        exchangeRate: "1",
        rateSource: "configured_demo_peg",
        isTestTransaction: true,
        transactionHash: TX_HASH,
        ledgerResult: "tesSUCCESS",
      },
    });
    expect(record.orderId).toMatch(/^DEMO-/);
    expect((provider as MockTicketProvider).purchases).toHaveLength(1);
    expect(reply.reply).toContain("Paid 168 XRP on XRPL Testnet for 2 demo tickets to New York Knicks vs. Boston Celtics ($168 ticket total).");
    expect(reply.reply).toContain(`Transaction: ${TX_HASH}`);
    expect(reply.reply).toContain(`https://testnet.xrpl.org/transactions/${TX_HASH}`);

    const events = traces.map((trace) => trace.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "ticket.price_lookup",
        "ticket.offer_selected",
        "ticket.purchase_requested",
        "ticket.purchase_confirmed",
        "ticket.payment_started",
        "ticket.payment_validated",
        "ticket.purchase_completed",
      ]),
    );
    expect(traces.find((trace) => trace.event === "ticket.purchase_completed")?.fields).toMatchObject({
      spaceId: "space-a",
      paymentNetwork: "xrpl-testnet",
      ledger: "testnet",
      isTestTransaction: true,
      transactionHash: TX_HASH,
    });
    expect(events.indexOf("ticket.payment_validated")).toBeLessThan(events.indexOf("ticket.purchase_completed"));
  });

  it("does not mark tickets purchased when the XRPL transaction fails", async () => {
    const ledger = new FakeLedger({ hash: "B".repeat(64), engineResult: "tecUNFUNDED_PAYMENT" });
    const { reply, service, provider, traces } = await buyKnicks({ payments: testnetPayments(ledger) });
    expect(reply.reply).toBe("The XRPL Testnet payment didn't go through, so I didn't buy the tickets.");
    const records = service.store.purchasesFor("space-a");
    expect(records.some((record) => record.status === "COMPLETED")).toBe(false);
    const failed = records.find((record) => record.status === "FAILED")!;
    expect(failed.orderId).toBeUndefined();
    expect(failed.paymentTransactionId).toBeUndefined();
    expect(failed.failureReason).toBe("tecUNFUNDED_PAYMENT");
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
    expect(traces.map((trace) => trace.event)).not.toContain("ticket.purchase_completed");
  });

  it("does not mark tickets purchased when the payment result is unknown", async () => {
    const ledger = new FakeLedger("throw");
    const { reply, service, provider } = await buyKnicks({ payments: testnetPayments(ledger) });
    expect(reply.reply).toContain("I couldn't confirm the XRPL Testnet payment, so I haven't marked the tickets as purchased.");
    expect(service.store.purchasesFor("space-a").some((record) => record.status === "COMPLETED")).toBe(false);
    expect((provider as MockTicketProvider).purchases).toHaveLength(0);
  });

  it("refuses without a configured Testnet merchant address instead of inventing one", async () => {
    const ledger = new FakeLedger();
    const { reply } = await buyKnicks({ payments: testnetPayments(ledger, { merchants: false }) });
    expect(reply.reply).toContain("I don't have a payment destination set up");
    expect(ledger.submitted).toHaveLength(0);
  });

  it("respects the shared payment limit", async () => {
    const ledger = new FakeLedger();
    const { reply } = await buyKnicks({ payments: testnetPayments(ledger, { maxUsd: 100 }) });
    expect(reply.reply).toBe("That's over the payment limit, so I didn't buy the tickets.");
    expect(ledger.submitted).toHaveLength(0);
  });
});

describe("test settlement is never real-world settlement", () => {
  it("labels Testnet-paid tickets as a demo and a test transaction", async () => {
    const { reply, service } = await buyKnicks({ payments: testnetPayments(new FakeLedger()) });
    expect(reply.reply).toContain("This was a test transaction, not a real ticket purchase.");
    expect(reply.reply).not.toMatch(/tickets? .* purchased for/);
    const record = service.store.purchasesFor("space-a").find((item) => item.status === "COMPLETED")!;
    expect(record.isDemo).toBe(true);
    expect(record.settlement?.isTestTransaction).toBe(true);
  });

  it("mock payments say no money moved", async () => {
    const payments = createSharedTicketPayments({
      provider: new MockPaymentProvider(),
      mode: "mock",
      merchants: createMerchantDirectory({ mode: "mock" }),
      merchantName: "Demo Box Office",
      xrpPerUsd: 1,
      maxUsd: 500,
      timeoutMs: 1_000,
    });
    const { reply, service } = await buyKnicks({ payments });
    expect(reply.reply).toContain("Demo payment only: no money moved and no real tickets were issued.");
    expect(service.store.purchasesFor("space-a").find((item) => item.status === "COMPLETED")?.paymentNetwork).toBe("mock");
  });

  it("a demo checkout of a real Ticketmaster event never calls Ticketmaster's purchase API", async () => {
    const commerce = {
      offers: [{ id: "000000000001", attributes: { name: "Standard", currency: "USD", prices: [{ priceZone: "1", value: "92.00", total: "108.00" }] } }],
    };
    const { fetcher, calls } = ticketmasterFetch({
      "/discovery/v2/events.json": { status: 200, body: { _embedded: { events: [TM_EVENT] } } },
      "/commerce/v2/": { status: 200, body: commerce },
    });
    const provider = new TicketmasterProvider({ apiKey: "k", partnerApiKey: "partner-key", fetcher, now: () => NOW });
    const { say, service } = ticketing({ provider, purchaseMode: "mock", payments: testnetPayments(new FakeLedger()) });
    await say("space-a", "any games tonight?");
    await say("space-a", "get 2");
    const done = await say("space-a", "yes");
    expect(done.reply).toContain("demo tickets");
    expect(done.reply).toContain("not a real ticket purchase");
    expect(calls.some((url) => url.includes("/cart"))).toBe(false);
    expect(service.store.purchasesFor("space-a").find((item) => item.status === "COMPLETED")?.isDemo).toBe(true);
  });

  it("never converts a non-USD ticket price silently", async () => {
    const payments = testnetPayments(new FakeLedger());
    const result = await payments.pay({
      purpose: "event_ticket",
      amount: 90,
      currency: "EUR",
      eventId: "e",
      spaceId: "s",
      initiatorId: "alice",
      idempotencyKey: "ticket:x",
      metadata: {},
    });
    expect(result).toEqual({ status: "failed", reason: "unsupported_currency" });
  });
});
