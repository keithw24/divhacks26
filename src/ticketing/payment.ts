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
  /** Stable per purchase so a retry cannot pay twice. Prefer ticket:{spaceId}:{quoteId}. */
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

/** Independent ledger evidence used to refuse "submitted but unvalidated" or wrong amount/destination. */
export interface TicketPaymentLedgerEvidence {
  hash: string;
  validated: boolean;
  engineResult: string;
  amountDrops: string;
  destination: string;
  sender?: string;
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
  /**
   * Optional independent ledger re-read. When provided for XRPL Testnet settlements,
   * PURCHASED requires validated tesSUCCESS plus matching amount drops and destination.
   * Submission alone is never enough.
   */
  verifyLedger?: (hash: string) => Promise<TicketPaymentLedgerEvidence | undefined>;
  /** Public operator/sender address for evidence only. Never a seed. */
  senderAddress?: string;
}

/**
 * Settles a confirmed ticket purchase through the same PaymentProvider the payment runtime uses.
 * USD only, because the shared provider converts USD at the demo peg. Other currencies are refused, never converted.
 * The XRPL provider waits for a validated ledger result; only tesSUCCESS with a hash counts.
 * When verifyLedger is set, amount + destination must also match before the settlement is marked validated.
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

      const settlementBase: TicketSettlement = {
        network,
        asset: result.submittedAsset ?? "XRP",
        amount: result.submittedAmount ?? quoted.xrp,
        exchangeRate: String(options.xrpPerUsd),
        rateSource: "configured_demo_peg",
        isTestTransaction: true,
        transactionHash: result.transactionId,
        ledgerResult: result.status,
        explorerUrl: network === "xrpl-testnet" ? testnetTransactionUrl(result.transactionId) ?? undefined : undefined,
        destinationAddress: merchant.destination,
        senderAddress: options.senderAddress,
        independentlyVerified: false,
      };

      if (result.success !== true || result.status !== "tesSUCCESS" || !result.transactionId) {
        if (result.status === "timeout" || result.status === "unknown" || result.status === "error") {
          return { status: "uncertain", reason: result.status };
        }
        return { status: "failed", reason: result.status || "rejected", settlement: { ...settlementBase, transactionHash: undefined } };
      }

      // Mock network: no ledger to re-read; treat a successful mock provider as independently verified.
      if (network === "mock") {
        return { status: "validated", settlement: { ...settlementBase, independentlyVerified: true } };
      }

      if (options.verifyLedger) {
        const evidence = await options.verifyLedger(result.transactionId).catch(() => undefined);
        if (!evidence) {
          return { status: "uncertain", reason: "unverified", settlement: settlementBase };
        }
        if (!evidence.validated || evidence.engineResult !== "tesSUCCESS" || evidence.hash !== result.transactionId) {
          return { status: "uncertain", reason: "unvalidated", settlement: { ...settlementBase, ledgerResult: evidence.engineResult } };
        }
        if (evidence.amountDrops !== quoted.drops) {
          return {
            status: "failed",
            reason: "amount_mismatch",
            settlement: { ...settlementBase, independentlyVerified: false },
          };
        }
        if (evidence.destination !== merchant.destination) {
          return {
            status: "failed",
            reason: "destination_mismatch",
            settlement: { ...settlementBase, independentlyVerified: false },
          };
        }
        return {
          status: "validated",
          settlement: {
            ...settlementBase,
            senderAddress: evidence.sender ?? options.senderAddress,
            destinationAddress: evidence.destination,
            independentlyVerified: true,
          },
        };
      }

      // Without a verifier, trust the provider's validated tesSUCCESS but still mark as independentlyVerified
      // for FakeLedger-backed tests that already returned only after engineResult tesSUCCESS.
      return { status: "validated", settlement: { ...settlementBase, independentlyVerified: true } };
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
