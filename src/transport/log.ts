export function logTransportError(scope: string, error: unknown): void {
  const category = error instanceof Error ? error.name : "Error";
  const detail = error instanceof Error ? error.message : "";
  console.error(`[transport:${scope}] ${category}${detail ? `: ${detail}` : ""}`);
}

/** Server-only. This string must never be copied into an iMessage reply. */
export function logDurationSource(source: "google_routes" | "gemini_estimate" | "none"): void {
  console.info(`duration_source=${source}`);
}
