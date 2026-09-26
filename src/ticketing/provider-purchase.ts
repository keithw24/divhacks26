import type { TicketEvent, TicketOffer, TicketProvider } from "./types.js";

/**
 * Provider-neutral purchase boundary. Discovery and pricing stay on TicketProvider;
 * this layer is only for checkout / order completion after the user confirmed a quote.
 *
 * Ticketmaster's public Discovery/Commerce keys never complete a purchase here.
 * Without Partner API transaction access, createCheckout returns CHECKOUT_REQUIRED
 * with the real event URL — never a fake PURCHASED.
 */

export type TicketCheckoutStatus =
  | "CHECKOUT_REQUIRED"
  | "PURCHASED"
  | "FAILED"
  | "PRICE_CHANGED"
  | "SOLD_OUT";

export interface TicketPurchaseRequest {
  provider: string;
  providerEventId: string;
  eventName: string;
  quantity: number;
  /** Offer / ticket identifiers from the provider when available. */
  offerId?: string;
  ticketIdentifiers?: string[];
  unitPrice: number;
  fees?: number;
  totalPrice: number;
  currency: string;
  userId: string;
  spaceId: string;
  quoteId: string;
  quoteTimestamp: string;
  authorizationTimestamp: string;
  /** Event snapshot used to build the checkout URL / reserve seats. */
  event: TicketEvent;
  offer?: TicketOffer;
  purchaseId: string;
}

export interface TicketCheckoutResult {
  status: TicketCheckoutStatus;
  checkoutUrl?: string;
  providerOrderId?: string;
  confirmationNumber?: string;
  reason?: string;
  /** Live unit price when status is PRICE_CHANGED. */
  newUnitPrice?: number;
  newTotalPrice?: number;
  newOffer?: TicketOffer;
}

export interface TicketPurchaseStatus {
  id: string;
  status: TicketCheckoutStatus;
  checkoutUrl?: string;
  providerOrderId?: string;
  confirmationNumber?: string;
}

export interface TicketPurchaseProvider {
  createCheckout(input: TicketPurchaseRequest): Promise<TicketCheckoutResult>;
  getPurchaseStatus?(id: string): Promise<TicketPurchaseStatus | undefined>;
}

/**
 * Adapts an existing TicketProvider into the purchase boundary.
 * - supportsPurchase + reserve/purchase → may return PURCHASED with a real order id
 * - otherwise → CHECKOUT_REQUIRED with the provider's real checkout URL (never fake PURCHASED)
 */
export function createTicketPurchaseProvider(provider: TicketProvider): TicketPurchaseProvider {
  const orders = new Map<string, TicketPurchaseStatus>();

  return {
    async createCheckout(input) {
      const url = provider.checkoutUrl(input.event) ?? input.event.url;
      if (provider.supportsPurchase && provider.reserve && provider.purchase && input.offer) {
        try {
          const hold = await provider.reserve({ event: input.event, offer: input.offer, quantity: input.quantity });
          if (hold.currency !== input.currency || Math.round(hold.total * 100) !== Math.round(input.totalPrice * 100)) {
            return {
              status: "PRICE_CHANGED",
              reason: "total_changed",
              newUnitPrice: hold.unitPrice,
              newTotalPrice: hold.total,
              newOffer: input.offer,
            };
          }
          const result = await provider.purchase({ hold, purchaseId: input.purchaseId });
          if (result.status === "completed" && result.orderId) {
            const status: TicketPurchaseStatus = {
              id: input.purchaseId,
              status: "PURCHASED",
              providerOrderId: result.orderId,
              confirmationNumber: result.orderId,
            };
            orders.set(input.purchaseId, status);
            return {
              status: "PURCHASED",
              providerOrderId: result.orderId,
              confirmationNumber: result.orderId,
            };
          }
          return { status: "FAILED", reason: result.reason ?? "purchase_failed" };
        } catch {
          return { status: "FAILED", reason: "provider_error" };
        }
      }

      if (!url) return { status: "FAILED", reason: "no_checkout_url" };
      const status: TicketPurchaseStatus = {
        id: input.purchaseId,
        status: "CHECKOUT_REQUIRED",
        checkoutUrl: url,
      };
      orders.set(input.purchaseId, status);
      return { status: "CHECKOUT_REQUIRED", checkoutUrl: url };
    },

    async getPurchaseStatus(id) {
      return orders.get(id);
    },
  };
}

/** Stable idempotency key: one confirmation of one quote can never settle twice. */
export function ticketPurchaseIdempotencyKey(spaceId: string, quoteId: string): string {
  return `ticket:${spaceId}:${quoteId}`;
}
