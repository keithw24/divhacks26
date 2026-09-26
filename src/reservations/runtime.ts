import { createOutboundCaller } from "../elevenlabs/calls.js";
import { startWebhookServer } from "../elevenlabs/server.js";
import type { MockScenario } from "../elevenlabs/types.js";
import type { StateStore } from "../store/state.js";
import { createGeminiReservationInterpreter } from "./gemini.js";
import { ReservationOrchestrator } from "./orchestrator.js";
import { createRestaurantDirectory } from "./restaurant.js";
import { ReservationStore } from "./state.js";

const SCENARIOS = new Set<MockScenario>([
  "exact_time",
  "alternative_within_window",
  "alternative_outside_window",
  "fully_booked",
  "asks_for_name",
  "asks_for_phone",
  "voicemail",
  "no_answer",
  "api_error",
  "malformed_completion",
]);

export interface ReservationRuntimeEnv {
  callMode: "mock" | "live";
  mockScenario?: string;
  allowGazetteerDial?: boolean;
  geminiApiKey?: string;
  geminiModel?: string;
  googleMapsApiKey?: string;
  elevenLabsApiKey?: string;
  elevenLabsAgentId?: string;
  elevenLabsAgentPhoneNumberId?: string;
  webhookSecret?: string;
  timeZone?: string;
  callTimeoutMs?: number;
  /** When omitted, mock mode completes the call in-process and live mode waits for the webhook. */
  autoComplete?: boolean;
  stateStore?: StateStore;
  notify?: (spaceId: string, text: string) => Promise<void>;
}

export function createReservationRuntime(env: ReservationRuntimeEnv) {
  const mockScenario = SCENARIOS.has(env.mockScenario as MockScenario)
    ? (env.mockScenario as MockScenario)
    : "alternative_within_window";
  const caller = createOutboundCaller({
    mode: env.callMode,
    apiKey: env.elevenLabsApiKey,
    agentId: env.elevenLabsAgentId,
    agentPhoneNumberId: env.elevenLabsAgentPhoneNumberId,
    scenario: mockScenario,
  });
  const directory = createRestaurantDirectory({
    googleMapsApiKey: env.googleMapsApiKey,
    allowGazetteerFallback: env.callMode !== "live" || env.allowGazetteerDial === true,
  });
  const interpreter = env.geminiApiKey
    ? createGeminiReservationInterpreter({ apiKey: env.geminiApiKey, model: env.geminiModel })
    : undefined;
  const orchestrator = new ReservationOrchestrator({
    directory,
    caller,
    interpreter,
    notify: env.notify,
    autoComplete: env.autoComplete ?? env.callMode === "mock",
    mockScenario,
    webhookSecret: env.webhookSecret,
    timeZone: env.timeZone,
    callTimeoutMs: env.callTimeoutMs,
    store: env.stateStore ? ReservationStore.open(env.stateStore) : undefined,
  });
  return {
    orchestrator,
    caller,
    listen(port: number) {
      return startWebhookServer(port, (body, signature) => orchestrator.handleWebhook(body, signature));
    },
  };
}
