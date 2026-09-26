import type { BackboardClient } from "./client.js";

export interface MemoryModeOptions {
  /** When true, use memory_pro instead of memory. Never send both. */
  memoryPro: boolean;
  /** Write mode from BACKBOARD_MEMORY_MODE. Reads always use Readonly. */
  writeMode: "Auto" | "Readonly" | "off";
}

/**
 * Store a durable utterance for one assistant without a user-visible reply.
 * send_to_llm is false so Backboard can extract memory without answering the chat.
 */
export async function ingestMemory(
  client: BackboardClient,
  input: {
    assistantId: string;
    threadId: string;
    content: string;
    mode: MemoryModeOptions;
  },
): Promise<void> {
  if (input.mode.writeMode === "off") return;
  if (!input.mode.memoryPro && input.mode.writeMode !== "Auto") return;
  await client.sendMessage({
    assistantId: input.assistantId,
    threadId: input.threadId,
    content: input.content,
    sendToLlm: false,
    ...(input.mode.memoryPro ? { memoryPro: "Auto" as const } : { memory: "Auto" as const }),
  });
}

/** Retrieval only. Does not create an assistant. Falls back to memory search. */
export async function retrieveMemories(
  client: BackboardClient,
  input: {
    assistantId: string;
    threadId?: string;
    query: string;
    memoryPro: boolean;
  },
): Promise<string[]> {
  const message = await client.sendMessage({
    assistantId: input.assistantId,
    threadId: input.threadId,
    content: input.query,
    sendToLlm: false,
    ...(input.memoryPro ? { memoryPro: "Readonly" as const } : { memory: "Readonly" as const }),
  });
  if (message.retrievedMemories.length > 0) return message.retrievedMemories;
  return client.searchMemories(input.assistantId, input.query, 8);
}
