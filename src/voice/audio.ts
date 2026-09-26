import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

let ffmpegAvailable: Promise<boolean> | undefined;

/** Whether ffmpeg can be run on this machine (checked once). */
export function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= run(FFMPEG, ["-version"]).then(() => true, () => false);
  return ffmpegAvailable;
}

/** Run ffmpeg on a buffer via temp files (mp4 output needs a seekable file, not a pipe). */
async function convert(input: Buffer, inExt: string, outExt: string, args: string[]): Promise<{ audio: Buffer; seconds?: number }> {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  const src = join(dir, `in.${inExt}`);
  const dst = join(dir, `out.${outExt}`);
  try {
    await writeFile(src, input);
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, ...args, dst], { timeout: 30_000 });
    const probe = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dst]).catch(() => null);
    const seconds = probe ? Number.parseFloat(probe.stdout) : Number.NaN;
    return { audio: await readFile(dst), seconds: Number.isFinite(seconds) ? seconds : undefined };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** MP3 → AAC in an .m4a container, the format iMessage voice memos play inline. */
export function mp3ToM4a(mp3: Buffer) {
  return convert(mp3, "mp3", "m4a", ["-c:a", "aac", "-b:a", "64k", "-ac", "1"]);
}

/** Formats ElevenLabs speech-to-text reliably accepts as-is. */
const TRANSCRIBABLE = /audio\/(mpeg|mp3|mp4|m4a|x-m4a|wav|x-wav|webm|ogg)/i;

/**
 * iPhone voice memos usually arrive as Opus in a CAF container, which speech-to-text services
 * may reject. Convert anything unusual to mono 16 kHz WAV; pass common formats through.
 */
export async function prepareForTranscription(
  audio: Buffer,
  mimeType: string,
): Promise<{ audio: Buffer; mimeType: string; filename: string }> {
  if (TRANSCRIBABLE.test(mimeType) || !(await hasFfmpeg())) {
    const ext = mimeType.split("/")[1]?.replace(/^x-/, "") || "audio";
    return { audio, mimeType, filename: `voice.${ext}` };
  }
  const { audio: wav } = await convert(audio, "caf", "wav", ["-ac", "1", "-ar", "16000"]);
  return { audio: wav, mimeType: "audio/wav", filename: "voice.wav" };
}
