import { vi } from "vitest";
import { runConversationTurn, type TurnOutcome } from "../../src/agent/turn.js";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import {
  createGuardedReservationPayments,
  type DepositGuardrail,
} from "../../src/payments/reservation-deposits.js";
import { PaymentService } from "../../src/payments/service.js";
import type { PaymentProvider } from "../../src/payments/types.js";
import { ConversationContextStore } from "../../src/orchestration/context.js";
import type { RestaurantSearch, RestaurantSearchResult } from "../../src/orchestration/dining.js";
import { CrossDomainOrchestrator } from "../../src/orchestration/orchestrator.js";
import { RippleBistroProvider } from "../../src/reservations/providers.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import { createMemoryDirectory, DEMO_RESTAURANTS, RIPPLE_BISTRO } from "../../src/reservations/restaurant.js";
import { ReservationStore } from "../../src/reservations/state.js";
import { createMemoryStateStore, type StateStore } from "../../src/store/state.js";
import { MockTicketProvider } from "../../src/ticketing/providers/mock.js";
import { TicketingService } from "../../src/ticketing/service.js";
import { createTransportationService } from "../../src/transport/service.js";
import type { PlaceLocation, RouteResult, RoutingProvider, TravelMode } from "../../src/transport/types.js";
import { BOX_OFFICE, FakeLedger, NOW, testnetPayments, TX_HASH } from "../ticketing/support.js";

export { BOX_OFFICE, FakeLedger, NOW, TX_HASH };

export const MERCHANT = "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2";
export const SENDER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
export const SPACE = "space-orch";

const BISTRO_PLACE: PlaceLocation = {
  name: RIPPLE_BISTRO.name,
  address: RIPPLE_BISTRO.address,
  latitude: 40.7032,
  longitude: -74.0119,
  source: "context",
  confidence: 0.9,
};

export function ledgerProvider(overrides?: { fail?: number; hash?: string }) {
  let failures = overrides?.fail ?? 0;
  const hash = overrides?.hash ?? TX_HASH;
  const sendPayment = vi.fn(async (input: Parameters<PaymentProvider["sendPayment"]>[0]) => {
    if (failures > 0) {
      failures -= 1;
      return { success: false, status: "tecPATH_DRY", error: "path dry" };
    }
    return {
      success: true,
      status: "tesSUCCESS",
      transactionId: hash,
      submittedAsset: "XRP",
      submittedAmount: String(input.amountUsd),
      submittedDrops: String(input.amountUsd * 1_000_000),
    };
  });
  return { sendPayment } satisfies PaymentProvider;
}

export function fakeRestaurants(
  result: RestaurantSearchResult | (() => RestaurantSearchResult) = {
    status: "ok",
    options: [
      {
        name: RIPPLE_BISTRO.name,
        address: RIPPLE_BISTRO.address,
        latitude: BISTRO_PLACE.latitude,
        longitude: BISTRO_PLACE.longitude,
        placeId: RIPPLE_BISTRO.placeId,
        distanceMeters: 420,
        rating: 4.6,
        source: "Google Places",
      },
      {
        name: "L'Artusi",
        address: "228 W 10th St, New York, NY 10014",
        latitude: 40.7342,
        longitude: -74.0028,
        placeId: "demo-lartusi",
        distanceMeters: 1800,
        rating: 4.5,
        source: "Google Places",
      },
      {
        name: "Carbone",
        address: "181 Thompson St, New York, NY 10012",
        latitude: 40.7278,
        longitude: -74.0001,
        placeId: "demo-carbone",
        distanceMeters: 2400,
        rating: 4.4,
        source: "Google Places",
      },
    ],
  },
): RestaurantSearch & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    source: "Google Places",
    calls,
    async search(request) {
      calls.push(request);
      return typeof result === "function" ? result() : result;
    },
  };
}

function transitRoute(): RouteResult {
  return {
    mode: "TRANSIT",
    durationSeconds: 28 * 60,
    distanceMeters: 5200,
    summary: "L train",
    steps: [
      {
        mode: "TRANSIT",
        instruction: "Take the L toward Canarsie",
        lineShortName: "L",
        departureStop: "Bowling Green",
        arrivalStop: "Bedford Av",
      },
    ],
  };
}

function walkRoute(): RouteResult {
  return {
    mode: "WALK",
    durationSeconds: 45 * 60,
    distanceMeters: 3600,
    steps: [{ mode: "WALK", instruction: "Walk northeast" }],
  };
}

export function conversation(options?: {
  agent?: StateStore;
  clock?: { now: Date };
  restaurants?: RestaurantSearch & { calls?: unknown[] };
  ticketLedger?: FakeLedger;
  depositProvider?: PaymentProvider;
  paymentMode?: "mock" | "ripple_test";
  ticketProvider?: MockTicketProvider;
  guard?: DepositGuardrail;
  resolvePlace?: (query: string) => Promise<{ latitude: number; longitude: number; label?: string } | undefined>;
}) {
  const clock = options?.clock ?? { now: new Date(NOW.getTime()) };
  const now = () => clock.now;
  const agent = options?.agent ?? createMemoryStateStore();
  const context = ConversationContextStore.open(agent, () => now().getTime());
  const ticketLedger = options?.ticketLedger ?? new FakeLedger();
  const depositProvider = options?.depositProvider ?? ledgerProvider();
  const paymentMode = options?.paymentMode ?? "ripple_test";
  const restaurants = options?.restaurants ?? fakeRestaurants();

  const payments = new PaymentService({
    provider: depositProvider,
    directory: loadRecipientDirectory(),
    maxUsd: 500,
  });

  const merchants = createMerchantDirectory({
    mode: paymentMode,
    json: JSON.stringify({ "Ripple Bistro": MERCHANT, "Demo Box Office": BOX_OFFICE }),
  });
  const guarded = createGuardedReservationPayments({
    payments,
    merchants,
    mode: paymentMode,
    serverUrl: "wss://s.altnet.rippletest.net:51233",
    xrpPerUsd: 1,
    maxUsd: 500,
    dailyMaxUsd: 1000,
    senderAddress: paymentMode === "ripple_test" ? SENDER : undefined,
    guard: options?.guard,
    now,
  });

  const caller = new MockOutboundCaller("exact_time");
  const bistro = new RippleBistroProvider();
  const reservationStore = ReservationStore.open(agent);
  const reservations = new ReservationOrchestrator({
    directory: createMemoryDirectory(DEMO_RESTAURANTS),
    caller,
    now,
    timeZone: "America/New_York",
    autoComplete: true,
    mockScenario: "exact_time",
    store: reservationStore,
    payments: guarded,
    providers: [bistro],
    merchants,
    paymentMode,
    notify: async () => undefined,
  });

  const routeCalls: { origin: string; destination: string; mode: TravelMode; originLat?: number; destLat?: number }[] = [];
  const routing: RoutingProvider = {
    async getRoute(origin, destination, mode) {
      routeCalls.push({
        origin: origin.name,
        destination: destination.name,
        mode,
        originLat: origin.latitude,
        destLat: destination.latitude,
      });
      if (mode === "WALK") return walkRoute();
      return transitRoute();
    },
  };
  const transport = createTransportationService({ routing });

  const ticketProvider = options?.ticketProvider ?? new MockTicketProvider({ now, timeZone: "America/New_York" });
  const ticketing = new TicketingService({
    provider: ticketProvider,
    purchaseMode: "mock",
    payments: testnetPayments(ticketLedger),
    merchantName: "Demo Box Office",
    now,
    timeZone: "America/New_York",
    onEventSelected: (spaceId, event) => {
      context.noteEvent(spaceId, event);
      if (!event.venue) return;
      transport.noteDestination(spaceId, {
        name: event.venue,
        address: event.address,
        latitude: event.latitude,
        longitude: event.longitude,
        source: "context",
        confidence: 0.9,
      });
    },
  });

  const orchestration = new CrossDomainOrchestrator({
    context,
    ticketing,
    reservations,
    payments,
    transport,
    restaurants,
    resolvePlace: options?.resolvePlace,
    paymentMode,
    now,
    timeZone: "America/New_York",
  });

  let counter = 0;
  async function say(
    text: string,
    extra?: { spaceId?: string; senderId?: string; senderName?: string; isGroup?: boolean },
  ): Promise<{ outcome: TurnOutcome; reply: string }> {
    counter += 1;
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: extra?.spaceId ?? SPACE,
        senderId: extra?.senderId ?? "alice",
        senderName: extra?.senderName ?? "Alice",
        direction: "inbound",
        isGroup: extra?.isGroup ?? false,
        question: text,
        messageId: `orch-${counter}`,
      },
      {
        reply: async (body) => {
          replies.push(body);
          return { id: "sent" };
        },
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        transcript: () => [],
        recordAssistant: () => undefined,
        suggest: async () => "gemini-fallback",
        handleTransport: (request) => transport.handle(request),
        handleReservation: (request) =>
          reservations.handleTurn({
            spaceId: request.spaceId,
            senderId: request.senderId,
            senderName: request.senderName,
            text: request.text,
            messageId: request.messageId,
          }),
        handlePayment: (request) =>
          payments.handleTurn({
            spaceId: request.spaceId,
            senderId: request.senderId,
            senderName: request.senderName,
            text: request.text,
            messageId: request.messageId,
          }),
        handleTicketing: (request) =>
          ticketing.handleTurn({
            spaceId: request.spaceId,
            senderId: request.senderId,
            senderName: request.senderName,
            text: request.text,
            messageId: request.messageId,
            phase: request.phase,
          }),
        handleOrchestration: (request) =>
          orchestration.handleTurn({
            spaceId: request.spaceId,
            senderId: request.senderId,
            senderName: request.senderName,
            text: request.text,
            messageId: request.messageId,
            isGroup: request.isGroup,
            handleTransport: request.handleTransport,
          }),
      },
    );
    return { outcome, reply: replies[0] ?? "" };
  }

  return {
    say,
    clock,
    agent,
    context,
    ticketing,
    reservations,
    payments,
    transport,
    orchestration,
    ticketLedger,
    depositProvider,
    bistro,
    caller,
    restaurants,
    routeCalls,
    places: { bistro: BISTRO_PLACE },
  };
}

export function depositSends(provider: PaymentProvider): number {
  if (provider instanceof MockPaymentProvider) return provider.calls.length;
  return (provider.sendPayment as ReturnType<typeof vi.fn>).mock.calls.length;
}
