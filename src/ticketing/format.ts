import { fromTicketEvent } from "../calendar/from.js";
import { withCalendarLine } from "../calendar/links.js";
import { addIsoDays, zonedDateISO } from "./time.js";
import { distinctPrices, isUsEvent, offerIsAllIn, unitPriceOf } from "./pricing.js";
import type { TicketEvent, TicketOffer, TicketPriceQuote, TicketPurchaseRecord } from "./types.js";

export function formatMoney(value: number, currency = "USD"): string {
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  if (currency === "USD") return `$${whole ? Math.round(value).toLocaleString("en-US") : value.toFixed(2)}`;
  return `${whole ? Math.round(value) : value.toFixed(2)} ${currency}`;
}

function clock(localTime: string | undefined): string | undefined {
  const match = localTime?.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = match[2];
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "am" : "";
  return `${h12}${minute === "00" ? "" : `:${minute}`}${suffix}`;
}

/** "tonight at 7:30", "tomorrow at 7:05", "Sat at 8". Uses the provider's local date and time. */
export function whenText(event: TicketEvent, now: Date, timeZone: string): string | undefined {
  const time = clock(event.localTime);
  if (!event.localDate) return time ? `at ${time}` : undefined;
  const today = zonedDateISO(now, timeZone);
  const hour = Number(event.localTime?.slice(0, 2) ?? "0");
  let day: string;
  if (event.localDate === today) day = hour >= 17 ? "tonight" : "today";
  else if (event.localDate === addIsoDays(today, 1)) day = "tomorrow";
  else {
    const date = new Date(`${event.localDate}T12:00:00Z`);
    const diffDays = (Date.parse(`${event.localDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    day =
      diffDays > 0 && diffDays < 7
        ? new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date)
        : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  }
  return time ? `${day} at ${time}` : day;
}

function fromPrice(event: TicketEvent): string | undefined {
  if (event.minPrice === undefined) return undefined;
  const amount = formatMoney(event.minPrice, event.currency);
  if (event.priceIncludesFees) return `from ${amount}`;
  return isUsEvent(event) ? `from ${amount} + fees` : `from ${amount}`;
}

function eventLine(event: TicketEvent, now: Date, timeZone: string): string {
  const parts = [event.name];
  if (event.venue && !event.name.toLowerCase().includes(event.venue.toLowerCase())) parts.push(`at ${event.venue}`);
  const when = whenText(event, now, timeZone);
  if (when) parts.push(when);
  const price = fromPrice(event);
  return price ? `${parts.join(" ")} (${price})` : parts.join(" ");
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function searchReply(input: {
  events: TicketEvent[];
  now: Date;
  timeZone: string;
  maxPrice?: number;
  unpricedSkipped: number;
  placeLabel?: string;
}): string {
  const where = input.placeLabel ? ` near ${input.placeLabel}` : "";
  if (input.events.length === 0) {
    if (input.maxPrice !== undefined) {
      const skipped = input.unpricedSkipped > 0 ? " A few listings don't show prices, so I left those out." : "";
      return `I didn't find anything${where} with tickets under ${formatMoney(input.maxPrice)}.${skipped}`;
    }
    return `I didn't find any ticketed events${where} for that time. Want me to widen the search?`;
  }
  const lines = input.events.map((event) => eventLine(event, input.now, input.timeZone));
  if (lines.length === 1) return `There's ${lines[0]}. Want ticket prices?`;
  return `Yeah — there's ${joinList(lines)}.`;
}

export function detailsReply(event: TicketEvent, now: Date, timeZone: string): string {
  const when = whenText(event, now, timeZone);
  const venue = event.venue ? ` at ${event.venue}` : "";
  const address = event.address ? ` (${event.address})` : "";
  const price = fromPrice(event);
  const priceText = price ? ` Tickets ${price.replace(/^from/, "start from")}.` : "";
  return withCalendarLine(`${event.name} is${venue}${address}${when ? ` ${when}` : ""}.${priceText}`, fromTicketEvent(event));
}

export function priceReply(event: TicketEvent, quote: TicketPriceQuote, checkoutUrl?: string): string {
  const currency = quote.currency ?? event.currency ?? "USD";
  if (quote.minPrice === undefined) {
    const link = checkoutUrl ? ` Here's the official listing: ${checkoutUrl}` : "";
    return `I couldn't get ticket prices for ${event.name} right now.${link}`;
  }
  const start = formatMoney(quote.minPrice, currency);
  const feeNote = quote.allIn ? " all-in" : isUsEvent(event) ? " before fees" : "";
  if (quote.offers.length > 0) {
    const prices = distinctPrices(quote);
    const options = prices.length > 1 ? ` I found options at ${joinList(prices.map((value) => formatMoney(value, currency)))}.` : "";
    const fees = !quote.allIn && isUsEvent(event) ? " Those don't include mandatory fees, so the final price will be higher." : "";
    return `Tickets for ${event.name} currently start at ${start}${feeNote}.${options}${fees}`;
  }
  const range = quote.maxPrice !== undefined && quote.maxPrice > quote.minPrice ? ` (up to ${formatMoney(quote.maxPrice, currency)})` : "";
  const link = checkoutUrl ? ` I can't see exact seats from here, but you can choose seats on the official listing: ${checkoutUrl}` : "";
  return `Tickets for ${event.name} currently start around ${start}${feeNote}${range}.${link}`;
}

function seatText(offer: TicketOffer): string {
  const parts = [offer.section ? `Section ${offer.section}` : undefined, offer.row ? `Row ${offer.row}` : undefined].filter(Boolean);
  if (parts.length) return ` (${parts.join(", ")})`;
  return offer.label ? ` (${offer.label})` : "";
}

export function quoteLine(offer: TicketOffer, quantity: number, event: TicketEvent): string {
  const unit = formatMoney(unitPriceOf(offer), offer.currency);
  const total = formatMoney(unitPriceOf(offer) * quantity, offer.currency);
  const fees = offerIsAllIn(offer) ? "" : isUsEvent(event) ? " before fees" : "";
  const noun = quantity === 1 ? "ticket" : "tickets";
  const found = offer.availableQuantity !== undefined ? `I found ${quantity} ${noun}` : `${quantity} ${noun} are listed`;
  const each = quantity === 1 ? "" : " each";
  const totalText = quantity === 1 ? "" : `, ${total} total${fees}`;
  return `${found} for ${event.name} at ${unit}${each}${quantity === 1 ? fees : ""}${seatText(offer)}${totalText}`;
}

export function confirmPurchaseReply(offer: TicketOffer, quantity: number, event: TicketEvent, demo: boolean): string {
  const ask = quantity === 1 ? "Want me to purchase it?" : "Want me to purchase them?";
  const demoNote = demo ? " (Demo checkout: no real tickets, paid with test funds on XRPL Testnet.)" : "";
  return `${quoteLine(offer, quantity, event)}. ${ask}${demoNote}`;
}

/** Pending link-mode quote: show the total, ask before handing off to the provider site. */
export function confirmCheckoutReply(offer: TicketOffer, quantity: number, event: TicketEvent): string {
  const total = formatMoney(unitPriceOf(offer) * quantity, offer.currency);
  return `${quantity === 1 ? "One ticket" : `${quantity} tickets`} to ${event.name} ${quantity === 1 ? "is" : "are"} ${total} total${seatText(offer)}. Want me to prepare the checkout?`;
}

export function checkoutPreparedReply(record: TicketPurchaseRecord): string {
  const noun = record.quantity === 1 ? "ticket" : "tickets";
  const total = formatMoney(record.total, record.currency);
  const url = record.checkoutUrl;
  const link = url ? `\n\n${url}` : "";
  return `Your ${record.quantity} ${noun} to ${record.eventName} ${record.quantity === 1 ? "is" : "are"} still available for ${total}. I prepared the checkout for you:${link}`;
}

export function soldOutReply(): string {
  return "Those tickets are no longer available, so I didn't charge you.";
}

export function overBudgetReply(alternative: TicketOffer | undefined, quantity: number, maxUnitPrice: number, event: TicketEvent, demo: boolean): string {
  const cap = formatMoney(maxUnitPrice, alternative?.currency ?? event.currency ?? "USD");
  if (!alternative) return `I don't see ${quantity} tickets for ${event.name} under ${cap} each right now.`;
  const ask = quantity === 1 ? "Want that one instead?" : "Want those instead?";
  const demoNote = demo ? " (Demo checkout: no real tickets, paid with test funds on XRPL Testnet.)" : "";
  const unit = formatMoney(unitPriceOf(alternative), alternative.currency);
  const fees = offerIsAllIn(alternative) ? "" : isUsEvent(event) ? " before fees" : "";
  const total = quantity === 1 ? "" : `, ${formatMoney(unitPriceOf(alternative) * quantity, alternative.currency)} total for ${quantity}`;
  return `Nothing under ${cap} each right now. The cheapest I see is ${unit}${quantity === 1 ? "" : " each"}${seatText(alternative)}${total}${fees}. ${ask}${demoNote}`;
}

export function requoteReply(
  offer: TicketOffer,
  quantity: number,
  total: number,
  event: TicketEvent,
  demo: boolean,
  previousTotal?: number,
): string {
  const ask = quantity === 1 ? "Want me to continue at the new price?" : "Want me to continue at the new price?";
  const demoNote = demo ? " (Demo checkout: no real tickets, paid with test funds on XRPL Testnet.)" : "";
  const noun = quantity === 1 ? "ticket" : "tickets";
  if (previousTotal !== undefined && Math.round(previousTotal * 100) !== Math.round(total * 100)) {
    return `The price changed from ${formatMoney(previousTotal, offer.currency)} to ${formatMoney(total, offer.currency)}, so I didn't purchase anything. ${ask}${demoNote}`;
  }
  return `The price changed: ${quantity} ${noun} for ${event.name} now come to ${formatMoney(total, offer.currency)} total${seatText(offer)}. ${ask}${demoNote}`;
}

export function whichEventReply(events: TicketEvent[]): string {
  const names = events.map((event) => event.name);
  if (names.length <= 1) return `Which event do you mean${names[0] ? ` — ${names[0]}` : ""}?`;
  const list = names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
  return `Which one — ${list}?`;
}

export function notEnoughReply(quantity: number, event: TicketEvent, maxAvailable?: number): string {
  const most = maxAvailable ? ` The most I can see in one listing is ${maxAvailable}.` : "";
  return `I don't see ${quantity} tickets available for ${event.name} right now.${most}`;
}

export function linkOnlyReply(input: { event: TicketEvent; offer?: TicketOffer; quantity?: number; url?: string; fromPrice?: number; allIn?: boolean }): string {
  const link = input.url ? ` here's the official link to buy: ${input.url}` : " I don't have an official link for it.";
  if (input.offer && input.quantity) {
    return `${quoteLine(input.offer, input.quantity, input.event)}. I can't complete checkout through this provider, but${link}`;
  }
  if (input.fromPrice !== undefined) {
    const fee = input.allIn ? " all-in" : isUsEvent(input.event) ? " before fees" : "";
    return `Tickets for ${input.event.name} start around ${formatMoney(input.fromPrice, input.event.currency)}${fee}. I can't pick exact seats from here, but${link}`;
  }
  return `I can't complete checkout for ${input.event.name} from here, but${link}`;
}

export function completedReply(record: TicketPurchaseRecord, event?: TicketEvent): string {
  const noun = record.quantity === 1 ? "ticket" : "tickets";
  const total = formatMoney(record.total, record.currency);
  const confirmation = record.confirmationNumber ?? record.orderId;
  let body: string;
  if (!record.isDemo) {
    body = `Booked — ${record.quantity} ${noun} to ${record.eventName} for ${total} total.${confirmation ? `\nConfirmation: ${confirmation}` : ""}`;
  } else {
    const settlement = record.settlement;
    if (settlement?.network === "xrpl-testnet") {
      const tx = settlement.transactionHash ? `\nTransaction: ${settlement.transactionHash}` : "";
      const explorer = settlement.explorerUrl ? `\n${settlement.explorerUrl}` : "";
      body =
        `Booked — ${record.quantity} ${noun} to ${record.eventName} for ${total} total.` +
        `${confirmation ? `\nConfirmation: ${confirmation}` : ""}` +
        `\nPayment: validated on XRPL Testnet` +
        `${tx}${explorer}` +
        `\n(Demo settlement only — XRPL Testnet, not a real Ticketmaster purchase.)`;
    } else if (settlement) {
      body = `Done — ${record.quantity} demo ${noun} for ${record.eventName}, ${total} total.${confirmation ? ` Order ${confirmation}.` : ""} Demo payment only: no money moved and no real tickets were issued.`;
    } else {
      body = `Done — ${record.quantity} demo ${noun} for ${record.eventName}, ${total} total.${confirmation ? ` Order ${confirmation}.` : ""} This was a demo checkout, so no real tickets were issued.`;
    }
  }
  return withCalendarLine(body, fromTicketEvent(event));
}

export function paymentFailedReply(reason: string): string {
  if (reason === "unsupported_currency") return "I can only settle USD-priced tickets in the demo, so I didn't buy them.";
  if (reason === "over_limit") return "That's over the payment limit, so I didn't buy the tickets.";
  if (reason === "unknown_merchant") return "I don't have a payment destination set up for this seller, so I didn't buy the tickets.";
  return "The XRPL Testnet payment didn't go through, so I didn't buy the tickets.";
}

export const PAYMENT_UNCERTAIN_REPLY =
  "I couldn't confirm the XRPL Testnet payment, so I haven't marked the tickets as purchased. I'll only report it once the ledger shows it.";
export const PURCHASE_FAILED_REPLY = "I couldn't complete that purchase, so nothing was bought. Want me to try again or send the official link?";
export const SEARCH_FAILED_REPLY = "I couldn't reach the ticket listings right now, so I can't say what's on. Try again in a bit?";
export const PRICE_FAILED_REPLY = "I couldn't get live ticket prices right now, so I don't want to guess.";
export const EXPIRED_REPLY = "That quote expired, so I didn't buy anything. Want me to check prices again?";