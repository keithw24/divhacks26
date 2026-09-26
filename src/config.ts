import "dotenv/config";

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
  timezone: env("TIMEZONE", "America/New_York"),
  databaseUrl: env("DATABASE_URL"),
  googleMapsApiKey: env("GOOGLE_MAPS_API_KEY"),
  tavilyApiKey: env("TAVILY_API_KEY"),
  parksEventsDataset: env("PARKS_EVENTS_DATASET", "w3wp-dpdi"),
  permittedEventsDataset: env("PERMITTED_EVENTS_DATASET", "tvpp-9vvx"),
  // ElevenLabs voice: transcribe inbound voice memos, optionally answer with a voice memo.
  elevenLabsApiKey: env("ELEVENLABS_API_KEY"),
  elevenLabsVoiceId: env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
  elevenLabsTtsModel: env("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
  elevenLabsSttModel: env("ELEVENLABS_STT_MODEL", "scribe_v2"),
  /** "match" = answer voice memos with a voice memo; "always"; "off". */
  voiceReplies: env("VOICE_REPLIES", "match") as "match" | "always" | "off",
};

export function loadConfig() {
  return config;
}
