import { createHash } from "node:crypto";
import {
  completedReply,
  PAYMENT_UNCERTAIN_REPLY,
  paymentFailedReply,
  PRICE_FAILED_REPLY,
  PURCHASE_FAILED_REPLY,
} from "./format.js";
import type { TicketTraceFields, TicketTraceSink } from "./log.js";
import type { TicketPaymentPort } from "./payment.js";
import { cents, totalFor, unitPriceOf } from "./pricing.js";
import type { TicketingStore } from "./state.js";
import type { TicketEvent, TicketHold, TicketOffer, TicketProvider, TicketPurchaseRecord } from "./types.js";

export type PurchaseOutcome =
  | { outcome: "completed"; record: TicketPurchaseRecord; reply: string }
  | { outcome: "failed"; record: TicketPurchaseRecord; reply: string }
  /** Live price differs from what the user confirmed. Nothing was bought; ask again with the new figures. */
  | { outcome: "requote"; record: TicketPurchaseRecord; offer: TicketOffer; total: number };

export interface PurchaseExecutorOptions {
  provider: TicketProvider;
  store: TicketingStore;
  trace: TicketTraceSink;
  payments?: TicketPaymentPort;
  merchantName?: string;
  now: () => Date;
}

/**
 * Runs a purchase the initiator already confirmed and this executor already claimed (PROCESSING).
 * The price is re-read from the provider first. A ticket is marked purchased only after an order result;
 * in demo mode that also requires a validated payment first.
 */
export class TicketPurchaseExecutor {
  constructor(private readonly options: PurchaseExecutorOptions) {}

  async execute(record: TicketPurchaseRecord, event: TicketEvent): Promise<PurchaseOutcome> {
    const { provider, store } = this.options;
    let offers: TicketOffer[];
    try {
      offers = provider.getOffers ? await provider.getOffers(event) : (await provider.getPrices(event)).offers;
    } catch {
      return this.fail(record, "reverify_failed", `${PRICE_FAILED_REPLY} I didn't buy anything.`);
    }
    const offer = offers.find((item) => item.id === record.offerId);
    if (!offer || (offer.availableQuantity !== undefined && offer.availableQuantity < record.quantity)) {
      return this.fail(record, "offer_gone", "Those tickets aren't available anymore, so I didn't buy anything. Want me to look again?");
    }
    if (offer.currency !== record.currency || cents(unitPriceOf(offer)) !== cents(record.unitPrice)) {
      const failed = store.patch(record.id, { status: "FAILED", failureReason: "price_changed" }) ?? record;
      this.trace("ticket.purchase_failed", failed, { reason: "price_changed" });
      return { outcome: "requote", record: failed, offer, total: totalFor(offer, record.quantity) };
    }
    if (record.mode === "provider") return this.providerPurchase(record, event, offer);
    return this.demoPurchase(record, event, offer);
  }

  private async providerPurchase(record: TicketPurchaseRecord, event: TicketEvent, offer: TicketOffer): Promise<PurchaseOutcome> {
    const { provider, store } = this.options;
    if (!provider.supportsPurchase || !provider.reserve || !provider.purchase) {
      return this.fail(record, "provider_cannot_purchase", PURCHASE_FAILED_REPLY);
    }
    let hold: TicketHold;
    try {
      hold = await provider.reserve({ event, offer, quantity: record.quantity });
    } catch {
      return this.fail(record, "reserve_failed", PURCHASE_FAILED_REPLY);
    }
    if (hold.currency !== record.currency || cents(hold.total) !== cents(record.total)) {
      const failed = store.patch(record.id, { status: "FAILED", failureReason: "total_changed" }) ?? record;
      this.trace("ticket.purchase_failed", failed, { reason: "total_changed" });
      return { outcome: "requote", record: failed, offer, total: hold.total };
    }
    const result = await provider.purchase({ hold, purchaseId: record.id }).catch(() => ({ status: "failed" as const, reason: "error" }));
    if (result.status !== "completed" || !result.orderId) {
      return this.fail(record, result.reason ?? "purchase_failed", PURCHASE_FAILED_REPLY);
    }
    return this.complete(record, { orderId: result.orderId, isDemo: false });
  }

  private async demoPurchase(record: TicketPurchaseRecord, event: TicketEvent, offer: TicketOffer): Promise<PurchaseOutcome> {
    const { store, payments } = this.options;
    let current = record;
    if (payments) {
      this.trace("ticket.payment_started", current, { paymentNetwork: payments.network, ledger: ledgerOf(payments.network), isTestTransaction: true });
      const paid = await payments
        .pay({
          purpose: "event_ticket",
          amount: record.total,
          currency: record.currency,
          merchant: this.options.merchantName,
          eventId: record.eventId,
          spaceId: record.spaceId,
          initiatorId: record.initiatorId,
          idempotencyKey: `ticket:${record.id}`,
          metadata: {
            purchaseId: record.id,
            offerId: record.offerId,
            quantity: record.quantity,
            unitPrice: record.unitPrice,
            provider: record.provider,
            demo: true,
          },
        })
        .catch(() => ({ status: "uncertain" as const, reason: "error" }));
      if (paid.status === "uncertain") {
        return this.fail(record, `payment_${paid.reason}`, PAYMENT_UNCERTAIN_REPLY, { paymentNetwork: payments.network });
      }
      if (paid.status === "failed") {
        return this.fail(record, paid.reason, paymentFailedReply(paid.reason), { paymentNetwork: payments.network, settlement: paid.settlement });
      }
      current =
        store.patch(record.id, {
          status: "PAYMENT_SUBMITTED",
          settlement: paid.settlement,
          paymentNetwork: paid.settlement.network,
          isTestTransaction: true,
          paymentTransactionId: paid.settlement.transactionHash,
        }) ?? current;
      this.trace("ticket.payment_validated", current, {
        paymentNetwork: paid.settlement.network,
        ledger: ledgerOf(paid.settlement.network),
        isTestTransaction: true,
        transactionHash: paid.settlement.transactionHash,
      });
    }

    let orderId: string | undefined;
    const provider = this.options.provider;
    if (provider.name === "mock" && provider.reserve && provider.purchase) {
      try {
        const hold = await provider.reserve({ event, offer, quantity: record.quantity });
        const result = await provider.purchase({ hold, purchaseId: record.id });
        if (result.status === "completed") orderId = result.orderId;
      } catch {
        orderId = undefined;
      }
    } else {
      orderId = `DEMO-${createHash("sha256").update(record.id).digest("hex").slice(0, 8).toUpperCase()}`;
    }

    if (!orderId) {
      const tx = current.settlement?.transactionHash;
      const reply = tx
        ? `The XRPL Testnet payment went through, but the demo order failed, so no tickets were issued.\nTransaction: ${tx}`
        : PURCHASE_FAILED_REPLY;
      return this.fail(current, current.settlement ? "order_failed_after_payment" : "order_failed", reply);
    }
    return this.complete(current, { orderId, isDemo: true });
  }

  private complete(record: TicketPurchaseRecord, result: { orderId: string; isDemo: boolean }): PurchaseOutcome {
    const saved =
      this.options.store.patch(record.id, {
        status: "COMPLETED",
        orderId: result.orderId,
        isDemo: result.isDemo,
        completedAt: this.options.now().toISOString(),
      }) ?? record;
    this.trace("ticket.purchase_completed", saved, {
      orderId: result.orderId,
      paymentNetwork: saved.paymentNetwork,
      ledger: saved.paymentNetwork ? ledgerOf(saved.paymentNetwork) : undefined,
      isTestTransaction: saved.isTestTransaction,
      transactionHash: saved.paymentTransactionId,
    });
    return { outcome: "completed", record: saved, reply: completedReply(saved) };
  }

  private fail(
    record: TicketPurchaseRecord,
    reason: string,
    reply: string,
    extra: { paymentNetwork?: "xrpl-testnet" | "mock"; settlement?: TicketPurchaseRecord["settlement"] } = {},
  ): PurchaseOutcome {
    const saved =
      this.options.store.patch(record.id, {
        status: "FAILED",
        failureReason: reason,
        ...(extra.paymentNetwork ? { paymentNetwork: extra.paymentNetwork, isTestTransaction: true } : {}),
        ...(extra.settlement ? { settlement: extra.settlement } : {}),
      }) ?? record;
    this.trace("ticket.purchase_failed", saved, {
      reason,
      paymentNetwork: saved.paymentNetwork,
      ledger: saved.paymentNetwork ? ledgerOf(saved.paymentNetwork) : undefined,
      transactionHash: saved.paymentTransactionId,
    });
    return { outcome: "failed", record: saved, reply };
  }

  private trace(event: Parameters<TicketTraceSink>[0], record: TicketPurchaseRecord, extra: Partial<TicketTraceFields> = {}): void {
    this.options.trace(event, {
      spaceId: record.spaceId,
      eventId: record.eventId,
      provider: record.provider,
      purchaseId: record.id,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      total: record.total,
      currency: record.currency,
      mode: record.mode,
      ...extra,
    });
  }
}

function ledgerOf(network: "xrpl-testnet" | "mock"): "testnet" | "mock" {
  return network === "xrpl-testnet" ? "testnet" : "mock";
}
