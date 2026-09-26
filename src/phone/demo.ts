import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { createMemoryStateStore } from "../store/state.js";
import { fetchConversation } from "./elevenlabs.js";
import { RestaurantCallService } from "./service.js";
import { createConfiguredCaller } from "./elevenlabs.js";
import type { RestaurantCallRequest } from "./types.js";

/**
 * Place one outbound restaurant call, or print the payload and dial nothing.
 * A real call happens only with --live.
 *
 * Dry run:
 *   npm run demo:restaurant-call -- --phone=+15551234567 --restaurant="Test Restaurant" --name=Rohan --party=2 --date=2026-09-27 --time=19:00
 *
 * Live (your own phone, not a restaurant, the first time):
 *   npm run demo:restaurant-call -- --live --phone=+15551234567 --restaurant="Test Restaurant" --name=Rohan --party=2 --date=2026-09-27 --time=19:00
 *
 * If RESTAURANT_CALL_TEST_NUMBER is set, --phone can be omitted. --live is still required to dial.
 */
async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const phone = flag("phone") || process.env.RESTAURANT_CALL_TEST_NUMBER?.trim() || "";
  const request: RestaurantCallRequest = {
    spaceId: flag("space") || "restaurant-call-demo",
    restaurantName: flag("restaurant") || "Test Restaurant",
    restaurantPhone: phone,
    customerName: flag("name") || "Rohan",
    partySize: Number(flag("party") || "2"),
    date: flag("date") || "2026-09-27",
    preferredTime: flag("time") || "19:00",
    acceptableTimeWindow: {
      earliest: flag("earliest") || flag("time") || "19:00",
      latest: flag("latest") || flag("time") || "19:00",
    },
    specialRequests: flag("special") ? [flag("special")!] : [],
    authorized: true,
    phoneSource: "operator",
    allowOperatorNumber: true,
  };

  if (!request.restaurantPhone) {
    console.error("Pass --phone=+1... or set RESTAURANT_CALL_TEST_NUMBER. No call was placed.");
    process.exit(1);
  }
  if (!Number.isInteger(request.partySize) || request.partySize < 1) {
    console.error("--party must be a positive integer. No call was placed.");
    process.exit(1);
  }

  const caller = createConfiguredCaller({
    apiKey: config.elevenLabsApiKey,
    agentId: config.elevenLabsAgentId,
    agentPhoneNumberId: config.elevenLabsAgentPhoneNumberId,
  });
  const service = new RestaurantCallService({
    state: createMemoryStateStore(),
    caller,
    agentId: config.elevenLabsAgentId,
    agentPhoneNumberId: config.elevenLabsAgentPhoneNumberId,
    notify: async (_spaceId, text) => {
      console.log(text);
    },
  });

  if (!live) {
    const preview = await service.callRestaurantForReservation(request, false);
    console.log("Dry run. No call was placed.");
    console.log(JSON.stringify(preview.payload, null, 2));
    if (preview.blocked) console.log(`Blocked: ${preview.blocked}`);
    return;
  }

  const missing = [
    ["ELEVENLABS_API_KEY", config.elevenLabsApiKey],
    ["ELEVENLABS_AGENT_ID", config.elevenLabsAgentId],
    ["ELEVENLABS_AGENT_PHONE_NUMBER_ID", config.elevenLabsAgentPhoneNumberId],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    console.error(`Missing ${missing.map(([name]) => name).join(", ")}. No call was placed.`);
    process.exit(1);
  }

  console.log(`Placing one live call to ${request.restaurantPhone} for ${request.restaurantName}.`);
  const placed = await service.callRestaurantForReservation(request, true);
  if (placed.blocked || placed.callStatus === "failed" || placed.callStatus === "not_placed") {
    console.error(placed.userMessage ?? "The call was not placed.");
    process.exit(1);
  }
  console.log("Call placed.");
  console.log(`conversation_id=${placed.conversationId ?? ""}`);
  console.log(`callSid=${placed.callSid ?? ""}`);

  if (!process.argv.includes("--wait") || !placed.conversationId || !config.elevenLabsApiKey) return;
  const result = await fetchConversation({ apiKey: config.elevenLabsApiKey, conversationId: placed.conversationId });
  if (!result) {
    console.log("The call is in progress. The post-call webhook delivers the reservation result.");
    return;
  }
  console.log(`provider_status=${result.status ?? "unknown"}`);
  if (result.transcript) console.log(result.transcript.slice(0, 1200));
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "The call was not placed.");
    process.exit(1);
  });
}
