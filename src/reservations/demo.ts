import { buildMockCompletion } from "../elevenlabs/calls.js";
import { signElevenLabsPayload } from "../elevenlabs/webhook.js";
import { createReservationRuntime } from "./runtime.js";

const SECRET = "demo-webhook-secret";
const spaceId = "demo-space";

/**
 * Full reservation lifecycle on the production orchestrator and webhook parser.
 * The caller is the mock ElevenLabs client. Nothing is dialed.
 */
async function main(): Promise<void> {
  const writeInfo = console.info;
  console.info = () => {};
  try {
    await run();
  } finally {
    console.info = writeInfo;
  }
}

async function run(): Promise<void> {
  const notes: string[] = [];
  const runtime = createReservationRuntime({
    callMode: "mock",
    mockScenario: "alternative_within_window",
    autoComplete: false,
    webhookSecret: SECRET,
    timeZone: "America/New_York",
    notify: async (id, text) => {
      notes.push(text);
      if (id !== spaceId) throw new Error(`Result went to ${id} instead of ${spaceId}`);
    },
  });
  const orchestrator = runtime.orchestrator;

  console.log("[Photon] User requested L'Artusi");
  const asked = await orchestrator.handleTurn({ spaceId, text: "Let's go to L'Artusi Friday." });
  if (!asked.reply) fail("Photon did not ask for the missing details");
  console.log("[Reservation] Collecting details");

  const party = await orchestrator.handleTurn({
    spaceId,
    text: "4 people. 8 would be ideal, anything 7:30-8:30 works.",
  });
  if (!party.reply?.toLowerCase().includes("name")) fail("Photon did not ask for the reservation name");
  console.log("[Photon] Party size/time collected");

  const named = await orchestrator.handleTurn({ spaceId, text: "Rohan." });
  if (!named.reply?.includes("Want me to call")) fail("Photon did not ask for confirmation");

  console.log("[Photon] User confirmed");
  const yes = await orchestrator.handleTurn({ spaceId, text: "Yes.", messageId: "demo-yes" });
  console.log("[ElevenLabs Mock] Calling L'Artusi");
  await yes.afterReply?.();

  const reservation = orchestrator.reservations.active(spaceId);
  if (!reservation?.call?.conversationId) fail("Mock call was not created");
  if (reservation.partySize !== 4 || reservation.customer?.name !== "Rohan") fail("Reservation details were lost before the webhook");

  console.log("[Restaurant Mock] Offered 7:45 PM");
  console.log("[Agent] Accepted 7:45 PM");
  console.log("[Restaurant Mock] Confirmed");
  const event = buildMockCompletion("alternative_within_window", reservation);
  if (event === "malformed") fail("Could not build the mock webhook");
  const raw = JSON.stringify(event);
  const signature = signElevenLabsPayload(raw, SECRET, Math.floor(Date.now() / 1000));
  const response = await orchestrator.handleWebhook(raw, signature);
  if (response.status !== 200 || reservation.status !== "BOOKED") fail("Webhook did not book the reservation");
  console.log("[Webhook] BOOKED");
  console.log(`[Photon] Sent result to space ${spaceId}`);
  if (!notes.some((text) => text.startsWith("Booked"))) fail("Photon did not receive the booking");
  orchestrator.dispose();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
