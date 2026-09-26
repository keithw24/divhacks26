export interface LiveDemoEnv {
  liveDemoMode: boolean;
  chatProvider: string;
  geminiApiKey: string;
  googleMapsApiKey: string;
  ticketmasterApiKey: string;
  ticketingPurchaseMode?: "mock" | "provider" | "link";
  elevenLabsApiKey: string;
  elevenLabsAgentId: string;
  elevenLabsAgentPhoneNumberId: string;
  elevenLabsWebhookSecret: string;
  backboardApiKey: string;
  databaseUrl: string;
  spectrumProjectId: string;
  spectrumProjectSecret: string;
  reservationAllowGazetteerDial: boolean;
}

/**
 * Problems that must stop a LIVE_DEMO_MODE process before it answers anyone.
 * Empty when live demo mode is off, so unit tests keep their mocks.
 */
export function liveDemoProblems(env: LiveDemoEnv): string[] {
  if (!env.liveDemoMode) return [];
  const problems: string[] = [];
  const need = (value: string, name: string) => {
    if (!value) problems.push(`${name} is not set`);
  };
  need(env.geminiApiKey, "GEMINI_API_KEY");
  need(env.googleMapsApiKey, "GOOGLE_MAPS_API_KEY");
  need(env.ticketmasterApiKey, "TICKETMASTER_API_KEY");
  need(env.elevenLabsApiKey, "ELEVENLABS_API_KEY");
  need(env.elevenLabsAgentId, "ELEVENLABS_AGENT_ID");
  need(env.elevenLabsAgentPhoneNumberId, "ELEVENLABS_AGENT_PHONE_NUMBER_ID");
  need(env.elevenLabsWebhookSecret, "ELEVENLABS_WEBHOOK_SECRET");
  need(env.backboardApiKey, "BACKBOARD_API_KEY");
  need(env.databaseUrl, "DATABASE_URL");
  need(env.spectrumProjectId, "SPECTRUM_PROJECT_ID or PHOTON_PROJECT_ID");
  need(env.spectrumProjectSecret, "SPECTRUM_PROJECT_SECRET or PHOTON_PROJECT_SECRET");
  if (env.chatProvider !== "imessage") {
    problems.push("CHAT_PROVIDER must be imessage so replies are delivered through Photon");
  }
  if (env.reservationAllowGazetteerDial) {
    problems.push("RESERVATION_ALLOW_GAZETTEER_DIAL must be false; gazetteer phone numbers are fixtures");
  }
  if (env.ticketingPurchaseMode === "mock") {
    problems.push("TICKETING_PURCHASE_MODE=mock would check out fixture tickets. Use link, or provider with Partner API access.");
  }
  return problems;
}
