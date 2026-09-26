import { createLiveOutboundCaller } from "./client.js";
import type { MockScenario, OutboundCaller, PlaceCallInput, PlaceCallResult } from "./types.js";
import { ElevenLabsCallError } from "./types.js";
import type { ReservationRequest } from "../reservations/types.js";

export class MockOutboundCaller implements OutboundCaller {
  readonly calls: PlaceCallInput[] = [];
  failWith?: ElevenLabsCallError;

  constructor(private readonly scenario: MockScenario = "alternative_within_window") {}

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    this.calls.push(input);
    if (this.scenario === "api_error" || this.failWith) {
      throw (
        this.failWith ??
        new ElevenLabsCallError("server", "Mock ElevenLabs failure", 500)
      );
    }
    const n = this.calls.length;
    return {
      success: true,
      conversationId: `conv_mock_${n}`,
      callSid: `CA_mock_${n}`,
      message: "mock",
    };
  }
}

export function createOutboundCaller(options: {
  mode: "mock" | "live";
  apiKey?: string;
  agentId?: string;
  agentPhoneNumberId?: string;
  fetchImpl?: typeof fetch;
  scenario?: MockScenario;
  timeoutMs?: number;
}): OutboundCaller {
  if (options.mode === "live") {
    return createLiveOutboundCaller({
      apiKey: options.apiKey,
      agentId: options.agentId,
      agentPhoneNumberId: options.agentPhoneNumberId,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }
  return new MockOutboundCaller(options.scenario);
}

export function buildMockCompletion(scenario: MockScenario, reservation: ReservationRequest): unknown | "malformed" {
  const conversationId = reservation.call?.conversationId ?? "conv_mock";
  const base = {
    agent_id: "agent",
    conversation_id: conversationId,
    user_id: reservation.id,
    conversation_initiation_client_data: {
      dynamic_variables: { reservation_id: reservation.id },
    },
  };
  if (scenario === "malformed_completion") return "malformed";
  if (scenario === "no_answer") {
    return {
      type: "call_initiation_failure",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        ...base,
        failure_reason: "no-answer",
        metadata: { type: "twilio", body: { To: reservation.restaurant.phone, CallStatus: "no-answer" } },
      },
    };
  }
  const transcriptFor = (lines: Array<{ role: "agent" | "user"; message: string }>, collected: Record<string, unknown>) => ({
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      ...base,
      status: "done",
      transcript: lines,
      analysis: { data_collection_results: collected, call_successful: "success" },
      metadata: {
        termination_reason: "completed",
        phone_call: { external_number: reservation.restaurant.phone, direction: "outbound" },
      },
    },
  });
  const ideal = reservation.requestedTime ?? "20:00";
  const spokenIdeal = ideal === "20:00" ? "8" : ideal;
  if (scenario === "exact_time") {
    return transcriptFor(
      [
        { role: "agent", message: "Hi, I'm calling on behalf of the customer." },
        { role: "user", message: `You're confirmed for ${reservation.partySize ?? 4} at ${spokenIdeal}.` },
      ],
      { outcome: { value: "BOOKED" }, confirmed_time: { value: ideal }, confirmed_party_size: { value: String(reservation.partySize ?? 4) } },
    );
  }
  if (scenario === "alternative_within_window") {
    return transcriptFor(
      [
        { role: "agent", message: "7:45 works. Could I book that?" },
        { role: "user", message: "We can do 7:45." },
        { role: "user", message: "You're all set for four at 7:45." },
      ],
      {
        outcome: { value: "BOOKED" },
        confirmed_time: { value: "19:45" },
        confirmed_party_size: { value: String(reservation.partySize ?? 4) },
        confirmation_name: { value: reservation.customer?.name ?? "" },
      },
    );
  }
  if (scenario === "alternative_outside_window") {
    return transcriptFor(
      [
        { role: "user", message: "We only have 9:30." },
        { role: "agent", message: "That is outside the times I can accept." },
      ],
      { outcome: { value: "NEEDS_USER_INPUT" }, offered_time: { value: "21:30" } },
    );
  }
  if (scenario === "fully_booked") {
    return transcriptFor(
      [{ role: "user", message: "We're fully booked that night. No tables." }],
      { outcome: { value: "UNAVAILABLE" }, restaurant_message: { value: "No tables between the requested times." } },
    );
  }
  if (scenario === "asks_for_name") {
    return transcriptFor(
      [{ role: "user", message: "What name should I put the reservation under?" }],
      { outcome: { value: "NEEDS_USER_INPUT" } },
    );
  }
  if (scenario === "asks_for_phone") {
    return transcriptFor(
      [{ role: "user", message: "Can I get a phone number?" }],
      { outcome: { value: "NEEDS_USER_INPUT" } },
    );
  }
  if (scenario === "voicemail") {
    return transcriptFor(
      [{ role: "user", message: "Please leave a message after the beep. You are confirmed." }],
      { outcome: { value: "BOOKED" }, reached_voicemail: { value: "true" }, confirmed_time: { value: ideal } },
    );
  }
  return transcriptFor([{ role: "user", message: "Hello?" }], { outcome: { value: "CALL_FAILED" } });
}
