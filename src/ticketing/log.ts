export type TicketTraceEvent =
  | "ticket.search"
  | "ticket.price_lookup"
  | "ticket.offer_selected"
  | "ticket.purchase_requested"
  | "ticket.purchase_confirmed"
  | "ticket.payment_started"
  | "ticket.payment_validated"
  | "ticket.purchase_completed"
  | "ticket.purchase_failed";

export interface TicketTraceFields {
  spaceId: string;
  eventId?: string;
  provider?: string;
  purchaseId?: string;
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
