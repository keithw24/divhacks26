export type TicketTraceEvent =
  | "ticket.search"
  | "ticket.price_lookup"
  | "ticket.offer_selected"
  | "ticket.purchase_requested"
  | "ticket.purchase_confirmed"
  | "ticket.payment_started"
  | "ticket.payment_validated"
  | "ticket.checkout_created"
  | "ticket.purchase_completed"
  | "ticket.purchase_failed"
  | "ticket.price_revalidated"
  /** Uppercase audit names used in the purchase trail (same payloads as the lowercase events). */
  | "TICKET_DISCOVERED"
  | "TICKET_QUOTED"
  | "TICKET_PURCHASE_REQUESTED"
  | "TICKET_PURCHASE_CONFIRMED"
  | "TICKET_PRICE_REVALIDATED"
  | "TICKET_PAYMENT_AUTHORIZED"
  | "TICKET_PAYMENT_SUBMITTED"
  | "TICKET_PAYMENT_VALIDATED"
  | "TICKET_CHECKOUT_CREATED"
  | "TICKET_PURCHASED"
  | "TICKET_PURCHASE_FAILED";

export interface TicketTraceFields {
  spaceId: string;
  eventId?: string;
  provider?: string;
  purchaseId?: string;
  quoteId?: string;
  quantity?: number;
  unitPrice?: number;
  total?: number;
  currency?: string;
  mode?: string;
  paymentNetwork?: string;
  /** "testnet" for XRPL Testnet, "mock" when nothing touches a ledger. Never mainnet. */
  ledger?: "testnet" | "mock";
  isTestTransaction?: boolean;
  transactionHash?: string;
  orderId?: string;
  resultCount?: number;
  priceSource?: string;
  reason?: string;
  checkoutUrl?: string;
  messageId?: string;
}

const UNSAFE_KEY = /key|secret|seed|token|password|card|destination|address/i;

export type TicketTraceSink = (event: TicketTraceEvent, fields: TicketTraceFields) => void;

export const consoleTrace: TicketTraceSink = (event, fields) => {
  const safe: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || UNSAFE_KEY.test(key)) continue;
    safe[key] = value;
  }
  console.info(JSON.stringify(safe));
};

/** Emit both the internal lowercase event and the uppercase audit name. */
export function dualTrace(sink: TicketTraceSink, pair: { internal: TicketTraceEvent; audit: TicketTraceEvent }, fields: TicketTraceFields): void {
  sink(pair.internal, fields);
  sink(pair.audit, fields);
}
