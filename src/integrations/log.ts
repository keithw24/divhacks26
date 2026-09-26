const SECRET_ENV = [
  "GOOGLE_MAPS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TICKETMASTER_API_KEY",
  "TICKETMASTER_PARTNER_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEBHOOK_SECRET",
  "WEBHOOK_SECRET",
  "BACKBOARD_API_KEY",
  "TAVILY_API_KEY",
  "NESSIE_API_KEY",
  "XRPL_TESTNET_SEED",
  "DATABASE_URL",
  "SPECTRUM_PROJECT_SECRET",
  "PHOTON_PROJECT_SECRET",
  "PHOTON_SECRET",
  "SPECTRUM_PROJECT_ID",
  "PHOTON_PROJECT_ID",
  "PHOTON_ID",
  "WEB_AUTH_SECRET",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_AGENT_PHONE_NUMBER_ID",
];

/** Remove credential material from a message before it is printed. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 6) out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/postgres(?:ql)?:\/\/[^@\s/]+@/gi, "postgresql://[redacted]@")
    .replace(/\b(xi-api-key|x-api-key|x-goog-api-key|authorization)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/apikey=[^&\s]+/gi, "apikey=[redacted]");
}

export function liveLoggingEnabled(): boolean {
  return process.env.LIVE_DEMO_MODE === "true" || process.env.INTEGRATIONS_CHECK === "1";
}

/** Demo-mode provider log. Never include keys, auth headers, or raw payloads. */
export function logIntegration(provider: string, mode: "LIVE" | "MOCK", message: string): void {
  if (!liveLoggingEnabled()) return;
  const safe = redactSecrets(message).replace(/\s+/g, " ").slice(0, 240);
  console.info(`[${provider}][${mode}] ${safe}`);
}
