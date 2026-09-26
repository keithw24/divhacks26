import type { Budget, Recommendation } from "../domain/contracts.js";
import { scorePlan, walkMinutes, planBudgetRank } from "./score.js";
import type { MemberConstraints, PlanScore, RankedPlan } from "./types.js";

const BUDGET_RANK: Record<Budget, number> = { free: 0, low: 1, medium: 2, high: 3 };

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function planLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function letterFor(itemId: string, ranked: RankedPlan[]): string | undefined {
  const index = ranked.findIndex((plan) => plan.item.id === itemId);
  return index >= 0 ? planLetter(index) : undefined;
}

function hasHard(member: MemberConstraints): boolean {
  return Boolean(
    member.maxBudget ||
      member.needsAccessible ||
      member.maxTravelMinutes != null ||
      member.dietary?.length ||
      member.avoid?.length,
  );
}

function clearHard(member: MemberConstraints): MemberConstraints {
  return {
    ...member,
    maxBudget: undefined,
    needsAccessible: false,
    maxTravelMinutes: undefined,
    dietary: [],
    avoid: [],
  };
}

function bumpBudgetTo35(members: MemberConstraints[]): MemberConstraints[] {
  return members.map((member) => ({
    ...member,
    maxBudget: !member.maxBudget || BUDGET_RANK[member.maxBudget] < 2 ? "medium" : member.maxBudget,
  }));
}

function startsWithin(item: Recommendation, now: Date, minutes: number): boolean {
  if (!item.startsAt) return false;
  const start = new Date(item.startsAt).getTime();
  const t = now.getTime();
  return start >= t && start <= t + minutes * 60_000;
}

function leastMiseryWinner(items: Recommendation[], members: MemberConstraints[]): PlanScore | undefined {
  const feasible = items.map((item) => scorePlan(item, members)).filter((plan) => plan.feasible);
  if (!feasible.length) return undefined;
  return [...feasible].sort((a, b) => b.leastMisery - a.leastMisery || b.nash - a.nash || b.average - a.average)[0];
}

export function selectionBecause(
  item: Recommendation,
  members: MemberConstraints[],
  now: Date,
): string {
  const bits: string[] = [];
  const cost = planBudgetRank(item);
  if (cost === 0) bits.push("it is free");
  else if (cost === 1) bits.push("it is inexpensive");
  if (startsWithin(item, now, 45)) bits.push("starts within 45 minutes");
  const minutes = walkMinutes(item.distanceMeters);
  const caps = members.map((member) => member.maxTravelMinutes).filter((value): value is number => value != null);
  const ceiling = caps.length ? Math.max(minutes, ...caps) : Math.max(minutes, 25);
  bits.push(`keeps everyone under ${ceiling} minutes of travel`);
  return `This was selected because ${joinAnd(bits)}.`;
}

export function counterfactualLines(input: {
  items: Recommendation[];
  members: MemberConstraints[];
  ranked: RankedPlan[];
  now: Date;
}): string[] {
  const selected = input.ranked[0];
  if (!selected) return [];
  const lines: string[] = [];

  const bumped = bumpBudgetTo35(input.members);
  const closerAt35 = input.items.filter((item) => {
    if (item.kind !== "food") return false;
    if (item.distanceMeters >= selected.item.distanceMeters) return false;
    const cost = planBudgetRank(item);
    if (cost == null || cost > 2) return false;
    return !scorePlan(item, input.members).feasible && scorePlan(item, bumped).feasible;
  });
  if (closerAt35.length) {
    const n = closerAt35.length;
    lines.push(
      `If the budget increases to $35, ${n} closer restaurant${n === 1 ? "" : "s"} become${n === 1 ? "s" : ""} available.`,
    );
  }

  const walk = walkMinutes(selected.item.distanceMeters);
  const laterWindow = input.items.filter(
    (item) => !startsWithin(item, input.now, 45) && startsWithin(item, new Date(input.now.getTime() + 30 * 60_000), 45),
  );
  if (walk >= 18 || laterWindow.length) {
    lines.push("If the group leaves 30 minutes later, transit becomes faster than walking.");
  }

  const tenMin = input.members.map((member) => ({ ...member, maxTravelMinutes: 10 }));
  const still = input.ranked.filter((plan) => scorePlan(plan.item, tenMin).feasible);
  if (still.length === 1 && still[0]) {
    const letter = letterFor(still[0].item.id, input.ranked) ?? "B";
    lines.push(`If walking is limited to 10 minutes, Plan ${letter} is the only feasible option.`);
  }

  for (const member of input.members) {
    if (!hasHard(member)) continue;
    const without = input.members.map((row) => (row.id === member.id ? clearHard(row) : row));
    const winner = leastMiseryWinner(input.items, without);
    if (!winner || winner.item.id === selected.item.id) continue;
    const letter = letterFor(winner.item.id, input.ranked);
    const target = letter ? `Plan ${letter}` : winner.item.name;
    const lead = member.discloseConstraints
      ? `Without ${member.name}'s private constraint`
      : "Without a private group constraint";
    lines.push(`${lead}, ${target} would rank first.`);
    break;
  }

  return lines.slice(0, 3);
}
