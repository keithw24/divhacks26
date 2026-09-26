export type MockScenario =
  | "exact_time"
  | "alternative_within_window"
  | "alternative_outside_window"
  | "fully_booked"
  | "asks_for_name"
  | "asks_for_phone"
  | "voicemail"
  | "no_answer"
  | "api_error"
  | "malformed_completion";

export interface PlaceCallInput {
  toNumber: string;
  reservationId: string;
  spaceId: string;
  systemPrompt: string;
  firstMessage: string;
  dynamicVariables: Record<string, string | number | boolean>;
}

export interface PlaceCallResult {
  success: true;
  conversationId: string;
  callSid?: string;
  message?: string;
}

export type ElevenLabsErrorKind =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server"
  | "timeout"
  | "malformed"
  | "unavailable";

export class ElevenLabsCallError extends Error {
  readonly statusCode?: number;
  readonly kind: ElevenLabsErrorKind;

  constructor(kind: ElevenLabsErrorKind, message: string, statusCode?: number) {
    super(message);
    this.name = "ElevenLabsCallError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export interface OutboundCaller {
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>;
}
