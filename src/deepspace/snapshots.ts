import type { DeepSpaceClient } from "./client.js";

/** Matches the backend's cap on POST /api/channels/snapshots/:key. */
const MAX_SNAPSHOT_BYTES = 500_000;

/**
 * Keep a public website panel current: rebuild the snapshot every interval and
 * push it to DeepSpace when it changed (or at least every `refreshMs`, so the
 * site can tell the feed is alive). The site can't reach this machine directly.
 */
export function startSnapshotPush(options: {
  client: Pick<DeepSpaceClient, "putSnapshot">;
  key: "xrpl" | "integrations";
  build: () => Promise<unknown>;
  intervalMs: number;
  refreshMs?: number;
  now?: () => number;
}): { stop: () => void; tick: () => Promise<void> } {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 5 * 60_000;
  let lastBody = "";
  let lastPushAt = 0;
  let running = false;
  let warned = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const snapshot = await options.build();
      const body = JSON.stringify(snapshot);
      if (body.length > MAX_SNAPSHOT_BYTES) {
        if (!warned) console.warn(`DeepSpace ${options.key} snapshot is too large to publish (${body.length} bytes).`);
        warned = true;
        return;
      }
      // generatedAt changes on every build; compare without it.
      const comparable = body.replace(/"generatedAt":"[^"]*"/, "");
      if (comparable === lastBody && now() - lastPushAt < refreshMs) return;
      await options.client.putSnapshot(options.key, snapshot);
      lastBody = comparable;
      lastPushAt = now();
      warned = false;
    } catch (error) {
      if (!warned) console.warn(`DeepSpace ${options.key} snapshot push failed: ${error instanceof Error ? error.message.slice(0, 200) : "Error"}`);
      warned = true;
    } finally {
      running = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
