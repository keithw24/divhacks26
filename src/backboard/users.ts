import { createHash } from "node:crypto";
import type { BackboardClient } from "./client.js";

export const SINGLE_USER_MEMORY_PROMPT = [
  "You store memory for exactly one person.",
  "Every fact and preference in this assistant belongs to that one person and nobody else.",
  "Do not mix in facts about other people.",
  "Keep durable personal facts and preferences: diet, allergies, transit, walking limits, neighborhoods, schedule, and budget.",
  "Do not keep ephemeral chatter such as greetings, jokes, or messages like 'see you in 5'.",
  "When a newer statement contradicts an older memory, the newer statement replaces it.",
].join(" ");

export function assistantNameFor(userId: string): string {
  const hash = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return `personal-memory-${hash}`;
}

export async function createPersonalAssistant(client: BackboardClient, userId: string): Promise<string> {
  const created = await client.createAssistant({
    name: assistantNameFor(userId),
    systemPrompt: SINGLE_USER_MEMORY_PROMPT,
  });
  return created.assistantId;
}
