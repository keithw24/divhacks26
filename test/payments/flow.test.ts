import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runConversationTurn } from "../../src/agent/turn.js";
import { classifyPaymentMessage, paymentInterrupts } from "../../src/payments/intent.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { DEFAULT_TEST_RECIPIENTS, loadRecipientDirectory } from "../../src/payments/recipients.js";
import { sanitizeExtraction } from "../../src/payments/gemini.js";
import { confirmationText } from "../../src/payments/format.js";
import { PaymentService } from "../../src/payments/service.js";
import { PaymentStore } from "../../src/payments/state.js";
import type { PaymentInterpreter, PaymentTurnInput, PaymentTurnResult } from "../../src/payments/types.js";
import { harness } from "../reservations/support.js";
import { lookupGazetteer } from "../../src/transport/locations.js";
import { extractTransportIntent } from "../../src/transport/intent.js";
import { createTransportationService } from "../../src/transport/service.js";
import { createFileStateStore } from "../../src/store/state.js";

function setup(options?: { maxUsd?: number; timeoutMs?: number; provider?: MockPaymentProvider; interpreter?: PaymentInterpreter }) {
  const provider = options?.provider ?? new MockPaymentProvider();
  const service = new PaymentService({
    provider,
    directory: loadRecipientDirectory(),
    maxUsd: options?.maxUsd,
    timeoutMs: options?.timeoutMs,
    interpreter: options?.interpreter,
  });
  async function say(spaceId: string, text: string, extra?: Partial<PaymentTurnInput>): Promise<PaymentTurnResult> {
    return service.handleTurn({
      spaceId,
      senderId: extra?.senderId ?? "rohan-id",
      senderName: extra?.senderName ?? "Rohan",
      text,
      messageId: extra?.messageId,
      recentTexts: extra?.recentTexts,
    });
  }
  return { service, provider, say };
}

const ask = (name: string, amountUsd: number, memo: string | null = null) =>
  confirmationText({ recipientName: name, amountUsd, memo });

describe("payment intent", () => {
  it("parses send, pay, and give requests", () => {
    expect(classifyPaymentMessage("Send Keith $20")).toMatchObject({
      kind: "request",
      recipientName: "Keith",
      memo: null,
    });
    expect(classifyPaymentMessage("Send Keith $20 for Uber")).toMatchObject({
      kind: "request",
      recipientName: "Keith",
      memo: "Uber",
    });
    expect(classifyPaymentMessage("Send Keith $20 for the Uber.")).toMatchObject({
      recipientName: "Keith",
      memo: "the Uber",
    });
    expect(classifyPaymentMessage("Pay Keith twenty dollars")).toMatchObject({
      kind: "request",
      recipientName: "Keith",
      memo: null,
    });
    expect(classifyPaymentMessage("Give Ben $15 for dinner")).toMatchObject({
      recipientName: "Ben",
      memo: "dinner",
    });
    expect(classifyPaymentMessage("Can you pay Ben $15 for dinner?")).toMatchObject({
      recipientName: "Ben",
      memo: "dinner",
    });
    expect(classifyPaymentMessage("Give Sarah $8 for coffee")).toMatchObject({
      recipientName: "Sarah",
      memo: "coffee",
    });
    expect(classifyPaymentMessage("Send him $10")).toMatchObject({ recipientName: "him" });
    expect(classifyPaymentMessage("Pay her $25")).toMatchObject({ recipientName: "her" });
  });

  it("does not treat ride, fare, or past-tense questions as payments", () => {
    expect(classifyPaymentMessage("Get me an Uber to Times Square").kind).toBe("none");
    expect(classifyPaymentMessage("How much would an Uber to Times Square cost?").kind).toBe("none");
    expect(classifyPaymentMessage("Uber costs $20").kind).toBe("none");
    expect(classifyPaymentMessage("How much did Keith pay?").kind).toBe("none");
    expect(classifyPaymentMessage("Book Carbone").kind).toBe("none");
    expect(classifyPaymentMessage("Send Keith a message").kind).toBe("none");
  });

  it("parses personal payment max commands", () => {
    expect(classifyPaymentMessage("Set my payment max to $10")).toMatchObject({
      kind: "set_max",
      amount: { ok: true, value: 10 },
    });
    expect(classifyPaymentMessage("Don't let me send more than $25")).toMatchObject({
      kind: "set_max",
      amount: { ok: true, value: 25 },
    });
    expect(classifyPaymentMessage("Set my max to $10")).toMatchObject({
      kind: "set_max",
      amount: { ok: true, value: 10 },
    });
    expect(classifyPaymentMessage("Cap my payments at $30")).toMatchObject({
      kind: "set_max",
      amount: { ok: true, value: 30 },
    });
    expect(classifyPaymentMessage("What's my payment max?")).toMatchObject({ kind: "query_max" });
    expect(paymentInterrupts("Set my payment max to $10")).toBe(true);
    expect(classifyPaymentMessage("that's wrong").kind).toBe("dispute");
    expect(classifyPaymentMessage("that's $15")).toMatchObject({ kind: "change" });
  });
});

describe("confirmation flow", () => {
  it("asks before sending Keith $20 and does not execute", async () => {
    const { say, provider, service } = setup();
    const reply = await say("space", "Send Keith $20");
    expect(reply.reply).toBe(ask("Keith", 20));
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")?.status).toBe("AWAITING_CONFIRMATION");
    expect(service.payments.active("space")?.destination).toBe(DEFAULT_TEST_RECIPIENTS.Keith?.rippleDestination);
  });

  it("keeps the Uber memo in the confirmation", async () => {
    const { say, provider } = setup();
    const reply = await say("space", "Send Keith $20 for the Uber.");
    expect(reply.reply).toBe(ask("Keith", 20, "the Uber"));
    expect(provider.calls).toHaveLength(0);
  });

  it("parses twenty dollars and dinner", async () => {
    const { say, provider } = setup();
    expect((await say("a", "Pay Keith twenty dollars")).reply).toBe(ask("Keith", 20));
    expect((await say("b", "Give Ben $15 for dinner")).reply).toBe(ask("Ben", 15, "dinner"));
    expect(provider.calls).toHaveLength(0);
  });

  it("executes only after yes", async () => {
    const { say, provider, service } = setup();
    await say("space", "Send Keith $20 for the Uber.");
    const sent = await say("space", "Yes");
    expect(sent.reply).toMatch(/^Sent \$20 to Keith for the Uber\. XRPL Testnet: https:\/\/testnet\.xrpl\.org\/transactions\/[A-F0-9]+$/);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.amountUsd).toBe(20);
    expect(provider.calls[0]?.destination).toBe(DEFAULT_TEST_RECIPIENTS.Keith?.rippleDestination);
    expect(provider.calls[0]?.memo).toBe("the Uber");
    expect(service.payments.active("space")?.status).toBe("SUCCEEDED");
  });

  it("cancels on no without sending", async () => {
    const { say, provider, service } = setup();
    await say("space", "Send Keith $20");
    const cancelled = await say("space", "no");
    expect(cancelled.reply).toBe("Okay, I won't send it.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
    const later = await say("space", "yes");
    expect(later.handled).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("changes the amount and requires a new confirmation", async () => {
    const { say, provider, service } = setup();
    await say("space", "Send Keith $20 for the Uber.");
    const changed = await say("space", "Actually make it $15.");
    expect(changed.reply).toBe(ask("Keith", 15, "the Uber"));
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")?.status).toBe("AWAITING_CONFIRMATION");
    expect(service.payments.active("space")?.amountUsd).toBe(15);
    const sent = await say("space", "yes");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.amountUsd).toBe(15);
    expect(sent.reply).toMatch(/Sent \$15 to Keith/);
  });

  it("flags the amount, accepts a correction, and cancels without sending", async () => {
    const { say, provider, service } = setup();
    const pending = await say("space", "Send Keith $20");
    expect(pending.reply).toMatch(/I'm about to send Keith \$20/);
    expect(pending.reply).toMatch(/Confirm \$20/);
    expect(service.payments.active("space")?.amountUsd).toBe(20);

    const disputed = await say("space", "that's wrong");
    expect(disputed.reply).toMatch(/Tracked amount is still \$20/);
    expect(service.payments.active("space")?.confirmationPhase).toBe("awaiting_correction");
    expect(provider.calls).toHaveLength(0);

    const blocked = await say("space", "yes");
    expect(blocked.reply).toMatch(/What should I send Keith/);
    expect(provider.calls).toHaveLength(0);

    const corrected = await say("space", "$12");
    expect(corrected.reply).toBe(ask("Keith", 12));
    expect(service.payments.active("space")?.amountUsd).toBe(12);
    expect(service.payments.active("space")?.confirmationPhase).toBe("confirm_amount");

    const cancelled = await say("space", "cancel");
    expect(cancelled.reply).toBe("Okay, I won't send it.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
  });

  it("rejects an unknown recipient and does not invent a destination", async () => {
    const { say, provider, service } = setup();
    const reply = await say("space", "Send Alex $10");
    expect(reply.reply).toBe("I don't have a payment destination for Alex yet.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
  });

  it.each([
    ["Send Keith $0", "I can only send a positive amount."],
    ["Send Keith -$5", "I can only send a positive amount."],
    ["Send Keith $-5", "I can only send a positive amount."],
    ["Send Keith $abc", "I didn't catch the amount."],
    ["Send Keith $20.555", "I didn't catch the amount."],
    ["Send Keith NaN dollars", "I didn't catch the amount."],
  ])("rejects %s", async (text, expected) => {
    const { say, provider } = setup();
    const reply = await say("space", text);
    expect(reply.reply).toBe(expected);
    expect(reply.handled).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects an amount over the sandbox maximum before confirmation", async () => {
    const { say, provider, service } = setup({ maxUsd: 500 });
    const reply = await say("space", "Send Keith $501");
    expect(reply.reply).toBe("I can only send up to $500 at a time.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
  });

  it("lets each sender set a personal max below the process cap", async () => {
    const { say, provider, service } = setup();
    expect((await say("space", "What's my payment max?")).reply).toBe("Your payment max is $500 (the default).");
    expect((await say("space", "Set my payment max to $10")).reply).toBe("Got it. I won't send more than $10 for you.");
    expect((await say("space", "What's my payment max?")).reply).toBe("Your payment max is $10.");
    const blocked = await say("space", "Send Keith $20");
    expect(blocked.reply).toBe("Transaction rejected. I can only send up to $10 at a time — that's your payment max.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
    const other = await say("space-b", "Send Keith $20", { senderId: "ben-id", senderName: "Ben" });
    expect(other.reply).toBe(ask("Keith", 20));
    expect(provider.calls).toHaveLength(0);
  });

  it("cancels a pending send that exceeds a newly lowered max", async () => {
    const { say, provider, service } = setup();
    await say("space", "Send Keith $20");
    const lowered = await say("space", "Set my payment max to $10");
    expect(lowered.reply).toMatch(/^Got it\. I won't send more than \$10 for you\. Transaction rejected\./);
    expect(service.payments.active("space")).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it("does not execute a second time when yes is repeated", async () => {
    const { say, provider } = setup();
    await say("space", "Send Keith $20", { messageId: "req" });
    const first = await say("space", "yes", { messageId: "yes-1" });
    const second = await say("space", "yes", { messageId: "yes-2" });
    expect(first.reply).toMatch(/^Sent \$20/);
    expect(first.reply).toContain("https://testnet.xrpl.org/transactions/");
    expect(second.reply).toMatch(/^Already sent \$20/);
    expect(second.reply).toContain("https://testnet.xrpl.org/transactions/");
    expect(provider.calls).toHaveLength(1);
  });

  it("does not execute a duplicated Photon delivery of the same yes", async () => {
    const { say, provider } = setup();
    await say("space", "Send Keith $20", { messageId: "req" });
    const [first, duplicate] = await Promise.all([
      say("space", "Yes", { messageId: "same-yes" }),
      say("space", "Yes", { messageId: "same-yes" }),
    ]);
    expect(provider.calls).toHaveLength(1);
    expect([first.reply, duplicate.reply].some((reply) => reply?.startsWith("Sent $20"))).toBe(true);
  });

  it("fails closed on a provider timeout and does not retry", async () => {
    const provider = new MockPaymentProvider();
    provider.result = "timeout";
    const { say } = setup({ provider, timeoutMs: 20 });
    await say("space", "Send Keith $20");
    const failed = await say("space", "yes", { messageId: "yes-1" });
    expect(failed.reply).toBe("Transaction rejected. I couldn't send the $20 payment. Nothing was charged.");
    expect(provider.calls).toHaveLength(1);
    const again = await say("space", "yes", { messageId: "yes-2" });
    expect(again.reply).toBe("Transaction rejected. I couldn't send the $20 payment. Nothing was charged.");
    expect(provider.calls).toHaveLength(1);
  });

  it("reports a provider rejection without claiming success", async () => {
    const provider = new MockPaymentProvider();
    provider.result = "reject";
    const { say, service } = setup({ provider });
    await say("space", "Send Keith $20 for Uber");
    const failed = await say("space", "yes");
    expect(failed.reply).toBe("Transaction rejected. I couldn't send the $20 payment. Nothing was charged.");
    expect(service.payments.active("space")?.status).toBe("FAILED");
    expect(provider.calls).toHaveLength(1);
  });

  it("uses mock mode without contacting Ripple", async () => {
    const { say, provider, service } = setup();
    await say("space", "Send Keith $20");
    const sent = await say("space", "confirm");
    expect(sent.reply).toMatch(/XRPL Testnet:/);
    expect(provider.calls).toHaveLength(1);
    expect(service.payments.active("space")?.providerStatus).toBe("tesSUCCESS");
    expect(service.payments.active("space")?.submittedAsset).toBe("XRP");
  });
});

describe("context, isolation, and groups", () => {
  it("resolves him from a clear recent person in this space", async () => {
    const { say, provider } = setup();
    const reply = await say("space", "Send him $10", { recentTexts: ["Keith is on his way"] });
    expect(reply.reply).toBe(ask("Keith", 10));
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects an ambiguous him", async () => {
    const { say, provider, service } = setup();
    const reply = await say("space", "Send him $10", { recentTexts: ["Keith and Ben are both here"] });
    expect(reply.reply).toBe("I'm not sure who you mean.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
  });

  it("does not use another space's person or pending payment", async () => {
    const { say, provider, service } = setup();
    await say("space-a", "Send Keith $20", { messageId: "a-req" });
    const other = await say("space-b", "Yes", { senderId: "rohan-id", messageId: "b-yes" });
    expect(other.handled).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space-a")?.status).toBe("AWAITING_CONFIRMATION");
    const contextual = await say("space-b", "Send him $10");
    expect(contextual.reply).toBe("I'm not sure who you mean.");
    expect(provider.calls).toHaveLength(0);
    const sent = await say("space-a", "yes", { messageId: "a-yes" });
    expect(sent.reply).toMatch(/^Sent \$20/);
    expect(provider.calls).toHaveLength(1);
  });

  it("lets only the initiator confirm", async () => {
    const { say, provider, service } = setup();
    await say("group", "Send Keith $20", { senderId: "rohan-id", senderName: "Rohan", messageId: "req" });
    const ben = await say("group", "yes", { senderId: "ben-id", senderName: "Ben", messageId: "ben-yes" });
    expect(ben.reply).toBe("Only Rohan can confirm that.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("group")?.amountUsd).toBe(20);
    const edited = await say("group", "Actually make it $15", { senderId: "ben-id", senderName: "Ben", messageId: "ben-edit" });
    expect(edited.reply).toBe("Only Rohan can change that.");
    expect(service.payments.active("group")?.amountUsd).toBe(20);
    const rohan = await say("group", "yes", { senderId: "rohan-id", senderName: "Rohan", messageId: "rohan-yes" });
    expect(rohan.reply).toMatch(/^Sent \$20 to Keith/);
    expect(provider.calls).toHaveLength(1);
  });

  it("reloads a pending payment from the agent state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photon-pay-"));
    try {
      const file = join(dir, "agent-state.json");
      const firstStore = createFileStateStore(file);
      const firstProvider = new MockPaymentProvider();
      const first = new PaymentService({
        provider: firstProvider,
        directory: loadRecipientDirectory(),
        store: PaymentStore.open(firstStore),
      });
      await first.handleTurn({
        spaceId: "space",
        senderId: "rohan-id",
        senderName: "Rohan",
        text: "Send Keith $20 for Uber",
        messageId: "req",
      });
      expect(firstProvider.calls).toHaveLength(0);

      const secondProvider = new MockPaymentProvider();
      const second = new PaymentService({
        provider: secondProvider,
        directory: loadRecipientDirectory(),
        store: PaymentStore.open(createFileStateStore(file)),
      });
      expect(second.payments.active("space")?.status).toBe("AWAITING_CONFIRMATION");
      expect(second.payments.active("space")?.amountUsd).toBe(20);
      const sent = await second.handleTurn({
        spaceId: "space",
        senderId: "rohan-id",
        senderName: "Rohan",
        text: "yes",
        messageId: "yes",
      });
      expect(sent.reply).toMatch(/^Sent \$20 to Keith for Uber/);
      expect(secondProvider.calls).toHaveLength(1);
      expect(firstProvider.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads a personal payment max from the agent state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photon-pay-max-"));
    try {
      const file = join(dir, "agent-state.json");
      const first = new PaymentService({
        provider: new MockPaymentProvider(),
        directory: loadRecipientDirectory(),
        store: PaymentStore.open(createFileStateStore(file)),
      });
      await first.handleTurn({
        spaceId: "space",
        senderId: "rohan-id",
        text: "Set my payment max to $10",
        messageId: "set",
      });

      const provider = new MockPaymentProvider();
      const second = new PaymentService({
        provider,
        directory: loadRecipientDirectory(),
        store: PaymentStore.open(createFileStateStore(file)),
      });
      const lookup = await second.handleTurn({
        spaceId: "space",
        senderId: "rohan-id",
        text: "What's my payment max?",
        messageId: "ask",
      });
      expect(lookup.reply).toBe("Your payment max is $10.");
      const blocked = await second.handleTurn({
        spaceId: "space",
        senderId: "rohan-id",
        text: "Send Keith $20",
        messageId: "pay",
      });
      expect(blocked.reply).toMatch(/^Transaction rejected\./);
      expect(provider.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("model extraction cannot send", () => {
  it("turns a model extraction into a pending payment and ignores any destination", async () => {
    const interpreter: PaymentInterpreter = {
      async extract() {
        return { intent: "SEND_PAYMENT", recipientName: "Keith", amountUsd: 20, memo: "Uber" };
      },
    };
    expect(sanitizeExtraction({ intent: "SEND_PAYMENT", recipientName: "Keith", amountUsd: 20, destination: "rFake" }).intent).toBe(
      "SEND_PAYMENT",
    );
    const { say, provider } = setup({ interpreter });
    const reply = await say("space", "Could you possibly transfer twenty bucks to Keith for the ride?");
    expect(reply.reply).toBe(ask("Keith", 20, "Uber"));
    expect(provider.calls).toHaveLength(0);
    const sent = await say("space", "yes");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.destination).toBe(DEFAULT_TEST_RECIPIENTS.Keith?.rippleDestination);
  });

  it("rejects a model amount that does not match the message", async () => {
    const interpreter: PaymentInterpreter = {
      async extract() {
        return { intent: "SEND_PAYMENT", recipientName: "Keith", amountUsd: 200, memo: "Uber" };
      },
    };
    const { say, provider, service } = setup({ interpreter });
    const reply = await say("space", "Could you possibly transfer twenty bucks to Keith for the ride?");
    expect(reply.reply).toBe("Transaction rejected. That amount doesn't match what you wrote. Nothing was sent.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
  });

  it("does not open a payment when the message has two dollar amounts", async () => {
    const { say, provider, service } = setup();
    const reply = await say("space", "Send Keith $20 for the $15 Uber");
    expect(reply.reply).toBe("Transaction rejected. I see more than one amount. Tell me exactly how much to send.");
    expect(provider.calls).toHaveLength(0);
    expect(service.payments.active("space")).toBeUndefined();
  });

  it("rejects a negative amount from the model", async () => {
    const interpreter: PaymentInterpreter = {
      async extract() {
        return { intent: "SEND_PAYMENT", recipientName: "Keith", amountUsd: -5, memo: null };
      },
    };
    const { say, provider } = setup({ interpreter });
    const reply = await say("space", "transfer Keith -5 dollars somehow");
    expect(reply.reply).toBe("I can only send a positive amount.");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("dispatcher precedence", () => {
  function world() {
    const provider = new MockPaymentProvider();
    const payments = new PaymentService({ provider, directory: loadRecipientDirectory() });
    const reservations = harness().orchestrator;
    const transport = createTransportationService({
      resolver: { resolve: async (query) => lookupGazetteer(query) },
    });
    const sink: string[] = [];
    async function turn(text: string) {
      const outcome = await runConversationTurn(
        { spaceId: "route", senderId: "rohan-id", senderName: "Rohan", direction: "inbound", isGroup: false, question: text, messageId: text },
        {
          reply: async (reply) => {
            sink.push(reply);
            return { id: "r" };
          },
          responding: async (fn) => fn(),
        },
        {
          autoReply: true,
          handleTransport: (request) => transport.handle(request),
          suggest: async () => "gemini",
          transcript: () => [],
          recordAssistant: () => undefined,
          handleReservation: (request) => reservations.handleTurn(request),
          handlePayment: (request) => payments.handleTurn(request),
        },
      );
      return { outcome, reply: sink.at(-1), provider, sink };
    }
    return { turn, provider };
  }

  it("sends a payment request to payments", async () => {
    const { turn, provider } = world();
    const result = await turn("Send Keith $20 for Uber");
    expect(result.outcome).toBe("payment");
    expect(result.reply).toBe(ask("Keith", 20, "Uber"));
    expect(provider.calls).toHaveLength(0);
  });

  it("sets a personal payment max without Gemini", async () => {
    const { turn, provider } = world();
    const result = await turn("Set my payment max to $15");
    expect(result.outcome).toBe("payment");
    expect(result.reply).toBe("Got it. I won't send more than $15 for you.");
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps an Uber ride on transportation", async () => {
    const { turn, provider } = world();
    expect(extractTransportIntent("Get me an Uber to Times Square").isTransport).toBe(true);
    const result = await turn("Get me an Uber to Times Square");
    expect(result.outcome).toBe("transport");
    expect(result.reply).not.toMatch(/Send Keith/);
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps an Uber fare question on transportation", async () => {
    const { turn, provider } = world();
    expect(extractTransportIntent("How much would an Uber to Times Square cost?").isTransport).toBe(true);
    expect(extractTransportIntent("How much would an Uber to Times Square cost?").destinationQuery).toBe("Times Square");
    const result = await turn("How much would an Uber to Times Square cost?");
    expect(result.outcome).toBe("transport");
    expect(provider.calls).toHaveLength(0);
  });

  it("does not treat a price mention or a past payment as a transfer", async () => {
    const { turn, provider } = world();
    const cost = await turn("Uber costs $20");
    expect(cost.outcome).toBe("gemini");
    expect(cost.reply).toBe("gemini");
    const past = await turn("How much did Keith pay?");
    expect(past.outcome).toBe("gemini");
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps a restaurant booking on reservations", async () => {
    const { turn, provider } = world();
    const result = await turn("Book Carbone");
    expect(result.outcome).toBe("reservation");
    expect(result.reply).not.toMatch(/^Send /);
    expect(provider.calls).toHaveLength(0);
  });
});
