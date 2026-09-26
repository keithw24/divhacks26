import type { SearchRequest } from "./intent.js";

/**
 * Ticketing domain. Every event, price, and offer here comes from a provider response.
 * Gemini never produces any of these values.
 */

export type TicketingProviderName = "mock" | "ticketmaster";

/**
 * mock: demo checkout, settled through the shared payment service (mock or XRPL Testnet). No real tickets.
 * provider: the ticket provider's own transaction API when it has one (Ticketmaster Partner API). Otherwise link.
 * link: never buys. Returns the official checkout URL.
 */
export type TicketPurchaseMode = "mock" | "provider" | "link";

/** Where a price came from. Never "model" or "user". */
export type PriceSource =
  | "discovery_price_range"
  | "commerce_offers"
  | "partner_availability"
  | "mock_inventory";

export interface TicketEvent {
  id: string;
  provider: string;
  name: string;
  venue?: string;
  address?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  /** ISO timestamp when the provider supplied one. */
  startTime?: string;
  /** Provider's local date/time, e.g. 2026-09-26 and 19:30:00. */
  localDate?: string;
  localTime?: string;
  timeZone?: string;
  category?: string;
  genre?: string;
  attractions?: string[];
  url?: string;
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  /** True when the provider said the range includes mandatory fees. */
  priceIncludesFees?: boolean;
  priceSource?: PriceSource;
  countryCode?: string;
}

export interface TicketOffer {
  id: string;
  eventId: string;
  provider: string;
  /** Provider label such as "Standard Admission". Never invented. */
  label?: string;
  section?: string;
  row?: string;
  /** Face value per ticket as the provider priced it. */
  unitPrice: number;
  /** Per-ticket price including mandatory fees, only when the provider supplied it. */
  allInUnitPrice?: number;
  currency: string;
  /** Only when the provider reports it. Undefined means unknown, not unlimited. */
  availableQuantity?: number;
  /** Seat-level offers can be reserved. Range-only prices cannot. */
  purchasable: boolean;
}

export interface TicketPriceQuote {
  eventId: string;
  provider: string;
  fetchedAt: string;
  currency?: string;
  minPrice?: number;
  maxPrice?: number;
  /** True only when every price in this quote includes mandatory fees. */
  allIn: boolean;
  source: PriceSource;
  offers: TicketOffer[];
}

export interface EventSearchQuery {
  latitude?: number;
  longitude?: number;
  city?: string;
  radiusMiles?: number;
  /** ISO timestamps (UTC). */
  startDateTime?: string;
  endDateTime?: string;
  keyword?: string;
  /** Provider classification, e.g. Music, Sports, Comedy, Theatre. */
  classificationName?: string;
  genre?: string;
  venue?: string;
  attraction?: string;
  /** Filter applied after the provider responds. Events without a known price are excluded. */
  maxPrice?: number;
  sortByPrice?: boolean;
  size?: number;
}

export interface TicketHold {
  holdId: string;
  eventId: string;
  offerId: string;
  quantity: number;
  unitPrice: number;
  total: number;
  currency: string;
  expiresAt?: string;
}

export interface ProviderPurchaseResult {
  status: "completed" | "failed";
  orderId?: string;
  reason?: string;
}

export interface TicketProvider {
  readonly name: string;
  /** True only when this provider can complete a real transaction for us. */
  readonly supportsPurchase: boolean;
  searchEvents(query: EventSearchQuery): Promise<TicketEvent[]>;
  getEvent(eventId: string): Promise<TicketEvent | undefined>;
  getPrices(event: TicketEvent): Promise<TicketPriceQuote>;
  getOffers?(event: TicketEvent): Promise<TicketOffer[]>;
  checkoutUrl(event: TicketEvent): string | undefined;
  reserve?(input: { event: TicketEvent; offer: TicketOffer; quantity: number }): Promise<TicketHold>;
  purchase?(input: { hold: TicketHold; purchaseId: string }): Promise<ProviderPurchaseResult>;
}

export type TicketProviderErrorKind = "unconfigured" | "unauthorized" | "rate_limited" | "unavailable" | "bad_response";

export class TicketProviderError extends Error {
  constructor(
    readonly kind: TicketProviderErrorKind,
    message: string = kind,
  ) {
    super(message);
    this.name = "TicketProviderError";
  }
}

/**
 * Lifecycle of one quote → confirmation → checkout/payment.
 * COMPLETED is the durable "purchased" state (demo or provider). CHECKOUT_REQUIRED means
 * the provider needs the user on its site — never treat that as purchased.
 */
export type TicketPurchaseStatus =
  | "AWAITING_CONFIRMATION"
  | "PROCESSING"
  | "PAYMENT_SUBMITTED"
  | "COMPLETED"
  | "CHECKOUT_REQUIRED"
  | "PRICE_CHANGED"
  | "SOLD_OUT"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "LINK_ONLY";

export interface TicketSettlement {
  network: "xrpl-testnet" | "mock";
  asset: string;
  amount: string;
  /** Units of `asset` per unit of the ticket currency. A configured demo peg, not a market rate. */
  exchangeRate: string;
  rateSource: "configured_demo_peg";
  isTestTransaction: true;
  transactionHash?: string;
  ledgerResult?: string;
  explorerUrl?: string;
  /** Public addresses only. Never seeds. */
  senderAddress?: string;
  destinationAddress?: string;
  /** True only after an independent ledger re-read matched amount + destination. */
  independentlyVerified?: boolean;
}

/** Traceable breadcrumb on a purchase. No secrets. */
export interface TicketPurchaseEvidence {
  type: string;
  at: string;
  messageId?: string;
  details?: Record<string, string | number | boolean | null>;
}

/**
 * One ticket purchase from intent to result. Links:
 * Photon space → event → offer → purchase intent → payment transaction → order.
 * `id` is the quote id shown before confirmation.
 */
export interface TicketPurchaseRecord {
  id: string;
  /** Same as id. Kept explicit so confirmation always binds to the quote the user saw. */
  quoteId: string;
  spaceId: string;
  initiatorId: string;
  initiatorName?: string;
  eventId: string;
  eventName: string;
  venue?: string;
  provider: string;
  offerId: string;
  quantity: number;
  unitPrice: number;
  /** Per-ticket fees when the provider supplied an all-in price above face value. */
  fees?: number;
  total: number;
  currency: string;
  allIn: boolean;
  mode: TicketPurchaseMode;
  /** Demo checkout. No real ticket is issued. */
  isDemo: boolean;
  status: TicketPurchaseStatus;
  ticketTotal: { amount: number; currency: string };
  settlement?: TicketSettlement;
  paymentNetwork?: "xrpl-testnet" | "mock";
  isTestTransaction?: boolean;
  paymentTransactionId?: string;
  orderId?: string;
  confirmationNumber?: string;
  checkoutUrl?: string;
  failureReason?: string;
  requestMessageId?: string;
  confirmMessageId?: string;
  quotedAt: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  evidence: TicketPurchaseEvidence[];
}

export interface TicketingState {
  spaceId: string;
  lastSearchResults: TicketEvent[];
  /** Filters of the last search, so "anything under $50?" refines it instead of starting over. */
  lastSearch?: Pick<SearchRequest, "when" | "category" | "place" | "nearby">;
  selectedEvent?: TicketEvent;
  lastQuote?: TicketPriceQuote;
  requestedQuantity?: number;
  maxPricePerTicket?: number;
  selectedOffer?: TicketOffer;
  pendingPurchaseId?: string;
  /** The agent asked a follow-up question and the next short reply answers it. */
  awaiting?: { kind: "quantity" } | { kind: "choice"; action: "price" | "purchase" };
  updatedAt: number;
}
