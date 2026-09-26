import { getGeminiClient } from "../gemini/client.js";
import { inspectMapsGrounding } from "./grounding.js";
import { lookupGazetteer } from "./locations.js";
import { logTransportError } from "./log.js";
import type {
  GeminiGroundedText,
  GeminiMapsClient,
  LatLng,
  PhraseDirectionsInput,
  PlaceLocation,
  PlaceResolveResult,
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

export function directionsModelInstructions(input: PhraseDirectionsInput): { system: string; user: string } {
  const optionalFacts =
    input.routes.length > 0
      ? `Optional structured route facts from Google Routes API (use only if present): ${JSON.stringify(
          input.routes.map((route) => ({
            mode: route.mode,
            durationSeconds: route.durationSeconds,
            distanceMeters: route.distanceMeters,
            summary: route.summary,
            steps: route.steps,
          })),
        )}`
      : "No structured Routes API facts were provided. Rely only on Google Maps grounding.";

  return {
    system: `${DIRECTIONS_AUTHORIZATION_RULE} ${TRANSPORT_RULES}`,
    user: [
      "You are an NYC local answering a transportation question over iMessage.",
      "Return the best route answer now. Do not ask a follow-up.",
      `Question: ${input.question}`,
      `Origin: ${input.origin ? JSON.stringify(input.origin) : "unknown"}`,
      `Destination: ${input.destination ? JSON.stringify(input.destination) : "unknown"}`,
      `Requested modes: ${input.modes.join(", ") || "WALK, TRANSIT"}`,
      `Party size: ${input.partySize ?? "unknown"}`,
      ...(input.preferenceNotes?.length
        ? [
            `Route constraints from this person's known preferences. Follow them when they do not conflict with the current question. Do not quote them as private history: ${input.preferenceNotes.join(" ")}`,
          ]
        : []),
      optionalFacts,
    ].join("\n"),
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
        DIRECTIONS_AUTHORIZATION_RULE,
      );
    },

    async phraseDirections(input: PhraseDirectionsInput): Promise<GeminiGroundedText> {
      const instructions = directionsModelInstructions(input);
      return generate(instructions.user, input.bias ?? biasFromPlace(input.origin), instructions.system);
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
