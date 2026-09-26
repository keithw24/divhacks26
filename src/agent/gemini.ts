import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

let client: GoogleGenAI | undefined;

export async function generateJson<T>(prompt: string, schema: object): Promise<T> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured");
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  const response = await client.models.generateContent({
    model: config.geminiModel,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      temperature: 0.1,
    },
  });
  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty JSON response");
  return JSON.parse(text) as T;
}
