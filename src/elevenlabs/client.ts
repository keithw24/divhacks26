import {
  ElevenLabsCallError,
  type OutboundCaller,
  type PlaceCallInput,
  type PlaceCallResult,
} from "./types.js";

const OUTBOUND_URL = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

function kindForStatus(status: number): ElevenLabsCallError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "unavailable";
}

/**
 * Live outbound calls use the current Conversational AI Twilio endpoint:
 * POST /v1/convai/twilio/outbound-call
 * https://elevenlabs.io/docs/api-reference/integrations/twilio/outbound-call
 */
export function createLiveOutboundCaller(options: {
  apiKey?: string;
  agentId?: string;
  agentPhoneNumberId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): OutboundCaller {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
      if (!/^\+[1-9]\d{9,14}$/.test(input.toNumber)) {
        throw new ElevenLabsCallError("malformed", "Destination is not E.164");
      }
      if (!options.apiKey || !options.agentId || !options.agentPhoneNumberId) {
        throw new ElevenLabsCallError("unavailable", "ElevenLabs outbound calling is not configured");
      }
      const body = {
        agent_id: options.agentId,
        agent_phone_number_id: options.agentPhoneNumberId,
        to_number: input.toNumber,
        conversation_initiation_client_data: {
          user_id: input.reservationId,
          dynamic_variables: input.dynamicVariables,
          conversation_config_override: {
            agent: {
              prompt: { prompt: input.systemPrompt },
              first_message: input.firstMessage,
            },
          },
        },
      };
      let response: Response;
      try {
        response = await fetchImpl(OUTBOUND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": options.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ElevenLabsCallError("timeout", "ElevenLabs outbound call timed out");
        }
        throw new ElevenLabsCallError("unavailable", "ElevenLabs outbound call failed");
      }
      if (!response.ok) {
        throw new ElevenLabsCallError(kindForStatus(response.status), `ElevenLabs HTTP ${response.status}`, response.status);
      }
      let payload: { success?: boolean; message?: string; conversation_id?: string | null; callSid?: string | null };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new ElevenLabsCallError("malformed", "ElevenLabs returned a non-JSON body", response.status);
      }
      if (!payload.success || !payload.conversation_id) {
        throw new ElevenLabsCallError("malformed", "ElevenLabs did not return a conversation id", response.status);
      }
      return {
        success: true,
        conversationId: payload.conversation_id,
        callSid: payload.callSid ?? undefined,
        message: payload.message,
      };
    },
  };
}
