import type { Budget } from "../domain/contracts.js";
import type { MemberConstraints } from "./types.js";

const BUDGET_RANK: Record<Budget, number> = { free: 0, low: 1, medium: 2, high: 3 };

export function tighterBudget(a?: Budget, b?: Budget): Budget | undefined {
  if (!a) return b;
  if (!b) return a;
  return BUDGET_RANK[a] <= BUDGET_RANK[b] ? a : b;
}

function dollarsToBudget(n: number): Budget {
  if (n <= 0) return "free";
  if (n <= 20) return "low";
  if (n <= 45) return "medium";
  return "high";
}

export function extractConstraints(text: string): Partial<MemberConstraints> {
  const t = text.toLowerCase();
  const out: Partial<MemberConstraints> = {};

  if (/\b(wheelchair|ada|step[-\s]?free|need(?:s)? accessible|mobility|can'?t (?:do )?stairs|no stairs)\b/i.test(t)) {
    out.needsAccessible = true;
  }

  const dollar = t.match(/(?:under|max(?:imum)?|cap(?:ped)?(?: at)?|no more than|can'?t (?:spend|pay) more than|(?:can\s+)?only\s+(?:spend|pay))\s*\$?\s*(\d+)/i)
    ?? t.match(/\$\s*(\d+)\s*(?:max|cap|limit|tops?)/i);
  if (dollar) out.maxBudget = dollarsToBudget(Number(dollar[1]));
  else if (/\b(free only|only free)\b/.test(t)) out.maxBudget = "free";
  else if (/\b(broke|cheap|inexpensive|budget)\b/.test(t)) out.maxBudget = "low";

  const minutes = t.match(
    /(?:(?:no more than|under|max(?:imum)?|within|can'?t (?:walk|travel|go) (?:more than|over))\s*)?(\d+)\s*-?\s*min(?:ute)?s?(?:\s*(?:walk|travel|away))?/i,
  );
  if (minutes && /(min|walk|travel|away|far)/i.test(t)) {
    out.maxTravelMinutes = Number(minutes[1]);
  }

  const cuisine: string[] = [];
  for (const name of ["ramen", "pizza", "italian", "sushi", "mexican", "thai", "indian", "korean", "chinese", "halal"]) {
    if (new RegExp(`\\b${name}\\b`, "i").test(t) && /\b(want|like|love|prefer|craving|down for)\b/.test(t)) {
      cuisine.push(name);
    }
  }
  if (cuisine.length) out.cuisine = cuisine;

  const avoid: string[] = [];
  const avoidMatch = t.match(/\b(?:avoid|hate|allergic to|can'?t (?:do|eat|stand))\s+([a-z][a-z\s]{1,24})/i);
  if (avoidMatch?.[1]) avoid.push(avoidMatch[1].trim());
  if (avoid.length) out.avoid = avoid;

  const dietary: MemberConstraints["dietary"] = [];
  if (/\bvegan\b/.test(t)) dietary.push("vegan");
  if (/\bvegetarian\b/.test(t) && !/\bvegan\b/.test(t)) dietary.push("vegetarian");
  if (/\bgluten[-\s]?free\b/.test(t)) dietary.push("gluten-free");
  if (/\bpeanut\b/.test(t) && /\b(allerg|can'?t eat)\b/.test(t)) dietary.push("peanut-free");
  if (dietary.length) out.dietary = dietary;

  return out;
}

function mergeMember(base: MemberConstraints, patch: Partial<MemberConstraints>): MemberConstraints {
  return {
    ...base,
    maxBudget: tighterBudget(base.maxBudget, patch.maxBudget),
    needsAccessible: base.needsAccessible || Boolean(patch.needsAccessible),
    maxTravelMinutes:
      patch.maxTravelMinutes != null
        ? Math.min(base.maxTravelMinutes ?? patch.maxTravelMinutes, patch.maxTravelMinutes)
        : base.maxTravelMinutes,
    cuisine: [...new Set([...(base.cuisine ?? []), ...(patch.cuisine ?? [])])],
    avoid: [...new Set([...(base.avoid ?? []), ...(patch.avoid ?? [])])],
    dietary: [...new Set([...(base.dietary ?? []), ...(patch.dietary ?? [])])],
    discloseConstraints: base.discloseConstraints || Boolean(patch.discloseConstraints),
  };
}

function patchHasHard(patch: Partial<MemberConstraints>): boolean {
  return Boolean(
    patch.maxBudget ||
      patch.needsAccessible ||
      patch.maxTravelMinutes != null ||
      patch.dietary?.length ||
      patch.avoid?.length,
  );
}

const NAME_CLAIM =
  /\b([A-Z][a-z]{1,12})\s+(?:is|needs?|can'?t|cannot|wants?|prefers?)\b/;

export function membersFromTranscript(
  transcript: Array<{ who: string; text: string }>,
  defaults?: { budget?: Budget; maxTravelMinutes?: number },
  privateLines?: Array<{ who: string; text: string }>,
): MemberConstraints[] {
  const byId = new Map<string, MemberConstraints>();

  const ensure = (id: string, name: string): MemberConstraints => {
    const existing = byId.get(id);
    if (existing) return existing;
    const created: MemberConstraints = {
      id,
      name,
      needsAccessible: false,
      discloseConstraints: false,
      maxBudget: defaults?.budget,
      maxTravelMinutes: defaults?.maxTravelMinutes,
    };
    byId.set(id, created);
    return created;
  };

  if (!transcript.length) {
    return [
      mergeMember(ensure("you", "you"), {
        maxBudget: defaults?.budget,
        maxTravelMinutes: defaults?.maxTravelMinutes,
      }),
    ];
  }

  for (const line of transcript) {
    const id = line.who.trim() || "you";
    const name = id;
    const claimed = line.text.match(NAME_CLAIM);
    const extracted = extractConstraints(line.text);
    const patch = { ...extracted, discloseConstraints: patchHasHard(extracted) };
    if (claimed?.[1] && claimed[1].toLowerCase() !== id.toLowerCase()) {
      const otherName = claimed[1];
      const otherId = otherName;
      byId.set(otherId, mergeMember(ensure(otherId, otherName), patch));
      ensure(id, name);
    } else {
      byId.set(id, mergeMember(ensure(id, name), patch));
    }
  }

  for (const line of privateLines ?? []) {
    const id = line.who.trim() || "you";
    const patch = extractConstraints(line.text);
    if (!patchHasHard(patch) && !patch.cuisine?.length) continue;
    byId.set(id, mergeMember(ensure(id, id), { ...patch, discloseConstraints: false }));
  }

  return [...byId.values()].map((member) => ({
    ...member,
    maxBudget: member.maxBudget ?? defaults?.budget,
    maxTravelMinutes: member.maxTravelMinutes ?? defaults?.maxTravelMinutes,
  }));
}

export function asksForMorePlans(question: string): boolean {
  return /\b((show|give|list)\s+more|more\s+options|other\s+options|none of (these|those)|don'?t like (these|those|any)|something else)\b/i.test(
    question,
  );
}
