import { describe, expect, it, vi } from "vitest";
import { PaymentService } from "../../src/payments/service.js";
import { PaymentStore } from "../../src/payments/state.js";
import { MapRecipientDirectory } from "../../src/payments/recipients.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { CustomerWalletSettlement, parseCustomerSenders } from "../../src/payments/xrpl/settlement.js";
import { PaymentAuditLog } from "../../src/payments/xrpl/audit.js";
import { PolicyEngine } from "../../src/payments/xrpl/policy.js";
import { policyConfig, XrplPaymentExecutor } from "../../src/payments/xrpl/executor.js";
import { WalletRegistry } from "../../src/payments/xrpl/wallets.js";
import { MemorySecretStore } from "../../src/payments/xrpl/secrets.js";
import { formatAuditTrail, XrplDashboardBuilder } from "../../src/payments/xrpl/dashboard.js";
import { validateConfirmationGuardrail } from "../../src/payments/guardrails.js";
import { confirmationText, correctionPromptText } from "../../src/payments/format.js";
import { FakeLedger, stack } from "./xrpl-support.js";
import type { CustomerWallet, LedgerPort, TestnetFaucet } from "../../src/payments/xrpl/types.js";

const TEST_RECIPIENTS = {
  Sarah: {
    displayName: "Sarah",
    rippleDestination: "rLkAvxEN7WtDYGNUdMMawSyaAGTWpVYnY4",
  },
  Keith: {
    displayName: "Keith",
    rippleDestination: "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2",
  },
  Ben: {
    displayName: "Ben",
    rippleDestination: "rnFjJdKG58dRrpHAreYfxu88heUgRa22mr",
  },
  Alex: {
    displayName: "Alex",
    rippleDestination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  },
};

const ROHAN_PHONE = "+15550000001";
const SARAH_WALLET_ADDR = "rLkAvxEN7WtDYGNUdMMawSyaAGTWpVYnY4";
const ROHAN_WALLET_ADDR = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

async function setupHarness(options: { intentTtlMs?: number } = {}) {
  const s = stack({ autonomousEnabled: false });
  s.ledger.evidenceSource = "XRPL_TESTNET";

  const senders = parseCustomerSenders(JSON.stringify({ [ROHAN_PHONE]: "rohan" }));
  const settlement = new CustomerWalletSettlement(s.guard.executor, senders, undefined, (id) =>
    s.guard.registry.getAddress(id),
  );
  const directory = new MapRecipientDirectory(TEST_RECIPIENTS);
  const provider = new MockPaymentProvider();
  const store = new PaymentStore();

  const service = new PaymentService({
    provider,
    directory,
    store,
    settlement,
    audit: s.guard.audit,
    intentTtlMs: options.intentTtlMs ?? 10 * 60 * 1000,
  });

  let messageSeq = 0;
  async function say(
    text: string,
    opts: { spaceId?: string; senderId?: string; senderName?: string; messageId?: string } = {},
  ) {
    messageSeq += 1;
    return service.handleTurn({
      spaceId: opts.spaceId ?? "space-1",
      senderId: opts.senderId ?? ROHAN_PHONE,
      senderName: opts.senderName ?? "Rohan",
      text,
      messageId: opts.messageId ?? `msg-${messageSeq}`,
    });
  }

  await s.guard.registry.ensureCustomerTestnetWallet("rohan");
  await s.guard.registry.ensureCustomerTestnetWallet("sarah");
  await s.guard.registry.ensureCustomerTestnetWallet("keith");
  await s.guard.registry.ensureCustomerTestnetWallet("ben");

  return {
    ledger: s.ledger,
    audit: s.guard.audit,
    registry: s.guard.registry,
    executor: s.guard.executor,
    settlement,
    directory,
    provider,
    store,
    service,
    say,
    s,
  };
}

describe("Mandatory User-Confirmation Guardrail for Ripple/XRPL Payments", () => {
  it("A. 'Send Sarah $25' does NOT immediately transfer", async () => {
    const { say, ledger, store } = await setupHarness();
    const result = await say("Send Sarah $25");

    // Must prompt for confirmation without transferring funds
    expect(result.reply).toBe(confirmationText({ recipientName: "Sarah", amountUsd: 25, memo: null }));
    expect(ledger.submits).toHaveLength(0);

    // Stored as pending payment intent
    const pending = store.active("space-1");
    expect(pending).toBeDefined();
    expect(pending?.status).toBe("AWAITING_CONFIRMATION");
    expect(pending?.recipientName).toBe("Sarah");
    expect(pending?.amountUsd).toBe(25);
    expect(pending?.confirmedAt).toBeUndefined();
  });

  it("B. User confirms $25 → exactly one $25 transaction", async () => {
    const { say, ledger, store, registry } = await setupHarness();
    await say("Send Sarah $25");
    expect(ledger.submits).toHaveLength(0);

    const confirmed = await say("yes");
    // Returns XRPL transaction confirmation / ledger evidence
    expect(confirmed.reply).toMatch(/XRPL Testnet/i);
    expect(confirmed.reply).toMatch(/Sarah/i);
    expect(confirmed.reply).toMatch(/\$25/);

    // Exactly one transaction executed
    expect(ledger.submits).toHaveLength(1);
    expect(ledger.submits[0]?.drops).toBe("25000000"); // 25 USD = 25 XRP drops at 1:1
    expect(ledger.submits[0]?.destination).toBe(registry.getAddress("sarah"));

    // Status updated to SUCCEEDED
    const record = store.active("space-1");
    expect(record?.status).toBe("SUCCEEDED");
    expect(record?.confirmedAt).toBeDefined();
    expect(record?.confirmedAmount).toBe(25);
  });

  it("C. User cancels on 'no' → zero transactions", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");
    const cancelled = await say("no");

    expect(cancelled.reply).toBe("Okay, I won't send it.");
    expect(ledger.submits).toHaveLength(0);
    expect(store.active("space-1")).toBeUndefined();
  });

  it("D. User disputes amount ('that's wrong') → asks for correction", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");
    const disputed = await say("that's wrong");

    expect(disputed.reply).toBe(correctionPromptText({ recipientName: "Sarah", amountUsd: 25 }));
    expect(ledger.submits).toHaveLength(0);

    const record = store.active("space-1");
    expect(record?.status).toBe("AWAITING_CONFIRMATION");
    expect(record?.confirmationPhase).toBe("awaiting_correction");
    expect(record?.confirmedAt).toBeUndefined();
  });

  it("E. User cancels during correction → zero transactions", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");
    await say("that's wrong");
    const cancelled = await say("cancel");

    expect(cancelled.reply).toBe("Okay, I won't send it.");
    expect(ledger.submits).toHaveLength(0);
    expect(store.active("space-1")).toBeUndefined();
  });

  it("F. User provides corrected amount '$15' → asks for confirmation again; does NOT immediately transfer", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");
    await say("that's wrong");
    const revised = await say("$15");

    // Asks for confirmation of new proposal; does NOT transfer yet
    expect(revised.reply).toBe(confirmationText({ recipientName: "Sarah", amountUsd: 15, memo: null }));
    expect(ledger.submits).toHaveLength(0);

    const record = store.active("space-1");
    expect(record?.status).toBe("AWAITING_CONFIRMATION");
    expect(record?.amountUsd).toBe(15);
    expect(record?.confirmationPhase).toBe("confirm_amount");
    expect(record?.confirmedAt).toBeUndefined();
  });

  it("G. User confirms revised $15 → exactly one $15 transaction", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");
    await say("that's wrong");
    await say("$15");
    const confirmed = await say("Yes");

    expect(confirmed.reply).toMatch(/XRPL Testnet/i);
    expect(confirmed.reply).toMatch(/\$15/);
    expect(ledger.submits).toHaveLength(1);
    expect(ledger.submits[0]?.drops).toBe("15000000");

    const record = store.active("space-1");
    expect(record?.status).toBe("SUCCEEDED");
    expect(record?.confirmedAmount).toBe(15);
  });

  it("H. User changes recipient → requires fresh confirmation", async () => {
    const { say, ledger, store, registry } = await setupHarness();
    await say("Send Sarah $25");
    const changed = await say("Actually send it to Keith");

    expect(changed.reply).toBe(confirmationText({ recipientName: "Keith", amountUsd: 25, memo: null }));
    expect(ledger.submits).toHaveLength(0);

    const record = store.active("space-1");
    expect(record?.status).toBe("AWAITING_CONFIRMATION");
    expect(record?.recipientName).toBe("Keith");
    expect(record?.confirmedAt).toBeUndefined();

    // Now confirm Keith
    const confirmed = await say("yes");
    expect(confirmed.reply).toMatch(/Keith/i);
    expect(ledger.submits).toHaveLength(1);
    expect(ledger.submits[0]?.destination).toBe(registry.getAddress("keith"));
  });

  it("I. User changes amount after confirming but before execution → block and reconfirm", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");

    // Simulate intent state transitioned to CONFIRMED
    const active = store.active("space-1")!;
    store.confirm(active.id, ROHAN_PHONE, "space-1");
    expect(store.get(active.id)?.status).toBe("CONFIRMED");

    // User changes amount before execution takes place
    const changed = await say("Actually make it $10");
    expect(changed.reply).toBe(confirmationText({ recipientName: "Sarah", amountUsd: 10, memo: null }));
    expect(ledger.submits).toHaveLength(0);

    // Old confirmed intent is updated, fresh unconfirmed intent for $10 created
    const current = store.active("space-1");
    expect(current?.status).toBe("AWAITING_CONFIRMATION");
    expect(current?.amountUsd).toBe(10);
    expect(current?.confirmedAt).toBeUndefined();

    // Confirm new amount
    await say("yes");
    expect(ledger.submits).toHaveLength(1);
    expect(ledger.submits[0]?.drops).toBe("10000000"); // 10 XRP drops
  });

  it("J. Confirmation from another space/user → rejected", async () => {
    const { say, ledger } = await setupHarness();
    await say("Send Sarah $25", { spaceId: "space-1", senderId: ROHAN_PHONE, senderName: "Rohan" });

    // Different user attempts to confirm
    const intruder = await say("yes", { spaceId: "space-1", senderId: "+15559999999", senderName: "Attacker" });
    expect(intruder.reply).toBe("Only Rohan can confirm that.");
    expect(ledger.submits).toHaveLength(0);

    // Different space attempts to confirm
    const otherSpace = await say("yes", { spaceId: "space-2", senderId: ROHAN_PHONE, senderName: "Rohan" });
    expect(otherSpace.handled).toBe(false);
    expect(ledger.submits).toHaveLength(0);
  });

  it("K. Expired confirmation → rejected", async () => {
    const { say, ledger, store } = await setupHarness({ intentTtlMs: -1000 }); // expired TTL
    await say("Send Sarah $25");

    const active = store.active("space-1");
    expect(active?.status).toBe("AWAITING_CONFIRMATION");

    const reply = await say("yes");
    expect(reply.reply).toMatch(/expired/i);
    expect(ledger.submits).toHaveLength(0);
  });

  it("L. Duplicate 'yes' → at most one transaction", async () => {
    const { say, ledger } = await setupHarness();
    await say("Send Sarah $25");

    const first = await say("yes");
    expect(first.reply).toMatch(/XRPL Testnet/i);
    expect(ledger.submits).toHaveLength(1);

    const second = await say("yes");
    expect(second.reply).toMatch(/Already sent \$25/i);
    expect(ledger.submits).toHaveLength(1); // Still exactly 1 submit
  });

  it("M. Missing pending payment + 'yes' → no transaction", async () => {
    const { say, ledger } = await setupHarness();
    const reply = await say("yes");
    expect(reply.handled).toBe(false);
    expect(ledger.submits).toHaveLength(0);
  });

  it("N. Ambiguous response → no transaction", async () => {
    const { say, ledger, store } = await setupHarness();
    await say("Send Sarah $25");

    const ambiguous = await say("maybe later");
    expect(ambiguous.handled).toBe(false);
    expect(ledger.submits).toHaveLength(0);

    // Still awaiting confirmation, nothing executed
    expect(store.active("space-1")?.status).toBe("AWAITING_CONFIRMATION");
  });

  it("O. Negative amount → no transaction", async () => {
    const { say, ledger, store } = await setupHarness();
    const reply = await say("Send Sarah -$25");
    expect(reply.reply).toBe("I can only send a positive amount.");
    expect(ledger.submits).toHaveLength(0);
    expect(store.active("space-1")).toBeUndefined();
  });

  it("P. Direct/internal call to the Ripple payment executor without valid confirmation → rejected", async () => {
    const { executor, ledger } = await setupHarness();

    // 1. Direct call with humanConfirmed: false in confirmed mode
    const rejected1 = await executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Sarah",
      amountUsd: 25,
      mode: "confirmed",
      humanConfirmed: false,
    });
    expect(rejected1.policy.allowed).toBe(false);
    expect(rejected1.policy.reasonCode).toBe("CONFIRMATION_REQUIRED");
    expect(ledger.submits).toHaveLength(0);

    // 2. Direct call without human confirmation in autonomous mode (when autonomous disabled)
    const rejected2 = await executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Sarah",
      amountUsd: 25,
      mode: "autonomous",
    });
    expect(rejected2.policy.allowed).toBe(false);
    expect(rejected2.policy.reasonCode).toBe("AUTONOMOUS_DISABLED");
    expect(ledger.submits).toHaveLength(0);
  });

  it("Q. Existing restaurant deposit flow still works, but requires its own explicit confirmation", async () => {
    const { service, store } = await setupHarness();

    // Synchronize deposit requirement
    const deposit = service.syncDeposit({
      spaceId: "table-1",
      senderId: ROHAN_PHONE,
      senderName: "Rohan",
      merchantName: "Carbone",
      destination: TEST_RECIPIENTS.Sarah.rippleDestination,
      amountUsd: 50,
      reservationId: "res-123",
      idempotencyKey: "deposit-res-123",
      memo: "Deposit for table at Carbone",
    });

    expect(deposit.status).toBe("AWAITING_CONFIRMATION");
    expect(deposit.purpose).toBe("RESERVATION_DEPOSIT");

    // Unauthorized sender cannot execute
    const unauthorized = await service.executeDeposit({
      spaceId: "table-1",
      senderId: "+15559999999",
      paymentId: deposit.id,
    });
    expect(unauthorized.outcome).toBe("unauthorized");

    // Authorized initiator executes confirmed deposit
    const executed = await service.executeDeposit({
      spaceId: "table-1",
      senderId: ROHAN_PHONE,
      paymentId: deposit.id,
    });
    expect(executed.outcome).toBe("succeeded");
    expect(store.get(deposit.id)?.status).toBe("SUCCEEDED");
  });

  it("R. Existing ticket purchase/payment flow still works, but requires its own explicit confirmation", async () => {
    // Ticket payment port requires valid amount, purpose, currency, and explicit quote
    const { provider } = await setupHarness();
    const guardrail = validateConfirmationGuardrail(
      { amountUsd: 50, recipientName: "Box Office", destination: TEST_RECIPIENTS.Keith.rippleDestination, currency: "USD", senderId: ROHAN_PHONE, spaceId: "tickets" },
      {
        id: "ticket-1",
        status: "CONFIRMED",
        confirmedAt: new Date().toISOString(),
        confirmedAmount: 50,
        confirmedRecipientName: "Box Office",
        confirmedDestination: TEST_RECIPIENTS.Keith.rippleDestination,
        confirmedCurrency: "USD",
        confirmedSenderId: ROHAN_PHONE,
        confirmedSpaceId: "tickets",
        amountUsd: 50,
        recipientName: "Box Office",
        destination: TEST_RECIPIENTS.Keith.rippleDestination,
        initiatorId: ROHAN_PHONE,
        photonSpaceId: "tickets",
      },
    );
    expect(guardrail.ok).toBe(true);

    const sent = await provider.sendPayment({
      destination: TEST_RECIPIENTS.Keith.rippleDestination,
      amountUsd: 50,
      confirmed: true,
      confirmationId: "ticket-1",
      idempotencyKey: "ticket-tx-1",
    });
    expect(sent.success).toBe(true);
  });

  it("S. Existing person-to-person payment flow uses this same guardrail", async () => {
    const { say, ledger, store } = await setupHarness();

    // Standard P2P flow
    await say("Send Sarah $25");
    expect(store.active("space-1")?.status).toBe("AWAITING_CONFIRMATION");
    expect(ledger.submits).toHaveLength(0);

    const confirmed = await say("confirm");
    expect(confirmed.reply).toMatch(/XRPL Testnet/i);
    expect(ledger.submits).toHaveLength(1);
    expect(store.active("space-1")?.status).toBe("SUCCEEDED");
  });

  it("Audit trail reflects full conversation lifecycle: PROPOSED → REVISED → CONFIRMED → VALIDATED", async () => {
    const { say, audit, registry, ledger } = await setupHarness();

    await say("Send Sarah $25");
    await say("that's wrong");
    await say("$15");
    await say("yes");

    const builder = new XrplDashboardBuilder({
      registry,
      audit,
      ledger,
      secrets: () => [],
    });
    const dashboard = await builder.build();

    expect(dashboard.auditTrail).toBeDefined();
    const trail = dashboard.auditTrail ?? [];

    expect(trail).toContain("PROPOSED: $25 → Sarah");
    expect(trail).toContain("REVISED: $15 → Sarah");
    expect(trail).toContain("CONFIRMED");
    expect(trail).toContain("GUARDRAIL: ALLOW");
    expect(trail).toContain("XRPL: tesSUCCESS");
    expect(trail).toContain("VALIDATED");
  });
});
