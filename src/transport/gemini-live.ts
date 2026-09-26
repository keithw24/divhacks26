import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { inspectMapsGrounding } from "./grounding.js";

const QUESTIONS = [
  "How should I get from Columbia University to Times Square?",
  "What subway should I take from Times Square to Grand Central Terminal?",
  "Should I walk or take the subway from Washington Square Park to Union Square?",
  "How should I get from Columbia University to Washington Square Park?",
  "What is the nearest subway station to Katz’s Delicatessen?",
  "How should I get from Katz’s Delicatessen to the Brooklyn Bridge?",
];

const NYC = { latitude: 40.758, longitude: -73.9855 };

function hasTransportInfo(text: string): string[] {
  const found: string[] = [];
  if (/\b(walk|walking|on foot)\b/i.test(text)) found.push("walk");
  if (/\b(subway|train|transit|bus|transfer)\b/i.test(text)) found.push("transit");
  if (/\b(\d+\s*(min|minute|minutes|hr|hour))\b/i.test(text)) found.push("duration");
  if (/\b(station|1|2|3|A|C|E|N|Q|R|L|4|5|6)\b/.test(text)) found.push("station-or-line");
  return found;
}

function verdict(grounded: boolean, info: string[]): "PASS" | "PARTIAL" | "FAIL" {
  if (!grounded) return "FAIL";
  if (info.length >= 2) return "PASS";
  if (info.length >= 1) return "PARTIAL";
  return "PARTIAL";
}

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("GEMINI_API_KEY is required for npm run transport:gemini-live");
  process.exit(1);
}

const requestedModel = process.env.GEMINI_MODEL?.trim();
const models = requestedModel
  ? [requestedModel]
  : ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
const ai = new GoogleGenAI({ apiKey });

async function generateWithMaps(model: string, question: string) {
  return ai.models.generateContent({
    model,
    contents: [
      "You are answering an NYC iMessage transportation question.",
      "Use Google Maps grounding for factual location and transportation information.",
      "Do not supply specific travel times, routes, stations, transfers, distances, or service information unless supported by the grounded Maps results.",
      "If the available Maps information is insufficient, say so rather than guessing.",
      "2-6 short lines.",
      `Question: ${question}`,
    ].join("\n"),
    config: {
      tools: [{ googleMaps: {} }],
      toolConfig: {
        retrievalConfig: {
          latLng: NYC,
        },
      },
    },
  });
}

console.log(`Gemini Maps live probe`);
console.log(`Using GEMINI_API_KEY only (key not printed).`);
console.log("");

let model = models[0]!;
for (const candidate of models) {
  try {
    await generateWithMaps(candidate, "What is Times Square?");
    model = candidate;
    console.log(`Model: ${model}`);
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const quota = /429|RESOURCE_EXHAUSTED|quota/i.test(message);
    console.log(`Model ${candidate} failed${quota ? " (quota)" : ""}; trying next.`);
    if (candidate === models[models.length - 1]) {
      throw error;
    }
  }
}

for (const question of QUESTIONS) {
  const response = await generateWithMaps(model, question);

  const text = response.text?.trim() || "(empty)";
  const candidate = response.candidates?.[0] as { groundingMetadata?: unknown } | undefined;
  const grounding = inspectMapsGrounding(candidate?.groundingMetadata);
  const info = hasTransportInfo(text);
  const result = verdict(grounding.grounded, info);

  console.log("==================================================");
  console.log(`QUESTION\n${question}`);
  console.log("");
  console.log(`GEMINI RESPONSE\n${text}`);
  console.log("");
  console.log(`MAPS GROUNDING DETECTED: ${grounding.grounded ? "YES" : "NO"}`);
  console.log(
    `GROUNDING SOURCES\n${
      grounding.sources.length
        ? grounding.sources.map((source) => `- ${source.title}${source.uri ? ` (${source.uri})` : ""}`).join("\n")
        : "(none)"
    }`,
  );
  console.log(`TRANSPORT INFORMATION RETURNED\n${info.length ? info.join(", ") : "(none detected)"}`);
  console.log(`PASS / PARTIAL / FAIL\n${result}`);
  console.log(`supports=${grounding.supportCount} queries=${grounding.webSearchQueries.join(" | ") || "(none)"}`);
  console.log("");
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
