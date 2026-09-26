import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, decode, hashes, type Payment } from "xrpl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import type { DepositPaymentPort } from "../../src/payments/deposit-port.js";
import { createXrplReservationPayments, depositIdempotencyKey, XrplReservationPayments } from "../../src/payments/reservation-xrpl.js";
import type { LedgerTransaction, XrplLedgerClient } from "../../src/payments/xrpl/client.js";
import { createXrplPayments, type XrplPayments } from "../../src/payments/xrpl/payments.js";
import { FileTransactionStore, MemoryTransactionStore, type XrplTransactionStore } from "../../src/payments/xrpl/records.js";
import { XrplTestWallet } from "../../src/payments/xrpl/wallet.js";
import type { ReservationInterpreter } from "../../src/reservations/gemini.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import type { ReservationPaymentRequest } from "../../src/reservations/payment.js";
import { RippleBistroProvider, type ProviderAvailability, type ProviderSlotQuery } from "../../src/reservations/providers.js";
import { createMemoryDirectory, DEMO_RESTAURANTS } from "../../src/reservations/restaurant.js";
import { createReservationRuntime } from "../../src/reservations/runtime.js";
import { ReservationStore } from "../../src/reservations/state.js";
import { NOW } from "./support.js";

const TESTNET = "wss://s.altnet.rippletest.net:51233";
const XRP = 1_000_000n;
const BOOK = "Book Ripple Bistro for 4 tonight at 8.";
const HASH = /^[0-9A-F]{64}$/;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** In-memory XRPL Testnet. Nothing opens a socket. */
class FakeLedger implements XrplLedgerClient {
  networkId: number | undefined = 1;
  accounts = new Map<string, { balance: bigint; ownerCount: number }>();
  txs = new Map<string, LedgerTransaction>();
  submitted: string[] = [];
  /** hold: accepted but not validated until release(). */
  mode: "validate" | "fail" | "hold" = "validate";
  held: string[] = [];
  ledgerIndex = 100;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getAccount(address: string) {
    const account = this.accounts.get(address);
    return account
      ? { exists: true, balanceDrops: account.balance.toString(), ownerCount: account.ownerCount }
      : { exists: false, balanceDrops: "0", ownerCount: 0 };
  }
  async getReserves() {
    return { baseDrops: "1000000", incrementDrops: "200000" };
  }
  async getValidatedLedgerIndex() {
    return this.ledgerIndex;
  }
  async autofill(tx: Payment): Promise<Payment> {
    return { ...tx, Fee: "12", Sequence: 7, LastLedgerSequence: this.ledgerIndex + 20 };
  }
  async submitSigned(txBlob: string) {
    this.submitted.push(txBlob);
    if (this.mode === "hold") {
      this.held.push(txBlob);
      return { engineResult: "tesSUCCESS" };
    }
    this.apply(txBlob, this.mode === "fail");
    return { engineResult: "tesSUCCESS" };
  }
  /** The held transactions reach a validated ledger. */
  release(): void {
    for (const blob of this.held.splice(0)) this.apply(blob, false);
  }
  async getTransaction(hash: string) {
    return this.txs.get(hash) ?? null;
  }
  async findPaymentByInvoiceId(account: string, invoiceId: string) {
    return [...this.txs.values()].find((tx) => tx.account === account && tx.invoiceId === invoiceId) ?? null;
  }
  async findLatestIncomingPayment() {
    return null;
  }
  async requestFaucetFunding(): Promise<never> {
    throw new Error("faucet is not used by reservation tests");
  }
  private apply(txBlob: string, fail: boolean): void {
    const tx = decode(txBlob) as unknown as Payment & { Fee: string; InvoiceID?: string; Amount: string };
    const hash = hashes.hashSignedTx(txBlob);
    const sender = this.accounts.get(tx.Account)!;
    const fee = BigInt(tx.Fee);
    const amount = BigInt(tx.Amount);
    this.ledgerIndex += 1;
    const base = {
      hash,
      validated: true,
      ledgerIndex: this.ledgerIndex,
      account: tx.Account,
      destination: tx.Destination,
      feeDrops: tx.Fee,
      closeTimeIso: "2026-09-25T19:01:00.000Z",
      invoiceId: tx.InvoiceID ?? null,
    };
    if (fail) {
      sender.balance -= fee;
      this.txs.set(hash, { ...base, engineResult: "tecPATH_DRY", deliveredDrops: null });
      return;
    }
    sender.balance -= amount + fee;
    const dest = this.accounts.get(tx.Destination) ?? { balance: 0n, ownerCount: 0 };
    dest.balance += amount;
    this.accounts.set(tx.Destination, dest);
    this.txs.set(hash, { ...base, engineResult: "tesSUCCESS", deliveredDrops: amount.toString() });
  }
}

/** Changes what Ripple Bistro quotes, to simulate terms moving between the ask and the yes. */
class ChangingBistro extends RippleBistroProvider {
  perPersonUsd?: number;
  refundable?: boolean;
  override async checkAvailability(query: ProviderSlotQuery): Promise<ProviderAvailability> {
    const quoted = await super.checkAvailability(query);
    if (!quoted.available || !quoted.payment) return quoted;
    const payment = { ...quoted.payment };
    if (this.perPersonUsd !== undefined) {
      payment.perPersonUsd = this.perPersonUsd;
      payment.amountUsd = this.perPersonUsd * query.partySize;
    }
    if (this.refundable !== undefined) payment.refundable = this.refundable;
    return { ...quoted, payment };
  }
}

interface World {
  operator: Wallet;
  merchant: string;
  ledger: FakeLedger;
  txStore: XrplTransactionStore;
  reservations: ReservationStore;
  bistro: RippleBistroProvider;
  clock: { now: Date };
}

function world(options: { balanceXrp?: bigint; txStore?: XrplTransactionStore; bistro?: RippleBistroProvider } = {}): World {
  const operator = Wallet.generate();
  const merchant = Wallet.generate().classicAddress;
  const ledger = new FakeLedger();
  ledger.accounts.set(operator.classicAddress, { balance: (options.balanceXrp ?? 1000n) * XRP, ownerCount: 0 });
  ledger.accounts.set(merchant, { balance: 50n * XRP, ownerCount: 0 });
  const secrets = [operator.seed ?? "", operator.privateKey];
  return {
    operator,
    merchant,
    ledger,
    txStore: options.txStore ?? new MemoryTransactionStore(() => secrets),
    reservations: new ReservationStore(),
    bistro: options.bistro ?? new RippleBistroProvider(),
    clock: { now: NOW },
  };
}

/** One server process: the shared XRPL service, the deposit port, and the orchestrator. */
function boot(w: World, options: { maxUsd?: number; interpreter?: ReservationInterpreter } = {}) {
  const logs: string[] = [];
  const audit: unknown[] = [];
  const xrpl: XrplPayments = createXrplPayments({
    env: {},
    network: { network: "testnet", url: TESTNET },
    client: w.ledger,
    store: w.txStore,
    wallet: () => new XrplTestWallet(w.operator, "env", "XRPL_TESTNET_SEED"),
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    now: () => w.clock.now,
    validationTimeoutMs: 30,
    pollMs: 1,
  });
  const send = vi.spyOn(xrpl, "send");
  const merchants = createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Ripple Bistro": w.merchant }) });
  const deposits = createXrplReservationPayments({
    xrpl,
    merchants,
    serverUrl: TESTNET,
    xrpPerUsd: 1,
    maxUsd: options.maxUsd ?? 500,
    dailyMaxUsd: 1000,
    audit: {
      appendEvent: (event) => audit.push(event),
      appendPolicy: (record) => audit.push(record),
    },
    now: () => w.clock.now,
  });
  const notes: string[] = [];
  const orchestrator = new ReservationOrchestrator({
    directory: createMemoryDirectory(DEMO_RESTAURANTS),
    caller: new MockOutboundCaller("exact_time"),
    store: w.reservations,
    now: () => w.clock.now,
    timeZone: "America/New_York",
    autoComplete: true,
    mockScenario: "exact_time",
    payments: deposits,
    providers: [w.bistro],
    merchants,
    paymentMode: "ripple_test",
    interpreter: options.interpreter,
    notify: async (_spaceId, text) => {
      notes.push(text);
    },
  });
  const replies: string[] = [];
  async function say(text: string, extra: { senderId?: string; senderName?: string; messageId?: string; spaceId?: string } = {}) {
    const result = await orchestrator.handleTurn({
      spaceId: extra.spaceId ?? "space-a",
      senderId: extra.senderId ?? "rohan-id",
      senderName: extra.senderName ?? "Rohan",
      text,
      messageId: extra.messageId,
    });
    replies.push(result.reply ?? "");
    return result.reply ?? "";
  }
  const active = () => orchestrator.reservations.active("space-a");
  const key = () => depositIdempotencyKey(active()!.id);
  const trace = () => orchestrator.paymentTrace(active()?.id ?? "");
  return { xrpl, send, deposits, orchestrator, say, active, key, trace, logs, audit, notes, replies };
}

function requestFor(session: ReturnType<typeof boot>, senderId = "rohan-id"): ReservationPaymentRequest {
  const deposit = session.active()!.deposit!;
  const requirement = deposit.requirement!;
  return {
    requirement,
    authorization: { spaceId: "space-a", senderId, senderName: "Rohan", at: NOW.toISOString() },
    initiatorId: deposit.initiatorId!,
    initiatorName: deposit.initiatorName,
    verified: { amountUsd: requirement.amountUsd, recipient: requirement.recipient },
  };
}

function expectNoSecrets(value: unknown, w: World): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(w.operator.seed!);
  expect(text).not.toContain(w.operator.privateKey);
  expect(text).not.toMatch(/"(seed|privateKey|secret)"/i);
}

describe("restaurant deposit through xrplPayments.send", () => {
  it("asks for explicit authorization with the amount, XRP equivalent, refund terms, and action; nothing is sent", async () => {
    const w = world();
    const s = boot(w);
    const asked = await s.say(BOOK, { messageId: "book" });
    expect(asked).toBe(
      "Ripple Bistro has a 8:00 PM table for 4 tonight. They require a $100 deposit ($25/person). " +
        "If you say yes, I'll send 100 test XRP to Ripple Bistro on XRPL Testnet, then book. " +
        "They didn't say whether it's refundable. Want me to pay the $100 deposit and book it?",
    );
    expect(s.active()?.status).toBe("AWAITING_DEPOSIT");
    expect(s.active()?.deposit?.paymentId).toBe(s.key());
    expect(s.send).not.toHaveBeenCalled();
    expect(w.ledger.submitted).toHaveLength(0);
    expect(w.bistro.confirmations).toHaveLength(0);
    expect(s.trace()?.senderWallet).toBe(w.operator.classicAddress);
  });

  it("states refundability when the provider gives it", async () => {
    const bistro = new ChangingBistro();
    bistro.refundable = false;
    const w = world({ bistro });
    const s = boot(w);
    expect(await s.say(BOOK, { messageId: "book" })).toContain("It's non-refundable.");
  });

  it("another group member, silence, and ambiguous replies never authorize", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    expect(await s.say("Yes", { senderId: "ben-id", senderName: "Ben", messageId: "ben" })).toMatch(/Only Rohan can confirm/);
    expect(await s.say("yes", { spaceId: "space-b", messageId: "other-space" })).not.toMatch(/paid|booked|validated/i);
    for (const [index, text] of ["Book it", "sounds good", "maybe", "hmm what time is it", "call them"].entries()) {
      expect(await s.say(text, { messageId: `amb-${index}` })).not.toMatch(/validated|booked/i);
    }
    expect(s.send).not.toHaveBeenCalled();
    expect(w.ledger.submitted).toHaveLength(0);
    expect(s.active()?.deposit?.status).toBe("AWAITING_PAYMENT");
    expect(s.trace()?.stages.find((step) => step.stage === "user_authorization")?.status).toBe("not_reached");
  });

  it("an expired authorization window re-asks instead of paying", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    w.clock.now = new Date(NOW.getTime() + 16 * 60_000);
    const stale = await s.say("Yes", { messageId: "late-yes" });
    expect(stale).toMatch(/^That payment request expired, so I didn't pay it\. .*Want me to pay the \$100 deposit and book it\?$/);
    expect(s.send).not.toHaveBeenCalled();
    expect(w.ledger.submitted).toHaveLength(0);
    expect(await s.say("Yes", { messageId: "fresh-yes" })).toMatch(/^You're booked at Ripple Bistro/);
    expect(w.ledger.submitted).toHaveLength(1);
  });

  it("terms that change after the ask are re-asked, never paid under the old yes", async () => {
    const bistro = new ChangingBistro();
    const w = world({ bistro });
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    bistro.perPersonUsd = 30;
    const changed = await s.say("Yes", { messageId: "yes-1" });
    expect(changed).toMatch(/^The payment terms changed, so I didn't pay\. For 4 people, the deposit is \$120/);
    expect(changed).toContain("120 test XRP");
    expect(s.send).not.toHaveBeenCalled();

    bistro.refundable = true;
    const refund = await s.say("Yes", { messageId: "yes-2" });
    expect(refund).toMatch(/^The payment terms changed, so I didn't pay\./);
    expect(refund).toContain("It's refundable.");
    expect(s.send).not.toHaveBeenCalled();
    expect(w.ledger.submitted).toHaveLength(0);
  });

  it("validated: pays once through xrplPayments.send, stores proof, then books", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const reservationId = s.active()!.id;
    const confirm = vi.spyOn(w.bistro, "confirm");
    const statusAtConfirm: (string | undefined)[] = [];
    confirm.mockImplementation(async function (this: RippleBistroProvider, input) {
      statusAtConfirm.push(s.xrpl.findByIdempotencyKey(`restaurant-deposit:${reservationId}`)?.status);
      return RippleBistroProvider.prototype.confirm.call(w.bistro, input);
    });

    const booked = await s.say("Yes", { messageId: "yes" });

    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: w.merchant,
        amountXrp: 100,
        idempotencyKey: `restaurant-deposit:${reservationId}`,
        purpose: "restaurant_deposit",
        reservationId,
      }),
    );
    expect(w.ledger.submitted).toHaveLength(1);
    expect(statusAtConfirm).toEqual(["validated"]);
    expect(booked).toMatch(
      /^You're booked at Ripple Bistro for 4 tonight at 8:00 PM\. The \$100 deposit \(100 test XRP\) was validated on XRPL Testnet\. Confirmation RB-[0-9A-F]{6}\.$/,
    );
    expect(booked).not.toMatch(HASH);

    const reservation = s.active()!;
    const hash = reservation.deposit!.transactionId!;
    expect(hash).toMatch(HASH);
    expect(reservation.status).toBe("BOOKED");
    expect(reservation.deposit?.status).toBe("PAID");
    expect(reservation.deposit?.proof).toEqual({
      network: "xrpl-testnet",
      status: "validated",
      amountXrp: 100,
      destination: w.merchant,
      transactionHash: hash,
      ledgerIndex: 101,
      validatedAt: "2026-09-25T19:01:00.000Z",
      explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
      idempotencyKey: `restaurant-deposit:${reservationId}`,
    });
    expect(reservation.result?.payment).toEqual({
      network: "xrpl-testnet",
      status: "validated",
      amountXrp: 100,
      transactionHash: hash,
      ledgerIndex: 101,
      explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
    });
    expect(w.bistro.confirmations).toEqual([expect.objectContaining({ transactionHash: hash })]);
    expect(w.ledger.accounts.get(w.merchant)?.balance).toBe(150n * XRP);

    const trace = s.trace()!;
    expect(trace.transactionHash).toBe(hash);
    expect(trace.explorerUrl).toBe(`https://testnet.xrpl.org/transactions/${hash}`);
    expect(trace.payment).toMatchObject({ status: "validated", ledgerIndex: 101, amountXrp: 100 });
    expect(trace.stages.map((step) => [step.stage, step.status])).toEqual([
      ["reservation_request", "done"],
      ["availability_lookup", "done"],
      ["deposit_requirement", "done"],
      ["authorization_request", "done"],
      ["user_authorization", "done"],
      ["terms_recheck", "done"],
      ["guardrail_approval", "done"],
      ["xrpl_submission", "done"],
      ["ledger_validation", "done"],
      ["reservation_confirmation", "done"],
    ]);
    expect(reservation.deposit?.history?.map((step) => step.state)).toEqual([
      "RESERVATION_PENDING",
      "PAYMENT_REQUIRED",
      "PAYMENT_AUTHORIZED",
      "TERMS_RECHECKED",
      "GUARDRAIL_APPROVED",
      "PAYMENT_SUBMITTED",
      "PAYMENT_CONFIRMED",
      "RESERVATION_CONFIRMED",
    ]);
  });

  it("pending: no booking and no failure claim; re-checks reuse the same key; validation later books", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    w.ledger.mode = "hold";

    const pending = await s.say("Yes", { messageId: "yes" });
    expect(pending).toBe(
      'The $100 deposit was submitted to XRPL Testnet and is still being verified, so Ripple Bistro isn\'t booked yet. Say "check" in a minute and I\'ll look again. It won\'t be paid twice.',
    );
    expect(pending).not.toMatch(/couldn't|failed|booked at/i);
    expect(s.active()?.status).toBe("AWAITING_DEPOSIT");
    expect(s.active()?.deposit?.status).toBe("PENDING");
    expect(s.active()?.deposit?.proof).toMatchObject({ status: "pending", ledgerIndex: null, explorerUrl: null });
    expect(s.active()?.deposit?.proof?.transactionHash).toMatch(HASH);
    expect(s.active()?.result?.payment).toBeUndefined();
    expect(w.bistro.confirmations).toHaveLength(0);
    expect(s.trace()?.stages.find((step) => step.stage === "ledger_validation")?.status).toBe("pending");
    expect(s.trace()?.stages.find((step) => step.stage === "reservation_confirmation")?.status).toBe("not_reached");

    expect(await s.say("no", { messageId: "no" })).toMatch(/can't cancel it/);
    expect(await s.say("Yes", { messageId: "yes-again" })).toBe(pending);
    expect(await s.say("check", { messageId: "check-1" })).toBe(pending);
    expect(await s.say("Book Ripple Bistro for 6 tonight at 8.", { messageId: "change" })).toMatch(/still being verified/);
    expect(w.ledger.submitted).toHaveLength(1);
    expect(w.bistro.confirmations).toHaveLength(0);

    w.ledger.release();
    const booked = await s.say("did it go through?", { messageId: "check-2" });
    expect(booked).toMatch(/^You're booked at Ripple Bistro for 4 tonight at 8:00 PM\. The \$100 deposit \(100 test XRP\) was validated/);
    expect(w.ledger.submitted).toHaveLength(1);
    const keys = new Set(s.send.mock.calls.map((call) => call[0].idempotencyKey));
    expect([...keys]).toEqual([s.key()]);
    expect(s.active()?.deposit?.history?.filter((step) => step.state === "PAYMENT_SUBMITTED")).toHaveLength(1);
  });

  it("failed: deposit unpaid, booking not confirmed, no XRPL internals; a new yes retries under the next attempt key", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    w.ledger.mode = "fail";
    const failed = await s.say("Yes", { messageId: "yes-1" });
    expect(failed).toBe("I couldn't pay the $100 deposit, so I didn't book Ripple Bistro. Say yes to try the payment again.");
    expect(failed).not.toMatch(/tec|XRPL|ledger|hash/i);
    expect(s.active()?.status).toBe("AWAITING_DEPOSIT");
    expect(s.active()?.deposit?.status).toBe("FAILED");
    expect(s.active()?.deposit?.state).toBe("PAYMENT_FAILED");
    expect(w.bistro.confirmations).toHaveLength(0);
    expect(w.ledger.accounts.get(w.merchant)?.balance).toBe(50n * XRP);
    expect(s.trace()?.stages.find((step) => step.stage === "ledger_validation")?.status).toBe("failed");

    w.ledger.mode = "validate";
    expect(await s.say("Yes", { messageId: "yes-2" })).toMatch(/^You're booked at Ripple Bistro/);
    const id = s.active()!.id;
    expect(s.send.mock.calls.map((call) => call[0].idempotencyKey)).toEqual([
      `restaurant-deposit:${id}`,
      `restaurant-deposit:${id}:attempt-2`,
    ]);
    expect(w.ledger.submitted).toHaveLength(2);
    expect(w.ledger.accounts.get(w.merchant)?.balance).toBe(150n * XRP);
  });

  it("a balance the guardrail can see is short is refused before the payment service", async () => {
    const w = world({ balanceXrp: 50n });
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const denied = await s.say("Yes", { messageId: "yes" });
    expect(denied).toMatch(/^I didn't pay the \$100 deposit because a payment safety check blocked it: sender balance/);
    expectNoSecrets(denied, w);
    expect(s.send).not.toHaveBeenCalled();
    expect(w.ledger.submitted).toHaveLength(0);
  });

  it("rejected by the payment service: insufficient test XRP is actionable, nothing is sent, and the same key is retried", async () => {
    // Enough raw balance for the guardrail, but owned objects raise the reserve the service enforces.
    const w = world({ balanceXrp: 110n });
    w.ledger.accounts.get(w.operator.classicAddress)!.ownerCount = 100;
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const rejected = await s.say("Yes", { messageId: "yes-1" });
    expect(rejected).toBe(
      "I didn't pay the $100 deposit because the agent's XRPL test wallet doesn't have enough test XRP for it. Nothing was sent, and Ripple Bistro isn't booked. Say yes to try again.",
    );
    expectNoSecrets(rejected, w);
    expect(rejected).not.toContain(w.operator.classicAddress);
    expect(w.ledger.submitted).toHaveLength(0);
    expect(s.active()?.deposit?.status).toBe("REJECTED");
    expect(s.active()?.deposit?.failureCode).toBe("INSUFFICIENT_BALANCE");
    expect(w.bistro.confirmations).toHaveLength(0);

    w.ledger.accounts.get(w.operator.classicAddress)!.balance = 1000n * XRP;
    expect(await s.say("Yes", { messageId: "yes-2" })).toMatch(/^You're booked at Ripple Bistro/);
    expect(new Set(s.send.mock.calls.map((call) => call[0].idempotencyKey))).toEqual(new Set([s.key()]));
    expect(w.ledger.submitted).toHaveLength(1);
  });

  it("a guardrail DENY sends nothing", async () => {
    const w = world();
    const s = boot(w, { maxUsd: 50 });
    await s.say(BOOK, { messageId: "book" });
    const denied = await s.say("Yes", { messageId: "yes" });
    expect(denied).toMatch(/^I didn't pay the \$100 deposit because a payment safety check blocked it/);
    expect(s.send).not.toHaveBeenCalled();
    expect(w.ledger.submitted).toHaveLength(0);
    expect(s.trace()?.stages.find((step) => step.stage === "guardrail_approval")?.status).toBe("failed");
  });

  it("duplicate yes, a redelivered Photon event, and concurrent yeses pay once", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const results = await Promise.all([
      s.say("Yes", { messageId: "c-1" }),
      s.say("yes", { messageId: "c-2" }),
      s.say("pay it", { messageId: "c-3" }),
    ]);
    expect(results.filter((reply) => reply.startsWith("You're booked"))).toHaveLength(1);
    const first = results.find((reply) => reply.startsWith("You're booked"))!;
    const firstId = `c-${results.indexOf(first) + 1}`;
    expect(await s.say("Yes", { messageId: firstId })).toBe(first);
    expect(await s.say("Yes", { messageId: "later-yes" })).not.toMatch(/validated|paid/i);
    expect(w.ledger.submitted).toHaveLength(1);
    expect(w.bistro.confirmations).toHaveLength(1);
  });

  it("recovers after a restart: the new process settles the pending payment without paying again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deposit-xrpl-"));
    dirs.push(dir);
    const path = join(dir, "xrpl-transactions.jsonl");
    const operator = Wallet.generate();
    const w = world({ txStore: new FileTransactionStore(path, () => [operator.seed!, operator.privateKey]) });
    w.operator = operator;
    w.ledger.accounts.set(operator.classicAddress, { balance: 1000n * XRP, ownerCount: 0 });

    const before = boot(w);
    await before.say(BOOK, { messageId: "book" });
    w.ledger.mode = "hold";
    expect(await before.say("Yes", { messageId: "yes" })).toMatch(/still being verified/);
    before.orchestrator.dispose();

    w.txStore = new FileTransactionStore(path, () => [operator.seed!, operator.privateKey]);
    w.ledger.release();
    const after = boot(w);
    expect(await after.say("Yes", { messageId: "yes" })).toMatch(/still being verified/);
    expect(await after.say("check", { messageId: "after-restart" })).toMatch(/^You're booked at Ripple Bistro/);
    expect(w.ledger.submitted).toHaveLength(1);
    expect(after.send.mock.calls.every((call) => call[0].idempotencyKey === after.key())).toBe(true);
    expectNoSecrets(readFileSync(path, "utf8"), w);
  });

  it("recovers from a lost local record through the ledger invoice id, only after an explicit yes", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    w.ledger.mode = "hold";
    await s.say("Yes", { messageId: "yes" });
    w.ledger.release();

    w.txStore = new MemoryTransactionStore(() => []);
    const restarted = boot(w);
    const unsure = await restarted.say("check", { messageId: "check" });
    expect(unsure).toMatch(/couldn't confirm whether the \$100 deposit went through/);
    expect(w.ledger.submitted).toHaveLength(1);
    expect(await restarted.say("Yes", { messageId: "yes-2" })).toMatch(/^You're booked at Ripple Bistro/);
    expect(w.ledger.submitted).toHaveLength(1);
  });

  it("never makes a second transaction for a booked reservation", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const request = requestFor(s);
    await s.say("Yes", { messageId: "yes" });
    const again = await s.deposits.payRestaurantDeposit(request);
    expect(again.outcome).toBe("already_confirmed");
    expect(again.proof?.status).toBe("validated");
    expect(w.ledger.submitted).toHaveLength(1);
    expect(s.xrpl.listTransactions({ type: "payment" })).toHaveLength(1);
  });

  it("concurrent payment continuations for one reservation make exactly one ledger payment", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const request = requestFor(s);
    const second = createXrplReservationPayments({
      xrpl: s.xrpl,
      merchants: createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Ripple Bistro": w.merchant }) }),
      serverUrl: TESTNET,
      xrpPerUsd: 1,
      maxUsd: 500,
      dailyMaxUsd: 1000,
      now: () => w.clock.now,
    });
    const ports: XrplReservationPayments[] = [s.deposits, s.deposits, s.deposits, second, second];
    const results = await Promise.all(ports.map((port) => port.payRestaurantDeposit(request)));
    expect(w.ledger.submitted).toHaveLength(1);
    expect(s.xrpl.listTransactions({ type: "payment" })).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "confirmed")).toHaveLength(1);
    expect(results.every((result) => result.outcome === "confirmed" || result.outcome === "already_confirmed")).toBe(true);
    expect(new Set(results.map((result) => result.transactionHash)).size).toBe(1);
    expect(new Set(results.map((result) => result.idempotencyKey))).toEqual(new Set([s.key()]));
  });

  it("a wrong sender cannot release the payment even through the port", async () => {
    const w = world();
    const s = boot(w);
    await s.say(BOOK, { messageId: "book" });
    const result = await s.deposits.payRestaurantDeposit(requestFor(s, "ben-id"));
    expect(result.outcome).toBe("unauthorized");
    expect(s.send).not.toHaveBeenCalled();
  });

  it("the seed never reaches traces, Gemini, Photon replies, logs, or the audit trail; Gemini cannot set amount, destination, or key", async () => {
    const w = world();
    const seen: unknown[] = [];
    const interpreter: ReservationInterpreter = {
      async extract(input) {
        seen.push(input);
        return {
          partySize: 4,
          depositUsd: 1,
          recipient: Wallet.generate().classicAddress,
          idempotencyKey: "attacker-key",
        } as Awaited<ReturnType<ReservationInterpreter["extract"]>>;
      },
    };
    const s = boot(w, { interpreter });
    await s.say(`${BOOK} The deposit is only $1.`, { messageId: "book" });
    await s.say("Yes", { messageId: "yes" });
    expect(s.active()?.status).toBe("BOOKED");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith(expect.objectContaining({ destination: w.merchant, amountXrp: 100, idempotencyKey: s.key() }));

    for (const value of [s.trace(), s.orchestrator.paymentTraces("space-a"), s.active(), seen, s.replies, s.notes, s.logs, s.audit, s.xrpl.listPublicTransactions()]) {
      expectNoSecrets(value, w);
    }
  });

  it("ripple_test runtime wiring uses the shared XRPL service and never the old PaymentService deposit path", () => {
    const w = world();
    const s = boot(w);
    const base = { callMode: "mock" as const, paymentMode: "ripple_test" as const, xrplTestnetUrl: TESTNET };
    const wired = createReservationRuntime({ ...base, xrplDeposits: s.xrpl });
    expect(wired.payments).toBeInstanceOf(XrplReservationPayments);
    expect(wired.payments?.senderAddress).toBe(w.operator.classicAddress);
    const legacy = createReservationRuntime({ ...base, depositPayments: {} as DepositPaymentPort });
    expect(legacy.payments).toBeUndefined();
    wired.orchestrator.dispose();
    legacy.orchestrator.dispose();
  });

  it("reservation code never loads a seed, builds a wallet, or signs", () => {
    const files = [
      "src/reservations/deposit-flow.ts",
      "src/reservations/orchestrator.ts",
      "src/reservations/runtime.ts",
      "src/reservations/payment.ts",
      "src/reservations/trace.ts",
      "src/payments/reservation-xrpl.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/XRPL_TESTNET_SEED|fromSeed|Wallet\.generate|new Wallet\(|\.sign\(|loadTestWallet/);
    }
    expect(readFileSync(join(process.cwd(), "src/index.ts"), "utf8")).not.toMatch(/senderAddressFromSeed/);
  });
});
