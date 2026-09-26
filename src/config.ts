import "dotenv/config";
import { parseCallTimeoutMs } from "./reservations/timeout.js";

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

/**
 * Photon / Spectrum credentials: accept both the current SPECTRUM_* names
 * and the earlier PHOTON_* names so existing .env files keep working.
 */
export const config = {
  chatProvider: env("CHAT_PROVIDER", "terminal") as "terminal" | "imessage",
  // Accept every Photon credential name the team uses.
  spectrumProjectId: env("SPECTRUM_PROJECT_ID") || env("PHOTON_PROJECT_ID") || env("PHOTON_ID"),
  spectrumProjectSecret: env("SPECTRUM_PROJECT_SECRET") || env("PHOTON_PROJECT_SECRET") || env("PHOTON_SECRET"),
  agentName: env("AGENT_NAME", "Agent"),
  terminalAsGroup: env("TERMINAL_AS_GROUP") === "1",
  autoReply: env("BOROUGHOS_AUTOREPLY", "true") !== "false",
  // GEMINI_API_KEY is canonical. GOOGLE_API_KEY is accepted only as a legacy alias.
  geminiApiKey: env("GEMINI_API_KEY") || env("GOOGLE_API_KEY"),
  geminiModel: env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
  googleMapsApiKey: env("GOOGLE_MAPS_API_KEY"),
  tavilyApiKey: env("TAVILY_API_KEY"),
  parksEventsDataset: env("PARKS_EVENTS_DATASET", "w3wp-dpdi"),
  permittedEventsDataset: env("PERMITTED_EVENTS_DATASET", "tvpp-9vvx"),
  timezone: env("TIMEZONE", "America/New_York"),
  databaseUrl: env("DATABASE_URL"),
  backboardApiKey: env("BACKBOARD_API_KEY"),
  backboardMemoryMode: memoryMode(env("BACKBOARD_MEMORY_MODE", "Auto")),
  backboardMemoryPro: env("BACKBOARD_MEMORY_PRO", "false").toLowerCase() === "true",
  backboardVerboseMemory: env("BACKBOARD_VERBOSE_MEMORY", "false").toLowerCase() === "true",
  agentStatePath: env("AGENT_STATE_PATH", "data/agent-state.json"),
  /** mock never dials. live places a real ElevenLabs outbound call after confirmation. */
  reservationCallMode: (env("RESERVATION_CALL_MODE", "mock") === "live" ? "live" : "mock") as "live" | "mock",
  reservationMockScenario: env("RESERVATION_MOCK_SCENARIO", "alternative_within_window"),
  reservationAllowGazetteerDial: env("RESERVATION_ALLOW_GAZETTEER_DIAL") === "true",
  reservationWebhookPort: Number(env("RESERVATION_WEBHOOK_PORT", "8787")) || 8787,
  reservationCallTimeoutMs: parseCallTimeoutMs(process.env.RESERVATION_CALL_TIMEOUT_MS),
  elevenLabsApiKey: env("ELEVENLABS_API_KEY"),
  elevenLabsAgentId: env("ELEVENLABS_AGENT_ID"),
  elevenLabsAgentPhoneNumberId: env("ELEVENLABS_AGENT_PHONE_NUMBER_ID") || env("ELEVENLABS_PHONE_NUMBER_ID"),
  elevenLabsWebhookSecret: env("ELEVENLABS_WEBHOOK_SECRET") || env("WEBHOOK_SECRET"),
};

function memoryMode(value: string): "Auto" | "Readonly" | "off" {
  if (value === "Readonly" || value === "off" || value === "Auto") return value;
  return "Auto";
}

export function loadConfig() {
  return config;
}
