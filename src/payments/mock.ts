import { createHash } from "node:crypto";
import { usdToDrops } from "./amount.js";
import type { PaymentProvider, PaymentResult, PaymentSendInput } from "./types.js";

/** In-memory provider. Same idempotency key returns the same result and does not count as a second send. */
export class MockPaymentProvider implements PaymentProvider {
  readonly calls: PaymentSendInput[] = [];
  result: "success" | "reject" | "timeout" | "throw" = "success";
  /** XRP per USD used only so mock results show the same sandbox asset the live path would submit. */
  xrpPerUsd = 1;
  private readonly seen = new Map<string, PaymentResult>();

  async sendPayment(input: PaymentSendInput): Promise<PaymentResult> {
    const prior = this.seen.get(input.idempotencyKey);
    if (prior) return prior;
    this.calls.push(input);
    if (this.result === "timeout") {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ success: false, status: "timeout", error: "timeout" });
        }, 30_000);
        timer.unref();
      });
    }
    if (this.result === "throw") throw Object.assign(new Error("payment timeout"), { name: "PaymentTimeout" });
    if (this.result === "reject") {
      const rejected: PaymentResult = {
        success: false,
        status: "tecUNFUNDED_PAYMENT",
        error: "rejected",
      };
      this.seen.set(input.idempotencyKey, rejected);
      return rejected;
    }
    const quoted = usdToDrops(input.amountUsd, this.xrpPerUsd);
    const settled: PaymentResult = {
      success: true,
      transactionId: mockTransactionId(input.idempotencyKey),
      status: "tesSUCCESS",
      submittedAsset: "XRP",
      submittedAmount: quoted.xrp,
      submittedDrops: quoted.drops,
    };
    this.seen.set(input.idempotencyKey, settled);
    return settled;
  }
}

export function mockTransactionId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 8).toUpperCase();
}
