import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { config } from "../config.js";
import type { LatLng } from "../chat/location.js";
import { systemPrompt } from "./prompt.js";

let client: GoogleGenAI | undefined;
function gemini(): GoogleGenAI {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set (see .env.example)");
  return (client ??= new GoogleGenAI({ apiKey: config.geminiApiKey }));
}

export interface SuggestInput {
  isGroup: boolean;
  asker: string;
  question: string;
  transcript: { at: Date; who: string; text: string }[];
  location?: LatLng & { who: string };
  now?: Date;
}

const clock = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: config.timezone, weekday: "long", hour: "numeric", minute: "2-digit" });

/** Everything Gemini needs to know about the moment, as one message. */
export function buildContext(input: SuggestInput): string {
  const now = input.now ?? new Date();
  const lines = [`It is ${clock(now)} in New York.`];

  if (input.location) {
    lines.push(`${input.location.who} shared their location: ${input.location.latitude}, ${input.location.longitude}.`);
  } else {
    lines.push("No shared location. Infer it from the chat if possible.");
  }

  if (input.transcript.length) {
    lines.push("", "Recent chat:");
    for (const l of input.transcript) lines.push(`[${clock(l.at)}] ${l.who}: ${l.text}`);
  }

  lines.push("", `${input.asker} asks: ${input.question}`);
  return lines.join("\n");
}

/** Google Maps links for the places the reply actually mentions (max 3). */
export function placeLinks(response: GenerateContentResponse, reply: string): string[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const chunk of chunks) {
    const place = chunk.maps;
    if (!place?.title || !place.uri || seen.has(place.title)) continue;
    if (!reply.toLowerCase().includes(place.title.toLowerCase())) continue;
    seen.add(place.title);
    links.push(`${place.title}: ${place.uri}`);
    if (links.length === 3) break;
  }
  return links;
}

/** Ask Gemini what the person/group should do next, grounded in Google Maps. */
export async function suggestNext(input: SuggestInput): Promise<string> {
  const response = await gemini().models.generateContent({
    model: config.geminiModel,
    contents: [{ role: "user", parts: [{ text: buildContext(input) }] }],
    config: {
      systemInstruction: systemPrompt(input.isGroup),
      tools: [{ googleMaps: {} }],
      ...(input.location && {
        toolConfig: {
          retrievalConfig: { latLng: { latitude: input.location.latitude, longitude: input.location.longitude } },
        },
      }),
    },
  });

  const reply = response.text?.trim();
  if (!reply) return "Hmm, I couldn't come up with anything. Where are you right now?";
  const links = placeLinks(response, reply);
  return links.length ? `${reply}\n\n${links.join("\n")}` : reply;
}
