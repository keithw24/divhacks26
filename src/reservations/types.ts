export type ReservationStatus =
  | "COLLECTING_DETAILS"
  | "READY_FOR_CONFIRMATION"
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
  | "offer";

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
