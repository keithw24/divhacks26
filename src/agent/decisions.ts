import type { RoutePreferences } from "../transport/preferences.js";

const TOPICS = [
  "times square",
  "midtown",
  "columbia",
  "peanuts",
  "peanut",
  "vegetarian",
  "italian",
  "subway",
  "buses",
  "sushi",
  "uber",
  "lyft",
  "walking",
  "walk",
  "meat",
  "vegan",
  "bus",
];

export interface ReconciledMemory {
  memories: string[];
  overrides: string[];
}

export interface DecisionConstraints {
  lines: string[];
  route: RoutePreferences;
}

/** Drop stale memories that the current conversation contradicts. Newer statement wins. */
export function reconcileMemories(memories: string[], statements: string[]): ReconciledMemory {
  let kept = memories.slice();
  const overrideByTopic = new Map<string, string>();

  for (const statement of statements) {
    const statementTopics = focusTopics(statement);
    const statementPolarity = polarity(statement);
    if (statementTopics.length === 0 || statementPolarity === "unknown") continue;
    let changed = false;
    kept = kept.filter((memory) => {
      const shared = statementTopics.some((topic) => focusTopics(memory).includes(topic));
      const memoryPolarity = polarity(memory);
      const conflict = shared && memoryPolarity !== "unknown" && memoryPolarity !== statementPolarity;
      if (conflict) changed = true;
      return !conflict;
    });
    if (changed) {
      for (const topic of statementTopics) overrideByTopic.set(topic, statement);
    }
  }

  const collapsed: string[] = [];
  for (const memory of kept) {
    const topics = focusTopics(memory);
    const memoryPolarity = polarity(memory);
    const withoutConflict = collapsed.filter((existing) => {
      const shared = topics.some((topic) => focusTopics(existing).includes(topic));
      return !(
        shared &&
        memoryPolarity !== "unknown" &&
        polarity(existing) !== "unknown" &&
        polarity(existing) !== memoryPolarity
      );
    });
    collapsed.length = 0;
    collapsed.push(...withoutConflict, memory);
  }

  return { memories: collapsed, overrides: [...new Set(overrideByTopic.values())] };
}

/**
 * Turn memory into route and recommendation constraints.
 * An explicit current mode request wins over an older preference.
 */
export function decisionConstraints(memories: string[], currentRequest: string): DecisionConstraints {
  const explicit = explicitModeRequest(currentRequest);
  const avoidAreas: string[] = [];
  let maxWalkMinutes: number | undefined;
  let preferTransit = false;
  let avoidBus = false;
  let defaultOrigin: string | undefined;
  const lines: string[] = [];

  for (const memory of memories) {
    const home = memory.match(/\b(?:i live|i(?:'|’)?m usually|i am usually)\s+(?:at|in|near)\s+([^.,!?]+)/i);
    if (home?.[1]) {
      const place = home[1].replace(/\b(?:but|and|though)\b.*$/i, "").trim();
      if (place.length >= 2) defaultOrigin = place;
    }
    const area = memory.match(/\bwalk(?:ing)?\s+through\s+([^.,!?]+)/i);
    if (area?.[1]) avoidAreas.push(area[1].trim());
    if (/\b(subway|transit)\b/i.test(memory) && /\b(prefer|always|usually)\b/i.test(memory)) preferTransit = true;
    if (/\bbuses?\b/i.test(memory) && /\b(hate|avoid|don't like|do not like|instead of|prefer the subway|prefer subway)\b/i.test(memory)) {
      avoidBus = true;
    }
    const minutes = memory.match(/\b(\d+)\s*minutes?\b/i);
    if (minutes?.[1] && /\bwalk/i.test(memory) && /\b(more than|over|longer than|less than|under|max)\b/i.test(memory)) {
      maxWalkMinutes = Number(minutes[1]);
    }
    if (/\bvegetarian\b|\bdon't eat meat\b|\bdo not eat meat\b|\bvegan\b/i.test(memory) && !/\b(steak|burger|meat)\b/i.test(currentRequest)) {
      lines.push("Do not recommend a meat-only place. Prefer something this person can eat.");
    }
    if (/\ballergic to peanuts\b|\bpeanut allergy\b/i.test(memory)) {
      lines.push("Avoid peanut-heavy suggestions.");
    }
  }

  if (/\b(uber|lyft|taxi|cab)\b/i.test(currentRequest) || /\b(drive|driving)\b/i.test(currentRequest)) {
    preferTransit = false;
    lines.push("The current message asks for a car. Do not replace that with subway or walking.");
  }

  const route: RoutePreferences = {
    avoidAreas: explicitWalk(currentRequest) ? [] : avoidAreas,
    maxWalkMinutes: explicitWalk(currentRequest) ? undefined : maxWalkMinutes,
    preferTransit: explicit ? false : preferTransit,
    avoidBus: explicit ? false : avoidBus,
    explicitRequest: explicit,
    ...(defaultOrigin ? { defaultOrigin } : {}),
    notes: notesFor(avoidAreas, maxWalkMinutes, preferTransit, explicit),
  };

  if (!explicit && avoidAreas.length > 0) {
    lines.push("If a walking route goes through an avoided area, choose another reasonable route.");
  }
  if (!explicit && typeof maxWalkMinutes === "number") {
    lines.push(`Prefer an option with about ${maxWalkMinutes} minutes of walking or less when one exists.`);
  }
  if (!explicit && preferTransit) lines.push("Prefer subway or transit over a long walk when both exist.");

  return { lines: unique(lines), route };
}

/** Group dining / planning requests can use other people's relevant preferences. */
export function requestConcernsOthers(text: string): boolean {
  return (
    /\b(all of us|everyone|everybody|each of us|the (whole )?group|\d+ of us|both of us|we all)\b/i.test(text) ||
    (/\b(eat|dinner|lunch|restaurant|food)\b/i.test(text) && /\b(we|us|our)\b/i.test(text)) ||
    /\bfind something everyone\b/i.test(text)
  );
}

function explicitModeRequest(text: string): boolean {
  return /\b(uber|lyft|taxi|cab|drive|driving)\b/i.test(text) || explicitWalk(text) || /\b(take|get)\s+(the\s+)?(subway|bus|train)\b/i.test(text);
}

function explicitWalk(text: string): boolean {
  return /\b(walk instead|can i walk|should i walk|let's walk|lets walk|we'll walk|we will walk)\b/i.test(text);
}

function notesFor(
  avoidAreas: string[],
  maxWalkMinutes: number | undefined,
  preferTransit: boolean,
  explicit: boolean,
): string[] {
  if (explicit) return ["The current request names a mode. Follow that mode even if an older preference differs."];
  const notes: string[] = [];
  for (const area of avoidAreas) notes.push(`Avoid walking through ${area} when another route exists.`);
  if (typeof maxWalkMinutes === "number") notes.push(`Prefer routes with under ${maxWalkMinutes} minutes of walking.`);
  if (preferTransit) notes.push("This person usually prefers the subway when it is practical.");
  return notes;
}

function focusTopics(text: string): string[] {
  const withoutContrast = text.replace(/\b(?:over|instead of|rather than)\s+[^.,!?]+/gi, " ");
  const lower = withoutContrast.toLowerCase();
  return TOPICS.filter((topic) => lower.includes(topic));
}

function polarity(text: string): "pos" | "neg" | "unknown" {
  const lower = text.toLowerCase();
  if (/\b(hate|hates|dislike|avoid|never|can't stand|cannot stand|don't like|do not like|don't eat|do not eat|not a fan)\b/.test(lower)) {
    return "neg";
  }
  if (/\b(like|likes|liking|love|loves|prefer|prefers|enjoy|always|usually)\b/.test(lower)) return "pos";
  return "unknown";
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}
