export function logTransportError(scope: string, error: unknown): void {
  const category = error instanceof Error ? error.name : "Error";
  console.error(`[transport:${scope}] ${category}`);
}
