import { createHash } from "node:crypto";

/** What a restaurant is charging to hold the table. NONE is never paid. */
export type ReservationPaymentType = "DEPOSIT" | "PREPAID" | "RESERVATION_FEE" | "CARD_HOLD" | "NONE";

/**
 * Payment and booking are separate. PAYMENT_CONFIRMED means money settled.
 * Only RESERVATION_CONFIRMED means the restaurant accepted the booking.
 */
export type ReservationPaymentState =
  | "RESERVATION_PENDING"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_AUTHORIZED"
  | "TERMS_RECHECKED"
  | "GUARDRAIL_APPROVED"
  | "GUARDRAIL_DENIED"
  | "PAYMENT_SUBMITTED"
  | "PAYMENT_PENDING"
  | "PAYMENT_CONFIRMED"
  | "RESERVATION_CONFIRMED"
  | "PAYMENT_FAILED"
  | "PAYMENT_REJECTED"
  | "PAYMENT_UNCERTAIN"
  | "PAYMENT_CANCELLED"
  | "PAYMENT_EXPIRED"
  | "RESERVATION_FAILED_AFTER_PAYMENT";

/**
 * Where the amount came from. Never "model" or "user".
 * demo: RESERVATION_DEPOSITS_JSON fixture. provider: reservation provider API.
 * phone: the restaurant said it on the call and the figure appears in their words.
 */
export type PaymentRequirementSource = "demo" | "provider" | "phone";

export interface ReservationPaymentRequirement {
  /** Deterministic. Same reservation terms, same obligation, same ledger idempotency key. */
  obligationId: string;
  paymentRequired: boolean;
  paymentType: ReservationPaymentType;
  restaurantId: string;
  restaurantName: string;
  reservationId: string;
  providerReservationId?: string;
  partySize: number;
  /** YYYY-MM-DD */
  reservationDate: string;
  /** HH:mm */
  reservationTime: string;
  amountUsd: number;
  perPersonUsd?: number;
  currency: "USD";
  /** XRPL classic address in ripple_test. A mock label in mock mode. Never from Gemini. */
  recipient: string;
  recipientSource: "mock" | "configured" | "provider";
  description: string;
  /** Only when the source says so. Unknown stays undefined. */
  refundable?: boolean;
  source: PaymentRequirementSource;
  providerId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ReservationPaymentAuthorization {
  spaceId: string;
  senderId: string;
  senderName?: string;
  messageId?: string;
  at: string;
}

export interface ReservationPaymentRequest {
  requirement: ReservationPaymentRequirement;
  authorization: ReservationPaymentAuthorization;
  /** The person who asked for the booking. Only they can release the payment. */
  initiatorId: string;
  initiatorName?: string;
  paymentId?: string;
  /** Re-read from the grounded source at authorization time. The guardrail compares these to the stored terms. */
  verified: { amountUsd: number; recipient: string };
  metadata?: Record<string, string | number>;
  /** Re-check an existing payment only. Never creates one. */
  settleOnly?: boolean;
}

export interface PaymentGuardCheck {
  code: string;
  passed: boolean;
  reasonCode: string;
  detail: string;
}

export interface PaymentGuardDecision {
  allowed: boolean;
  decision: "ALLOW" | "DENY";
  reasonCode: string;
  reasons: string[];
  checks: PaymentGuardCheck[];
  /** Guardrail checks that only apply to person-to-person or autonomous payments. */
  notApplicable?: string[];
}

export type ReservationPaymentOutcome =
  | "confirmed"
  | "already_confirmed"
  | "rejected"
  | "failed"
  | "uncertain"
  | "pending"
  | "in_progress"
  | "unauthorized";

/** Public evidence of a deposit on XRPL Testnet. Nothing here can sign or identify a conversation. */
export interface ReservationPaymentProof {
  network: "xrpl-testnet";
  status: "validated" | "pending" | "failed";
  amountXrp: number;
  destination: string;
  transactionHash: string | null;
  ledgerIndex: number | null;
  validatedAt: string | null;
  explorerUrl: string | null;
  idempotencyKey: string;
}

export interface ReservationPaymentResult {
  outcome: ReservationPaymentOutcome;
  obligationId: string;
  paymentId?: string;
  amountUsd: number;
  currency: "USD";
  recipient: string;
  senderAddress?: string;
  transactionHash?: string;
  ledgerResult?: string;
  submittedAsset?: string;
  submittedAmount?: string;
  policy?: PaymentGuardDecision;
  /** Ledger payments only. validated is the only proof of payment. */
  proof?: ReservationPaymentProof;
  idempotencyKey?: string;
  /** True when an earlier payment was returned instead of a new one being made. */
  replayed?: boolean;
  /** Why nothing settled. reason is safe to show the user. */
  failure?: { code: string; reason: string };
  at: string;
}

export interface ReservationPaymentPort {
  payRestaurantDeposit(request: ReservationPaymentRequest): Promise<ReservationPaymentResult>;
  /** Creates or refreshes the pending payment row. Nothing is sent. */
  prepare(input: {
    spaceId: string;
    requirement: ReservationPaymentRequirement;
    initiatorId: string;
    initiatorName?: string;
  }): { paymentId: string };
  cancel(input: { spaceId: string; senderId?: string; paymentId: string }): { cancelled: boolean; unauthorized?: boolean };
  /** Public sender address for traces. Never a seed. */
  readonly senderAddress?: string;
  /** XRP the port would send for this USD amount, so the ask can state it. */
  amountXrp?(amountUsd: number): string | undefined;
}

export interface PaymentHistoryEntry {
  state: ReservationPaymentState;
  at: string;
  detail?: string;
}

export function obligationIdFor(input: {
  spaceId: string;
  reservationId: string;
  restaurantId: string;
  recipient: string;
  paymentType: ReservationPaymentType;
  amountUsd: number;
  currency: string;
  partySize: number;
  reservationDate: string;
  reservationTime: string;
}): string {
  const canonical = [
    input.spaceId,
    input.reservationId,
    input.restaurantId,
    input.recipient,
    input.paymentType,
    String(Math.round(input.amountUsd * 100)),
    input.currency,
    String(input.partySize),
    input.reservationDate,
    input.reservationTime,
  ].join("|");
  return `resv-pay-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export function paymentNoun(type: ReservationPaymentType): string {
  if (type === "PREPAID") return "prepayment";
  if (type === "RESERVATION_FEE") return "reservation fee";
  if (type === "CARD_HOLD") return "card hold";
  return "deposit";
}

/** XRPL can settle a transfer. It cannot place a card authorization hold. */
export function isPayableOnLedger(type: ReservationPaymentType): boolean {
  return type === "DEPOSIT" || type === "PREPAID" || type === "RESERVATION_FEE";
}

export function isExpired(requirement: Pick<ReservationPaymentRequirement, "expiresAt">, now: Date): boolean {
  const expires = Date.parse(requirement.expiresAt);
  return !Number.isFinite(expires) || now.getTime() > expires;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
