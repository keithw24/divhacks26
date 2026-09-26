import type { LatLng } from "../chat/location.js";
import { orchestrate } from "./orchestrate.js";

export interface SuggestInput {
  isGroup: boolean;
  asker: string;
  question: string;
  transcript: { at: Date; who: string; text: string }[];
  location?: LatLng & { who: string };
  now?: Date;
}

/**
 * Route non-transportation turns through the shared factual skill orchestrator.
 * The dedicated transportation service runs first in agent/turn.ts.
 */
export async function suggestNext(input: SuggestInput): Promise<string> {
  return orchestrate({
    question: input.question,
    transcript: input.transcript,
    location: input.location,
    now: input.now,
  });
}
