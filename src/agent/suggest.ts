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

/** Route one chat turn through the shared Gemini intent parser and factual skills. */
export async function suggestNext(input: SuggestInput): Promise<string> {
  return orchestrate({
    question: input.question,
    transcript: input.transcript,
    location: input.location,
    now: input.now,
  });
}
