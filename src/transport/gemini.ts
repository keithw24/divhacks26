import { getGeminiClient } from "../gemini/client.js";
import { MESSAGE_WRITING_RULES } from "../agent/writing-style.js";
import { formatApproximateDuration } from "./format.js";
import { inspectMapsGrounding } from "./grounding.js";
import { displayName, lookupGazetteer } from "./locations.js";
import { logTransportError } from "./log.js";
import type {
  GeminiGroundedText,
  GeminiMapsClient,
  LatLng,
  PhraseDirectionsInput,
  PlaceLocation,
  PlaceResolveResult,
  TravelMode,
  TravelTimeEstimate,
  TravelTimeEstimateInput,
} from "./types.js";

interface GeminiMapsConfig {
  apiKey: string;
  model?: string;
}

export const DIRECTIONS_AUTHORIZATION_RULE =
  "When the user asks for directions, transportation advice, route comparison, or how to get somewhere, treat the request as authorization to perform all available route and transportation lookups. Do not ask whether the user wants you to check routes, Maps, transit status, stations, travel times, or related information. Perform those actions automatically and return the best available answer. Ask a clarification only when a required origin or destination cannot be determined from the current message, conversation context, or available memory.";

const TRANSPORT_RULES = [
  "Use Google Maps grounding for factual location and transportation information.",
  "Do not supply specific travel times, routes, stations, transfers, distances, or service information unless supported by the grounded Maps results.",
  "If the available Maps information is insufficient, say so rather than guessing.",
  "Answer immediately. Do not ask permission to search Maps, check routes, check transit, compare modes, find stations, or look up travel times.",
  "Do not append offers such as \"want me to\", \"should I check\", \"I can check\", or \"want directions\".",
  "Keep the reply to 2-6 short iMessage lines. No JSON. No markdown headings.",
  "Immediately after the answer, mention Google Maps source titles when they exist.",
].join(" ");

const DIRECTION_REPLY_RULES = [
  "Answer the user's directions question directly.",
  "Include the travel time naturally when duration is available.",
  "If durationSource is gemini_estimate, use approximate language such as about, roughly, or around. Never present that estimate as an exact live travel time.",
  "If durationSource is null, do not invent a travel time.",
  "Never mention APIs, configuration, providers, missing keys, errors, HTTP statuses, quotas, timeouts, or fallback logic.",
  "Never invent a subway line, station, bus, road, fare, departure time, or other route detail that is not present in the structured route facts.",
  "Do not ask a follow-up or offer another lookup when the request can already be answered.",
  "Keep the response concise and conversational for iMessage. No JSON. No markdown headings.",
].join(" ");

export function directionsBrief(input: PhraseDirectionsInput): {
  origin: string | null;
  destination: string | null;
  mode: TravelMode[];
  route: string | null;
  duration: string | null;
  distance: string | null;
  durationSource: PhraseDirectionsInput["durationSource"];
} {
  return {
    origin: input.origin ? displayName(input.origin) : null,
    destination: input.destination ? displayName(input.destination) : null,
    mode: input.modes,
    route: input.routeSummary ?? null,
    duration: input.durationLabel ?? null,
    distance: input.distanceLabel ?? null,
    durationSource: input.durationSource ?? null,
  };
}

export function directionsModelInstructions(input: PhraseDirectionsInput): { system: string; user: string } {
  return {
    system: `${DIRECTIONS_AUTHORIZATION_RULE} ${DIRECTION_REPLY_RULES}\n\n${MESSAGE_WRITING_RULES}`,
    user: [
      "You are an NYC local answering a transportation question over iMessage.",
      "Return the best route answer now. Do not ask a follow-up.",
      "Use only the structured facts below for lines, stations, buses, roads, fares, and times.",
      `Question: ${input.question}`,
      `Party size: ${input.partySize ?? "unknown"}`,
      ...(input.preferenceNotes?.length
        ? [
            `Route constraints from this person's known preferences. Follow them when they do not conflict with the current question. Do not quote them as private history: ${input.preferenceNotes.join(" ")}`,
          ]
        : []),
      ...(input.conversation?.length ? [`Recent conversation: ${input.conversation.join(" | ")}`] : []),
      `Facts: ${JSON.stringify(directionsBrief(input))}`,
    ].join("\n"),
  };
}

const TRAVEL_TIME_SCHEMA = {
  type: "object",
  properties: {
    canEstimate: { type: "boolean" },
    lowMinutes: { type: "integer" },
    highMinutes: { type: "integer" },
  },
  required: ["canEstimate"],
};

export function travelTimeEstimateInstructions(input: TravelTimeEstimateInput): string {
  return [
    "Estimate a conservative door-to-door travel-time range for this NYC trip.",
    "Use only the facts below. If they are not enough to estimate responsibly, set canEstimate to false and omit the minutes.",
    "Do not invent subway lines, stations, buses, roads, fares, or departure times.",
    "Prefer a range over one exact minute. Return JSON only.",
    `Origin: ${displayName(input.origin)}${input.origin.address ? ` (${input.origin.address})` : ""}`,
    `Destination: ${displayName(input.destination)}${input.destination.address ? ` (${input.destination.address})` : ""}`,
    `Modes: ${input.modes.join(", ") || "WALK, TRANSIT"}`,
    input.groundedRoute ? `Grounded route facts: ${input.groundedRoute}` : "No grounded route steps are available.",
    ...(input.preferenceNotes?.length ? [`Preferences: ${input.preferenceNotes.join(" ")}`] : []),
    ...(input.conversation?.length ? [`Recent conversation: ${input.conversation.join(" | ")}`] : []),
  ].join("\n");
}

function asMinutes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Accept a conservative range. Anything incomplete or too wide becomes no duration. */
export function parseTravelTimeEstimate(raw: unknown, modes: TravelMode[]): TravelTimeEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { canEstimate?: unknown; lowMinutes?: unknown; highMinutes?: unknown };
  if (value.canEstimate !== true) return null;
  const low = asMinutes(value.lowMinutes);
  const high = asMinutes(value.highMinutes);
  if (low === undefined || high === undefined) return null;
  if (low < 1 || high > 180 || high < low) return null;
  if (high - low > 30) return null;
  return {
    lowMinutes: low,
    highMinutes: high,
    phrase: formatApproximateDuration(low, high, modes),
  };
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain JSON");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function biasFromPlace(place?: PlaceLocation): LatLng | undefined {
  if (typeof place?.latitude === "number" && typeof place?.longitude === "number") {
    return { latitude: place.latitude, longitude: place.longitude };
  }
  return undefined;
}

export function createGeminiMapsClient(config: GeminiMapsConfig): GeminiMapsClient {
  const ai = getGeminiClient(config.apiKey);
  const model = config.model ?? "gemini-3.8-flash";

  async function generate(prompt: string, bias?: LatLng, system?: string): Promise<GeminiGroundedText> {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        ...(system ? { systemInstruction: system } : {}),
        tools: [{ googleMaps: {} }],
        ...(bias
          ? {
              toolConfig: {
                retrievalConfig: {
                  latLng: {
                    latitude: bias.latitude,
                    longitude: bias.longitude,
                  },
                },
              },
            }
          : {}),
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("Gemini returned an empty Maps-grounded response");
    }

    const candidate = response.candidates?.[0] as { groundingMetadata?: unknown } | undefined;
    const grounding = inspectMapsGrounding(candidate?.groundingMetadata);
    return {
      text,
      sources: grounding.sources,
      grounded: grounding.grounded,
      grounding,
    };
  }

  return {
    async resolvePlaces(query, bias): Promise<PlaceResolveResult> {
      try {
        const result = await generate(
          [
            "Resolve this place name for an NYC transportation agent.",
            TRANSPORT_RULES,
            "Do not invent coordinates, addresses, or a unique match.",
            "If several businesses share the name, status must be ambiguous and include distinct candidates.",
            "If Maps cannot confirm the place, status must be unknown.",
            "Return JSON only with this shape:",
            '{"status":"resolved"|"ambiguous"|"unknown","places":[{"name":"","address":"","latitude":0,"longitude":0,"confidence":0}]}',
            `Query: ${query}`,
          ].join("\n"),
          bias,
        );

        const parsed = extractJsonObject(result.text) as {
          status?: PlaceResolveResult["status"];
          places?: Array<Partial<PlaceLocation>>;
        };

        const places: PlaceLocation[] = (parsed.places ?? [])
          .filter((place) => typeof place.name === "string" && place.name.trim())
          .map((place) => ({
            name: String(place.name),
            address: place.address ? String(place.address) : undefined,
            latitude: typeof place.latitude === "number" ? place.latitude : undefined,
            longitude: typeof place.longitude === "number" ? place.longitude : undefined,
            source: "gemini-maps",
            confidence: typeof place.confidence === "number" ? place.confidence : 0.7,
          }));

        const status = parsed.status ?? (places.length > 1 ? "ambiguous" : places.length === 1 ? "resolved" : "unknown");
        return { status, query, places, sources: result.sources };
      } catch (error) {
        logTransportError("gemini.resolvePlaces", error);
        throw error;
      }
    },

    async nearby(origin, query): Promise<GeminiGroundedText> {
      return generate(
        [
          "Answer this nearby-places question for someone texting in iMessage.",
          TRANSPORT_RULES,
          "Answer now. Do not ask permission to look the place up.",
          `User location: ${origin.name}${origin.address ? ` (${origin.address})` : ""}`,
          `Question: ${query}`,
        ].join("\n"),
        biasFromPlace(origin),
        `${DIRECTIONS_AUTHORIZATION_RULE}\n\n${MESSAGE_WRITING_RULES}`,
      );
    },

    async phraseDirections(input: PhraseDirectionsInput): Promise<GeminiGroundedText> {
      const instructions = directionsModelInstructions(input);
      return generate(instructions.user, input.bias ?? biasFromPlace(input.origin), instructions.system);
    },

    async estimateTravelTime(input: TravelTimeEstimateInput): Promise<TravelTimeEstimate | null> {
      const response = await ai.models.generateContent({
        model,
        contents: travelTimeEstimateInstructions(input),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: TRAVEL_TIME_SCHEMA,
          temperature: 0.2,
        },
      });
      const text = response.text?.trim();
      if (!text) return null;
      return parseTravelTimeEstimate(JSON.parse(text), input.modes);
    },
  };
}

export function gazetteerBackedResolver(
  gemini?: GeminiMapsClient,
  places?: { resolve(query: string, bias?: LatLng): Promise<PlaceResolveResult> },
): { resolve(query: string, bias?: LatLng): Promise<PlaceResolveResult> } {
  return {
    async resolve(query, bias) {
      const local = lookupGazetteer(query);
      if (local.status === "resolved" && (local.places[0]?.confidence ?? 0) >= 0.8) {
        return local;
      }
      if (places) {
        try {
          const remote = await places.resolve(query, bias);
          if (remote.status !== "unknown" && remote.places.length > 0) return remote;
        } catch (error) {
          logTransportError("places.resolve", error);
        }
      }
      if (gemini) {
        return gemini.resolvePlaces(query, bias);
      }
      return local.status === "resolved" ? local : { status: "unknown", query, places: [] };
    },
  };
}
