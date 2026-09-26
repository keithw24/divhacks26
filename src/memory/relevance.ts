const STOP = new Set([
  "a", "an", "the", "and", "or", "to", "from", "of", "in", "on", "for", "with", "my", "me", "we", "our",
  "you", "your", "it", "is", "am", "are", "was", "be", "do", "does", "did", "not", "no", "yes", "just",
  "really", "very", "always", "usually", "never", "like", "likes", "love", "loves", "hate", "hates",
  "prefer", "prefers", "preferred", "dont", "through", "instead", "that", "this", "what", "how", "should",
  "would", "could", "where", "when", "who", "get", "got", "take", "takes", "form", "want", "wants",
  "something", "about", "into", "over", "than", "then", "them", "they", "have", "has", "had", "been",
  "being", "but", "if", "so", "too", "also", "can", "will", "going", "gonna", "please", "help", "figure",
  "out", "there", "here", "all", "four", "us",
]);

const DOMAINS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "transport",
    pattern: /\b(walk(?:ing)?|subway|bus(?:es)?|uber|lyft|taxi|cab|drive|driving|transit|train|bike|biking|route|routes|transport(?:ation)?|directions|commute)\b/i,
  },
  {
    name: "food",
    pattern: /\b(eat|eats|eating|food|restaurant|dinner|lunch|breakfast|vegetarian|vegan|meat|sushi|italian|pizza|allergic|allergy|peanuts?|cuisine|hungry)\b/i,
  },
  {
    name: "place",
    pattern: /\b(times square|midtown|columbia|brooklyn|manhattan|queens|soho|harlem|neighborhood)\b/i,
  },
  {
    name: "schedule",
    pattern: /\b(schedule|class|work|morning|evening|budget)\b/i,
  },
];

const ROUTE_ASK =
  /\b(how (?:do|should|can) (?:i|we) get|get (?:me |us )?(?:from|to)|from .+ to |directions|commute|transport)\b/i;

export function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same preference said again should not create another memory. */
export function isDuplicateMemory(existing: string, incoming: string): boolean {
  const a = normalizeMemoryText(existing);
  const b = normalizeMemoryText(incoming);
  if (!a || !b) return false;
  if (a === b) return true;
  if ((a.length >= 12 && b.includes(a)) || (b.length >= 12 && a.includes(b))) return true;
  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 || right.length === 0) return false;
  let shared = 0;
  const rightSet = new Set(right);
  for (const token of left) if (rightSet.has(token)) shared += 1;
  const union = new Set([...left, ...right]).size;
  return union > 0 && shared / union >= 0.75;
}

/**
 * Keep memories that share words or a topic with the request.
 * A transportation question can surface a walking dislike even when the
 * place name is not in the question. A food preference does not.
 */
export function selectRelevant(memories: string[], query: string, limit = 5): string[] {
  const cap = Math.max(1, limit);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const memory of memories) {
    const text = memory.trim();
    if (!text) continue;
    const key = normalizeMemoryText(text);
    if (!key || seen.has(key)) continue;
    if (!isRelevant(text, query)) continue;
    seen.add(key);
    picked.push(text);
    if (picked.length >= cap) break;
  }
  return picked;
}

function isRelevant(memory: string, query: string): boolean {
  if (tokenOverlap(memory, query) > 0) return true;
  const memoryDomains = domainsOf(memory);
  const queryDomains = domainsOf(query);
  if (ROUTE_ASK.test(query)) queryDomains.add("transport");
  if (memoryDomains.size === 0 || queryDomains.size === 0) return false;
  const foodOnly = memoryDomains.size === 1 && memoryDomains.has("food");
  if (foodOnly && queryDomains.has("transport") && !queryDomains.has("food")) return false;
  for (const domain of memoryDomains) {
    if (queryDomains.has(domain)) return true;
  }
  return false;
}

function domainsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const domain of DOMAINS) {
    if (domain.pattern.test(text)) found.add(domain.name);
  }
  return found;
}

function tokenOverlap(memory: string, query: string): number {
  const queryTokens = new Set(tokens(normalizeMemoryText(query)));
  let shared = 0;
  for (const token of tokens(normalizeMemoryText(memory))) {
    if (queryTokens.has(token)) shared += 1;
  }
  return shared;
}

function tokens(normalized: string): string[] {
  return normalized.split(" ").filter((token) => token.length >= 4 && !STOP.has(token));
}
