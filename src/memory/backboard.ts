import type { BackboardClient } from "../backboard/client.js";
import { createBackboardClient } from "../backboard/client.js";
import { ingestMemory, retrieveMemories } from "../backboard/memory.js";
import { classifyMemory, isDurableMemory } from "../agent/classify.js";
import { ensureSpaceThread, resolveUser, userIdFor } from "../identity/users.js";
import type { StateStore } from "../store/state.js";
import { isDuplicateMemory, selectRelevant } from "./relevance.js";
import type { MemoryContext, MemoryQuery, MemoryService, MemoryWrite, MemoryWriteResult } from "./service.js";

export type { MemoryContext, MemoryQuery, MemoryService, MemoryWrite, MemoryWriteResult } from "./service.js";

const DEFAULT_LIMIT = 5;
const RECENT_MEMORY_CAP = 24;

export interface BackboardMemoryServiceOptions {
  /** Pass a client in tests. Production can pass apiKey instead. */
  client?: BackboardClient;
  apiKey?: string;
  store: StateStore;
  memoryPro: boolean;
  writeMode: "Auto" | "Readonly" | "off";
  timeoutMs?: number;
}

/**
 * Backboard implementation of MemoryService.
 * One Photon user maps to one assistant. Search never receives another user's id.
 */
export function createBackboardMemoryService(options: BackboardMemoryServiceOptions): MemoryService {
  const client =
    options.client ??
    (options.apiKey ? createBackboardClient({ apiKey: options.apiKey, timeoutMs: options.timeoutMs }) : undefined);
  if (!client) return disabledMemoryService();

  const mode = { memoryPro: options.memoryPro, writeMode: options.writeMode };

  async function assistantFor(input: { userId: string; displayName?: string }): Promise<{
    userId: string;
    assistantId: string;
  } | null> {
    const photonIdentifier = photonId(input.userId);
    const profile = await resolveUser({
      store: options.store,
      photonIdentifier,
      displayName: input.displayName,
      client,
    });
    if (!profile.backboardAssistantId) return null;
    return { userId: profile.userId, assistantId: profile.backboardAssistantId };
  }

  return {
    async store(input): Promise<MemoryWriteResult> {
      const content = input.text.trim();
      if (!content) return { stored: false, reason: "empty" };
      if (!isDurableMemory(classifyMemory(content))) return { stored: false, reason: "not_durable" };
      if (mode.writeMode === "off" || (!mode.memoryPro && mode.writeMode !== "Auto")) {
        return { stored: false, reason: "disabled" };
      }

      const owner = await assistantFor(input);
      if (!owner) return { stored: false, reason: "disabled" };
      const photonIdentifier = photonId(input.userId);

      const prior = await searchQuietly(client, owner.assistantId, content);
      const remembered = recentMemoryTexts(options.store, photonIdentifier);
      if ([...prior, ...remembered].some((memory) => isDuplicateMemory(memory, content))) {
        return { stored: false, reason: "duplicate" };
      }

      const threadId = await ensureSpaceThread({
        store: options.store,
        userId: owner.userId,
        photonSpaceId: input.spaceId || "personal",
        assistantId: owner.assistantId,
        client,
      });
      await ingestMemory(client, {
        assistantId: owner.assistantId,
        threadId,
        content,
        mode,
      });
      rememberMemoryText(options.store, photonIdentifier, content);
      return { stored: true };
    },

    async search(input): Promise<string[]> {
      const owner = await assistantFor(input);
      if (!owner) return [];
      const found = await client.searchMemories(owner.assistantId, input.query, input.limit ?? 8);
      return unique(found);
    },

    async getRelevantContext(input): Promise<MemoryContext> {
      const owner = await assistantFor(input);
      if (!owner) return { userId: userIdFor(photonId(input.userId)), memories: [] };
      const threadId = await ensureSpaceThread({
        store: options.store,
        userId: owner.userId,
        photonSpaceId: input.spaceId || "personal",
        assistantId: owner.assistantId,
        client,
      });
      const retrieved = await retrieveMemories(client, {
        assistantId: owner.assistantId,
        threadId,
        query: input.query,
        memoryPro: mode.memoryPro,
      });
      return {
        userId: owner.userId,
        memories: selectRelevant(retrieved, input.query, input.limit ?? DEFAULT_LIMIT),
      };
    },
  };
}

function disabledMemoryService(): MemoryService {
  return {
    async store() {
      return { stored: false, reason: "disabled" };
    },
    async search() {
      return [];
    },
    async getRelevantContext(input) {
      return { userId: userIdFor(photonId(input.userId)), memories: [] };
    },
  };
}

function photonId(userId: string): string {
  return userId.startsWith("photon:") ? userId.slice("photon:".length) : userId;
}

function unique(memories: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const memory of memories) {
    const text = memory.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function recentMemoryTexts(store: StateStore, photonIdentifier: string): string[] {
  const saved = store.getState().users[photonIdentifier]?.recentMemoryTexts;
  if (!Array.isArray(saved)) return [];
  return saved.filter((text) => typeof text === "string" && text.trim().length > 0);
}

function rememberMemoryText(store: StateStore, photonIdentifier: string, content: string): void {
  store.update((state) => {
    const profile = state.users[photonIdentifier];
    if (!profile) return;
    const prior = (profile.recentMemoryTexts ?? []).filter((text) => text !== content);
    profile.recentMemoryTexts = [...prior, content].slice(-RECENT_MEMORY_CAP);
  });
}

/** A failed duplicate check must not block the write or surface as a hard failure by itself. */
async function searchQuietly(client: BackboardClient, assistantId: string, query: string): Promise<string[]> {
  try {
    return await client.searchMemories(assistantId, query, 8);
  } catch {
    return [];
  }
}
