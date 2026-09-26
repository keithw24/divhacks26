import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { createRippleTestProvider, XRPL_TESTNET_NETWORK_ID, type SubmittedPayment, type XrplSession } from "../../src/payments/ripple.js";
import type { GeoPoint } from "../../src/ticketing/discovery.js";
import type { TicketTraceEvent, TicketTraceFields } from "../../src/ticketing/log.js";
import { createSharedTicketPayments, type TicketPaymentPort } from "../../src/ticketing/payment.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { TicketingService, type TicketingTurnResult } from "../../src/ticketing/service.js";
import type { TicketEvent, TicketProvider, TicketPurchaseMode } from "../../src/ticketing/types.js";

/** Thursday noon in New York. Tonight: Knicks 7:30, Brooklyn Steel 8, Comedy Cellar 9. */
export const NOW = new Date("2026-09-24T12:00:00-04:00");
export const TESTNET = "wss://s.altnet.rippletest.net:51233";
export const BOX_OFFICE = "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2";
export const TX_HASH = "A".repeat(63) + "1";

export function ticketing(options?: {
  provider?: TicketProvider;
  purchaseMode?: TicketPurchaseMode;
  payments?: TicketPaymentPort;
  resolvePlace?: (query: string) => Promise<GeoPoint | undefined>;
  now?: () => Date;
  onEventSelected?: (spaceId: string, event: TicketEvent) => void;
}) {
  const now = options?.now ?? (() => NOW);
  const provider = options?.provider ?? new MockTicketProvider({ now, timeZone: "America/New_York" });
  const traces: { event: TicketTraceEvent; fields: TicketTraceFields }[] = [];
  const focused: { spaceId: string; event: TicketEvent }[] = [];
  const service = new TicketingService({
    provider,
    purchaseMode: options?.purchaseMode ?? "mock",
    payments: options?.payments,
    merchantName: "Demo Box Office",
    now,
    timeZone: "America/New_York",
    resolvePlace: options?.resolvePlace,
    trace: (event, fields) => traces.push({ event, fields }),
    onEventSelected: (spaceId, event) => {
      focused.push({ spaceId, event });
      options?.onEventSelected?.(spaceId, event);
    },
  });
  let counter = 0;
  /** Same order as the turn router: priority pass, then (after reservations/payments) the fallback pass. */
  async function say(
    spaceId: string,
    text: string,
    options?: { senderId?: string; location?: GeoPoint },
  ): Promise<TicketingTurnResult> {
    counter += 1;
    const base = {
      spaceId,
      senderId: options?.senderId ?? "alice",
      senderName: options?.senderId && options.senderId !== "alice" ? options.senderId : "Alice",
      text,
      messageId: `msg-${counter}`,
      location: options?.location,
    };
    const first = await service.handleTurn({ ...base, phase: "priority" });
    if (first.handled) return first;
    return service.handleTurn({ ...base, phase: "fallback" });
  }
  return { service, provider, traces, focused, say };
}

export class FakeLedger implements XrplSession {
  networkId: number | undefined = XRPL_TESTNET_NETWORK_ID;
  readonly submitted: { destination: string; drops: string; idempotencyKey: string }[] = [];
  constructor(private readonly result: SubmittedPayment | "throw" = { hash: TX_HASH, engineResult: "tesSUCCESS" }) {}
  async submitPayment(input: { destination: string; drops: string; idempotencyKey: string }): Promise<SubmittedPayment> {
    this.submitted.push({ destination: input.destination, drops: input.drops, idempotencyKey: input.idempotencyKey });
    if (this.result === "throw") throw new Error("network down");
    return this.result;
  }
  async findPayment(): Promise<SubmittedPayment | undefined> {
    return undefined;
  }
  async close(): Promise<void> {}
}

/** Real shared XRPL Testnet provider over an injected ledger session. */
export function testnetPayments(ledger: FakeLedger, options?: { maxUsd?: number; merchants?: boolean }): TicketPaymentPort {
  return createSharedTicketPayments({
    provider: createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger }),
    mode: "ripple_test",
    merchants: createMerchantDirectory({
      mode: "ripple_test",
      json: options?.merchants === false ? undefined : JSON.stringify({ "Demo Box Office": BOX_OFFICE }),
    }),
    merchantName: "Demo Box Office",
    xrpPerUsd: 1,
    maxUsd: options?.maxUsd ?? 500,
    timeoutMs: 5_000,
  });
}

/** Minimal fetch stub for Ticketmaster. Routes by path; records every URL requested. */
export function ticketmasterFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const match = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    const route = match?.[1] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, calls };
}

export const TM_EVENT = {
  id: "vvG1zZ9KnicksCeltics",
  name: "New York Knicks vs. Boston Celtics",
  url: "https://www.ticketmaster.com/event/vvG1zZ9KnicksCeltics",
  dates: { start: { localDate: "2026-09-24", localTime: "19:30:00", dateTime: "2026-09-24T23:30:00Z" }, timezone: "America/New_York" },
  classifications: [{ segment: { name: "Sports" }, genre: { name: "Basketball" } }],
  priceRanges: [
    { type: "standard", currency: "USD", min: 72, max: 410 },
    { type: "standard including fees", currency: "USD", min: 84, max: 455 },
  ],
  _embedded: {
    venues: [
      {
        name: "Madison Square Garden",
        address: { line1: "4 Pennsylvania Plaza" },
        city: { name: "New York" },
        state: { stateCode: "NY" },
        country: { countryCode: "US" },
        location: { latitude: "40.7505", longitude: "-73.9934" },
      },
    ],
    attractions: [{ name: "New York Knicks" }, { name: "Boston Celtics" }],
  },
};
