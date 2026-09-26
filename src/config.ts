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
  // ElevenLabs voice: transcribe inbound voice memos, optionally answer with a voice memo.
  elevenLabsVoiceId: env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
  elevenLabsTtsModel: env("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
  elevenLabsSttModel: env("ELEVENLABS_STT_MODEL", "scribe_v2"),
  /** "match" = answer voice memos with a voice memo; "always"; "off". */
  voiceReplies: env("VOICE_REPLIES", "match") as "match" | "always" | "off",
  /**
   * mock submits nothing. nessie records a fake Capital One purchase.
   * ripple_test submits XRP on XRPL Testnet. nessie_ripple does both.
   * There is no mainnet or real-money mode.
   */
  paymentsMode: paymentsMode(env("PAYMENTS_MODE", "mock")),
  paymentsMaxUsd: positiveNumber(env("PAYMENTS_MAX_USD", "500"), 500),
  paymentsTimeoutMs: positiveNumber(env("PAYMENTS_TIMEOUT_MS", "20000"), 20_000),
  paymentsXrpPerUsd: positiveNumber(env("PAYMENTS_XRP_PER_USD", "1"), 1),
  xrplTestnetUrl: env("XRPL_TESTNET_URL", "wss://s.altnet.rippletest.net:51233"),
  xrplTestnetSeed: env("XRPL_TESTNET_SEED"),
  paymentsRecipientsJson: env("PAYMENTS_RECIPIENTS_JSON"),
  nessieApiKey: env("NESSIE_API_KEY"),
  nessieBaseUrl: env("NESSIE_BASE_URL", "http://api.nessieisreal.com"),
  nessieCustomerId: env("NESSIE_CUSTOMER_ID"),
  nessieAccountId: env("NESSIE_ACCOUNT_ID"),
  // Website API (sign-in codes over iMessage, onboarding). WEB_API_PORT=off disables it.
  webApiPort: env("WEB_API_PORT") || env("PORT", "8788"),
  webApiHost: env("WEB_API_HOST", "0.0.0.0"),
  webAllowedOrigins: env("WEB_ALLOWED_ORIGINS", "http://localhost:5174,http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  webMaxUsers: positiveNumber(env("WEB_MAX_USERS", "100"), 100),
  webAuthSecret: env("WEB_AUTH_SECRET"),
  webStatePath: env("WEB_STATE_PATH", "data/web-users.json"),
  agentNumber: env("AGENT_NUMBER", "+14155951440"),
};

export type PaymentsMode = "mock" | "ripple_test" | "nessie" | "nessie_ripple";

function paymentsMode(value: string): PaymentsMode {
  if (value === "ripple_test" || value === "nessie" || value === "nessie_ripple") return value;
  if (value && value !== "mock") {
    console.warn(`PAYMENTS_MODE=${value} is not supported; using mock. Real-money payments are disabled.`);
  }
  return "mock";
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function memoryMode(value: string): "Auto" | "Readonly" | "off" {
  if (value === "Readonly" || value === "off" || value === "Auto") return value;
  return "Auto";
}

export function loadConfig() {
  return config;
}
