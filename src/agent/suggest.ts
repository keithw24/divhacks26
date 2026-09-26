import type { GenerateContentResponse } from "@google/genai";
import { config } from "../config.js";
import type { LatLng } from "../chat/location.js";
import { getGeminiClient } from "../gemini/client.js";
import { formatSafetyReply } from "../formatReport.js";
import { geocodeNyc } from "../geocode.js";
import { currentHourEt, lookupBlockSafety, parseRequestedHour } from "../safety.js";
import { wantsSafetySketch } from "../safetyIntent.js";
import { systemPrompt } from "./prompt.js";

function gemini() {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set (see .env.example)");
  return getGeminiClient(config.geminiApiKey);
}
import { orchestrate } from "./orchestrate.js";

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
  if (!wantsSafetySketch(input.question)) {
    console.info("tiger: skipped (not a safety prompt)");
    return undefined;
  }
  if (!config.databaseUrl) {
    console.info("tiger: skipped (no DATABASE_URL)");
    return undefined;
  }
  let placeLabel = "shared pin";
  let lat = input.location?.latitude;
  let lon = input.location?.longitude;
  if (lat == null || lon == null) {
    const geo = await geocodeNyc(input.question).catch(() => null);
    if (!geo) {
      console.info(`tiger: skipped (geocode missed: ${JSON.stringify(input.question)})`);
      return undefined;
    }
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

function isRetryableModelError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /429|404|503|RESOURCE_EXHAUSTED|no longer available|exceeded your current quota|high demand/i.test(text);
}

function fallbackReply(citySketch: string | undefined): string {
  if (citySketch) {
    return `${citySketch}\n\nGemini is unavailable right now, so this is the city-data sketch only.`;
  }
  return "Gemini is unavailable right now (quota or retired model). Try GEMINI_MODEL=gemini-3.5-flash-lite in .env.";
}

async function generateWithGemini(input: SuggestInput, citySketch: string | undefined, model: string, useMaps: boolean) {
  return gemini().models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: buildContext({ ...input, citySketch }) }] }],
    config: {
      systemInstruction: systemPrompt(input.isGroup),
      ...(useMaps ? { tools: [{ googleMaps: {} }] } : {}),
      ...(useMaps && input.location
        ? {
            toolConfig: {
              retrievalConfig: { latLng: { latitude: input.location.latitude, longitude: input.location.longitude } },
            },
          }
        : {}),
    },
  });
}

/**
 * Single-prompt Gemini suggestion (with the Tiger city sketch and a model fallback chain).
 * Used when the skill pipeline has nothing verified to offer, e.g. no Places key or no events loaded.
 */
export async function suggestWithGemini(input: SuggestInput): Promise<string> {
  const citySketch = await citySketchFor(input).catch((err) => {
    console.error(`tiger sketch failed: ${err instanceof Error ? err.name : "Error"}`);
    return undefined;
  });
  if (citySketch) {
    const first = citySketch.split("\n")[0] ?? "tiger sketch";
    console.info(`tiger: queried nypd_complaints (${first})`);
  }

  const tried = new Set<string>();
  const attempts: Array<{ model: string; useMaps: boolean }> = [
    { model: config.geminiModel, useMaps: false },
    { model: "gemini-3.5-flash-lite", useMaps: false },
    { model: "gemini-flash-lite-latest", useMaps: false },
  ];

  for (const attempt of attempts) {
    if (tried.has(attempt.model)) continue;
    tried.add(attempt.model);
    try {
      const response = await generateWithGemini(input, citySketch, attempt.model, attempt.useMaps);
      const reply = response.text?.trim();
      if (!reply) continue;
      const links = attempt.useMaps ? placeLinks(response, reply) : [];
      return links.length ? `${reply}\n\n${links.join("\n")}` : reply;
    } catch (err) {
      console.error(`gemini ${attempt.model} failed:`, err);
      if (!isRetryableModelError(err)) throw err;
    }
  }

  return fallbackReply(citySketch);
}

/**
 * Route one chat turn through the shared intent parser and factual skills (safety, food, events, route).
 * If no skill returns anything usable, fall back to the single-prompt Gemini suggestion.
 */
export async function suggestNext(input: SuggestInput): Promise<string> {
  return orchestrate({
    question: input.question,
    transcript: input.transcript,
    location: input.location,
    now: input.now,
    fallback: () => suggestWithGemini(input),
  });
}
