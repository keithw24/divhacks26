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
  googleMapsApiKey: env("GOOGLE_MAPS_API_KEY"),

  timezone: env("TIMEZONE", "America/New_York"),
  databaseUrl: env("DATABASE_URL"),
};

export function loadConfig() {
  return config;
}
