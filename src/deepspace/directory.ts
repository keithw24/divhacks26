import type { DirectoryPerson } from "./client.js";
import type { AccountOnboardingStore } from "../payments/xrpl/onboarding.js";
import { preferNamedWallets } from "../payments/recipients.js";

export interface PeopleDirectoryEntry {
  displayName?: string;
  userId?: string;
  xrplAddress?: string;
  /** iMessage handle (phone or Apple ID). Gemini may use this; do not log it. */
  imessage?: string;
}

export function mergePeopleDirectory(
  local: PeopleDirectoryEntry[],
  remote: DirectoryPerson[],
): PeopleDirectoryEntry[] {
  const remoteRows: PeopleDirectoryEntry[] = remote.map((row) => ({
    userId: row.userId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    xrplAddress: row.xrplAddress,
    ...(row.photonIdentifier ? { imessage: row.photonIdentifier } : {}),
  }));
  const merged = preferNamedWallets(local, remoteRows) as PeopleDirectoryEntry[];
  for (const row of remote) {
    const match = merged.find(
      (person) =>
        person.userId === row.userId ||
        (row.xrplAddress && person.xrplAddress === row.xrplAddress) ||
        (row.displayName && person.displayName?.trim().toLowerCase() === row.displayName.trim().toLowerCase()),
    );
    if (match) match.imessage = match.imessage || row.photonIdentifier;
  }
  return merged;
}

export function formatPeopleDirectory(people: PeopleDirectoryEntry[]): string[] {
  return people.map((person) => {
    const bits = [person.displayName || person.userId || "member"];
    if (person.userId) bits.push(`userId ${person.userId}`);
    if (person.xrplAddress && person.xrplAddress !== "0") bits.push(`wallet ${person.xrplAddress}`);
    else bits.push("no Testnet wallet");
    if (person.imessage?.trim()) bits.push(`iMessage ${person.imessage.trim()}`);
    return bits.join(" — ");
  });
}

export function createDirectoryCache(loadRemote: () => Promise<DirectoryPerson[]>, ttlMs = 60_000) {
  let cached: { at: number; people: DirectoryPerson[] } | undefined;
  return async (): Promise<DirectoryPerson[]> => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.people;
    try {
      const people = await loadRemote();
      cached = { at: now, people };
      return people;
    } catch {
      return cached?.people ?? [];
    }
  };
}
