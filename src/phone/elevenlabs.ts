import { createLiveOutboundCaller } from "../elevenlabs/client.js";
import type { OutboundCaller, PlaceCallInput, PlaceCallResult } from "../elevenlabs/types.js";
import type { RestaurantCallRequest, RestaurantOutboundPayload } from "./types.js";

/**
 * Dashboard prompt for the restaurant agent. Also sent per call as a prompt override.
 * Overrides must be enabled on the agent Security tab or ElevenLabs uses the dashboard prompt.
 *
 * Twilio account credentials stay in the ElevenLabs phone-number connection.
 * This app does not place the Twilio call itself.
 */
export function restaurantAgentPrompt(): string {
  return [
    "You are calling a restaurant on behalf of a customer to request a reservation.",
    "Say naturally that you are an automated assistant calling on behalf of the customer.",
    "",
    "Restaurant:",
    "{{restaurant_name}}",
    "",
    "Customer:",
    "{{customer_name}}",
    "",
    "Party size:",
    "{{party_size}}",
    "",
    "Date:",
    "{{reservation_date}}",
    "",
    "Preferred time:",
    "{{preferred_time}}",
    "",
    "Acceptable range:",
    "{{earliest_time}} to {{latest_time}}",
    "",
    "Special requests:",
    "{{special_requests}}",
    "",
    "Ask whether the requested reservation is available.",
    "If the preferred time is unavailable, ask about times inside the acceptable range.",
    "You may confirm a reservation ONLY inside the authorized date/time range.",
    "If the restaurant offers a time outside that range, do not accept it. Record the offered time for the customer.",
    "Never invent availability.",
    "Never claim a reservation is confirmed until the restaurant explicitly confirms it.",
    "Never provide a customer's payment card information.",
    "Never agree to a deposit or cancellation charge unless the calling workflow explicitly says the user already authorized that exact amount.",
    "Before ending a successful call, verbally verify:",
    "- restaurant",
    "- date",
    "- time",
    "- party size",
    "- reservation name",
    "- confirmation number, if one exists.",
    "If anything remains ambiguous, treat the reservation as unconfirmed.",
  ].join("\n");
}

export function restaurantOpeningLine(request: RestaurantCallRequest): string {
  const name = request.customerName || "a customer";
  return `Hi, I'm an automated assistant calling on behalf of ${name} to request a reservation.`;
}

export function outboundDynamicVariables(request: RestaurantCallRequest): Record<string, string> {
  const requests = request.specialRequests?.length ? request.specialRequests.join("; ") : "none";
  return {
    restaurant_name: request.restaurantName,
    customer_name: request.customerName,
    party_size: String(request.partySize),
    reservation_date: request.date,
    preferred_time: request.preferredTime,
    earliest_time: request.acceptableTimeWindow?.earliest ?? request.preferredTime,
    latest_time: request.acceptableTimeWindow?.latest ?? request.preferredTime,
    special_requests: requests,
  };
}

export function buildOutboundPayload(options: {
  agentId: string;
  agentPhoneNumberId: string;
  request: RestaurantCallRequest;
  toNumber: string;
  userId?: string;
}): RestaurantOutboundPayload {
  const request = options.request;
  return {
    agent_id: options.agentId,
    agent_phone_number_id: options.agentPhoneNumberId,
    to_number: options.toNumber,
    conversation_initiation_client_data: {
      user_id: options.userId ?? request.spaceId,
      dynamic_variables: outboundDynamicVariables(request),
      conversation_config_override: {
        agent: {
          prompt: { prompt: restaurantAgentPrompt() },
          first_message: restaurantOpeningLine(request),
        },
      },
    },
  };
}

export function placeCallInput(request: RestaurantCallRequest, toNumber: string, userId?: string): PlaceCallInput {
  return {
    toNumber,
    reservationId: userId ?? request.spaceId,
    spaceId: request.spaceId,
    systemPrompt: restaurantAgentPrompt(),
    firstMessage: restaurantOpeningLine(request),
    dynamicVariables: outboundDynamicVariables(request),
  };
}

export async function placeRestaurantOutboundCall(
  caller: OutboundCaller,
  request: RestaurantCallRequest,
  toNumber: string,
  userId?: string,
): Promise<PlaceCallResult> {
  return caller.placeCall(placeCallInput(request, toNumber, userId));
}

export function createConfiguredCaller(options: {
  apiKey?: string;
  agentId?: string;
  agentPhoneNumberId?: string;
  fetchImpl?: typeof fetch;
}): OutboundCaller {
  return createLiveOutboundCaller(options);
}

/** Read a finished conversation. Used by the demo to report an outcome. Never logs the API key. */
export async function fetchConversation(options: {
  apiKey: string;
  conversationId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ status?: string; transcript?: string } | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(options.conversationId)}`, {
    headers: { "xi-api-key": options.apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as {
    status?: string;
    transcript?: Array<{ role?: string; message?: string }>;
  };
  const transcript = Array.isArray(payload.transcript)
    ? payload.transcript
        .map((turn) => turn.message ?? "")
        .filter(Boolean)
        .join("\n")
    : undefined;
  return { status: payload.status, transcript };
}
