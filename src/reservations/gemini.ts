import { getGeminiClient } from "../gemini/client.js";
import { sanitizeExtraction } from "./collect.js";
import type { ReservationExtraction } from "./types.js";

export interface ReservationInterpreter {
  extract(input: { text: string; today: string; pendingQuestion?: string }): Promise<ReservationExtraction>;
}

const SCHEMA = {
  type: "object",
  properties: {
    restaurantName: { type: "string" },
    partySize: { type: "integer" },
    requestedDate: { type: "string", description: "YYYY-MM-DD" },
    requestedTime: { type: "string", description: "HH:mm in 24-hour form" },
    earliestTime: { type: "string" },
    latestTime: { type: "string" },
    alternativeTimesAllowed: { type: "boolean" },
    flexibilityKnown: { type: "boolean" },
    customerName: { type: "string" },
    specialRequests: { type: "array", items: { type: "string" } },
  },
};

/**
 * Fills reservation slots from a user message. Phone numbers are not in the schema
 * and are stripped again by sanitizeExtraction. This is not the phone-call audio path.
 */
export function createGeminiReservationInterpreter(options: {
  apiKey: string;
  model?: string;
}): ReservationInterpreter {
  const ai = getGeminiClient(options.apiKey);
  const model = options.model ?? "gemini-3.8-flash";
  return {
    async extract(input) {
      const response = await ai.models.generateContent({
        model,
        contents: [
          `Today is ${input.today} in America/New_York.`,
          input.pendingQuestion ? `Photon just asked about: ${input.pendingQuestion}.` : "",
          "Extract only reservation details the user explicitly stated.",
          "Do not invent a restaurant phone number, email, credit card, or confirmation.",
          "Bare hours like 8 for dinner are 20:00. Return JSON.",
          `User: ${input.text}`,
        ]
          .filter(Boolean)
          .join("\n"),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: SCHEMA,
        },
      });
      const text = response.text?.trim();
      if (!text) return {};
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return sanitizeExtraction(parsed);
    },
  };
}
