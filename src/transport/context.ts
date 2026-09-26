import { displayName } from "./locations.js";
import type { PlaceLocation, SpaceTravelContext, TravelMode } from "./types.js";

const MAX_MESSAGES = 20;
const MAX_PLACES = 8;

export class ConversationMemory {
  private readonly spaces = new Map<string, SpaceTravelContext>();

  get(spaceId: string): SpaceTravelContext {
    const existing = this.spaces.get(spaceId);
    if (existing) return existing;
    const created: SpaceTravelContext = {
      spaceId,
      recentPlaces: [],
      recentMessages: [],
    };
    this.spaces.set(spaceId, created);
    return created;
  }

  observe(spaceId: string, text: string, senderId?: string, at = Date.now()): SpaceTravelContext {
    const ctx = this.get(spaceId);
    ctx.recentMessages = [...ctx.recentMessages, { senderId, text, at }].slice(-MAX_MESSAGES);
    return ctx;
  }

  rememberPlace(spaceId: string, place: PlaceLocation, role?: "origin" | "destination"): SpaceTravelContext {
    const ctx = this.get(spaceId);
    ctx.recentPlaces = [place, ...ctx.recentPlaces.filter((item) => item.name !== place.name)].slice(0, MAX_PLACES);
    if (role === "origin") ctx.origin = place;
    if (role === "destination") ctx.destination = place;
    return ctx;
  }

  setMode(spaceId: string, mode?: TravelMode): void {
    this.get(spaceId).lastMode = mode;
  }

  setPartySize(spaceId: string, partySize?: number): void {
    if (partySize) this.get(spaceId).partySize = partySize;
  }

  findPlace(spaceId: string, query: string): PlaceLocation | undefined {
    const ctx = this.get(spaceId);
    const needle = query.toLowerCase();
    const candidates = [ctx.destination, ctx.origin, ...ctx.recentPlaces].filter(
      (place): place is PlaceLocation => Boolean(place),
    );
    return candidates.find((place) => {
      const name = displayName(place).toLowerCase();
      const address = place.address?.toLowerCase() ?? "";
      return name.includes(needle) || needle.includes(name) || address.includes(needle);
    });
  }
}
