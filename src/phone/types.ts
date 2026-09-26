/** Telephony progress. A completed call is not a confirmed reservation. */
export type TelephonyStatus =
  | "initiated"
  | "ringing"
  | "answered"
  | "completed"
  | "failed"
  | "no-answer"
  | "busy";

/**
 * What the restaurant agreed to. CONFIRMED requires the restaurant's own words,
 * not a completed call and not the model's summary alone.
 */
export type ReservationCallStatus =
  | "PENDING"
  | "CONFIRMED"
  | "DECLINED"
  | "ALTERNATIVE_OFFERED"
  | "NO_AVAILABILITY"
  | "NEEDS_USER_DECISION"
  | "UNKNOWN"
  | "DEPOSIT_REQUIRED";

export type VerifiedPhoneSource = "places" | "gazetteer" | "directory" | "operator";

export type PhoneBlockCode = "NO_AUTHORIZATION" | "NO_VERIFIED_PHONE_NUMBER" | "MALFORMED_PHONE" | "ONLINE_BOOKING";

export interface RestaurantCallRequest {
  spaceId: string;
  restaurantName: string;
  restaurantPhone: string;
  customerName: string;
  partySize: number;
  date: string;
  preferredTime: string;
  acceptableTimeWindow?: {
    earliest: string;
    latest: string;
  };
  specialRequests?: string[];
  /** Explicit user intent to call or book. Discovery questions never set this. */
  authorized: boolean;
  /**
   * Where the number came from. Missing or unknown sources are not dialed.
   * `operator` is only the demo CLI, and only with allowOperatorNumber.
   */
  phoneSource?: VerifiedPhoneSource;
  /** Demo CLI only. The reservation flow never sets this. */
  allowOperatorNumber?: boolean;
  /** When an online booking provider already completed the reservation, do not call. */
  onlineBookingCompleted?: boolean;
}

export interface RestaurantDepositRequest {
  amount: number;
  currency: "USD";
  restaurant: string;
  date?: string;
  time?: string;
  partySize?: number;
  reservationName?: string;
}

export interface RestaurantCallResult {
  spaceId: string;
  callStatus: TelephonyStatus | "not_placed";
  reservationStatus: ReservationCallStatus;
  blocked?: PhoneBlockCode;
  conversationId?: string;
  callSid?: string;
  restaurantName?: string;
  date?: string;
  time?: string;
  partySize?: number;
  reservationName?: string;
  confirmationNumber?: string | null;
  offeredTime?: string;
  deposit?: RestaurantDepositRequest;
  summary?: string;
  failureReason?: string;
  /** iMessage text. Never includes provider ids or error details. */
  userMessage?: string;
  dryRun?: boolean;
  payload?: RestaurantOutboundPayload;
}

export interface RestaurantOutboundPayload {
  agent_id: string;
  agent_phone_number_id: string;
  to_number: string;
  conversation_initiation_client_data: {
    user_id: string;
    dynamic_variables: Record<string, string>;
    conversation_config_override: {
      agent: {
        prompt: { prompt: string };
        first_message: string;
      };
    };
  };
}

/** Pending outbound call, keyed by Photon space id. */
export interface PhoneCallRecord {
  spaceId: string;
  restaurantName: string;
  restaurantPhone: string;
  customerName: string;
  partySize: number;
  date: string;
  preferredTime: string;
  earliestTime?: string;
  latestTime?: string;
  specialRequests?: string[];
  conversationId?: string;
  callSid?: string;
  callStatus: TelephonyStatus | "not_placed";
  reservationStatus: ReservationCallStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  confirmedTime?: string;
  confirmationNumber?: string | null;
  offeredTime?: string;
  deposit?: RestaurantDepositRequest;
  summary?: string;
}

export interface PhoneCallBook {
  bySpace: Record<string, PhoneCallRecord>;
  byConversation: Record<string, string>;
}

export function emptyPhoneCallBook(): PhoneCallBook {
  return { bySpace: {}, byConversation: {} };
}
