import type { DirectoryPerson } from "./client.js";
import type { AccountOnboardingStore } from "../payments/xrpl/onboarding.js";

export interface PeopleDirectoryEntry {
  displayName?: string;
  userId?: string;
  xrplAddress?: string;
}

export function mergePeopleDirectory(
  local: PeopleDirectoryEntry[],
  remote: DirectoryPerson[],
): PeopleDirectoryEntry[] {
  const byKey = new Map<string, PeopleDirectoryEntry>();
  const keyOf = (row: PeopleDirectoryEntry) =>
    (row.userId?.trim() || row.xrplAddress?.trim() || row.displayName?.trim() || "").toLowerCase();
  for (const row of local) {
    const key = keyOf(row);
    if (!key) continue;
    byKey.set(key, { ...row });
  }
  for (const row of remote) {
    const existing =
      [...byKey.values()].find((person) => person.userId === row.userId || person.xrplAddress === row.xrplAddress) ??
      undefined;
    if (existing) {
      existing.userId = existing.userId || row.userId;
      existing.xrplAddress = existing.xrplAddress || row.xrplAddress;
      continue;
    }
    byKey.set(row.userId.toLowerCase(), { userId: row.userId, xrplAddress: row.xrplAddress });
  }
  return [...byKey.values()];
}

export function formatPeopleDirectory(people: PeopleDirectoryEntry[]): string[] {
  return people.map((person) => {
    const bits = [person.displayName || person.userId || "member"];
    if (person.userId) bits.push(`userId ${person.userId}`);
    if (person.xrplAddress) bits.push(`wallet ${person.xrplAddress}`);
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
