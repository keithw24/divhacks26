import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretStore {
  put(customerId: string, seed: string): void;
  get(customerId: string): string | undefined;
  /** Used only to scrub logs. Callers must not print the result. */
  knownSecrets(): readonly string[];
}

class SeedMap {
  private readonly seeds = new Map<string, string>();

  put(customerId: string, seed: string): void {
    if (!customerId.trim() || !seed.trim()) throw new Error("refusing to store an empty wallet secret");
    this.seeds.set(customerId, seed);
  }

  get(customerId: string): string | undefined {
    return this.seeds.get(customerId);
  }

  knownSecrets(): readonly string[] {
    return [...this.seeds.values()];
  }

  pairs(): Iterable<[string, string]> {
    return this.seeds.entries();
  }
}

/** In-memory seeds. They are never copied onto a wallet record. */
export class MemorySecretStore implements SecretStore {
  private readonly seeds = new SeedMap();

  put(customerId: string, seed: string): void {
    this.seeds.put(customerId, seed);
  }

  get(customerId: string): string | undefined {
    return this.seeds.get(customerId);
  }

  knownSecrets(): readonly string[] {
    return this.seeds.knownSecrets();
  }
}

/**
 * Seeds live in their own file, separate from public wallet metadata.
 * The default path is under data/, which is gitignored.
 */
export class FileSecretStore implements SecretStore {
  private readonly seeds = new SeedMap();

  constructor(private readonly path: string) {
    this.load();
  }

  put(customerId: string, seed: string): void {
    this.seeds.put(customerId, seed);
    this.save();
  }

  get(customerId: string): string | undefined {
    if (!this.seeds.get(customerId)) this.load();
    return this.seeds.get(customerId);
  }

  knownSecrets(): readonly string[] {
    return this.seeds.knownSecrets();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [customerId, seed] of Object.entries(parsed)) {
      if (typeof seed === "string" && seed.trim() && !this.seeds.get(customerId)) this.seeds.put(customerId, seed);
    }
  }

  private save(): void {
    // Another process (the agent or the demo) may have added a seed since we loaded.
    this.load();
    mkdirSync(dirname(this.path), { recursive: true });
    const body: Record<string, string> = {};
    for (const [customerId, seed] of this.seeds.pairs()) body[customerId] = seed;
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Some environments ignore chmod. The file is still not the public wallet record.
    }
    renameSync(tmp, this.path);
  }
}
