import "dotenv/config";

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

export const config = {
  chatProvider: env("CHAT_PROVIDER", "terminal") as "terminal" | "imessage",
  // Also accept the PHOTON_ID / PHOTON_SECRET names used in the team .env.
  spectrumProjectId: env("SPECTRUM_PROJECT_ID") || env("PHOTON_ID"),
  spectrumProjectSecret: env("SPECTRUM_PROJECT_SECRET") || env("PHOTON_SECRET"),
  agentName: env("AGENT_NAME", "Agent"),
  terminalAsGroup: env("TERMINAL_AS_GROUP") === "1",
  geminiApiKey: env("GEMINI_API_KEY"),
  geminiModel: env("GEMINI_MODEL", "gemini-3.8-flash"),
  timezone: env("TIMEZONE", "America/New_York"),
};
