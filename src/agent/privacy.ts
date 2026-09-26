export interface AttributedMemory {
  userId: string;
  displayName?: string;
  memories: string[];
}

const LEAK =
  /\b(told me|privately|private (?:chat|conversation)|previous (?:private )?conversation|i remember|months ago|weeks ago|you (?:once |previously |earlier )?said|according to (?:his|her|their|your) (?:memory|profile)|stored memory|backboard)\b/i;

/**
 * Keep the useful recommendation. Drop sentences that expose private memory
 * or quote a stored fact the group has not just said.
 */
export function sanitizeGroupReply(reply: string, memories: AttributedMemory[], recentText: string): string {
  const privateFacts = memories
    .flatMap((person) => person.memories)
    .map((memory) => memory.trim())
    .filter((memory) => memory.length >= 12);
  const recent = recentText.toLowerCase();
  const sentences = reply
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const kept = sentences.filter((sentence) => {
    if (LEAK.test(sentence)) return false;
    const lower = sentence.toLowerCase();
    return !privateFacts.some((fact) => lower.includes(fact.toLowerCase()) && !recent.includes(fact.toLowerCase()));
  });
  if (kept.length > 0) return kept.join(" ");
  return "I'd lean toward an option that fits what you just asked.";
}
