import { TimeoutError } from "xrpl";
import { describe, expect, it } from "vitest";
import { usdToDrops } from "../../src/payments/amount.js";
import { PaymentService } from "../../src/payments/service.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import {
  XRPL_TESTNET_NETWORK_ID,
  assertRippleTestUrl,
  createRippleTestProvider,
  paymentInvoiceId,
  type XrplSession,
} from "../../src/payments/ripple.js";

const TESTNET = "wss://s.altnet.rippletest.net:51233";
const KEITH = "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2";

class FakeSession implements XrplSession {
  submits = 0;
  networkId: number;
  private readonly find: XrplSession["findPayment"];
  private readonly submit: XrplSession["submitPayment"];

  constructor(options?: {
    networkId?: number;
    findPayment?: XrplSession["findPayment"];
    submitPayment?: XrplSession["submitPayment"];
  }) {
    this.networkId = options?.networkId ?? XRPL_TESTNET_NETWORK_ID;
    this.find = options?.findPayment ?? (async () => undefined);
    this.submit =
      options?.submitPayment ??
      (async () => ({ hash: "ABCDEF1234567890HASH", engineResult: "tesSUCCESS" }));
  }

  async findPayment(invoiceId: string) {
    return this.find(invoiceId);
  }

  async submitPayment(input: Parameters<XrplSession["submitPayment"]>[0]) {
    this.submits += 1;
    return this.submit(input);
  }

  async close() {}
}

function session(options?: ConstructorParameters<typeof FakeSession>[0]): FakeSession {
  return new FakeSession(options);
}

describe("sandbox conversion", () => {
  it("pegs one demo dollar to one testnet XRP by default", () => {
    expect(usdToDrops(20, 1)).toEqual({ drops: "20000000", xrp: "20" });
    expect(usdToDrops(1.5, 1)).toEqual({ drops: "1500000", xrp: "1.5" });
  });

  it("refuses a non-testnet URL", () => {
    expect(() => assertRippleTestUrl("wss://s1.ripple.com")).toThrow(/Testnet/);
    expect(() => assertRippleTestUrl("wss://s.devnet.rippletest.net:51233")).toThrow(/Testnet/);
    expect(() => assertRippleTestUrl(TESTNET)).not.toThrow();
  });
});

describe("ripple test provider", () => {
  it("records success only for tesSUCCESS with a hash", async () => {
    const ledger = session();
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const result = await provider.sendPayment({
      destination: KEITH,
      amountUsd: 20,
      memo: "Uber",
      idempotencyKey: "pay-1",
    });
    expect(result).toMatchObject({
      success: true,
      status: "tesSUCCESS",
      transactionId: "ABCDEF1234567890HASH",
      submittedAsset: "XRP",
      submittedAmount: "20",
      submittedDrops: "20000000",
    });
    expect(ledger.submits).toBe(1);
  });

  it("does not claim success when the engine rejects the payment", async () => {
    const ledger = session({
      async submitPayment() {
        return { hash: "REJECTEDHASH", engineResult: "tecUNFUNDED_PAYMENT" };
      },
    });
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const result = await provider.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-2" });
    expect(result.success).toBe(false);
    expect(result.status).toBe("tecUNFUNDED_PAYMENT");
    expect(result.transactionId).toBeUndefined();
  });

  it("does not claim success for an unknown provider state", async () => {
    const ledger = session({
      async submitPayment() {
        return { hash: "MAYBEHASH" };
      },
    });
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const result = await provider.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-3" });
    expect(result.success).toBe(false);
    expect(result.status).toBe("unknown");
  });

  it("treats a timeout without a validated transaction as a failure", async () => {
    const ledger = session({
      async submitPayment() {
        throw new TimeoutError("timed out");
      },
    });
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const result = await provider.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-4" });
    expect(result).toMatchObject({ success: false, status: "timeout" });
  });

  it("reuses a validated transaction for the same idempotency key", async () => {
    const ledger = session({
      async findPayment() {
        return { hash: "EXISTINGHASH", engineResult: "tesSUCCESS" };
      },
      async submitPayment() {
        throw new Error("should not submit");
      },
    });
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const result = await provider.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-5" });
    expect(result.success).toBe(true);
    expect(result.transactionId).toBe("EXISTINGHASH");
    expect(paymentInvoiceId("pay-5")).toHaveLength(64);
  });

  it("does not connect or submit without a seed", async () => {
    let called = false;
    const ledger = session({
      async submitPayment() {
        called = true;
        return { hash: "NOPE", engineResult: "tesSUCCESS" };
      },
    });
    const provider = createRippleTestProvider({ serverUrl: TESTNET, xrpPerUsd: 1, session: ledger });
    const result = await provider.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-6" });
    expect(result).toMatchObject({ success: false, status: "unconfigured" });
    expect(called).toBe(false);
  });

  it("refuses mainnet and devnet even if a session is injected", async () => {
    let called = false;
    const ledger = session({
      networkId: 0,
      async submitPayment() {
        called = true;
        return { hash: "NOPE", engineResult: "tesSUCCESS" };
      },
    });
    const mainnet = createRippleTestProvider({
      serverUrl: "wss://s1.ripple.com",
      seed: "sEdTestSeed",
      xrpPerUsd: 1,
      session: ledger,
    });
    expect((await mainnet.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-7" })).status).toBe("refused");

    const devnet = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    expect((await devnet.sendPayment({ destination: KEITH, amountUsd: 1, idempotencyKey: "pay-8" })).status).toBe("refused");
    expect(called).toBe(false);
  });

  it("tells the user nothing was charged when Ripple rejects the confirmed payment", async () => {
    const ledger = session({
      async submitPayment() {
        return { engineResult: "tecNO_DST_INSUF_XRP" };
      },
    });
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const service = new PaymentService({ provider, directory: loadRecipientDirectory(), timeoutMs: 1000 });
    await service.handleTurn({
      spaceId: "space",
      senderId: "rohan-id",
      senderName: "Rohan",
      text: "Send Keith $1 for coffee",
      messageId: "req",
    });
    const reply = await service.handleTurn({
      spaceId: "space",
      senderId: "rohan-id",
      text: "yes",
      messageId: "yes",
    });
    expect(reply.reply).toBe("Transaction rejected. I couldn't send the $1 payment. Nothing was charged.");
    expect(service.payments.active("space")?.status).toBe("FAILED");
  });

  it("reports a Ripple tesSUCCESS through the same confirmation flow", async () => {
    const ledger = session();
    const provider = createRippleTestProvider({ serverUrl: TESTNET, seed: "sEdTestSeed", xrpPerUsd: 1, session: ledger });
    const service = new PaymentService({ provider, directory: loadRecipientDirectory() });
    await service.handleTurn({
      spaceId: "space",
      senderId: "rohan-id",
      text: "Send Keith $1 for coffee",
      messageId: "req",
    });
    const reply = await service.handleTurn({
      spaceId: "space",
      senderId: "rohan-id",
      text: "yes",
      messageId: "yes",
    });
    expect(reply.reply).toBe(
      "Sent $1 to Keith for coffee. XRPL Testnet: ABCDEF12. https://testnet.xrpl.org/transactions/ABCDEF1234567890HASH",
    );
    expect(service.payments.active("space")?.submittedDrops).toBe("1000000");
    expect(ledger.submits).toBe(1);
  });
});
