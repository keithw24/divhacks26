/**
 * Safe end-to-end ticketing demo transcript.
 *   npx tsx scripts/ticket-purchase-demo.ts
 * Never spends real money. XRPL path uses an injected Testnet ledger stub.
 */
import "dotenv/config";
import { createMerchantDirectory } from "../src/payments/merchants.js";
import { createRippleTestProvider, XRPL_TESTNET_NETWORK_ID, type SubmittedPayment, type XrplSession } from "../src/payments/ripple.js";
import { createSharedTicketPayments } from "../src/ticketing/payment.js";
import { MockTicketProvider } from "../src/ticketing/providers/mock.js";
import { TicketmasterProvider } from "../src/ticketing/providers/ticketmaster.js";
import { TicketingService } from "../src/ticketing/service.js";

const NOW = new Date("2026-09-24T12:00:00-04:00");
const BOX = "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2";
const TX = "A".repeat(63) + "1";

class FakeLedger implements XrplSession {
  networkId = XRPL_TESTNET_NETWORK_ID;
  submitted: unknown[] = [];
  async submitPayment(input: { destination: string; drops: string; idempotencyKey: string }): Promise<SubmittedPayment> {
    this.submitted.push(input);
    return { hash: TX, engineResult: "tesSUCCESS" };
  }
  async findPayment(): Promise<SubmittedPayment | undefined> {
    return undefined;
  }
  async close(): Promise<void> {}
}

async function run(label: string, service: TicketingService): Promise<void> {
  console.log(`\n========== ${label} ==========\n`);
  let n = 0;
  const say = async (text: string) => {
    n += 1;
    const base = { spaceId: "demo", senderId: "alice", senderName: "Alice", text, messageId: `d-${n}` };
    let r = await service.handleTurn({ ...base, phase: "priority" });
    if (!r.handled) r = await service.handleTurn({ ...base, phase: "fallback" });
    console.log(`User: ${text}`);
    console.log(`Agent: ${r.reply ?? "(unhandled)"}`);
    console.log("");
  };
  await say("Anything cool happening tonight?");
  await say("How much is the second one?");
  await say("Get me two.");
  await say("Yes.");
  console.log("--- purchase records ---");
  for (const p of service.store.purchasesFor("demo")) {
    console.log(
      JSON.stringify(
        {
          status: p.status,
          eventId: p.eventId,
          eventName: p.eventName,
          quantity: p.quantity,
          total: p.total,
          currency: p.currency,
          checkoutUrl: p.checkoutUrl,
          orderId: p.orderId,
          isDemo: p.isDemo,
          xrpl: p.settlement?.transactionHash,
          purchased: p.status === "COMPLETED",
        },
        null,
        2,
      ),
    );
  }
}

const ledger = new FakeLedger();
const payments = createSharedTicketPayments({
  provider: createRippleTestProvider({
    serverUrl: "wss://s.altnet.rippletest.net:51233",
    seed: "sEdTestSeed",
    xrpPerUsd: 1,
    session: ledger,
  }),
  mode: "ripple_test",
  merchants: createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Demo Box Office": BOX }) }),
  merchantName: "Demo Box Office",
  xrpPerUsd: 1,
  maxUsd: 500,
  timeoutMs: 5_000,
});

await run(
  "XRPL Testnet autonomous demo (mock inventory + validated Testnet settlement)",
  new TicketingService({
    provider: new MockTicketProvider({ now: () => NOW, timeZone: "America/New_York" }),
    purchaseMode: "mock",
    payments,
    merchantName: "Demo Box Office",
    now: () => NOW,
    timeZone: "America/New_York",
  }),
);

const key = process.env.TICKETMASTER_API_KEY;
if (key) {
  await run(
    "Ticketmaster Discovery live (checkout redirect — no API purchase)",
    new TicketingService({
      provider: new TicketmasterProvider({ apiKey: key, now: () => new Date() }),
      purchaseMode: "link",
      now: () => new Date(),
      timeZone: "America/New_York",
      defaultCity: "New York",
    }),
  );
} else {
  console.log("\n(No TICKETMASTER_API_KEY — showing Ticketmaster checkout path with provider-shaped fixtures)\n");
  const event = {
    id: "vvG1zZ9Demo",
    name: "Demo Band Live",
    url: "https://www.ticketmaster.com/event/vvG1zZ9Demo",
    dates: {
      start: { localDate: "2026-09-24", localTime: "20:00:00", dateTime: "2026-09-25T00:00:00Z" },
      timezone: "America/New_York",
    },
    classifications: [{ segment: { name: "Music" }, genre: { name: "Rock" } }],
    priceRanges: [{ type: "standard including fees", currency: "USD", min: 45, max: 120 }],
    _embedded: {
      venues: [
        {
          name: "Terminal 5",
          city: { name: "New York" },
          state: { stateCode: "NY" },
          country: { countryCode: "US" },
          location: { latitude: "40.7707", longitude: "-73.9926" },
        },
      ],
      attractions: [{ name: "Demo Band" }],
    },
  };
  const commerce = {
    offers: [{ id: "offer1", attributes: { name: "GA", currency: "USD", prices: [{ priceZone: "1", value: "42.25", total: "54.75" }] } }],
  };
  const fetcher = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path.includes("/offers")) return new Response(JSON.stringify(commerce), { status: 200 });
    if (path.includes("/events.json")) return new Response(JSON.stringify({ _embedded: { events: [event] } }), { status: 200 });
    if (path.includes("/events/")) return new Response(JSON.stringify(event), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  await run(
    "Ticketmaster checkout path (provider shape → CHECKOUT_REQUIRED, not purchased)",
    new TicketingService({
      provider: new TicketmasterProvider({ apiKey: "demo", fetcher, now: () => NOW }),
      purchaseMode: "link",
      now: () => NOW,
      timeZone: "America/New_York",
    }),
  );
}
