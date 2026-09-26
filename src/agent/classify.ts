export type MemoryClass = "DURABLE_PREFERENCE" | "DURABLE_FACT" | "EPHEMERAL" | "UNCERTAIN";

const EPHEMERAL_EXACT =
  /^(lol+|lmao+|haha+|hehe+|ok+|okay|k|yeah|yep|yup|nah|nope|brb|omw|ttyl|thx|thanks|thank you|hi|hey|hello|sup|yo|cya|gtg|bet|cool|nice|word|same|true|facts|sure)[\s!.?]*$/i;

const INTERROGATIVE = /^(what|how|where|when|why|who|which|can|could|should|would|do|does|did|is|are)\b/i;

const FIRST_PERSON = /\b(i|i'm|i am|i've|i have|i'd|i would|my)\b/i;

const PREFERENCE =
  /\b(hate|hates|hating|like|likes|liking|love|loves|prefer|prefers|avoid|avoids|avoiding|vegetarian|vegan|always|usually|never|don't like|do not like|don't eat|do not eat|can't stand|cannot stand|would rather)\b/i;

const FACT =
  /\b(live near|live in|live at|my name is|allergic to|i'm allergic|i am allergic|leave class|leave work|leave school|i work)\b/i;

/**
 * Conservative local classifier. Only DURABLE_* messages are eligible for memory.
 * Questions are not stored. Ephemeral chatter is left out.
 */
export function classifyMemory(text: string): MemoryClass {
  const trimmed = text.trim();
  if (!trimmed) return "EPHEMERAL";
  const statements = trimmed
    .split(/(?<=[.!])\s+/)
    .map((part) => part.replace(/\?+$/g, "").trim())
    .filter((part) => part && !INTERROGATIVE.test(part));
  if (statements.length === 0) return INTERROGATIVE.test(trimmed) || trimmed.endsWith("?") ? "UNCERTAIN" : classifyClause(trimmed);
  return classifyClause(statements.join(". "));
}

function classifyClause(trimmed: string): MemoryClass {
  if (!trimmed) return "EPHEMERAL";
  if (EPHEMERAL_EXACT.test(trimmed) || /^see you\b/i.test(trimmed)) return "EPHEMERAL";
  if (!FIRST_PERSON.test(trimmed)) {
    return trimmed.length < 24 ? "EPHEMERAL" : "UNCERTAIN";
  }
  if (FACT.test(trimmed)) return "DURABLE_FACT";
  if (PREFERENCE.test(trimmed)) return "DURABLE_PREFERENCE";
  return trimmed.length < 20 ? "EPHEMERAL" : "UNCERTAIN";
}

export function isDurableMemory(kind: MemoryClass): boolean {
  return kind === "DURABLE_PREFERENCE" || kind === "DURABLE_FACT";
}
