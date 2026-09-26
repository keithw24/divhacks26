import { gazetteerBackedResolver, createGeminiMapsClient } from "./gemini.js";
import { createGoogleRoutesProvider, createPlacesResolver } from "./routing.js";
import { TransportationService } from "./service.js";
import type { TransportationDependencies } from "./service.js";

export interface TransportEnv {
  geminiApiKey?: string;
  googleMapsApiKey?: string;
  geminiModel?: string;
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

  return new TransportationService({
    memory: overrides.memory,
    gemini,
    routing,
    resolver,
  });
}
