import { usdToDrops } from "../payments/amount.js";
import type { MerchantDirectory } from "../payments/merchants.js";
import type { PaymentProvider, PaymentResult } from "../payments/types.js";
import { testnetTransactionUrl } from "../payments/xrpl/explorer.js";
import type { TicketSettlement } from "./types.js";

/** What the ticketing agent asks the shared payment layer to settle. Amount is the ticket total in its own currency. */
export interface TicketPaymentRequest {
  purpose: "event_ticket";
  amount: number;
  currency: string;
  merchant?: string;
  eventId: string;
  spaceId: string;
  initiatorId: string;
  /** Stable per purchase so a retry cannot pay twice. */
  idempotencyKey: string;
  metadata: Record<string, string | number | boolean>;
}

export type TicketPaymentResult =
  | { status: "validated"; settlement: TicketSettlement }
  | { status: "failed"; reason: string; settlement?: TicketSettlement }
  | { status: "uncertain"; reason: string };

/** Boundary to the shared Ripple/XRPL payment work. Ticketing never holds a wallet or a seed. */
export interface TicketPaymentPort {
  readonly network: "xrpl-testnet" | "mock";
  pay(request: TicketPaymentRequest): Promise<TicketPaymentResult>;
}

export interface SharedTicketPaymentsOptions {
  /** The shared payment provider: MockPaymentProvider or the XRPL Testnet provider. */
  provider: PaymentProvider;
  mode: "mock" | "ripple_test";
  merchants: MerchantDirectory;
  /** Default merchant name, resolved through PAYMENTS_MERCHANTS_JSON. */
  merchantName: string;
  /** Configured demo peg. Recorded on every settlement as the exchange rate. */
  xrpPerUsd: number;
  maxUsd: number;
  timeoutMs: number;
}

/**
 * Settles a confirmed ticket purchase through the same PaymentProvider the payment runtime uses.
 * USD only, because the shared provider converts USD at the demo peg. Other currencies are refused, never converted.
 * The XRPL provider waits for a validated ledger result; only tesSUCCESS with a hash counts.
 */
export function createSharedTicketPayments(options: SharedTicketPaymentsOptions): TicketPaymentPort {
  const network = options.mode === "ripple_test" ? "xrpl-testnet" : "mock";
  return {
    network,
    async pay(request) {
      if (request.purpose !== "event_ticket") return { status: "failed", reason: "unsupported_purpose" };
      if (request.currency !== "USD") return { status: "failed", reason: "unsupported_currency" };
      if (!Number.isFinite(request.amount) || request.amount <= 0) return { status: "failed", reason: "invalid_amount" };
      if (request.amount > options.maxUsd) return { status: "failed", reason: "over_limit" };
      const merchant = options.merchants.resolve(request.merchant ?? options.merchantName);
      if (!merchant.ok) return { status: "failed", reason: "unknown_merchant" };

      let quoted: { drops: string; xrp: string };
      try {
        quoted = usdToDrops(request.amount, options.xrpPerUsd);
      } catch {
        return { status: "failed", reason: "invalid_amount" };
      }

      let result: PaymentResult;
      try {
        result = await withTimeout(
          options.provider.sendPayment({
            destination: merchant.destination,
            amountUsd: request.amount,
            memo: `tickets ${request.eventId}`.slice(0, 120),
            idempotencyKey: request.idempotencyKey,
          }),
          options.timeoutMs,
        );
      } catch {
        return { status: "uncertain", reason: "timeout" };
      }

      const settlement: TicketSettlement = {
        network,
        asset: result.submittedAsset ?? "XRP",
        amount: result.submittedAmount ?? quoted.xrp,
        exchangeRate: String(options.xrpPerUsd),
        rateSource: "configured_demo_peg",
        isTestTransaction: true,
        transactionHash: result.transactionId,
        ledgerResult: result.status,
        explorerUrl: network === "xrpl-testnet" ? testnetTransactionUrl(result.transactionId) ?? undefined : undefined,
      };
      if (result.success === true && result.status === "tesSUCCESS" && result.transactionId) {
        return { status: "validated", settlement };
      }
      if (result.status === "timeout" || result.status === "unknown" || result.status === "error") {
        return { status: "uncertain", reason: result.status };
      }
      return { status: "failed", reason: result.status || "rejected", settlement: { ...settlement, transactionHash: undefined } };
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ticket payment timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
