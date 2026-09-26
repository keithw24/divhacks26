import "dotenv/config";
import { createTransportationServiceFromEnv } from "./factory.js";

const spaceId = "manual-imessage";
const turns = process.argv.slice(2);

const script =
  turns.length > 0
    ? turns
    : [
        "How should I get from Columbia University to Times Square?",
        "I’m at Columbia University.",
        "How should I get to Washington Square Park?",
        "Can I walk instead?",
      ];

const service = createTransportationServiceFromEnv({
  geminiApiKey: process.env.GEMINI_API_KEY,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  geminiModel: process.env.GEMINI_MODEL,
});

for (const text of script) {
  const result = await service.handle({ spaceId, text, senderId: "manual" });
  console.log(`\nYou: ${text}`);
  if (result.handled) {
    console.log(`Agent:\n${result.reply ?? "(no reply)"}`);
  } else {
    console.log("Agent: (not a transportation request — context updated if a place was mentioned)");
  }
}
