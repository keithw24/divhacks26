import type {
  Budget,
  Location,
  SkillName,
  TravelMode,
  UserIntent,
} from "../domain/contracts.js";
import { generateJson } from "./gemini.js";

interface IntentJson {
  needs?: string[];
  locationQuery?: string;
  destinationQuery?: string;
  when?: string;
  budget?: string;
  categories?: string[];
  cuisine?: string[];
  travelMode?: string;
  maxTravelMinutes?: number;
  needsClarification?: boolean;
  clarificationQuestion?: string;
}

const SKILLS = new Set<SkillName>(["safety", "food", "events", "route"]);
const MODES = new Set<TravelMode>(["WALK", "TRANSIT", "DRIVE", "BICYCLE"]);
const BUDGETS = new Set<Budget>(["free", "low", "medium", "high"]);

const schema = {
  type: "object",
  properties: {
    needs: { type: "array", items: { type: "string", enum: [...SKILLS] } },
    locationQuery: { type: "string" },
    destinationQuery: { type: "string" },
    when: { type: "string" },
    budget: { type: "string", enum: [...BUDGETS] },
    categories: { type: "array", items: { type: "string" } },
    cuisine: { type: "array", items: { type: "string" } },
    travelMode: { type: "string", enum: [...MODES] },
    maxTravelMinutes: { type: "number" },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: "string" },
  },
  required: ["needs", "when", "categories", "travelMode", "needsClarification"],
};

export function heuristicIntent(question: string, origin?: Location): UserIntent {
  const text = question.toLowerCase();
  const needs = new Set<SkillName>();
  const broad = /plan|night out|what should (?:i|we) do|what now|date night/.test(text);
  const focusedRoute = /how (?:do|can) (?:i|we) get|directions? to|route to|take me to/.test(text);
  if (focusedRoute) needs.add("route");
  if (/safe|safety|crime|danger|sketch/.test(text)) needs.add("safety");
  if (/food|eat|dinner|lunch|breakfast|restaurant|cuisine|hungry/.test(text)) needs.add("food");
  if (!focusedRoute && /event|activity|activities|fun|concert|movie|festival|show|park/.test(text)) needs.add("events");
  if (/route|direction|take me|travel/.test(text)) needs.add("route");
  if (broad || needs.size === 0) {
    needs.add("food");
    needs.add("events");
    needs.add("safety");
    needs.add("route");
  }
  const budget: Budget | undefined = /\bfree\b/.test(text)
    ? "free"
    : /cheap|budget|inexpensive/.test(text)
      ? "low"
      : /fancy|expensive|splurge/.test(text)
        ? "high"
        : undefined;
  const travelMode: TravelMode = /subway|train|bus|transit/.test(text)
    ? "TRANSIT"
    : /drive|car|uber|taxi/.test(text)
      ? "DRIVE"
      : /bike|cycling/.test(text)
        ? "BICYCLE"
        : "WALK";
  const destinationMatch = question.match(/(?:to|get to|directions? to)\s+(.+)$/i);
  return {
    needs: [...needs],
    ...(origin && { origin }),
    ...(!origin && { locationQuery: question }),
    ...(destinationMatch?.[1] && { destinationQuery: destinationMatch[1].trim() }),
    when: /tonight/.test(text) ? "tonight" : /tomorrow/.test(text) ? "tomorrow" : "now",
    ...(budget && { budget }),
    categories: [],
    travelMode,
    needsClarification: !origin && question.trim().length < 3,
    ...(!origin && question.trim().length < 3 && { clarificationQuestion: "Where in NYC are you?" }),
  };
}

function validate(json: IntentJson, fallback: UserIntent, origin?: Location): UserIntent {
  const needs = (json.needs ?? []).filter((value): value is SkillName => SKILLS.has(value as SkillName));
  const travelMode = MODES.has(json.travelMode as TravelMode)
    ? (json.travelMode as TravelMode)
    : fallback.travelMode;
  const budget = BUDGETS.has(json.budget as Budget) ? (json.budget as Budget) : fallback.budget;
  return {
    needs: needs.length ? [...new Set(needs)] : fallback.needs,
    ...(origin && { origin }),
    ...(json.locationQuery?.trim() && { locationQuery: json.locationQuery.trim() }),
    ...(json.destinationQuery?.trim() && { destinationQuery: json.destinationQuery.trim() }),
    when: json.when?.trim() || fallback.when,
    ...(budget && { budget }),
    categories: (json.categories ?? []).map(String).slice(0, 5),
    ...((json.cuisine?.length ?? 0) > 0 && { cuisine: json.cuisine!.map(String).slice(0, 5) }),
    travelMode,
    ...(Number.isFinite(json.maxTravelMinutes) && { maxTravelMinutes: Math.min(90, Math.max(5, Number(json.maxTravelMinutes))) }),
    needsClarification: Boolean(json.needsClarification),
    ...(json.clarificationQuestion?.trim() && { clarificationQuestion: json.clarificationQuestion.trim() }),
  };
}

export async function parseIntent(question: string, origin?: Location): Promise<UserIntent> {
  const fallback = heuristicIntent(question, origin);
  const prompt = `Classify this NYC iMessage request for an agent with four skills: safety, food, events, route.
Return JSON only. Select only skills needed to answer the request. A broad request to plan a night may use all skills.
Extract a named origin/destination as text but never invent coordinates. If no shared origin and no place is stated, ask one short location question.
Shared origin: ${origin ? JSON.stringify(origin) : "none"}
Message: ${question}`;
  try {
    return validate(await generateJson<IntentJson>(prompt, schema), fallback, origin);
  } catch (error) {
    console.warn("Gemini intent parsing unavailable; using deterministic routing:", error);
    return fallback;
  }
}
