export type BackboardFailureKind =
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "rate_limit"
  | "server"
  | "malformed"
  | "network";

export class BackboardRequestError extends Error {
  readonly kind: BackboardFailureKind;
  readonly status?: number;

  constructor(kind: BackboardFailureKind, status?: number) {
    super(status ? `backboard ${kind} ${status}` : `backboard ${kind}`);
    this.name = "BackboardRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export interface SendMessageInput {
  content: string;
  assistantId: string;
  threadId?: string;
  memory?: "Auto" | "Readonly" | "off";
  memoryPro?: "Auto" | "Readonly";
  sendToLlm?: boolean;
  systemPrompt?: string;
}

export interface SendMessageResult {
  threadId?: string;
  assistantId?: string;
  content?: string;
  retrievedMemories: string[];
}

export interface BackboardClient {
  createAssistant(input: { name: string; systemPrompt: string }): Promise<{ assistantId: string }>;
  createThread(assistantId: string): Promise<{ threadId: string }>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  searchMemories(assistantId: string, query: string, limit?: number): Promise<string[]>;
  /** Every stored memory with its id (for the website's "what the agent remembers" page). */
  listMemories?(assistantId: string): Promise<StoredMemory[]>;
  deleteMemory?(assistantId: string, memoryId: string): Promise<void>;
  /** Deletes all memories on the assistant. Irreversible; used on account deletion. */
  resetMemories?(assistantId: string): Promise<void>;
}

export interface StoredMemory {
  id: string;
  text: string;
  createdAt?: string;
}

export interface BackboardClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://app.backboard.io/api";

export function createBackboardClient(options: BackboardClientOptions): BackboardClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new BackboardRequestError("timeout");
      throw new BackboardRequestError("network");
    }

    const raw = await response.text();
    let parsed: unknown = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new BackboardRequestError("malformed", response.status);
      }
    }
    if (!response.ok) throw new BackboardRequestError(kindForStatus(response.status), response.status);
    return parsed;
  }

  return {
    async createAssistant(input) {
      const payload = await request("POST", "/assistants", {
        name: input.name,
        system_prompt: input.systemPrompt,
      });
      const assistantId = readString(payload, "assistant_id");
      if (!assistantId) throw new BackboardRequestError("malformed");
      return { assistantId };
    },

    async createThread(assistantId) {
      const payload = await request("POST", `/assistants/${encodeURIComponent(assistantId)}/threads`, {});
      const threadId = readString(payload, "thread_id");
      if (!threadId) throw new BackboardRequestError("malformed");
      return { threadId };
    },

    async sendMessage(input) {
      const payload = await request("POST", "/threads/messages", {
        content: input.content,
        assistant_id: input.assistantId,
        ...(input.threadId ? { thread_id: input.threadId } : {}),
        ...(input.systemPrompt ? { system_prompt: input.systemPrompt } : {}),
        ...(input.memoryPro
          ? { memory_pro: input.memoryPro }
          : input.memory
            ? { memory: input.memory }
            : {}),
        send_to_llm: input.sendToLlm === false ? "false" : "true",
        stream: false,
      });
      if (!payload || typeof payload !== "object") throw new BackboardRequestError("malformed");
      return {
        threadId: readString(payload, "thread_id"),
        assistantId: readString(payload, "assistant_id"),
        content: readString(payload, "content"),
        retrievedMemories: readMemories(payload),
      };
    },

    async searchMemories(assistantId, query, limit = 8) {
      const payload = await request(
        "POST",
        `/assistants/${encodeURIComponent(assistantId)}/memories/search`,
        { query, limit },
      );
      if (!payload || typeof payload !== "object") throw new BackboardRequestError("malformed");
      return readMemories(payload);
    },

    async listMemories(assistantId) {
      const out: StoredMemory[] = [];
      for (let page = 1; page <= 5; page++) {
        const payload = await request(
          "GET",
          `/assistants/${encodeURIComponent(assistantId)}/memories?page=${page}&page_size=100`,
        );
        const rows = (payload as { memories?: unknown })?.memories;
        if (!Array.isArray(rows)) break;
        for (const row of rows as Record<string, unknown>[]) {
          const id = row.id ?? row.memory_id;
          const text = row.content ?? row.memory;
          if (typeof id !== "string" || typeof text !== "string" || !text.trim()) continue;
          out.push({ id, text: text.trim(), ...(typeof row.created_at === "string" && { createdAt: row.created_at }) });
        }
        if (rows.length < 100) break;
      }
      return out;
    },

    async deleteMemory(assistantId, memoryId) {
      await request("DELETE", `/assistants/${encodeURIComponent(assistantId)}/memories/${encodeURIComponent(memoryId)}`);
    },

    async resetMemories(assistantId) {
      await request("DELETE", `/assistants/${encodeURIComponent(assistantId)}/memories`);
    },
  };
}

function kindForStatus(status: number): BackboardFailureKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "server";
}

function readString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMemories(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const list = record.retrieved_memories ?? record.memories;
  if (!Array.isArray(list)) return [];
  const memories: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      memories.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = row.memory ?? row.content;
    if (typeof text === "string" && text.trim()) memories.push(text.trim());
  }
  return memories;
}
