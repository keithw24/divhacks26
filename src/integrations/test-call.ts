import "dotenv/config";
import { createLiveOutboundCaller } from "../elevenlabs/client.js";
import { config } from "../config.js";

/**
 * Places one real ElevenLabs outbound call.
 * Refuses to run unless --confirm is present and ELEVENLABS_TEST_NUMBER is an E.164 number you control.
 *
 *   npm run integrations:test-call -- --confirm
 */
const confirmed = process.argv.includes("--confirm");
const toNumber = process.env.ELEVENLABS_TEST_NUMBER?.trim() ?? "";

if (!confirmed || !/^\+[1-9]\d{9,14}$/.test(toNumber)) {
  console.error("Refusing to place a call.");
  console.error("Set ELEVENLABS_TEST_NUMBER to an E.164 number you control, then re-run:");
  console.error("  npm run integrations:test-call -- --confirm");
  process.exit(1);
}

if (!config.elevenLabsApiKey || !config.elevenLabsAgentId || !config.elevenLabsAgentPhoneNumberId) {
  console.error("ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_AGENT_PHONE_NUMBER_ID are required.");
  process.exit(1);
}

const caller = createLiveOutboundCaller({
  apiKey: config.elevenLabsApiKey,
  agentId: config.elevenLabsAgentId,
  agentPhoneNumberId: config.elevenLabsAgentPhoneNumberId,
  timeoutMs: 20_000,
});

const placed = await caller.placeCall({
  toNumber,
  reservationId: `health-${Date.now()}`,
  spaceId: "integration-health",
  systemPrompt: "This is an integration health check. Say that the line is working, then end the call.",
  firstMessage: "This is a BoroughOS integration health check. No reservation is being requested.",
  dynamicVariables: { reservation_id: "health-check" },
});

console.log(`Call started. conversation accepted: ${placed.success ? "yes" : "no"}`);
