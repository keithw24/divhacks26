/**
 * Transportation capability.
 *
 * Default path uses Gemini + native Google Maps grounding (GEMINI_API_KEY).
 * Google Routes / Places stay optional behind GOOGLE_MAPS_API_KEY.
 *
 * Photon APIs used by the listener (unchanged from the current Spectrum integration):
 * Spectrum(), imessage.config(), terminal.config(), app.messages,
 * space.send, space.responding, message.sender, space.id.
 */
export { ConversationMemory } from "./context.js";
export { processPhotonTextMessage } from "./dispatch.js";
export { createTransportationServiceFromEnv } from "./factory.js";
export { inspectMapsGrounding } from "./grounding.js";
export { extractTransportIntent } from "./intent.js";
export { createTransportationService, TransportationService } from "./service.js";
export { UNGROUNDED_FALLBACK, USER_FALLBACK } from "./types.js";
export type { TransportationRequest, TransportationResult } from "./service.js";
export type {
  GeminiMapsClient,
  GroundingEvidence,
  PlaceLocation,
  PlaceResolver,
  RouteResult,
  RoutingProvider,
  TravelMode,
} from "./types.js";
