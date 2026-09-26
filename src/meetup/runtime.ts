import type { StateStore } from "../store/state.js";
import { gazetteerBackedResolver } from "../transport/gemini.js";
import { createGoogleRoutesProvider, createPlacesResolver } from "../transport/routing.js";
import type { PlaceResolver, RoutingProvider } from "../transport/types.js";
import { MeetupService } from "./service.js";
import { MeetupStore } from "./store.js";

export interface MeetupRuntimeEnv {
  googleMapsApiKey?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  timeZone?: string;
  stateStore?: StateStore;
  routing?: RoutingProvider;
  resolver?: PlaceResolver;
}

export function createMeetupRuntime(env: MeetupRuntimeEnv) {
  const routing = env.routing ?? (env.googleMapsApiKey ? createGoogleRoutesProvider(env.googleMapsApiKey) : undefined);
  const places = env.googleMapsApiKey ? createPlacesResolver(env.googleMapsApiKey) : undefined;
  const resolver = env.resolver ?? gazetteerBackedResolver(undefined, places);
  const store = env.stateStore ? MeetupStore.open(env.stateStore) : new MeetupStore();
  const service = new MeetupService({
    store,
    routing,
    resolver,
    timeZone: env.timeZone ?? "America/New_York",
  });
  return { service };
}
