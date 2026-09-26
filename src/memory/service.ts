/**
 * Persistent personal memory. Callers pass a user id and text.
 * They never choose a Backboard assistant or see another person's store.
 */
export interface MemoryWrite {
  /** Photon sender id, or the stable `photon:<id>` user id. */
  userId: string;
  text: string;
  spaceId?: string;
  displayName?: string;
}

export interface MemoryQuery {
  userId: string;
  query: string;
  spaceId?: string;
  displayName?: string;
  /** Caps how many memories are returned. Defaults are small on purpose. */
  limit?: number;
}

export interface MemoryWriteResult {
  stored: boolean;
  reason?: "empty" | "not_durable" | "duplicate" | "disabled";
}

export interface MemoryContext {
  userId: string;
  memories: string[];
}

export interface MemoryService {
  /** Keep a durable fact for this user. Skips chatter and duplicates. */
  store(input: MemoryWrite): Promise<MemoryWriteResult>;
  /** Raw lookup for this user only. May include loosely related hits. */
  search(input: MemoryQuery): Promise<string[]>;
  /** The few memories that should enter the model context for this request. */
  getRelevantContext(input: MemoryQuery): Promise<MemoryContext>;
}
