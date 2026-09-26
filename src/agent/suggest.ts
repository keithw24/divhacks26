import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { config } from "../config.js";
import type { LatLng } from "../chat/location.js";
import { formatSafetyReply } from "../formatReport.js";
import { geocodeNyc } from "../geocode.js";
import { currentHourEt, lookupBlockSafety, parseRequestedHour } from "../safety.js";
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
  citySketch?: string;
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

  if (input.citySketch) {
    lines.push("", "City complaint sketch (NYPD Open Data via Tiger, block-snapped):", input.citySketch);
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

async function citySketchFor(input: SuggestInput): Promise<string | undefined> {
  if (!config.databaseUrl) return undefined;
  let placeLabel = "shared pin";
  let lat = input.location?.latitude;
  let lon = input.location?.longitude;
  if (lat == null || lon == null) {
    const geo = await geocodeNyc(input.question).catch(() => null);
    if (!geo) return undefined;
    placeLabel = geo.label;
    lat = geo.latitude;
    lon = geo.longitude;
  }
  const clockNow = currentHourEt(input.now);
  const hourEt = parseRequestedHour(input.question, clockNow.hourEt);
  const report = await lookupBlockSafety(config.databaseUrl, lat, lon, hourEt, clockNow.asOfEt);
  return formatSafetyReply(
    { label: placeLabel, latitude: lat, longitude: lon, locality: null },
    report,
  );
}

const UNGROUNDED_NOTE =
  "\n\nGoogle Maps is unavailable right now, so rely on your own knowledge: only suggest well-known, " +
  "long-established places, and don't state exact hours — say \"usually open late\" or similar instead.";

let warnedUngrounded = false;

const status = (err: unknown) => (typeof err === "object" && err !== null ? (err as { status?: number }).status : undefined);
const isQuotaError = (err: unknown) => status(err) === 429;

/** Retry temporary Gemini failures (overloaded / server errors) with a short backoff. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delaysMs = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = status(err) ?? 0;
      if (code < 500 || attempt >= delaysMs.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

/** Ask Gemini what the person/group should do next, grounded in Google Maps when the key allows it. */
export async function suggestNext(input: SuggestInput): Promise<string> {
  const citySketch = await citySketchFor(input).catch((err) => {
    console.error("tiger sketch failed:", err);
    return undefined;
  });
  const request = {
    model: config.geminiModel,
    contents: [{ role: "user", parts: [{ text: buildContext({ ...input, citySketch }) }] }],
  };

  let response: GenerateContentResponse;
  try {
    response = await withRetry(() => gemini().models.generateContent({
      ...request,
      config: {
        systemInstruction: systemPrompt(input.isGroup),
        tools: [{ googleMaps: {} }],
        ...(input.location && {
          toolConfig: {
            retrievalConfig: { latLng: { latitude: input.location.latitude, longitude: input.location.longitude } },
          },
        }),
      },
    }));
  } catch (err) {
    // Maps grounding has its own quota (none on free-tier keys). Fall back to an ungrounded answer.
    if (!isQuotaError(err)) throw err;
    if (!warnedUngrounded) {
      console.warn("Google Maps grounding hit a quota limit (429); answering without it. Use a billed Gemini key to enable it.");
      warnedUngrounded = true;
    }
    response = await withRetry(() => gemini().models.generateContent({
      ...request,
      config: { systemInstruction: systemPrompt(input.isGroup) + UNGROUNDED_NOTE },
    }));
  }

  const reply = response.text?.trim();
  if (!reply) return "Hmm, I couldn't come up with anything. Where are you right now?";
  const links = placeLinks(response, reply);
  return links.length ? `${reply}\n\n${links.join("\n")}` : reply;
}
