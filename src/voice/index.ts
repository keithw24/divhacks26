import { voice, type Space } from "spectrum-ts";
import { config } from "../config.js";
import { mp3ToM4a, hasFfmpeg, prepareForTranscription } from "./audio.js";
import type { SocialRead } from "../agent/social.js";
import { voiceStyle } from "./decide.js";
import { synthesize, transcribe } from "./elevenlabs.js";

export const voiceEnabled = () => Boolean(config.elevenLabsApiKey);

/** Should this answer also go out as a voice memo? (Legacy check; see `shouldSpeak` in decide.ts.) */
export function wantsVoiceReply(mode: typeof config.voiceReplies, inboundWasVoice: boolean): boolean {
  if (!voiceEnabled() || mode === "off") return false;
  return mode === "always" || inboundWasVoice;
}

export interface HeardVoiceMemo {
  text: string;
  /** Non-speech sounds, e.g. ["laughter", "sigh"]. Used as tone cues, never as the request. */
  audioEvents: string[];
}

/** Split speech-to-text audio-event tags like "(laughter)" or "[sighs]" out of the transcript. */
export function splitAudioEvents(transcript: string): HeardVoiceMemo {
  const audioEvents: string[] = [];
  const text = transcript
    .replace(/[([]([a-z][a-z \-]{1,28})[)\]]/gi, (_m, event: string) => {
      audioEvents.push(event.trim().toLowerCase());
      return " ";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, audioEvents };
}

/** Transcribe an inbound voice memo. Returns null when voice is disabled or nothing was said. */
export async function transcribeVoiceMemo(memo: { read(): Promise<Buffer>; mimeType: string }): Promise<HeardVoiceMemo | null> {
  if (!voiceEnabled()) return null;
  const raw = await memo.read();
  const prepared = await prepareForTranscription(raw, memo.mimeType);
  const text = await transcribe(prepared.audio, {
    apiKey: config.elevenLabsApiKey,
    model: config.elevenLabsSttModel,
    filename: prepared.filename,
    mimeType: prepared.mimeType,
  });
  const heard = splitAudioEvents(text);
  // Metadata only: no transcript text in logs.
  console.info(
    `voice.in ${JSON.stringify({ mimeType: memo.mimeType, bytes: raw.length, sentAs: prepared.mimeType, transcriptChars: heard.text.length, audioEvents: heard.audioEvents.length })}`,
  );
  return heard.text ? heard : null;
}

const MAX_SPOKEN_CHARS = 600;

/**
 * Turn a text reply into something worth hearing: links, emoji and list punctuation don't read
 * aloud well, and long replies are cut at a sentence boundary (the text message has the full version).
 */
export function speakableText(reply: string): string {
  let text = reply
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_#`>|]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .split("\n").map((line) => line.trim()).filter(Boolean).join(". ")
    .replace(/([.!?:;,])\s*\./g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text.length > MAX_SPOKEN_CHARS) {
    const cut = text.slice(0, MAX_SPOKEN_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    text = end > 200 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return text;
}

/** Speak a reply into the chat as a voice memo (m4a when ffmpeg is available, otherwise an MP3 attachment). */
export async function sendVoiceReply(space: Space, reply: string, social?: SocialRead): Promise<void> {
  const spoken = speakableText(reply);
  if (!spoken) return;
  // Delivery follows the moment: steadier and slower when someone's stressed, brighter when excited.
  const style = voiceStyle(social, config.elevenLabsTtsModel);
  const mp3 = await synthesize(style.tag ? `${style.tag} ${spoken}` : spoken, {
    apiKey: config.elevenLabsApiKey,
    voiceId: config.elevenLabsVoiceId,
    model: config.elevenLabsTtsModel,
    ...(style.settings && { voiceSettings: style.settings }),
  });
  if (await hasFfmpeg()) {
    const { audio, seconds } = await mp3ToM4a(mp3);
    await space.send(voice(audio, { name: "reply.m4a", mimeType: "audio/mp4", ...(seconds && { duration: Math.round(seconds) }) }));
    console.info(`voice.out ${JSON.stringify({ format: "m4a", bytes: audio.length, seconds: seconds && Math.round(seconds) })}`);
  } else {
    await space.send(voice(mp3, { name: "reply.mp3", mimeType: "audio/mpeg" }));
    console.info(`voice.out ${JSON.stringify({ format: "mp3", bytes: mp3.length })}`);
  }
}
