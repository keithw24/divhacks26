import type { ProviderPaymentTerms } from "../providers.js";
import type { ReservationFlexibility, ReservationRequest } from "../types.js";

export type BookingChannel = "online" | "phone";

export type BookingAttemptStatus = "AVAILABLE" | "UNAVAILABLE" | "UNSUPPORTED" | "FAILED" | "BOOKED" | "PENDING";

/**
 * Online work and the phone call are never active together.
 * CALLING_RESTAURANT is only entered after CHECKING_ONLINE / BOOKING_ONLINE has finished.
 */
export type ExecutionPhase =
  | "DISCOVERING"
  | "CHECKING_ONLINE"
  | "BOOKING_ONLINE"
  | "ONLINE_UNAVAILABLE"
  | "AWAITING_PAYMENT"
  | "AWAITING_USER"
  | "CALLING_RESTAURANT"
  | "CONFIRMED"
  | "FAILED"
  | "CANCELLED";

export type ExecutionDisposition =
  | "confirmed"
  | "needs_phone"
  | "needs_user"
  | "needs_payment"
  | "phone_forbidden"
  | "failed";

export interface BookingAttempt {
  channel: BookingChannel;
  status: BookingAttemptStatus;
  provider?: string;
  reason?: string;
  confirmationId?: string;
  evidence?: Record<string, unknown>;
}

/** Why the router must not dial. */
export interface FallbackPolicy {
  phoneForbidden?: boolean;
  cancelled?: boolean;
  paymentDenied?: boolean;
  guardrailDenied?: boolean;
  /** Money already moved. A failed confirmation must not place a second booking by phone. */
  paymentCaptured?: boolean;
}

export interface ReservationAuditEvent {
  event: string;
  executionId: string;
  spaceId: string;
  restaurant: string;
  timestamp: string;
  channel?: BookingChannel;
  reason?: string;
  status?: string;
  provider?: string;
  phase?: ExecutionPhase;
}

export interface BookingExecutionRecord {
  executionId: string;
  phase: ExecutionPhase;
  status?: "CONFIRMED" | "FAILED" | "PENDING";
  channel?: BookingChannel;
  restaurantName: string;
  requestedTime: string;
  confirmedTime?: string;
  confirmationId?: string;
  partySize?: number;
  confirmationName?: string;
  disposition?: ExecutionDisposition;
  attempts: BookingAttempt[];
  events: ReservationAuditEvent[];
  reply?: string;
  alternativeTime?: string;
}

export interface ReservationExecutionResult {
  executionId: string;
  status: "CONFIRMED" | "FAILED" | "PENDING";
  disposition: ExecutionDisposition;
  channel?: BookingChannel;
  restaurantName: string;
  requestedTime: string;
  confirmedTime?: string;
  confirmationId?: string;
  partySize?: number;
  confirmationName?: string;
  attempts: BookingAttempt[];
  /** A materially different time. Never treated as a booking. */
  alternative?: { time: string; requiresConfirmation: true };
  reply: string;
  phase: ExecutionPhase;
  /** Dial after the reply is sent. Absent unless a phone call was actually selected. */
  afterReply?: () => Promise<void>;
}

export interface AvailabilityResult {
  status: BookingAttemptStatus;
  time?: string;
  reason?: string;
  payment?: ProviderPaymentTerms;
  /** Provider offered a time outside the authorized window. */
  alternativeTime?: string;
  evidence?: Record<string, unknown>;
}

export interface BookingResult {
  status: "BOOKED" | "FAILED" | "PENDING" | "UNAVAILABLE";
  confirmationId?: string;
  time?: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Online reservation APIs. A listing or booking URL is not an implementation of this —
 * canHandle is true only when checkAvailability and book talk to a real booking path.
 */
export interface RestaurantBookingProvider {
  readonly id: string;
  canHandle(restaurant: ReservationRequest["restaurant"]): Promise<boolean>;
  checkAvailability(restaurant: ReservationRequest["restaurant"], request: ReservationRequest): Promise<AvailabilityResult>;
  book(restaurant: ReservationRequest["restaurant"], request: ReservationRequest, availability: AvailabilityResult): Promise<BookingResult>;
}

export interface PhoneBookingRequest {
  executionId: string;
  /** Phone starts only after the online attempt has already stopped. */
  phase: "ONLINE_UNAVAILABLE";
  request: {
    spaceId: string;
    restaurantId: string;
    restaurantName: string;
    restaurantPhone?: string;
    partySize: number;
    requestedTime: string;
    requestedDate?: string;
    userId?: string;
    specialRequests?: string[];
    flexibility?: ReservationFlexibility;
    customerName?: string;
  };
  reservation: ReservationRequest;
  onlineAttempt?: BookingAttempt;
  messageId?: string;
}

export interface PhoneBookingResult {
  status: "CONFIRMED" | "FAILED" | "PENDING";
  confirmationId?: string;
  confirmedTime?: string;
  confirmationName?: string;
  partySize?: number;
  callId?: string;
  reason?: string;
  /** Restaurant proposed a different time. The router will not accept it silently. */
  alternativeTime?: string;
  reply?: string;
  evidence?: Record<string, unknown>;
  afterReply?: () => Promise<void>;
}

/**
 * Boundary for the outbound restaurant-call agent.
 * The router never imports an ElevenLabs client. Implement this and pass it in.
 */
export interface RestaurantPhoneBookingService {
  bookByPhone(request: PhoneBookingRequest): Promise<PhoneBookingResult>;
}

export interface PaymentGateResult {
  status: "PENDING" | "DENIED" | "CONFIRMED";
  reason?: string;
  confirmationId?: string;
  confirmedTime?: string;
  reply?: string;
}

/** Hands a deposit-required slot to the existing reservation payment flow. Must not dial. */
export interface OnlinePaymentCoordinator {
  onDepositRequired(input: {
    reservation: ReservationRequest;
    providerId: string;
    time: string;
    payment: ProviderPaymentTerms;
    executionId: string;
  }): Promise<PaymentGateResult>;
}

export interface ExecuteOptions {
  allowPhone?: boolean;
  policy?: FallbackPolicy;
  messageId?: string;
}
