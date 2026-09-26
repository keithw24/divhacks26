import type { TicketEvent, TicketOffer, TicketPriceQuote } from "./types.js";

/** Per-ticket price we compare and charge: all-in when the provider supplied it, otherwise face value. */
export function unitPriceOf(offer: TicketOffer): number {
  return offer.allInUnitPrice ?? offer.unitPrice;
}

export function offerIsAllIn(offer: TicketOffer): boolean {
  return offer.allInUnitPrice !== undefined;
}

export function totalFor(offer: TicketOffer, quantity: number): number {
  return money(unitPriceOf(offer) * quantity);
}

export function isUsEvent(event: Pick<TicketEvent, "countryCode" | "currency">): boolean {
  return event.countryCode === "US" || (!event.countryCode && (event.currency ?? "USD") === "USD");
}

export type OfferSelection =
  | { status: "selected"; offer: TicketOffer }
  | { status: "over_budget"; alternative?: TicketOffer }
  | { status: "not_enough"; maxAvailable?: number }
  | { status: "no_offers" };

/**
 * Cheapest offer that covers the quantity and, when given, stays within the per-ticket cap.
 * An offer with unknown availability is only chosen when nothing with known availability fits.
 */
export function selectOffer(offers: TicketOffer[], input: { quantity: number; maxUnitPrice?: number; requirePurchasable?: boolean }): OfferSelection {
  const priced = offers.filter((offer) => Number.isFinite(unitPriceOf(offer)) && unitPriceOf(offer) > 0 && (!input.requirePurchasable || offer.purchasable));
  if (priced.length === 0) return { status: "no_offers" };
  const covers = (offer: TicketOffer) => offer.availableQuantity === undefined || offer.availableQuantity >= input.quantity;
  const enough = priced.filter(covers);
  if (enough.length === 0) {
    const known = priced.map((offer) => offer.availableQuantity).filter((value): value is number => value !== undefined);
    return { status: "not_enough", maxAvailable: known.length ? Math.max(...known) : undefined };
  }
  const byPrice = [...enough].sort((a, b) => {
    const diff = unitPriceOf(a) - unitPriceOf(b);
    if (diff !== 0) return diff;
    return Number(b.availableQuantity !== undefined) - Number(a.availableQuantity !== undefined);
  });
  const within = input.maxUnitPrice === undefined ? byPrice : byPrice.filter((offer) => unitPriceOf(offer) <= input.maxUnitPrice! + 1e-9);
  if (within[0]) return { status: "selected", offer: within[0] };
  return { status: "over_budget", alternative: byPrice[0] };
}

/** Distinct per-ticket prices, cheapest first. Only what the provider listed. */
export function distinctPrices(quote: TicketPriceQuote, limit = 4): number[] {
  const values = [...new Set(quote.offers.map((offer) => money(quote.allIn ? unitPriceOf(offer) : offer.unitPrice)))];
  return values.sort((a, b) => a - b).slice(0, limit);
}

export function hasAnyPrice(quote: TicketPriceQuote): boolean {
  return quote.minPrice !== undefined || quote.offers.length > 0;
}

export function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function cents(value: number): number {
  return Math.round(value * 100);
}
