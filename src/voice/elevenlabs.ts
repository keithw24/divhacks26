/** Minimal ElevenLabs client: speech-to-text for inbound voice memos, text-to-speech for replies. */

const API = "https://api.elevenlabs.io/v1";

export interface ElevenLabsOptions {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class ElevenLabsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

async function check(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  // ElevenLabs puts the reason in the body (bad key, quota, unknown voice); keep it short for logs.
  const detail = (await response.text().catch(() => "")).slice(0, 200);
  throw new ElevenLabsError(response.status, `ElevenLabs ${what} failed (${response.status}): ${detail}`);
}

/** Transcribe audio. Returns the transcript text (may be empty for silence). */
export async function transcribe(
  audio: Buffer,
  opts: ElevenLabsOptions & { model: string; filename: string; mimeType: string },
): Promise<string> {
  const form = new FormData();
  form.append("model_id", opts.model);
  form.append("file", new Blob([new Uint8Array(audio)], { type: opts.mimeType }), opts.filename);
  const response = await (opts.fetcher ?? fetch)(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const json = (await (await check(response, "speech-to-text")).json()) as { text?: string };
  return (json.text ?? "").trim();
}

/** Synthesize speech. Returns MP3 audio (44.1 kHz, 128 kbps). */
export async function synthesize(
  text: string,
  opts: ElevenLabsOptions & { voiceId: string; model: string },
): Promise<Buffer> {
  const url = `${API}/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=mp3_44100_128`;
  const response = await (opts.fetcher ?? fetch)(url, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: opts.model }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  return Buffer.from(await (await check(response, "text-to-speech")).arrayBuffer());
}
