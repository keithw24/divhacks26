import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { runConversationTurn, type TurnOutcome } from "../../src/agent/turn.js";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { startWebhookServer } from "../../src/elevenlabs/server.js";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import {
  createGuardedReservationPayments,
  createPolicyEngineDepositGuard,
  senderAddressFromSeed,
  type DepositAuditSink,
  type DepositGuardrail,
  type LedgerTransactionView,
} from "../../src/payments/reservation-deposits.js";
import { PaymentAuditLog } from "../../src/payments/xrpl/audit.js";
import { XrplDashboardBuilder } from "../../src/payments/xrpl/dashboard.js";
import { PaymentService } from "../../src/payments/service.js";
import type { PaymentProvider } from "../../src/payments/types.js";
import { PolicyEngine } from "../../src/payments/xrpl/policy.js";
import { policyConfig } from "../../src/payments/xrpl/executor.js";
import { loadDemoDepositCatalog } from "../../src/reservations/deposits.js";
import type { ReservationInterpreter } from "../../src/reservations/gemini.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import type { ReservationPaymentRequirement } from "../../src/reservations/payment.js";
import { RippleBistroProvider } from "../../src/reservations/providers.js";
import { createMemoryDirectory, DEMO_RESTAURANTS } from "../../src/reservations/restaurant.js";
import { interpretCompletion } from "../../src/reservations/result.js";
import { paymentTraceRoute } from "../../src/reservations/runtime.js";
import { NOW } from "./support.js";

const MERCHANT = "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2";
const SENDER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TX = "A".repeat(8) + "0123456789ABCDEF".repeat(3) + "B".repeat(8);
const BOOK = "Book Ripple Bistro for 4 tonight at 8.";

function ledgerProvider(overrides?: Partial<{ fail: number }>) {
  let failures = overrides?.fail ?? 0;
  const sendPayment = vi.fn(async (input: Parameters<PaymentProvider["sendPayment"]>[0]) => {
    if (failures > 0) {
      failures -= 1;
      return { success: false, status: "tecPATH_DRY", error: "path dry" };
    }
    return {
      success: true,
      status: "tesSUCCESS",
      transactionId: TX,
      submittedAsset: "XRP",
      submittedAmount: String(input.amountUsd),
      submittedDrops: String(input.amountUsd * 1_000_000),
    };
  });
  return { sendPayment } satisfies PaymentProvider;
}

function session(options?: {
  provider?: PaymentProvider;
  mode?: "mock" | "ripple_test";
  merchantsJson?: string;
  maxUsd?: number;
  guard?: DepositGuardrail;
  scenario?: ConstructorParameters<typeof MockOutboundCaller>[0];
  depositsJson?: string;
  interpreter?: ReservationInterpreter;
  bistro?: RippleBistroProvider;
  senderAddress?: string;
  clock?: { now: Date };
  audit?: DepositAuditSink;
  ledger?: { balanceDrops: (address: string) => Promise<string>; transaction: (hash: string) => Promise<LedgerTransactionView | null> };
}) {
  const mode = options?.mode ?? "mock";
  const provider = options?.provider ?? new MockPaymentProvider();
  const payments = new PaymentService({ provider, directory: loadRecipientDirectory() });
  const caller = new MockOutboundCaller(options?.scenario ?? "exact_time");
  const merchants = createMerchantDirectory({ mode, json: options?.merchantsJson });
  const bistro = options?.bistro ?? new RippleBistroProvider();
  const clock = options?.clock ?? { now: NOW };
  const guarded = createGuardedReservationPayments({
    payments,
    merchants,
    mode,
    serverUrl: "wss://s.altnet.rippletest.net:51233",
    xrpPerUsd: 1,
    maxUsd: options?.maxUsd ?? 500,
    dailyMaxUsd: 1000,
    senderAddress: options?.senderAddress ?? (mode === "ripple_test" ? SENDER : undefined),
    guard: options?.guard,
    audit: options?.audit,
    balanceDrops: options?.ledger?.balanceDrops,
    ledgerTransaction: options?.ledger?.transaction,
    now: () => clock.now,
  });
  const notes: { spaceId: string; text: string }[] = [];
  const orchestrator = new ReservationOrchestrator({
    directory: createMemoryDirectory(DEMO_RESTAURANTS),
    caller,
    now: () => clock.now,
    timeZone: "America/New_York",
    autoComplete: true,
    mockScenario: options?.scenario ?? "exact_time",
    deposits: options?.depositsJson ? loadDemoDepositCatalog(options.depositsJson) : undefined,
    payments: guarded,
    providers: [bistro],
    merchants,
    paymentMode: mode,
    interpreter: options?.interpreter,
    notify: async (spaceId, text) => {
      notes.push({ spaceId, text });
    },
  });

  async function say(
    text: string,
    extra?: { spaceId?: string; senderId?: string; senderName?: string; messageId?: string; isGroup?: boolean },
  ): Promise<{ outcome: TurnOutcome; reply: string }> {
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: extra?.spaceId ?? "space-a",
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

  const active = (spaceId = "space-a") => orchestrator.reservations.active(spaceId);
  const trace = (spaceId = "space-a") => orchestrator.paymentTrace(active(spaceId)?.id ?? "");
  return { say, provider, payments, orchestrator, caller, bistro, notes, active, trace, guarded, clock };
}

function sends(provider: PaymentProvider): number {
  if (provider instanceof MockPaymentProvider) return provider.calls.length;
  return (provider.sendPayment as ReturnType<typeof vi.fn>).mock.calls.length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("restaurant deposits through the Ripple payment layer", () => {
  it("1. keeps the existing call flow for a restaurant with no deposit", async () => {
    const { say, provider, caller, payments } = session();
    const asked = await say("Book Don Angie for four tomorrow at 8 under Rohan, exactly 8.");
    expect(asked.reply).toMatch(/Want me to call/i);
    const yes = await say("Yes", { messageId: "no-deposit-yes" });
    expect(yes.reply).toMatch(/Calling Don Angie/i);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caller.calls).toHaveLength(1);
    expect(sends(provider)).toBe(0);
    expect(payments.payments.active("space-a")).toBeUndefined();
  });

  it("2. asks before paying a Ripple Bistro deposit, with grounded terms", async () => {
    const { say, provider, active, bistro } = session();
    const asked = await say(BOOK, { messageId: "book" });
    expect(asked.reply).toBe(
      "Ripple Bistro has a 8:00 PM table for 4 tonight. They require a $100 deposit ($25/person). Want me to pay the $100 deposit and book it?",
    );
    expect(asked.outcome).toBe("reservation");
    expect(sends(provider)).toBe(0);
    expect(bistro.confirmations).toHaveLength(0);
    const reservation = active();
    expect(reservation?.status).toBe("AWAITING_DEPOSIT");
    expect(reservation?.deposit?.state).toBe("PAYMENT_REQUIRED");
    expect(reservation?.deposit?.requirement).toMatchObject({
      paymentRequired: true,
      paymentType: "DEPOSIT",
      restaurantName: "Ripple Bistro",
      partySize: 4,
      reservationTime: "20:00",
      amountUsd: 100,
      perPersonUsd: 25,
      currency: "USD",
      recipient: "mock:merchant:ripple-bistro",
      source: "provider",
      providerId: "ripple-bistro-mock",
    });
    expect(reservation?.deposit?.requirement?.obligationId).toMatch(/^resv-pay-[0-9a-f]{32}$/);
  });

  it("3. does not treat another booking phrase as payment authorization", async () => {
    const { say, provider, active } = session();
    await say(BOOK, { messageId: "book" });
    const bookIt = await say("Book it", { messageId: "book-it" });
    expect(bookIt.reply).toBe("I won't pay the $100 deposit unless you say yes. Pay it and book?");
    expect(active()?.deposit?.history?.filter((step) => step.state === "PAYMENT_REQUIRED")).toHaveLength(1);
    for (const [index, text] of ["Book it", "Book Ripple Bistro for 4 tonight at 8", "sounds good", "call them"].entries()) {
      const reply = await say(text, { messageId: `not-auth-${index}` });
      expect(reply.reply).not.toMatch(/paid|Booked/i);
    }
    expect(sends(provider)).toBe(0);
    expect(active()?.deposit?.status).toBe("AWAITING_PAYMENT");
  });

  it("4-8. pays the exact amount to the grounded wallet on yes, persists the hash, then books", async () => {
    const provider = ledgerProvider();
    const { say, active, bistro, trace } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
    });
    await say(BOOK, { messageId: "book" });
    expect(active()?.status).toBe("AWAITING_DEPOSIT");
    expect(bistro.confirmations).toHaveLength(0);
    const paid = await say("Yes", { messageId: "yes" });
    expect(provider.sendPayment).toHaveBeenCalledTimes(1);
    expect(provider.sendPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destination: MERCHANT, amountUsd: 100, memo: "Ripple Bistro reservation deposit" }),
    );
    const sent = provider.sendPayment.mock.calls[0]![0];
    expect(sent.idempotencyKey).toBe(active()?.deposit?.requirement?.obligationId);
    expect(bistro.confirmations).toEqual([expect.objectContaining({ transactionHash: TX })]);
    expect(paid.reply).toMatch(
      /^Booked Ripple Bistro for 4 tonight at 8:00 PM\. The \$100 deposit was paid successfully on XRPL Testnet \(tx AAAAAAAA\)\. Confirmation RB-[0-9A-F]{6}\.$/,
    );
    const reservation = active();
    expect(reservation?.status).toBe("BOOKED");
    expect(reservation?.deposit?.transactionId).toBe(TX);
    expect(reservation?.deposit?.ledgerResult).toBe("tesSUCCESS");
    expect(reservation?.deposit?.state).toBe("RESERVATION_CONFIRMED");
    const states = reservation?.deposit?.history?.map((step) => step.state);
    expect(states).toEqual([
      "RESERVATION_PENDING",
      "PAYMENT_REQUIRED",
      "PAYMENT_AUTHORIZED",
      "TERMS_RECHECKED",
      "GUARDRAIL_APPROVED",
      "PAYMENT_SUBMITTED",
      "PAYMENT_CONFIRMED",
      "RESERVATION_CONFIRMED",
    ]);
    const view = trace();
    expect(view).toMatchObject({
      restaurant: "Ripple Bistro",
      partySize: 4,
      reservationTime: "20:00",
      depositRequired: true,
      amountUsd: 100,
      currency: "USD",
      senderWallet: SENDER,
      recipientWallet: MERCHANT,
      transactionHash: TX,
      explorerUrl: `https://testnet.xrpl.org/transactions/${TX}`,
      ledgerResult: "tesSUCCESS",
      reservationStatus: "BOOKED",
      paymentState: "RESERVATION_CONFIRMED",
      network: "xrpl-testnet",
    });
    expect(view?.guardrail?.decision).toBe("ALLOW");
    expect(view?.guardrail?.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(["GROUNDED_REQUIREMENT", "KNOWN_MERCHANT", "HUMAN_AUTHORIZATION", "MAX_SINGLE_PAYMENT", "INTENT_PAYLOAD_MATCH", "NETWORK_ALLOWED"]),
    );
  });

  it("9. never claims a booking when the XRPL payment fails, and retries the same obligation once", async () => {
    const provider = ledgerProvider({ fail: 1 });
    const { say, active, bistro } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
    });
    await say(BOOK, { messageId: "book" });
    const failed = await say("Yes", { messageId: "yes-1" });
    expect(failed.reply).toBe("I couldn't pay the $100 deposit, so I didn't book Ripple Bistro. Say yes to try the payment again.");
    expect(active()?.status).toBe("AWAITING_DEPOSIT");
    expect(active()?.deposit?.state).toBe("PAYMENT_FAILED");
    expect(bistro.confirmations).toHaveLength(0);
    const retried = await say("Yes", { messageId: "yes-2" });
    expect(retried.reply).toMatch(/^Booked Ripple Bistro/);
    expect(provider.sendPayment).toHaveBeenCalledTimes(2);
    const keys = provider.sendPayment.mock.calls.map((call) => call[0].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("10. a second yes does not pay twice", async () => {
    const { say, provider, bistro } = session();
    await say(BOOK, { messageId: "book" });
    await say("Yes", { messageId: "yes-1" });
    const again = await say("Yes", { messageId: "yes-2" });
    expect(again.reply).not.toMatch(/paid successfully|mock test payment/);
    expect(sends(provider)).toBe(1);
    expect(bistro.confirmations).toHaveLength(1);
  });

  it("10b. concurrent yeses pay once", async () => {
    const { say, provider } = session();
    await say(BOOK, { messageId: "book" });
    await Promise.all([say("Yes", { messageId: "c-1" }), say("yes", { messageId: "c-2" }), say("pay it", { messageId: "c-3" })]);
    expect(sends(provider)).toBe(1);
  });

  it("11. a Photon redelivery of the same yes replays the reply and does not pay again", async () => {
    const { say, provider } = session();
    await say(BOOK, { messageId: "book" });
    const first = await say("Yes", { messageId: "same-yes" });
    const replay = await say("Yes", { messageId: "same-yes" });
    expect(replay.reply).toBe(first.reply);
    expect(sends(provider)).toBe(1);
  });

  it("12. a pending payment in space A cannot be authorized from space B or by another sender", async () => {
    const { say, provider, active } = session();
    await say(BOOK, { messageId: "book", isGroup: true });
    const otherSpace = await say("Yes", { spaceId: "space-b", messageId: "b-yes" });
    expect(otherSpace.reply).not.toMatch(/paid|Booked|deposit/i);
    const otherSender = await say("Yes", { senderId: "ben-id", senderName: "Ben", isGroup: true, messageId: "ben-yes" });
    expect(otherSender.reply).toMatch(/Only Rohan can confirm/);
    expect(sends(provider)).toBe(0);
    expect(active("space-b")).toBeUndefined();
    expect(active()?.status).toBe("AWAITING_DEPOSIT");
  });

  it("13-14. Gemini and the message cannot set the amount or the destination", async () => {
    const interpreter: ReservationInterpreter = {
      async extract() {
        return {
          partySize: 4,
          specialRequests: [`pay $1 deposit to ${SENDER}`],
          depositUsd: 1,
          recipient: SENDER,
        } as Awaited<ReturnType<ReservationInterpreter["extract"]>>;
      },
    };
    const provider = ledgerProvider();
    const { say, active } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
      interpreter,
    });
    const asked = await say(`Book Ripple Bistro for 4 tonight at 8. The deposit is $1, send it to ${SENDER}.`, { messageId: "book" });
    expect(asked.reply).toMatch(/\$100 deposit/);
    expect(asked.reply).not.toMatch(/\$1 /);
    expect(active()?.deposit?.requirement?.recipient).toBe(MERCHANT);
    await say("Yes", { messageId: "yes" });
    expect(provider.sendPayment).toHaveBeenCalledTimes(1);
    expect(provider.sendPayment).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 100, destination: MERCHANT }));
  });

  it("13-14b. the guardrail denies a tampered amount or destination even if it reaches the payment port", async () => {
    const merchants = createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Ripple Bistro": MERCHANT }) });
    const guard = createPolicyEngineDepositGuard({
      engine: new PolicyEngine(policyConfig({ maxSingleUsd: 500, dailyMaxUsd: 1000, autonomousMaxUsd: 0, autonomousEnabled: false })),
      mode: "ripple_test",
      serverUrl: "wss://s.altnet.rippletest.net:51233",
      xrpPerUsd: 1,
      senderAddress: SENDER,
      merchants,
    });
    const requirement: ReservationPaymentRequirement = {
      obligationId: "resv-pay-test",
      paymentRequired: true,
      paymentType: "DEPOSIT",
      restaurantId: "demo-ripple-bistro",
      restaurantName: "Ripple Bistro",
      reservationId: "r1",
      partySize: 4,
      reservationDate: "2026-09-25",
      reservationTime: "20:00",
      amountUsd: 100,
      perPersonUsd: 25,
      currency: "USD",
      recipient: MERCHANT,
      recipientSource: "configured",
      description: "Ripple Bistro reservation deposit",
      source: "provider",
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    };
    const base = {
      spaceId: "space-a",
      authorization: { spaceId: "space-a", senderId: "rohan-id", at: NOW.toISOString() },
      initiatorId: "rohan-id",
      paymentId: "p1",
      alreadySettled: false,
      now: NOW,
    };
    const honest = await guard.evaluate({ ...base, requirement, verified: { amountUsd: 100, recipient: MERCHANT } });
    expect(honest.decision).toBe("ALLOW");
    const amount = await guard.evaluate({ ...base, requirement: { ...requirement, amountUsd: 1 }, verified: { amountUsd: 100, recipient: MERCHANT } });
    expect(amount.decision).toBe("DENY");
    expect(amount.reasonCode).toBe("UNGROUNDED_REQUIREMENT");
    const destination = await guard.evaluate({ ...base, requirement: { ...requirement, recipient: SENDER }, verified: { amountUsd: 100, recipient: MERCHANT } });
    expect(destination.decision).toBe("DENY");
    expect(destination.reasonCode).toBe("UNKNOWN_MERCHANT");
    const crossSpace = await guard.evaluate({
      ...base,
      authorization: { ...base.authorization, spaceId: "space-b" },
      requirement,
      verified: { amountUsd: 100, recipient: MERCHANT },
    });
    expect(crossSpace.decision).toBe("DENY");
    expect(crossSpace.reasonCode).toBe("NOT_AUTHORIZED");
  });

  it("15-16. the wallet seed never reaches replies, notifications, logs, state, or traces", async () => {
    const wallet = Wallet.generate();
    const seed = wallet.seed!;
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    const provider = ledgerProvider();
    const { say, active, trace, notes, orchestrator, payments } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
      senderAddress: senderAddressFromSeed(seed),
    });
    const replies = [(await say(BOOK, { messageId: "book" })).reply, (await say("Yes", { messageId: "yes" })).reply];
    expect(active()?.status).toBe("BOOKED");
    expect(trace()?.senderWallet).toBe(wallet.classicAddress);
    const route = paymentTraceRoute(orchestrator, "/reservations/payments", new URLSearchParams({ spaceId: "space-a" }));
    const surfaces = [
      ...replies,
      ...notes.map((note) => note.text),
      ...logged,
      JSON.stringify(active()),
      JSON.stringify(trace()),
      JSON.stringify(route),
      JSON.stringify(payments.payments.byIdempotencyKey(active()?.deposit?.requirement?.obligationId ?? "")),
      JSON.stringify(provider.sendPayment.mock.calls),
    ].join("\n");
    expect(logged.length).toBeGreaterThan(0);
    expect(surfaces).not.toContain(seed);
    expect(surfaces).not.toContain(wallet.privateKey);
  });

  it("17. a guardrail DENY blocks payment and never marks the reservation confirmed", async () => {
    const provider = ledgerProvider();
    const { say, active, bistro, trace, payments } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
      maxUsd: 50,
    });
    await say(BOOK, { messageId: "book" });
    const blocked = await say("Yes", { messageId: "yes" });
    expect(blocked.reply).toMatch(/^I didn't pay the \$100 deposit because a payment safety check blocked it: .+ Ripple Bistro is not booked\.$/);
    expect(provider.sendPayment).not.toHaveBeenCalled();
    expect(bistro.confirmations).toHaveLength(0);
    expect(active()?.status).not.toBe("BOOKED");
    expect(active()?.deposit?.state).toBe("PAYMENT_REJECTED");
    expect(trace()?.guardrail).toMatchObject({ decision: "DENY", reasonCode: expect.stringMatching(/MAX|LIMIT/) });
    expect(trace()?.transactionHash).toBeUndefined();
    const record = payments.payments.byIdempotencyKey(active()?.deposit?.requirement?.obligationId ?? "").at(-1);
    expect(record?.status).toBe("CANCELLED");
  });

  it("17b. an injected guardrail DENY also blocks the mock path", async () => {
    const guard: DepositGuardrail = {
      async evaluate() {
        return {
          allowed: false,
          decision: "DENY",
          reasonCode: "TEST_DENY",
          reasons: ["Blocked for the test."],
          checks: [{ code: "TEST", passed: false, reasonCode: "TEST_DENY", detail: "Blocked for the test." }],
        };
      },
    };
    const { say, provider, active } = session({ guard });
    await say(BOOK, { messageId: "book" });
    const blocked = await say("Yes", { messageId: "yes" });
    expect(blocked.reply).toMatch(/blocked for the test\. Ripple Bistro is not booked\./);
    expect(sends(provider)).toBe(0);
    expect(active()?.status).toBe("NEEDS_USER_INPUT");
  });

  it("18. Ripple Bistro completes the whole flow in mock mode with an honest receipt", async () => {
    const { say, provider, active, bistro, trace } = session();
    await say(BOOK, { messageId: "book" });
    const paid = await say("yes", { messageId: "yes" });
    expect(paid.reply).toMatch(
      /^Booked Ripple Bistro for 4 tonight at 8:00 PM\. The \$100 deposit was a mock test payment, so no XRPL transaction was sent\. Confirmation RB-/,
    );
    expect(sends(provider)).toBe(1);
    expect(bistro.confirmations).toHaveLength(1);
    expect(active()?.result?.confirmationNumber).toMatch(/^RB-/);
    expect(trace()?.explorerUrl).toBeUndefined();
    expect(trace()?.network).toBe("mock");
  });

  it("keeps paid-but-unbooked separate and retries booking without paying again", async () => {
    const bistro = new RippleBistroProvider();
    bistro.failNextConfirm = true;
    const { say, provider, active } = session({ bistro });
    await say(BOOK, { messageId: "book" });
    const paid = await say("Yes", { messageId: "yes" });
    expect(paid.reply).toBe(
      "The $100 deposit was paid in mock mode, but Ripple Bistro didn't confirm the reservation, so it isn't booked. Say try again and I'll retry the booking without paying again.",
    );
    expect(active()?.deposit?.state).toBe("RESERVATION_FAILED_AFTER_PAYMENT");
    expect(active()?.status).not.toBe("BOOKED");
    const retry = await say("try again", { messageId: "retry" });
    expect(retry.reply).toMatch(/^Booked Ripple Bistro/);
    expect(sends(provider)).toBe(1);
    expect(bistro.confirmations).toHaveLength(2);
  });

  it("expires a stale pending payment and re-asks instead of paying", async () => {
    const clock = { now: NOW };
    const { say, provider, active } = session({ clock });
    await say(BOOK, { messageId: "book" });
    const firstObligation = active()?.deposit?.requirement?.expiresAt;
    clock.now = new Date(NOW.getTime() + 16 * 60_000);
    const stale = await say("Yes", { messageId: "late-yes" });
    expect(stale.reply).toMatch(/^That payment request expired, so I didn't pay it\. .*Want me to pay the \$100 deposit and book it\?$/);
    expect(sends(provider)).toBe(0);
    expect(active()?.deposit?.requirement?.expiresAt).not.toBe(firstObligation);
    await say("Yes", { messageId: "fresh-yes" });
    expect(sends(provider)).toBe(1);
  });

  it("re-quotes when the party changes and pays only the new amount", async () => {
    const { say, provider, active } = session();
    await say(BOOK, { messageId: "book" });
    const changed = await say("Actually make it 6 people.", { messageId: "six" });
    expect(changed.reply).toBe("For 6 people, the deposit is $150 ($25/person). Want me to pay the $150 deposit and book it?");
    await say("Yes", { messageId: "yes" });
    expect(sends(provider)).toBe(1);
    expect((provider as MockPaymentProvider).calls[0]?.amountUsd).toBe(150);
    expect(active()?.result?.confirmedPartySize).toBe(6);
  });

  it("reports an unavailable slot without asking for money", async () => {
    const { say, provider, active } = session();
    const full = await say("Book Ripple Bistro for 4 tonight at 9:30.", { messageId: "book" });
    expect(full.reply).toBe("Ripple Bistro is full at 9:30 PM. Want a different time?");
    expect(sends(provider)).toBe(0);
    expect(active()?.deposit).toBeUndefined();
  });

  it("does not ask for money in ripple_test when the restaurant wallet is not configured", async () => {
    const provider = ledgerProvider();
    const { say } = session({ provider, mode: "ripple_test" });
    const asked = await say(BOOK, { messageId: "book" });
    expect(asked.reply).toBe("I found the $100 deposit, but I don't have a payment destination for Ripple Bistro.");
    expect(provider.sendPayment).not.toHaveBeenCalled();
  });
});

/** Ledger double whose balances move only when the provider actually sends. */
function fakeLedger(provider: ReturnType<typeof ledgerProvider>, options?: { skewRecipient?: boolean }) {
  const balances = new Map([
    [SENDER, 1_000_000_000n],
    [MERCHANT, 50_000_000n],
  ]);
  let applied = 0;
  const settle = () => {
    for (const call of provider.sendPayment.mock.calls.slice(applied)) {
      const drops = BigInt(Math.round(call[0].amountUsd * 1_000_000));
      balances.set(SENDER, balances.get(SENDER)! - drops - 12n);
      balances.set(MERCHANT, balances.get(MERCHANT)! + drops + (options?.skewRecipient ? 1n : 0n));
    }
    applied = provider.sendPayment.mock.calls.length;
  };
  return {
    async balanceDrops(address: string) {
      settle();
      return String(balances.get(address) ?? 0n);
    },
    async transaction(hash: string): Promise<LedgerTransactionView | null> {
      const call = provider.sendPayment.mock.calls[0]?.[0];
      if (!call) return null;
      return {
        hash,
        validated: true,
        engineResult: "tesSUCCESS",
        account: SENDER,
        destination: call.destination,
        deliveredDrops: String(Math.round(call.amountUsd * 1_000_000)),
        feeDrops: "12",
        ledgerIndex: 123,
      };
    },
    dashboardLedger: {
      networkId: 1,
      async prepare() {},
      async getBalanceDrops(address: string) {
        return String(balances.get(address) ?? 0n);
      },
      async getTransaction(hash: string) {
        return { hash, validated: true, engineResult: "tesSUCCESS", ledgerIndex: 123 };
      },
    },
  };
}

describe("restaurant deposits on the website XRPL dashboard", () => {
  const registry = { listPublic: () => [] };

  it("lists a ledger-verified Ripple Bistro deposit with its hash and no secrets", async () => {
    const provider = ledgerProvider();
    const ledger = fakeLedger(provider);
    const audit = new PaymentAuditLog();
    const { say, active } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
      audit,
      ledger,
    });
    await say(BOOK, { messageId: "book" });
    await say("Yes", { messageId: "yes" });
    expect(active()?.status).toBe("BOOKED");
    const dashboard = await new XrplDashboardBuilder({
      registry,
      audit,
      ledger: ledger.dashboardLedger as never,
      secrets: () => [],
    }).build();
    expect(dashboard.transactions).toEqual([
      expect.objectContaining({
        paymentId: active()?.deposit?.requirement?.obligationId,
        mode: "confirmed",
        sender: { name: "Rohan (Photon wallet)", address: SENDER },
        recipient: { name: "Ripple Bistro (reservation deposit)", address: MERCHANT },
        amount: { xrp: "100", drops: "100000000", requestedUsd: 100 },
        transactionHash: TX,
        engineResult: "tesSUCCESS",
        verifiedOnLedger: true,
        explorerUrl: `https://testnet.xrpl.org/transactions/${TX}`,
        recipientKind: "merchant",
      }),
    ]);
    expect(dashboard.transactions[0]?.policy?.checks).toContainEqual({ code: "HUMAN_AUTHORIZATION", passed: true });
    expect(dashboard.guardrails).toEqual([]);
  });

  it("shows a guardrail DENY and writes no transaction evidence", async () => {
    const provider = ledgerProvider();
    const ledger = fakeLedger(provider);
    const audit = new PaymentAuditLog();
    const { say } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
      maxUsd: 50,
      audit,
      ledger,
    });
    await say(BOOK, { messageId: "book" });
    await say("Yes", { messageId: "yes" });
    const dashboard = await new XrplDashboardBuilder({ registry, audit, ledger: ledger.dashboardLedger as never, secrets: () => [] }).build();
    expect(dashboard.transactions).toEqual([]);
    expect(dashboard.guardrails).toEqual([
      expect.objectContaining({ recipientName: "Ripple Bistro", requestedUsd: 100, submittedToLedger: false, transactionHash: null }),
    ]);
    expect(dashboard.guardrails[0]?.reasonCode).toMatch(/MAX|LIMIT/);
  });

  it("does not list a deposit whose balance changes do not match the transaction", async () => {
    const provider = ledgerProvider();
    const ledger = fakeLedger(provider, { skewRecipient: true });
    const audit = new PaymentAuditLog();
    const { say, active } = session({
      provider,
      mode: "ripple_test",
      merchantsJson: JSON.stringify({ "Ripple Bistro": MERCHANT }),
      audit,
      ledger,
    });
    await say(BOOK, { messageId: "book" });
    await say("Yes", { messageId: "yes" });
    expect(active()?.status).toBe("BOOKED");
    expect(audit.snapshot().evidence).toEqual([]);
    expect(audit.snapshot().policyRecords.map((record) => record.decision)).toEqual(["ALLOW"]);
  });
});

describe("payment trace endpoint", () => {
  it("serves traces to direct local requests only and requires a space id", async () => {
    const { say, orchestrator } = session();
    await say(BOOK, { messageId: "book" });
    await say("Yes", { messageId: "yes" });
    const server = await startWebhookServer(
      0,
      (body, signature) => orchestrator.handleWebhook(body, signature),
      (path, query) => paymentTraceRoute(orchestrator, path, query),
    );
    try {
      const base = `http://127.0.0.1:${server.port}/reservations/payments`;
      const local = await fetch(`${base}?spaceId=space-a`);
      expect(local.status).toBe(200);
      const body = (await local.json()) as { traces: { restaurant: string; amountUsd: number; reservationStatus: string }[] };
      expect(body.traces).toEqual([expect.objectContaining({ restaurant: "Ripple Bistro", amountUsd: 100, reservationStatus: "BOOKED" })]);
      expect((await fetch(base)).status).toBe(400);
      expect((await fetch(`${base}?spaceId=space-b`).then((res) => res.json())) as unknown).toEqual({ traces: [] });
      const tunneled = await fetch(`${base}?spaceId=space-a`, { headers: { "X-Forwarded-For": "203.0.113.9" } });
      expect(tunneled.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("deposits stated by a restaurant on an ElevenLabs call", () => {
  it("captures a grounded phone deposit, asks, pays through the same port, and calls back to finish", async () => {
    const { say, provider, notes, active, caller } = session({ scenario: "deposit_required" });
    const asked = await say("Book Carbone for 4 tomorrow at 8 under Rohan, exactly 8.", { messageId: "book" });
    expect(asked.reply).toMatch(/Want me to call/i);
    await say("Yes", { messageId: "call-yes" });
    await vi.waitFor(() => expect(notes.length).toBeGreaterThan(0));
    expect(notes.at(-1)?.text).toBe(
      "Carbone can hold 4 tomorrow at 8:00 PM, but they require a $100 deposit first. Want me to pay the $100 deposit and book it?",
    );
    expect(sends(provider)).toBe(0);
    expect(active()?.deposit?.requirement).toMatchObject({ source: "phone", amountUsd: 100, recipient: "mock:merchant:carbone" });
    const paid = await say("Yes", { messageId: "pay-yes" });
    expect(sends(provider)).toBe(1);
    expect(caller.calls).toHaveLength(2);
    expect(paid.reply).toBe("Booked Carbone for 4 tomorrow at 8:00 PM. The $100 deposit was a mock test payment, so no XRPL transaction was sent.");
    expect(active()?.status).toBe("BOOKED");
    expect(active()?.deposit?.state).toBe("RESERVATION_CONFIRMED");
  });

  it("ignores a deposit amount the restaurant never said", () => {
    const reservation = { id: "r1", photonSpaceId: "s", partySize: 4, requestedTime: "20:00", restaurant: { name: "Carbone" } } as Parameters<
      typeof interpretCompletion
    >[0];
    const result = interpretCompletion(reservation, {
      type: "post_call_transcription",
      conversationId: "c1",
      transcript: [
        { role: "agent", message: "Table for 4 at 8?" },
        { role: "user", message: "We need a deposit to hold it." },
      ],
      collected: { outcome: "NEEDS_USER_INPUT", deposit_required: "true", deposit_amount_usd: "500" },
    });
    expect(result.paymentRequired).toBeUndefined();
    const grounded = interpretCompletion(reservation, {
      type: "post_call_transcription",
      conversationId: "c2",
      transcript: [
        { role: "agent", message: "Table for 4 at 8?" },
        { role: "user", message: "Yes, with a 100 dollars deposit." },
      ],
      collected: { outcome: "NEEDS_USER_INPUT", deposit_required: "yes", deposit_amount_usd: "$100" },
    });
    expect(grounded.paymentRequired).toEqual({ paymentType: "DEPOSIT", amountUsd: 100, perPersonUsd: undefined });
  });

  it("a restaurant mention alone still does not start a call or a payment", async () => {
    const { say, provider, caller } = session();
    const reply = await say("Ripple Bistro was great last week", { messageId: "mention" });
    expect(reply.outcome).not.toBe("reservation");
    expect(caller.calls).toHaveLength(0);
    expect(sends(provider)).toBe(0);
  });
});
