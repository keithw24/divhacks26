import { describe, expect, it } from "vitest";
import { runConversationTurn } from "../src/agent/turn.js";
import { classifyLedgerMessage, ledgerInterrupts } from "../src/ledger/intent.js";
import { netBalances, settleTransfers, splitEven } from "../src/ledger/math.js";
import { LedgerService } from "../src/ledger/service.js";
import { createLedgerStore } from "../src/ledger/store.js";
import { MockPaymentProvider } from "../src/payments/mock.js";
import { loadRecipientDirectory } from "../src/payments/recipients.js";
import { PaymentService } from "../src/payments/service.js";

const people = [
  { id: "p-rohan", displayName: "Rohan" },
  { id: "p-maya", displayName: "Maya" },
  { id: "p-ben", displayName: "Ben" },
  { id: "p-agent", displayName: "Agent" },
];

describe("group ledger intent", () => {
  it("logs self expenses and named payers, not person-to-person sends", () => {
    expect(classifyLedgerMessage("I paid $40 for the Uber")).toMatchObject({
      kind: "expense",
      payer: "me",
      memo: "the Uber",
    });
    expect(classifyLedgerMessage("Keith paid $80 for dinner").kind).toBe("expense");
    expect(classifyLedgerMessage("I paid Keith $20").kind).toBe("none");
    expect(classifyLedgerMessage("Send Keith $20").kind).toBe("none");
    expect(ledgerInterrupts("let's settle")).toBe(true);
    expect(ledgerInterrupts("who owes what")).toBe(true);
    expect(ledgerInterrupts("pay everyone $20")).toBe(true);
    expect(ledgerInterrupts("Send Keith $20")).toBe(false);
  });
});

describe("group ledger math", () => {
  it("splits remainders and settles the fewest transfers", () => {
    const members = [
      { key: "a", name: "Rohan" },
      { key: "b", name: "Maya" },
      { key: "c", name: "Ben" },
    ];
    expect(splitEven(100, members).map((row) => row.cents)).toEqual([34, 33, 33]);
    const net = netBalances(members, [
      {
        kind: "expense",
        payerKey: "a",
        amountCents: 9000,
        shares: [
          { key: "a", cents: 3000 },
          { key: "b", cents: 3000 },
          { key: "c", cents: 3000 },
        ],
      },
      { kind: "transfer", payerKey: "b", payeeKey: "a", amountCents: 3000 },
    ]);
    expect(settleTransfers(members, net)).toEqual([
      { fromKey: "c", fromName: "Ben", toKey: "a", toName: "Rohan", cents: 3000 },
    ]);
  });
});

describe("group ledger service", () => {
  it("splits a logged cost, records payouts quietly, and only speaks on settle", async () => {
    const ledger = new LedgerService({ store: createLedgerStore() });
    const spaceId = "group-1";
    const logged = await ledger.handleTurn({
      spaceId,
      senderId: "p-rohan",
      senderName: "Rohan",
      text: "I paid $40 for the Uber",
      participants: people,
    });
    expect(logged.reply).toContain("Logged $40 for the Uber on Rohan");
    expect(logged.reply).toContain("split 3 ways");
    expect(logged.reply).toContain("Ask me to settle up");

    await ledger.recordSettledPayment({
      spaceId,
      fromName: "Maya",
      toName: "Rohan",
      amountUsd: 10,
      paymentId: "pay-maya",
    });
    await ledger.recordSettledPayment({
      spaceId,
      fromName: "Maya",
      toName: "Rohan",
      amountUsd: 10,
      paymentId: "pay-maya",
    });

    const mid = await ledger.handleTurn({
      spaceId,
      senderId: "p-ben",
      senderName: "Ben",
      text: "settle up",
      participants: people,
    });
    expect(mid.reply).toContain("Ben → Rohan $13.33");
    expect(mid.reply).toContain("Maya → Rohan $3.33");
    expect(mid.reply).toContain("I didn't send anything");
    expect(mid.reply).toContain("confirm with yes");

    await ledger.recordSettledPayment({
      spaceId,
      fromName: "Ben",
      toName: "Rohan",
      amountUsd: 13.33,
      paymentId: "pay-ben",
    });
    await ledger.recordSettledPayment({
      spaceId,
      fromName: "Maya",
      toName: "Rohan",
      amountUsd: 3.33,
      paymentId: "pay-maya-2",
    });
    const done = await ledger.handleTurn({
      spaceId,
      senderId: "p-rohan",
      senderName: "Rohan",
      text: "are we even?",
      participants: people,
    });
    expect(done.reply).toBe("You're all even.");
  });

  it("does not invent a split when the chat only has one person", async () => {
    const ledger = new LedgerService();
    const result = await ledger.handleTurn({
      spaceId: "solo",
      senderId: "p-rohan",
      senderName: "Rohan",
      text: "I paid $40",
      participants: [{ id: "p-rohan", displayName: "Rohan" }],
    });
    expect(result.reply).toContain("I only see you");
  });

  it("uses Tiger when a query function is provided", async () => {
    const rows: Record<string, unknown>[] = [];
    const sqls: string[] = [];
    const ledger = new LedgerService({
      store: createLedgerStore(async (sql, params) => {
        sqls.push(sql);
        if (/^INSERT/i.test(sql)) {
          rows.push({
            id: params?.[0],
            space_id: params?.[1],
            created_at: params?.[2],
            kind: params?.[3],
            payer_key: params?.[4],
            payer_name: params?.[5],
            amount_cents: params?.[6],
            memo: params?.[7],
            payee_key: params?.[8],
            payee_name: params?.[9],
            shares: params?.[10],
            payment_id: params?.[11],
            explorer_url: params?.[12],
          });
        }
        return { rows: /SELECT/i.test(sql) ? rows : [], rowCount: 1 };
      }),
    });
    await ledger.handleTurn({
      spaceId: "tiger-space",
      senderId: "p-rohan",
      senderName: "Rohan",
      text: "I paid $20 for snacks",
      participants: people,
    });
    expect(sqls.some((sql) => sql.includes("group_night_ledger"))).toBe(true);
    const status = await ledger.handleTurn({
      spaceId: "tiger-space",
      senderId: "p-maya",
      senderName: "Maya",
      text: "who owes",
      participants: people,
    });
    expect(status.reply).toContain("Still open");
  });
});

describe("Photon turn ledger branch", () => {
  it("answers settle up without Gemini", async () => {
    const ledger = new LedgerService();
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: "group-1",
        senderId: "p-maya",
        senderName: "Maya",
        direction: "inbound",
        isGroup: true,
        question: "settle up",
      },
      {
        reply: async (text) => {
          replies.push(text);
        },
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        handleLedger: (input) => ledger.handleTurn({ ...input, participants: people }),
        suggest: async () => "should not run",
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );
    expect(outcome).toBe("ledger");
    expect(replies).toEqual(["Nothing on the ledger yet."]);
  });

  it("never submits a transfer from settle-up or pay-everyone", async () => {
    const ledger = new LedgerService();
    const provider = new MockPaymentProvider();
    const payments = new PaymentService({
      provider,
      directory: loadRecipientDirectory(),
    });
    await ledger.handleTurn({
      spaceId: "group-pay",
      senderId: "p-rohan",
      senderName: "Rohan",
      text: "I paid $40 for the Uber",
      participants: people,
    });
    await payments.handleTurn({
      spaceId: "group-pay",
      senderId: "p-maya",
      senderName: "Maya",
      text: "Send Keith $20",
    });

    const paymentCalls: string[] = [];
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: "group-pay",
        senderId: "p-maya",
        senderName: "Maya",
        direction: "inbound",
        isGroup: true,
        question: "pay everyone $20",
      },
      {
        reply: async (text) => {
          replies.push(text);
        },
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        handlePayment: (input) => {
          paymentCalls.push(input.text);
          return payments.handleTurn(input);
        },
        handleLedger: (input) => ledger.handleTurn({ ...input, participants: people }),
        suggest: async () => "should not run",
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );

    expect(outcome).toBe("ledger");
    expect(paymentCalls).toEqual([]);
    expect(provider.calls).toEqual([]);
    expect(replies[0]).toContain("I didn't send anything");
    expect(payments.payments.active("group-pay")?.status).toBe("AWAITING_CONFIRMATION");
  });
});
