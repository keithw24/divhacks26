import type { DeepSpaceClient } from "./client.js";
import type { UserProfileWriter } from "../profiles/tiger.js";

/** Pull the trusted DeepSpace profile feed into Tiger's operational directory. */
export async function syncDeepSpaceProfiles(
  client: Pick<DeepSpaceClient, "directory">,
  profiles: UserProfileWriter,
): Promise<number> {
  const people = await client.directory();
  let synced = 0;
  for (const person of people) {
    await profiles.upsert({
      userId: person.userId,
      displayName: person.displayName,
      photonIdentifier: person.photonIdentifier,
      walletAddress: person.xrplAddress || "0",
    });
    synced++;
  }
  return synced;
}

/** One non-overlapping pull now and on an interval. Failures never stop chat delivery. */
export function startDeepSpaceProfileSync(options: {
  client: Pick<DeepSpaceClient, "directory">;
  profiles: UserProfileWriter;
  intervalMs: number;
}): { stop(): void; pollOnce(): Promise<number> } {
  let running = false;
  async function pollOnce(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const count = await syncDeepSpaceProfiles(options.client, options.profiles);
      if (count) console.info(`deepspace.profile_sync ${JSON.stringify({ synced: count })}`);
      return count;
    } catch (error) {
      const reason = error instanceof Error ? error.name : "Error";
      console.error(`deepspace.profile_sync failed: ${reason}`);
      return 0;
    } finally {
      running = false;
    }
  }
  void pollOnce();
  const timer = setInterval(() => void pollOnce(), Math.max(5_000, options.intervalMs));
  timer.unref?.();
  return { stop: () => clearInterval(timer), pollOnce };
}
