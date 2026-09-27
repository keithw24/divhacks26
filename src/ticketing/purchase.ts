import { createHash } from "node:crypto";
import {
  checkoutPreparedReply,
  completedReply,
  PAYMENT_UNCERTAIN_REPLY,
  paymentFailedReply,
  PRICE_FAILED_REPLY,
  PURCHASE_FAILED_REPLY,
  soldOutReply,
} from "./format.js";
import type { TicketTraceFields, TicketTraceSink } from "./log.js";
import type { TicketPaymentPort } from "./payment.js";
import { cents, totalFor, unitPriceOf } from "./pricing.js";
import { createTicketPurchaseProvider, ticketPurchaseIdempotencyKey } from "./provider-purchase.js";
import type { TicketingStore } from "./state.js";
import type { TicketEvent, TicketOffer, TicketProvider, TicketPurchaseRecord } from "./types.js";

export type PurchaseOutcome =
  | { outcome: "completed"; record: TicketPurchaseRecord; reply: string }
  | { outcome: "checkout_required"; record: TicketPurchaseRecord; reply: string }
  | { outcome: "failed"; record: TicketPurchaseRecord; reply: string }
  | { outcome: "sold_out"; record: TicketPurchaseRecord; reply: string }
  /** Live price differs from what the user confirmed. Nothing was bought; ask again with the new figures. */
  | { outcome: "requote"; record: TicketPurchaseRecord; offer: TicketOffer; total: number; previousTotal: number };

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
 * The price is re-read from the provider first. A ticket is marked COMPLETED/PURCHASED only after
 * a real provider order or a validated XRPL Testnet demo settlement — never from submit alone.
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
    this.note(record.id, "TICKET_PRICE_REVALIDATED", { offerCount: offers.length });
    this.trace("ticket.price_revalidated", record, { reason: "pre_purchase" });
    this.trace("TICKET_PRICE_REVALIDATED", record, { reason: "pre_purchase" });

    const offer = offers.find((item) => item.id === record.offerId);
    if (!offer || (offer.availableQuantity !== undefined && offer.availableQuantity < record.quantity)) {
      return this.soldOut(record);
    }
    if (offer.currency !== record.currency || cents(unitPriceOf(offer)) !== cents(record.unitPrice)) {
      const failed =
        store.patch(record.id, {
          status: "PRICE_CHANGED",
          failureReason: "price_changed",
        }) ?? record;
      this.note(failed.id, "TICKET_PURCHASE_FAILED", { reason: "price_changed" });
      this.trace("ticket.purchase_failed", failed, { reason: "price_changed" });
      this.trace("TICKET_PURCHASE_FAILED", failed, { reason: "price_changed" });
      return { outcome: "requote", record: failed, offer, total: totalFor(offer, record.quantity), previousTotal: record.total };
    }

    if (record.mode === "link") return this.providerCheckout(record, event, offer);
    if (record.mode === "provider") return this.providerPurchase(record, event, offer);
    return this.demoPurchase(record, event, offer);
  }

  private async providerCheckout(record: TicketPurchaseRecord, event: TicketEvent, offer: TicketOffer): Promise<PurchaseOutcome> {
    const purchase = createTicketPurchaseProvider(this.options.provider);
    const result = await purchase.createCheckout({
      provider: record.provider,
      providerEventId: record.eventId,
      eventName: record.eventName,
      quantity: record.quantity,
      offerId: record.offerId,
      unitPrice: record.unitPrice,
      fees: record.fees,
      totalPrice: record.total,
      currency: record.currency,
      userId: record.initiatorId,
      spaceId: record.spaceId,
      quoteId: record.quoteId,
      quoteTimestamp: record.quotedAt,
      authorizationTimestamp: record.confirmedAt ?? this.options.now().toISOString(),
      event,
      offer,
      purchaseId: record.id,
    });

    if (result.status === "PRICE_CHANGED" && result.newOffer && result.newTotalPrice != null) {
      const failed =
        this.options.store.patch(record.id, { status: "PRICE_CHANGED", failureReason: "price_changed" }) ?? record;
      return {
        outcome: "requote",
        record: failed,
        offer: result.newOffer,
        total: result.newTotalPrice,
        previousTotal: record.total,
      };
    }
    if (result.status === "SOLD_OUT") return this.soldOut(record);
    if (result.status === "PURCHASED" && result.providerOrderId) {
      return this.complete(record, { orderId: result.providerOrderId, isDemo: false }, event);
    }
    if (result.status !== "CHECKOUT_REQUIRED" || !result.checkoutUrl) {
      return this.fail(record, result.reason ?? "checkout_failed", PURCHASE_FAILED_REPLY);
    }

    const saved =
      this.options.store.patch(record.id, {
        status: "CHECKOUT_REQUIRED",
        checkoutUrl: result.checkoutUrl,
        completedAt: this.options.now().toISOString(),
      }) ?? record;
    this.note(saved.id, "TICKET_CHECKOUT_CREATED", { checkoutUrl: result.checkoutUrl });
    this.trace("ticket.checkout_created", saved, { checkoutUrl: result.checkoutUrl });
    this.trace("TICKET_CHECKOUT_CREATED", saved, { checkoutUrl: result.checkoutUrl });
    return { outcome: "checkout_required", record: saved, reply: checkoutPreparedReply(saved) };
  }

  private async providerPurchase(record: TicketPurchaseRecord, event: TicketEvent, offer: TicketOffer): Promise<PurchaseOutcome> {
    const purchase = createTicketPurchaseProvider(this.options.provider);
    const result = await purchase.createCheckout({
      provider: record.provider,
      providerEventId: record.eventId,
      eventName: record.eventName,
      quantity: record.quantity,
      offerId: record.offerId,
      unitPrice: record.unitPrice,
      fees: record.fees,
      totalPrice: record.total,
      currency: record.currency,
      userId: record.initiatorId,
      spaceId: record.spaceId,
      quoteId: record.quoteId,
      quoteTimestamp: record.quotedAt,
      authorizationTimestamp: record.confirmedAt ?? this.options.now().toISOString(),
      event,
      offer,
      purchaseId: record.id,
    });

    if (result.status === "CHECKOUT_REQUIRED" && result.checkoutUrl) {
      const saved =
        this.options.store.patch(record.id, {
          status: "CHECKOUT_REQUIRED",
          checkoutUrl: result.checkoutUrl,
          completedAt: this.options.now().toISOString(),
        }) ?? record;
      this.note(saved.id, "TICKET_CHECKOUT_CREATED", { checkoutUrl: result.checkoutUrl });
      this.trace("ticket.checkout_created", saved, { checkoutUrl: result.checkoutUrl });
      this.trace("TICKET_CHECKOUT_CREATED", saved, { checkoutUrl: result.checkoutUrl });
      return { outcome: "checkout_required", record: saved, reply: checkoutPreparedReply(saved) };
    }
    if (result.status === "PRICE_CHANGED" && result.newOffer && result.newTotalPrice != null) {
      const failed =
        this.options.store.patch(record.id, { status: "PRICE_CHANGED", failureReason: "price_changed" }) ?? record;
      return {
        outcome: "requote",
        record: failed,
        offer: result.newOffer,
        total: result.newTotalPrice,
        previousTotal: record.total,
      };
    }
    if (result.status === "SOLD_OUT") return this.soldOut(record);
    if (result.status !== "PURCHASED" || !result.providerOrderId) {
      return this.fail(record, result.reason ?? "purchase_failed", PURCHASE_FAILED_REPLY);
    }
    return this.complete(record, { orderId: result.providerOrderId, isDemo: false }, event);
  }

  private async demoPurchase(record: TicketPurchaseRecord, event: TicketEvent, offer: TicketOffer): Promise<PurchaseOutcome> {
    const { store, payments } = this.options;
    let current = record;
    if (payments) {
      this.trace("ticket.payment_started", current, { paymentNetwork: payments.network, ledger: ledgerOf(payments.network), isTestTransaction: true });
      this.trace("TICKET_PAYMENT_AUTHORIZED", current, { paymentNetwork: payments.network, ledger: ledgerOf(payments.network), isTestTransaction: true });
      this.trace("TICKET_PAYMENT_SUBMITTED", current, { paymentNetwork: payments.network, ledger: ledgerOf(payments.network), isTestTransaction: true });
      this.note(current.id, "TICKET_PAYMENT_AUTHORIZED", { network: payments.network });

      const paid = await payments
        .pay({
          purpose: "event_ticket",
          amount: record.total,
          currency: record.currency,
          merchant: this.options.merchantName,
          eventId: record.eventId,
          spaceId: record.spaceId,
          initiatorId: record.initiatorId,
          idempotencyKey: ticketPurchaseIdempotencyKey(record.spaceId, record.quoteId),
          metadata: {
            purchaseId: record.id,
            quoteId: record.quoteId,
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
      if (!paid.settlement.independentlyVerified && paid.settlement.network === "xrpl-testnet") {
        // createSharedTicketPayments always sets independentlyVerified for validated XRPL results.
        // If a settlement lacks it, never mark purchased.
        return this.fail(record, "payment_unverified", PAYMENT_UNCERTAIN_REPLY, {
          paymentNetwork: payments.network,
          settlement: paid.settlement,
        });
      }

      current =
        store.patch(record.id, {
          status: "PAYMENT_SUBMITTED",
          settlement: paid.settlement,
          paymentNetwork: paid.settlement.network,
          isTestTransaction: true,
          paymentTransactionId: paid.settlement.transactionHash,
        }) ?? current;
      this.note(current.id, "TICKET_PAYMENT_VALIDATED", {
        transactionHash: paid.settlement.transactionHash ?? null,
        independentlyVerified: paid.settlement.independentlyVerified === true,
      });
      this.trace("ticket.payment_validated", current, {
        paymentNetwork: paid.settlement.network,
        ledger: ledgerOf(paid.settlement.network),
        isTestTransaction: true,
        transactionHash: paid.settlement.transactionHash,
      });
      this.trace("TICKET_PAYMENT_VALIDATED", current, {
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
    return this.complete(current, { orderId, isDemo: true }, event);
  }

  private complete(record: TicketPurchaseRecord, result: { orderId: string; isDemo: boolean }, event?: TicketEvent): PurchaseOutcome {
    const saved =
      this.options.store.patch(record.id, {
        status: "COMPLETED",
        orderId: result.orderId,
        confirmationNumber: result.orderId,
        isDemo: result.isDemo,
        completedAt: this.options.now().toISOString(),
      }) ?? record;
    this.note(saved.id, "TICKET_PURCHASED", { orderId: result.orderId, isDemo: result.isDemo });
    this.trace("ticket.purchase_completed", saved, {
      orderId: result.orderId,
      paymentNetwork: saved.paymentNetwork,
      ledger: saved.paymentNetwork ? ledgerOf(saved.paymentNetwork) : undefined,
      isTestTransaction: saved.isTestTransaction,
      transactionHash: saved.paymentTransactionId,
    });
    this.trace("TICKET_PURCHASED", saved, {
      orderId: result.orderId,
      paymentNetwork: saved.paymentNetwork,
      ledger: saved.paymentNetwork ? ledgerOf(saved.paymentNetwork) : undefined,
      isTestTransaction: saved.isTestTransaction,
      transactionHash: saved.paymentTransactionId,
    });
    return { outcome: "completed", record: saved, reply: completedReply(saved, event) };
  }

  private soldOut(record: TicketPurchaseRecord): PurchaseOutcome {
    const saved = this.options.store.patch(record.id, { status: "SOLD_OUT", failureReason: "offer_gone" }) ?? record;
    this.note(saved.id, "TICKET_PURCHASE_FAILED", { reason: "sold_out" });
    this.trace("ticket.purchase_failed", saved, { reason: "sold_out" });
    this.trace("TICKET_PURCHASE_FAILED", saved, { reason: "sold_out" });
    return { outcome: "sold_out", record: saved, reply: soldOutReply() };
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
    this.note(saved.id, "TICKET_PURCHASE_FAILED", { reason });
    this.trace("ticket.purchase_failed", saved, {
      reason,
      paymentNetwork: saved.paymentNetwork,
      ledger: saved.paymentNetwork ? ledgerOf(saved.paymentNetwork) : undefined,
      transactionHash: saved.paymentTransactionId,
    });
    this.trace("TICKET_PURCHASE_FAILED", saved, {
      reason,
      paymentNetwork: saved.paymentNetwork,
      ledger: saved.paymentNetwork ? ledgerOf(saved.paymentNetwork) : undefined,
      transactionHash: saved.paymentTransactionId,
    });
    return { outcome: "failed", record: saved, reply };
  }

  private note(id: string, type: string, details: Record<string, string | number | boolean | null> = {}): void {
    this.options.store.appendEvidence(id, { type, at: this.options.now().toISOString(), details });
  }

  private trace(event: Parameters<TicketTraceSink>[0], record: TicketPurchaseRecord, extra: Partial<TicketTraceFields> = {}): void {
    this.options.trace(event, {
      spaceId: record.spaceId,
      eventId: record.eventId,
      provider: record.provider,
      purchaseId: record.id,
      quoteId: record.quoteId,
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
