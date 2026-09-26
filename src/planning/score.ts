import type { Budget, Recommendation } from "../domain/contracts.js";
import type { MemberConstraints, PersonScore, PlanScore } from "./types.js";

const BUDGET_RANK: Record<Budget, number> = { free: 0, low: 1, medium: 2, high: 3 };

const WALK_METERS_PER_MIN = 80;
const NASH_FLOOR = 0.02;

export function walkMinutes(distanceMeters: number): number {
  return Math.max(1, Math.round(distanceMeters / WALK_METERS_PER_MIN));
}

export function planBudgetRank(item: Recommendation): number | undefined {
  const blob = `${item.name} ${item.description ?? ""} ${item.categories.join(" ")} ${item.priceLevel ?? ""}`.toLowerCase();
  if (item.priceLevel?.includes("FREE") || /\bfree\b/.test(blob)) return 0;
  if (item.priceLevel?.includes("INEXPENSIVE") || /\binexpensive\b/.test(blob)) return 1;
  if (item.priceLevel?.includes("MODERATE")) return 2;
  if (item.priceLevel?.includes("VERY_EXPENSIVE")) return 3;
  if (item.priceLevel?.includes("EXPENSIVE")) return 3;
  if (item.kind === "event") return 0;
  return undefined;
}

function blob(item: Recommendation): string {
  return `${item.name} ${item.description ?? ""} ${item.categories.join(" ")} ${item.location.label}`.toLowerCase();
}

function accessibilityState(item: Recommendation): "yes" | "no" | "unknown" {
  const t = blob(item);
  if (/\b(stairs only|walk-up only|not accessible|no elevator|inaccessible)\b/.test(t)) return "no";
  if (/\b(wheelchair|ada|accessible|step[-\s]?free)\b/.test(t)) return "yes";
  return "unknown";
}

function dietaryViolation(member: MemberConstraints, item: Recommendation): string | undefined {
  const t = blob(item);
  if (member.dietary?.includes("vegan") && /\b(steak|bbq|barbecue|burger|ribs|butcher|oyster bar)\b/.test(t) && !/\bvegan\b/.test(t)) {
    return `${member.name} is vegan`;
  }
  if (member.dietary?.includes("vegetarian") && /\b(steakhouse|butcher|oyster bar)\b/.test(t) && !/\b(vegetarian|vegan)\b/.test(t)) {
    return `${member.name} is vegetarian`;
  }
  if (member.dietary?.includes("peanut-free") && /\bpeanut\b/.test(t)) {
    return `${member.name} can't eat peanuts`;
  }
  return undefined;
}

export function scorePerson(member: MemberConstraints, item: Recommendation): PersonScore {
  const hardViolations: string[] = [];
  const minutes = walkMinutes(item.distanceMeters);
  const t = blob(item);

  if (member.maxTravelMinutes != null && minutes > member.maxTravelMinutes) {
    hardViolations.push(`${member.name}'s ${member.maxTravelMinutes}-min time limit`);
  }

  const cost = planBudgetRank(item);
  if (member.maxBudget && cost != null && cost > BUDGET_RANK[member.maxBudget]) {
    hardViolations.push(`${member.name}'s ${member.maxBudget} budget`);
  }
  if (member.maxBudget === "free" && item.kind === "food" && cost === undefined) {
    hardViolations.push(`${member.name}'s free-only budget`);
  }

  if (member.needsAccessible && accessibilityState(item) === "no") {
    hardViolations.push(`${member.name}'s accessibility need`);
  }

  const diet = dietaryViolation(member, item);
  if (diet) hardViolations.push(diet);

  for (const avoid of member.avoid ?? []) {
    if (avoid.length >= 3 && t.includes(avoid.toLowerCase())) {
      hardViolations.push(`${member.name} asked to avoid ${avoid}`);
    }
  }

  if (hardViolations.length) {
    return { memberId: member.id, name: member.name, score: 0, hardViolations };
  }

  let score = 0.55;
  if (member.maxTravelMinutes != null) {
    score += 0.25 * (1 - minutes / member.maxTravelMinutes);
  } else {
    score += 0.2 * Math.max(0, 1 - minutes / 40);
  }

  if (member.maxBudget && cost != null) {
    const slack = BUDGET_RANK[member.maxBudget] - cost;
    score += Math.min(0.12, slack * 0.06);
  }

  if (member.needsAccessible) {
    score += accessibilityState(item) === "yes" ? 0.12 : -0.08;
  }

  for (const cuisine of member.cuisine ?? []) {
    if (t.includes(cuisine.toLowerCase())) score += 0.1;
  }

  if (item.rating) score += Math.min(0.08, (item.rating - 3.5) * 0.05);
  if (item.openNow) score += 0.03;
  if (item.kind === "event" && /\bfree\b/.test(t)) score += 0.04;

  return {
    memberId: member.id,
    name: member.name,
    score: Math.min(1, Math.max(NASH_FLOOR, score)),
    hardViolations: [],
  };
}

function nashWelfare(scores: number[]): number {
  if (!scores.length) return 0;
  const logs = scores.map((value) => Math.log(Math.max(NASH_FLOOR, value)));
  return Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length);
}

export function scorePlan(item: Recommendation, members: MemberConstraints[]): PlanScore {
  const byPerson = members.map((member) => scorePerson(member, item));
  const feasible = byPerson.every((row) => row.hardViolations.length === 0);
  const values = byPerson.map((row) => row.score);
  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const leastMisery = values.length ? Math.min(...values) : 0;
  return {
    item,
    byPerson,
    feasible,
    average,
    leastMisery,
    nash: feasible ? nashWelfare(values) : 0,
  };
}
