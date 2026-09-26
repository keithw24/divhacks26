import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | undefined;
let clientKey: string | undefined;

/** One Gemini client for the process. The key stays in server memory. */
export function getGeminiClient(apiKey: string): GoogleGenAI {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  if (!client || clientKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    clientKey = apiKey;
  }
  return client;
}
