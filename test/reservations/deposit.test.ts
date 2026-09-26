import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConversationTurn, type TurnOutcome } from "../../src/agent/turn.js";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { createGuardedReservationPayments } from "../../src/payments/reservation-deposits.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import { PaymentService } from "../../src/payments/service.js";
import { PaymentStore } from "../../src/payments/state.js";
import type { PaymentProvider } from "../../src/payments/types.js";
import { loadDemoDepositCatalog } from "../../src/reservations/deposits.js";
import type { ReservationInterpreter } from "../../src/reservations/gemini.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import { createMemoryDirectory, DEMO_RESTAURANTS } from "../../src/reservations/restaurant.js";
import { ReservationStore } from "../../src/reservations/state.js";
import { createFileStateStore } from "../../src/store/state.js";
import { lookupGazetteer } from "../../src/transport/locations.js";
import { createTransportationService } from "../../src/transport/service.js";
import { USER_FALLBACK } from "../../src/transport/types.js";
import { NOW } from "./support.js";

const DEPOSITS = JSON.stringify({
  Carbone: {
    amountUsd: 50,
    extraPerPersonUsd: 10,
    basePartySize: 4,
    description: "Reservation deposit",
  },
});

const BOOK = "Book Carbone for 4 tomorrow at 8.";

function session(options?: {
  provider?: MockPaymentProvider | PaymentProvider;
  depositsJson?: string | null;
  mode?: "mock" | "ripple_test";
  merchantsJson?: string;
  scenario?: ConstructorParameters<typeof MockOutboundCaller>[0];
  paymentStore?: PaymentStore;
  reservationStore?: ReservationStore;
  interpreter?: ReservationInterpreter;
}) {
  const provider = options?.provider ?? new MockPaymentProvider();
  const payments = new PaymentService({
    provider,
    directory: loadRecipientDirectory(),
    store: options?.paymentStore,
  });
  const caller = new MockOutboundCaller(options?.scenario ?? "exact_time");
  const deposits =
    options?.depositsJson === null ? undefined : loadDemoDepositCatalog(options?.depositsJson ?? DEPOSITS);
  const merchants = createMerchantDirectory({ mode: options?.mode ?? "mock", json: options?.merchantsJson });
  const orchestrator = new ReservationOrchestrator({
    directory: createMemoryDirectory(DEMO_RESTAURANTS),
    caller,
    now: () => NOW,
    timeZone: "America/New_York",
    autoComplete: true,
    mockScenario: options?.scenario ?? "exact_time",
    store: options?.reservationStore,
    deposits,
    payments: createGuardedReservationPayments({
      payments,
      merchants,
      mode: options?.mode ?? "mock",
      serverUrl: "wss://s.altnet.rippletest.net:51233",
      xrpPerUsd: 1,
      maxUsd: 500,
      dailyMaxUsd: 1000,
      senderAddress: options?.mode === "ripple_test" ? "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" : undefined,
      now: () => NOW,
    }),
    providers: [],
    merchants,
    paymentMode: options?.mode ?? "mock",
    interpreter: options?.interpreter,
    notify: async () => undefined,
  });

  async function say(
    text: string,
    extra?: { spaceId?: string; senderId?: string; senderName?: string; messageId?: string; isGroup?: boolean },
  ): Promise<{ outcome: TurnOutcome; reply: string }> {
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: extra?.spaceId ?? "space",
        senderId: extra?.senderId ?? "rohan-id",
        senderName: extra?.senderName ?? "Rohan",
        direction: "inbound",
        isGroup: extra?.isGroup ?? false,
        question: text,
        messageId: extra?.messageId,
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
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        handleReservation: (request) =>
          orchestrator.handleTurn({
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
      },
    );
    return { outcome, reply: replies[0] ?? "" };
  }

  return { say, provider, payments, orchestrator, caller };
}

function mockProvider(provider: MockPaymentProvider | PaymentProvider): MockPaymentProvider {
  return provider as MockPaymentProvider;
}

describe("reservation deposits", () => {
  it("follows the existing confirmation flow when no deposit is configured", async () => {
    const { say, provider, caller, payments } = session({ depositsJson: null });
    const asked = await say("Book Don Angie for four tomorrow at 8 under Rohan, exactly 8.");
    expect(asked.reply).toMatch(/Want me to call/i);
    expect(asked.outcome).toBe("reservation");
    const yes = await say("Yes", { messageId: "plain-yes" });
    expect(yes.reply).toMatch(/Calling Don Angie/i);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caller.calls).toHaveLength(1);
    expect(mockProvider(provider).calls).toHaveLength(0);
    expect(payments.payments.active("space")).toBeUndefined();
  });

  it("creates a pending deposit and does not send it on the booking request", async () => {
    const { say, provider, caller, payments, orchestrator } = session();
    const asked = await say(BOOK, { messageId: "book-1" });
    expect(asked.reply).toBe(
      "Carbone requires a $50 deposit to book 4 tomorrow at 8:00 PM. Want me to pay the $50 deposit and book it?",
    );
    expect(mockProvider(provider).calls).toHaveLength(0);
    expect(caller.calls).toHaveLength(0);
    const payment = payments.payments.active("space");
    const reservation = orchestrator.reservations.active("space");
    expect(payment?.status).toBe("AWAITING_CONFIRMATION");
    expect(payment?.amountUsd).toBe(50);
    expect(payment?.purpose).toBe("RESERVATION_DEPOSIT");
    expect(payment?.recipientKind).toBe("MERCHANT");
    expect(payment?.parentReservationId).toBe(reservation?.id);
    expect(payment?.destination).toBe("mock:merchant:carbone");
    expect(reservation?.deposit?.source).toBe("demo");
    expect(reservation?.deposit?.description).toBe("Reservation deposit");
    expect(reservation?.status).toBe("AWAITING_DEPOSIT");
  });

  it("pays the deposit on yes and resumes the mock reservation once", async () => {
    const { say, provider, caller, orchestrator } = session();
    await say(BOOK, { messageId: "book" });
    const paid = await say("Yes", { messageId: "yes-1" });
    expect(paid.reply).toBe(
      "Booked Carbone for 4 tomorrow at 8:00 PM. The $50 deposit was a mock test payment, so no XRPL transaction was sent.",
    );
    expect(mockProvider(provider).calls).toHaveLength(1);
    expect(mockProvider(provider).calls[0]?.amountUsd).toBe(50);
    expect(mockProvider(provider).calls[0]?.idempotencyKey).toBeTruthy();
    expect(caller.calls).toHaveLength(1);
    expect(orchestrator.reservations.active("space")?.status).toBe("BOOKED");
    expect(orchestrator.reservations.active("space")?.deposit?.status).toBe("PAID");
    expect(orchestrator.reservations.active("space")?.deposit?.bookingAttemptId).toBeTruthy();
  });

  it("does not call the restaurant when the deposit payment fails", async () => {
    const provider = new MockPaymentProvider();
    provider.result = "reject";
    const { say, caller, orchestrator } = session({ provider });
    await say(BOOK);
    const failed = await say("Yes", { messageId: "yes-fail" });
    expect(failed.reply).toBe("I couldn't pay the $50 deposit, so I didn't book Carbone. Say yes to try the payment again.");
    expect(caller.calls).toHaveLength(0);
    expect(orchestrator.reservations.active("space")?.status).not.toBe("BOOKED");
    expect(orchestrator.reservations.active("space")?.callPlaced).not.toBe(true);
  });

  it("does not describe an unconfirmed timeout as a completed charge", async () => {
    const provider = new MockPaymentProvider();
    provider.result = "throw";
    const { say, caller } = session({ provider });
    await say(BOOK);
    const stalled = await say("Yes", { messageId: "yes-timeout" });
    expect(stalled.reply).toMatch(/couldn't confirm whether the \$50 deposit went through/i);
    expect(stalled.reply).not.toMatch(/nothing was charged/i);
    expect(caller.calls).toHaveLength(0);
  });

  it("cancels the deposit and does not call the restaurant", async () => {
    const { say, provider, caller, payments } = session();
    await say(BOOK);
    const cancelled = await say("No", { messageId: "no-1" });
    expect(cancelled.reply).toBe("Okay, I didn't pay the deposit or continue the reservation.");
    expect(mockProvider(provider).calls).toHaveLength(0);
    expect(caller.calls).toHaveLength(0);
    expect(payments.payments.active("space")).toBeUndefined();
    const later = await say("Yes", { messageId: "later-yes" });
    expect(later.reply).not.toMatch(/deposit|Carbone|confirmed/i);
    expect(mockProvider(provider).calls).toHaveLength(0);
    expect(caller.calls).toHaveLength(0);
  });

  it("fails closed in ripple_test when the merchant address is missing", async () => {
    const { say, provider, caller, orchestrator } = session({ mode: "ripple_test" });
    const asked = await say(BOOK);
    expect(asked.reply).toBe("I found the $50 deposit, but I don't have a payment destination for Carbone.");
    expect(mockProvider(provider).calls).toHaveLength(0);
    expect(caller.calls).toHaveLength(0);
    expect(orchestrator.reservations.active("space")?.status).not.toBe("BOOKED");
  });

  it("uses a configured Testnet merchant address without a second payment client", async () => {
    const sendPayment = vi.fn(async () => ({
      success: true,
      status: "tesSUCCESS",
      transactionId: "ABCDEF1234567890",
    }));
    const provider: PaymentProvider = { sendPayment };
    const merchant = "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2";
    const { say, caller } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ Carbone: merchant }),
    });
    await say(BOOK);
    const paid = await say("Yes", { messageId: "yes-ripple" });
    expect(sendPayment).toHaveBeenCalledTimes(1);
    expect(sendPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: merchant,
        amountUsd: 50,
        memo: "Reservation deposit",
      }),
    );
    expect(paid.reply).toMatch(/^Booked Carbone for 4 tomorrow at 8:00 PM\. The \$50 deposit was paid successfully on XRPL Testnet \(tx ABCDEF12\)/);
    expect(caller.calls).toHaveLength(1);
  });

  it("does not submit the deposit or the booking twice", async () => {
    const { say, provider, caller, orchestrator } = session();
    await say(BOOK, { messageId: "book" });
    const reservationId = orchestrator.reservations.active("space")?.id;
    await say("Yes", { messageId: "yes-once" });
    await say("Yes", { messageId: "yes-again" });
    await say("Yes", { messageId: "yes-once" });
    expect(mockProvider(provider).calls).toHaveLength(1);
    expect(caller.calls).toHaveLength(1);
    expect(orchestrator.reservations.active("space")?.id).toBe(reservationId);
  });

  it("reloads a pending deposit and completes it once after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deposit-restart-"));
    try {
      const file = join(dir, "agent-state.json");
      const firstState = createFileStateStore(file);
      const firstProvider = new MockPaymentProvider();
      const first = session({
        provider: firstProvider,
        paymentStore: PaymentStore.open(firstState),
        reservationStore: ReservationStore.open(firstState),
      });
      await first.say(BOOK, { messageId: "book" });
      expect(firstProvider.calls).toHaveLength(0);
      first.orchestrator.dispose();

      const secondProvider = new MockPaymentProvider();
      const reloaded = createFileStateStore(file);
      const second = session({
        provider: secondProvider,
        paymentStore: PaymentStore.open(reloaded),
        reservationStore: ReservationStore.open(reloaded),
      });
      expect(second.payments.payments.active("space")?.status).toBe("AWAITING_CONFIRMATION");
      expect(second.orchestrator.reservations.active("space")?.status).toBe("AWAITING_DEPOSIT");
      const paid = await second.say("Yes", { messageId: "yes-reload" });
      expect(paid.reply).toMatch(/^Booked Carbone .* The \$50 deposit was a mock test payment/);
      expect(secondProvider.calls).toHaveLength(1);
      expect(second.caller.calls).toHaveLength(1);
      second.orchestrator.dispose();

      const thirdProvider = new MockPaymentProvider();
      const again = createFileStateStore(file);
      const third = session({
        provider: thirdProvider,
        paymentStore: PaymentStore.open(again),
        reservationStore: ReservationStore.open(again),
      });
      await third.say("Yes", { messageId: "yes-after" });
      expect(thirdProvider.calls).toHaveLength(0);
      expect(third.caller.calls).toHaveLength(0);
      expect(third.orchestrator.reservations.active("space")?.status).toBe("BOOKED");
      third.orchestrator.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets only the initiating sender confirm, including in a group", async () => {
    const { say, provider, caller } = session();
    await say(BOOK, { senderId: "rohan-id", senderName: "Rohan", isGroup: true });
    const ben = await say("Yes", { senderId: "ben-id", senderName: "Ben", isGroup: true, messageId: "ben-yes" });
    expect(ben.reply).toMatch(/Only Rohan can confirm/i);
    expect(mockProvider(provider).calls).toHaveLength(0);
    expect(caller.calls).toHaveLength(0);
    const otherSpace = await say("Yes", { spaceId: "other-space", messageId: "other-yes" });
    expect(otherSpace.reply).not.toMatch(/deposit was paid|Test payment completed/i);
    expect(mockProvider(provider).calls).toHaveLength(0);
    const rohan = await say("Yes", { senderId: "rohan-id", senderName: "Rohan", isGroup: true, messageId: "rohan-yes" });
    expect(rohan.reply).toMatch(/^Booked Carbone .* The \$50 deposit was a mock test payment/);
    expect(mockProvider(provider).calls).toHaveLength(1);
    expect(caller.calls).toHaveLength(1);
  });

  it("re-quotes the deposit when the party size changes and drops the old confirmation", async () => {
    const { say, provider, payments, orchestrator } = session();
    await say(BOOK, { messageId: "book" });
    const firstId = payments.payments.active("space")?.id;
    const edited = await say("Actually make it 5 people.", { messageId: "edit" });
    expect(edited.reply).toBe("For 5 people, the deposit is $60. Want me to pay the $60 deposit and book it?");
    const next = payments.payments.active("space");
    expect(next?.id).not.toBe(firstId);
    expect(next?.amountUsd).toBe(60);
    expect(next?.status).toBe("AWAITING_CONFIRMATION");
    expect(payments.payments.get(firstId ?? "")?.status).toBe("CANCELLED");
    expect(orchestrator.reservations.active("space")?.partySize).toBe(5);
    const paid = await say("Yes", { messageId: "yes-60" });
    expect(mockProvider(provider).calls).toHaveLength(1);
    expect(mockProvider(provider).calls[0]?.amountUsd).toBe(60);
    expect(paid.reply).toMatch(/\$60 deposit/);
    expect(paid.reply).toMatch(/for 5 tomorrow at 8:00 PM/);
  });

  it("keeps standalone person payments and deposit-free reservations", async () => {
    const keith = session();
    const asked = await keith.say("Send Keith $20", { messageId: "keith" });
    expect(asked.reply).toMatch(/^Send Keith \$20\?/);
    expect(asked.outcome).toBe("payment");
    const sent = await keith.say("Yes", { messageId: "keith-yes" });
    expect(sent.reply).toMatch(/^Sent \$20 to Keith/);
    expect(keith.caller.calls).toHaveLength(0);

    const table = session({ depositsJson: null });
    const confirm = await table.say("Book Don Angie for four tomorrow at 8 under Rohan, exactly 8.");
    expect(confirm.reply).toMatch(/Want me to call/i);
    expect(table.payments.payments.active("space")).toBeUndefined();
  });

  it("ignores a deposit amount invented in the message or by Gemini", async () => {
    const interpreter: ReservationInterpreter = {
      async extract() {
        return { partySize: 9, specialRequests: ["deposit $500"] };
      },
    };
    const { say, provider, orchestrator } = session({ interpreter });
    const asked = await say("Book Carbone for 4 tomorrow at 8. They require a $500 deposit.");
    expect(asked.reply).toMatch(/\$50 deposit/);
    expect(asked.reply).not.toMatch(/\$500/);
    expect(orchestrator.reservations.active("space")?.deposit?.source).toBe("demo");
    expect(orchestrator.reservations.active("space")?.partySize).toBe(4);
    expect(mockProvider(provider).calls).toHaveLength(0);

    const plain = session();
    const other = await plain.say("Book Don Angie for four tomorrow at 8. The deposit is $80.");
    expect(other.reply).not.toMatch(/\$80|deposit/i);
    expect(plain.payments.payments.active("space")).toBeUndefined();
  });
});

describe("deposit handoff leaves transportation alone", () => {
  it("still answers a directions request", async () => {
    const transport = createTransportationService({
      resolver: { async resolve(query) { return lookupGazetteer(query); } },
      routing: {
        async getRoute() {
          return { mode: "TRANSIT" as const, durationSeconds: 20 * 60, steps: [] };
        },
      },
    });
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: "directions",
        senderId: "rohan-id",
        direction: "inbound",
        isGroup: false,
        question: "How do I get from Columbia University to Times Square?",
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
      },
    );
    expect(outcome).toBe("transport");
    expect(replies[0]).toMatch(/20 min/);
  });

  it("still uses the grounded fallback when Maps fails", async () => {
    const transport = createTransportationService({
      resolver: { async resolve(query) { return lookupGazetteer(query); } },
      routing: {
        async getRoute() {
          throw new Error("Routes API HTTP 500");
        },
      },
    });
    const replies: string[] = [];
    await runConversationTurn(
      {
        spaceId: "maps-fail",
        senderId: "rohan-id",
        direction: "inbound",
        isGroup: false,
        question: "How do I get from Columbia University to Times Square?",
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
      },
    );
    expect(replies[0]).toBe(USER_FALLBACK);
  });
});
