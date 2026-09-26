import type { BookingExecutionRecord } from "./execution/types.js";
import type {
  PaymentGuardDecision,
  PaymentHistoryEntry,
  PaymentRequirementSource,
  ReservationPaymentProof,
  ReservationPaymentRequirement,
  ReservationPaymentState,
  ReservationPaymentType,
} from "./payment.js";

export type ReservationStatus =
  | "COLLECTING_DETAILS"
  | "READY_FOR_CONFIRMATION"
  | "AWAITING_DEPOSIT"
  | "CONFIRMED_BY_USER"
  | "CALLING"
  | "AWAITING_RESTAURANT"
  | "BOOKED"
  | "UNAVAILABLE"
  | "NEEDS_USER_INPUT"
  | "CALL_FAILED";

export type ReservationOutcome = "BOOKED" | "UNAVAILABLE" | "NEEDS_USER_INPUT" | "CALL_FAILED";

export type TrustedPhoneSource = "places" | "gazetteer" | "directory";

export type PendingQuestion =
  | "restaurant"
  | "location"
  | "party_time"
  | "party"
  | "time"
  | "date"
  | "flexibility"
  | "name"
  | "confirm"
  | "phone"
  | "offer"
  | "deposit";

export interface RestaurantIdentity {
  name: string;
  address?: string;
  phone?: string;
  placeId?: string;
  /** Set only after a trusted lookup. Never "model" or "user". */
  phoneSource?: TrustedPhoneSource;
  websiteUrl?: string;
  openNow?: boolean;
}

export interface ReservationFlexibility {
  earliestTime?: string;
  latestTime?: string;
  alternativeTimesAllowed: boolean;
}

export interface ReservationResult {
  outcome: ReservationOutcome;
  confirmedDate?: string;
  confirmedTime?: string;
  confirmedPartySize?: number;
  confirmationName?: string;
  confirmationNumber?: string;
  restaurantMessage?: string;
  questionForUser?: string;
  offeredTime?: string;
  /** The restaurant asked for money on the call and stated the amount itself. */
  paymentRequired?: {
    paymentType: ReservationPaymentType;
    amountUsd: number;
    perPersonUsd?: number;
  };
  /** Set only after the deposit validated on XRPL Testnet. */
  payment?: {
    network: "xrpl-testnet";
    status: "validated";
    amountXrp: number;
    transactionHash: string;
    ledgerIndex: number | null;
    explorerUrl: string | null;
  };
}

export interface ReservationCall {
  provider: "elevenlabs";
  conversationId?: string;
  callId?: string;
  startedAt?: string;
  completedAt?: string;
  transcript?: string;
}

export interface ReservationRequest {
  id: string;
  photonSpaceId: string;
  restaurant: RestaurantIdentity;
  /** Other locations when the name matches more than one place. */
  locationOptions?: RestaurantIdentity[];
  partySize?: number;
  /** YYYY-MM-DD in the space timezone. */
  requestedDate?: string;
  /** HH:mm 24-hour. Ideal time, not the whole authorized window. */
  requestedTime?: string;
  flexibility?: ReservationFlexibility;
  flexibilityKnown: boolean;
  customer?: {
    name?: string;
    phone?: string;
  };
  specialRequests?: string[];
  status: ReservationStatus;
  pendingQuestion?: PendingQuestion;
  /** Time the restaurant offered outside the authorized window. */
  offeredTime?: string;
  call?: ReservationCall;
  result?: ReservationResult;
  confirmGeneration: number;
  confirming: boolean;
  callPlaced: boolean;
  resultDelivered: boolean;
  /** True after a trusted lookup has run for the current name. */
  phoneChecked?: boolean;
  /** Photon message id that already confirmed this attempt. Duplicate events do not dial again. */
  confirmationMessageId?: string;
  /** Photon sender who started this reservation. Only they can authorize a payment for it. */
  requester?: { senderId?: string; senderName?: string };
  /**
   * Deposit required before this reservation can be booked.
   * `source: "demo"` is configured fixture data, not a live restaurant policy.
   */
  deposit?: ReservationDepositState;
  /** The user said not to call the restaurant. Phone fallback stays off. */
  doNotCall?: boolean;
  /** Decision record for online-then-phone booking. Survives a restart. */
  bookingExecution?: BookingExecutionRecord;
}

export interface ReservationDepositState {
  required: boolean;
  source: PaymentRequirementSource;
  amountUsd?: number;
  description?: string;
  paymentType?: ReservationPaymentType;
  /** Grounded terms of the payment. Set only when every field came from a trusted source. */
  requirement?: ReservationPaymentRequirement;
  state?: ReservationPaymentState;
  history?: PaymentHistoryEntry[];
  paymentId?: string;
  /** PENDING: submitted to XRPL, not validated yet. Never paid again and never treated as failed. */
  status?: "AWAITING_PAYMENT" | "PAID" | "FAILED" | "CANCELLED" | "UNCERTAIN" | "REJECTED" | "PENDING";
  initiatorId?: string;
  initiatorName?: string;
  transactionId?: string;
  ledgerResult?: string;
  senderAddress?: string;
  paidAt?: string;
  policy?: PaymentGuardDecision;
  /** Latest XRPL payment evidence, including a pending hash. */
  proof?: ReservationPaymentProof;
  /** Code behind the last failure or refusal. For traces, not for the user. */
  failureCode?: string;
  bookingAttemptId?: string;
  /** When set, the booking result is returned on the payment turn instead of a second message. */
  quietResult?: boolean;
  lastReply?: string;
  confirmMessageId?: string;
}

export interface ReservationExtraction {
  restaurantName?: string;
  partySize?: number;
  requestedDate?: string;
  requestedTime?: string;
  earliestTime?: string;
  latestTime?: string;
  alternativeTimesAllowed?: boolean;
  flexibilityKnown?: boolean;
  customerName?: string;
  customerPhone?: string;
  specialRequests?: string[];
}
