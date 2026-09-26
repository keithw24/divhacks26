import "dotenv/config";
import { parseCallTimeoutMs } from "./reservations/timeout.js";
import { parseVoiceMode } from "./voice/decide.js";

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
  messageBatchDelayMs: positiveNumber(env("MESSAGE_BATCH_DELAY_MS", "2000"), 2000),
  autoReply: env("BOROUGHOS_AUTOREPLY", "true") !== "false",
  // GEMINI_API_KEY is canonical. GOOGLE_API_KEY is accepted only as a legacy alias.
  geminiApiKey: env("GEMINI_API_KEY") || env("GOOGLE_API_KEY"),
  geminiModel: env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
  /** Restyles the exact safety chart before it is sent over iMessage. */
  geminiImageModel: env("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image"),
  googleMapsApiKey: env("GOOGLE_MAPS_API_KEY"),
  tavilyApiKey: env("TAVILY_API_KEY"),
  parksEventsDataset: env("PARKS_EVENTS_DATASET", "w3wp-dpdi"),
  permittedEventsDataset: env("PERMITTED_EVENTS_DATASET", "tvpp-9vvx"),
  timezone: env("TIMEZONE", "America/New_York"),
  databaseUrl: env("DATABASE_URL"),
  /** With DATABASE_URL, only one running agent answers each message. MESSAGE_CLAIMS=off disables it. */
  messageClaims: env("MESSAGE_CLAIMS", "on").toLowerCase() !== "off",
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
  /** Demo fixture only. Example: {"Carbone":{"amountUsd":50,"extraPerPersonUsd":10,"basePartySize":4}} */
  reservationDepositsJson: env("RESERVATION_DEPOSITS_JSON"),
  elevenLabsApiKey: env("ELEVENLABS_API_KEY"),
  elevenLabsAgentId: env("ELEVENLABS_AGENT_ID"),
  elevenLabsAgentPhoneNumberId: env("ELEVENLABS_AGENT_PHONE_NUMBER_ID") || env("ELEVENLABS_PHONE_NUMBER_ID"),
  elevenLabsWebhookSecret: env("ELEVENLABS_WEBHOOK_SECRET") || env("WEBHOOK_SECRET"),
  // ElevenLabs voice: transcribe inbound voice memos, optionally answer with a voice memo.
  elevenLabsVoiceId: env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
  elevenLabsTtsModel: env("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
  elevenLabsSttModel: env("ELEVENLABS_STT_MODEL", "scribe_v2"),
  /**
   * "match" = answer voice memos (or "say that out loud") with a voice memo;
   * "smart" = match, plus when someone is on the move or needs a route now; "always"; "off".
   */
  voiceReplies: parseVoiceMode(env("VOICE_REPLIES", "smart")),
  /**
   * mock submits nothing. nessie records a fake Capital One purchase.
   * ripple_test submits XRP on XRPL Testnet. nessie_ripple does both.
   * There is no mainnet or real-money mode.
   */
  paymentsMode: paymentsMode(env("PAYMENTS_MODE", "mock")),
  paymentsMaxUsd: positiveNumber(env("PAYMENTS_MAX_USD", "500"), 500),
  paymentsDailyMaxUsd: positiveNumber(env("PAYMENTS_DAILY_MAX_USD", "1000"), 1000),
  paymentsTimeoutMs: positiveNumber(env("PAYMENTS_TIMEOUT_MS", "20000"), 20_000),
  paymentsXrpPerUsd: positiveNumber(env("PAYMENTS_XRP_PER_USD", "1"), 1),
  xrplTestnetUrl: env("XRPL_TESTNET_URL", "wss://s.altnet.rippletest.net:51233"),
  xrplTestnetSeed: env("XRPL_TESTNET_SEED"),
  /** Registered customers missing a wallet can be funded from the Testnet faucet. Never Mainnet. */
  xrplAutoProvisionTestnet: env("XRPL_AUTO_PROVISION_TESTNET") === "true",
  /** Autonomous agent payments. Still Testnet-only, and still under AUTONOMOUS_MAX_USD. */
  autonomousPaymentsEnabled: env("AUTONOMOUS_PAYMENTS_ENABLED") === "true",
  autonomousMaxUsd: positiveNumber(env("AUTONOMOUS_MAX_USD", "25"), 25),
  /** Photon sender id → registered customer, e.g. {"+15551234567":"rohan"}. Unmapped senders cannot spend. */
  xrplCustomerSendersJson: env("XRPL_CUSTOMER_SENDERS_JSON"),
  /**
   * Shared secret so a DeepSpace (or other) signup server can enroll Photon users
   * and receive a Testnet wallet address. Never a user seed.
   */
  deepspaceOnboardingSecret: env("DEEPSPACE_ONBOARDING_SECRET"),
  /** Read-only JSON for the website's XRPL Testnet section. Bound to 127.0.0.1. */
  xrplDashboardPort: positiveNumber(env("XRPL_DASHBOARD_PORT", "8790"), 8790),
  paymentsRecipientsJson: env("PAYMENTS_RECIPIENTS_JSON"),
  /** Testnet merchant addresses. Example: {"Carbone":"r..."}. Never invent one. */
  paymentsMerchantsJson: env("PAYMENTS_MERCHANTS_JSON"),
  /** mock needs no credentials. ticketmaster uses the Discovery API with TICKETMASTER_API_KEY. */
  ticketingProvider: (env("TICKETING_PROVIDER", "mock") === "ticketmaster" ? "ticketmaster" : "mock") as "mock" | "ticketmaster",
  /** Unset: mock provider → demo checkout, ticketmaster → link only. provider needs Partner API access. */
  ticketingPurchaseMode: ticketPurchaseMode(env("TICKETING_PURCHASE_MODE")),
  ticketmasterApiKey: env("TICKETMASTER_API_KEY"),
  /** Only with approved Ticketmaster Partner API access. Without it, purchases return the official link. */
  ticketmasterPartnerApiKey: env("TICKETMASTER_PARTNER_API_KEY"),
  ticketingDefaultCity: env("TICKETING_DEFAULT_CITY", "New York"),
  /** Demo checkout payee, resolved through PAYMENTS_MERCHANTS_JSON like reservation deposits. */
  ticketingMerchantName: env("TICKETING_MERCHANT_NAME", "Demo Box Office"),
  nessieApiKey: env("NESSIE_API_KEY"),
  nessieBaseUrl: env("NESSIE_BASE_URL", "http://api.nessieisreal.com"),
  nessieCustomerId: env("NESSIE_CUSTOMER_ID"),
  nessieAccountId: env("NESSIE_ACCOUNT_ID"),
  // Website API (sign-in codes over iMessage, onboarding). WEB_API_PORT=off disables it.
  webApiPort: env("WEB_API_PORT") || env("PORT", "8788"),
  webApiHost: env("WEB_API_HOST", "0.0.0.0"),
  webAllowedOrigins: env("WEB_ALLOWED_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174,http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  webMaxUsers: positiveNumber(env("WEB_MAX_USERS", "100"), 100),
  webAuthSecret: env("WEB_AUTH_SECRET"),
  webStatePath: env("WEB_STATE_PATH", "data/web-users.json"),
  agentNumber: env("AGENT_NUMBER", "+14155951440"),
  appName: env("APP_NAME", "plansaroundus"),
  // Outgoing email for sign-in codes and the agent-number email (any SMTP provider).
  smtpHost: env("SMTP_HOST"),
  smtpPort: positiveNumber(env("SMTP_PORT", "465"), 465),
  smtpUser: env("SMTP_USER"),
  smtpPass: env("SMTP_PASS"),
  emailFrom: env("EMAIL_FROM"),
  /** When true, mock providers and silent fixture fallbacks are refused. */
  liveDemoMode: env("LIVE_DEMO_MODE", "false").toLowerCase() === "true",
};

function ticketPurchaseMode(value: string): "mock" | "provider" | "link" | undefined {
  if (value === "mock" || value === "provider" || value === "link") return value;
  if (value) console.warn(`TICKETING_PURCHASE_MODE=${value} is not supported; using the safe default.`);
  return undefined;
}

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
