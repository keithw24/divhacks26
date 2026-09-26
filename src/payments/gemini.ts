import { getGeminiClient } from "../gemini/client.js";
import type { PaymentExtraction, PaymentInterpreter } from "./types.js";

const SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["SEND_PAYMENT", "NONE"] },
    recipientName: { type: "string" },
    amountUsd: { type: "number" },
    memo: { type: "string" },
  },
  required: ["intent"],
};

/**
 * Extracts payment fields only. The model cannot choose a wallet or submit a transaction.
 * Application code re-validates the amount and resolves the recipient from the directory.
 */
export function createGeminiPaymentInterpreter(options: { apiKey: string; model?: string }): PaymentInterpreter {
  const ai = getGeminiClient(options.apiKey);
  const model = options.model ?? "gemini-3.5-flash-lite";
  return {
    async extract(input) {
      const response = await ai.models.generateContent({
        model,
        contents: [
          "Extract a payment request from the user message.",
          "intent is SEND_PAYMENT only when they are asking to transfer money to a person.",
          "Ride requests, fare questions, and questions about a past payment are NONE.",
          "Do not invent a wallet, address, or destination. Do not decide to send the payment.",
          "amountUsd must be the exact dollar amount the user stated. Do not convert, round up, or invent a number.",
          "If they stated more than one amount, omit amountUsd.",
          "memo is the short reason, such as Uber or dinner, if stated.",
          input.recentTexts.length ? `Recent messages:\n${input.recentTexts.slice(-6).join("\n")}` : "",
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
      if (!text) return { intent: "NONE", recipientName: null, amountUsd: null, memo: null };
      return sanitizeExtraction(JSON.parse(text) as Record<string, unknown>);
    },
  };
}

export function sanitizeExtraction(value: Record<string, unknown>): PaymentExtraction {
  const intent = value.intent === "SEND_PAYMENT" ? "SEND_PAYMENT" : "NONE";
  const recipientName = typeof value.recipientName === "string" && value.recipientName.trim() ? value.recipientName.trim() : null;
  const amountUsd = typeof value.amountUsd === "number" && Number.isFinite(value.amountUsd) ? value.amountUsd : null;
  const memo = typeof value.memo === "string" && value.memo.trim() ? value.memo.trim() : null;
  return { intent, recipientName, amountUsd, memo };
}
