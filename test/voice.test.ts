import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { hasFfmpeg, mp3ToM4a, prepareForTranscription } from "../src/voice/audio.js";
import { ElevenLabsError, synthesize, transcribe } from "../src/voice/elevenlabs.js";
import { speakableText, wantsVoiceReply } from "../src/voice/index.js";

const run = promisify(execFile);

/** Generate a short test tone in the given format with ffmpeg. */
async function tone(ext: string, codecArgs: string[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "voice-test-"));
  try {
    const out = join(dir, `tone.${ext}`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...codecArgs, out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ElevenLabs client", () => {
  it("sends the audio and model to speech-to-text and returns the transcript", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ text: " what should we do? " })));
    const text = await transcribe(Buffer.from("audio"), {
      apiKey: "k", model: "scribe_v2", filename: "voice.m4a", mimeType: "audio/mp4", fetcher: fetcher as typeof fetch,
    });
    expect(text).toBe("what should we do?");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe("k");
    const form = init!.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect((form.get("file") as File).name).toBe("voice.m4a");
  });

  it("requests MP3 text-to-speech for the configured voice and model", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
    const audio = await synthesize("hi there", { apiKey: "k", voiceId: "voice 1", model: "m1", fetcher: fetcher as typeof fetch });
    expect([...audio]).toEqual([1, 2, 3]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%201?output_format=mp3_44100_128");
    expect(JSON.parse(init!.body as string)).toEqual({ text: "hi there", model_id: "m1" });
  });

  it("surfaces API errors with the status code", async () => {
    const fetcher = vi.fn(async () => new Response("invalid api key", { status: 401 }));
    const call = synthesize("hi", { apiKey: "bad", voiceId: "v", model: "m", fetcher: fetcher as typeof fetch });
    await expect(call).rejects.toBeInstanceOf(ElevenLabsError);
    await expect(call).rejects.toMatchObject({ status: 401 });
  });
});

describe("speakableText", () => {
  it("drops links, list numbers and emoji", () => {
    const reply = "1. Caffe Reggio — 5 min walk 🍰\nhttps://maps.google.com/?q=x\n2. The Stand — comedy\nwant me to pick one?";
    expect(speakableText(reply)).toBe("Caffe Reggio, 5 min walk. The Stand, comedy. want me to pick one?");
  });

  it("cuts long replies at a sentence boundary", () => {
    const spoken = speakableText("This is a sentence that goes on. ".repeat(40));
    expect(spoken.length).toBeLessThanOrEqual(600);
    expect(spoken.endsWith(".")).toBe(true);
  });
});

describe("wantsVoiceReply", () => {
  const original = config.elevenLabsApiKey;
  afterEach(() => { config.elevenLabsApiKey = original; });

  it("never speaks without an ElevenLabs key", () => {
    config.elevenLabsApiKey = "";
    expect(wantsVoiceReply("always", true)).toBe(false);
  });

  it("matches the sender by default and respects always/off", () => {
    config.elevenLabsApiKey = "k";
    expect(wantsVoiceReply("match", true)).toBe(true);
    expect(wantsVoiceReply("match", false)).toBe(false);
    expect(wantsVoiceReply("always", false)).toBe(true);
    expect(wantsVoiceReply("off", true)).toBe(false);
  });
});

describe("audio conversion (ffmpeg)", async () => {
  const ffmpeg = await hasFfmpeg();

  it.skipIf(!ffmpeg)("converts MP3 to an m4a voice memo with a duration", async () => {
    const { audio, seconds } = await mp3ToM4a(await tone("mp3", ["-c:a", "libmp3lame"]));
    expect(audio.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(1.3);
  });

  it.skipIf(!ffmpeg)("converts an iPhone-style CAF memo to WAV for transcription", async () => {
    const caf = await tone("caf", ["-c:a", "pcm_s16le"]);
    const prepared = await prepareForTranscription(caf, "audio/x-caf");
    expect(prepared.mimeType).toBe("audio/wav");
    expect(prepared.audio.subarray(0, 4).toString("latin1")).toBe("RIFF");
  });

  it("passes common formats through untouched", async () => {
    const input = Buffer.from("m4a-bytes");
    const prepared = await prepareForTranscription(input, "audio/mp4");
    expect(prepared.audio).toBe(input);
    expect(prepared.filename).toBe("voice.mp4");
  });
});
