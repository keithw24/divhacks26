import { lookupNavHazards } from "../navigation/hazards.js";
import { gazetteerBackedResolver, createGeminiMapsClient } from "./gemini.js";
import { createGoogleRoutesProvider, createPlacesResolver } from "./routing.js";
import { TransportationService } from "./service.js";
import type { TransportationDependencies } from "./service.js";
import { getSafety } from "../skills/safetySkill.js";

export interface TransportEnv {
  geminiApiKey?: string;
  googleMapsApiKey?: string;
  geminiModel?: string;
  databaseUrl?: string;
}

/** Gemini Maps grounding is the default. Routes/Places stay optional. */
export function createTransportationServiceFromEnv(
  env: TransportEnv,
  overrides: TransportationDependencies = {},
): TransportationService {
  const gemini =
    overrides.gemini ??
    (env.geminiApiKey
      ? createGeminiMapsClient({ apiKey: env.geminiApiKey, model: env.geminiModel })
      : undefined);
  const routing = overrides.routing ?? (env.googleMapsApiKey ? createGoogleRoutesProvider(env.googleMapsApiKey) : undefined);
  const places = env.googleMapsApiKey ? createPlacesResolver(env.googleMapsApiKey) : undefined;
  const resolver = overrides.resolver ?? gazetteerBackedResolver(gemini, places);

  const safetyLookup =
    overrides.safetyLookup ??
    (env.databaseUrl
      ? async (input: { latitude: number; longitude: number; label: string; when: string }) => {
          const result = await getSafety({
            origin: { label: input.label, latitude: input.latitude, longitude: input.longitude },
            when: input.when,
            databaseUrl: env.databaseUrl,
          });
          return result.data ?? null;
        }
      : undefined);

  const hazardLookup =
    overrides.hazardLookup ??
    (env.databaseUrl
      ? async (input: { origin: { latitude?: number; longitude?: number }; destination: { latitude?: number; longitude?: number }; when: string }) =>
          lookupNavHazards({
            points: [input.origin, input.destination].flatMap((place) =>
              typeof place.latitude === "number" && typeof place.longitude === "number"
                ? [{ latitude: place.latitude, longitude: place.longitude }]
                : [],
            ),
            databaseUrl: env.databaseUrl,
            when: input.when,
          })
      : undefined);

  return new TransportationService({
    memory: overrides.memory,
    gemini,
    routing,
    resolver,
    safetyLookup,
    hazardLookup,
  });
}
