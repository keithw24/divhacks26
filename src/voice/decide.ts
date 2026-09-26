import type { SocialRead } from "../agent/social.js";

/**
 * match  = speak when someone sends a voice memo or asks to hear it.
 * smart  = match, plus when they're on the move or need a route right now.
 * always = every reply; off = never.
 */
export type VoiceMode = "match" | "smart" | "always" | "off";

export interface VoiceDecisionInput {
  mode: VoiceMode;
  enabled: boolean;
  inboundWasVoice: boolean;
  social?: SocialRead;
  /** Which handler answered (payment, transport, gemini, ...). */
  outcome?: string;
}

export function parseVoiceMode(value: string): VoiceMode {
  return value === "smart" || value === "always" || value === "off" ? value : "match";
}

/** Should this answer also go out as a voice memo? */
export function shouldSpeak(input: VoiceDecisionInput): boolean {
  if (!input.enabled || input.mode === "off") return false;
  // Money confirmations are for reading carefully, not hearing.
  if (input.outcome === "payment") return false;
  if (input.mode === "always" || input.inboundWasVoice || input.social?.wantsVoice) return true;
  if (input.mode !== "smart" || !input.social) return false;
  const routeAnswer = input.outcome === "transport";
  return (input.social.onTheMove && (routeAnswer || input.outcome === "gemini")) || (input.social.urgency === "now" && routeAnswer);
}

/** ElevenLabs `voice_settings` plus an optional eleven_v3 audio tag, chosen from the mood. */
export interface VoiceStyle {
  settings?: { stability: number; similarity_boost: number; style: number; speed: number };
  tag?: string;
}

export function voiceStyle(social: SocialRead | undefined, model: string): VoiceStyle {
  if (!social || social.confidence === 0) return {};
  const v3 = model.startsWith("eleven_v3");
  const soothing = ["stressed", "anxious", "sad", "tired", "frustrated"].includes(social.mood);
  const bright = social.mood === "excited" || social.mood === "playful";
  // eleven_v3 takes direction from inline tags and only a few stability steps, so leave settings alone there.
  if (v3) {
    if (social.urgency === "now") return { tag: "[clearly]" };
    if (soothing) return { tag: social.mood === "sad" ? "[softly]" : "[calmly]" };
    if (bright) return { tag: "[cheerfully]" };
    return {};
  }
  if (social.urgency === "now") return { settings: { stability: 0.6, similarity_boost: 0.75, style: 0.1, speed: 1.08 } };
  if (soothing) return { settings: { stability: 0.7, similarity_boost: 0.75, style: 0.1, speed: 0.92 } };
  if (bright) return { settings: { stability: 0.35, similarity_boost: 0.75, style: 0.45, speed: 1.04 } };
  return {};
}
