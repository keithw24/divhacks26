import { scorePlan, walkMinutes } from "./score.js";
import type { MemberConstraints, PlanScore, RankedPlan, Strategy } from "./types.js";
import type { Recommendation } from "../domain/contracts.js";
import type { GroupPlanResult } from "./types.js";

function dominates(a: PlanScore, b: PlanScore): boolean {
  const ge = a.average >= b.average && a.leastMisery >= b.leastMisery && a.nash >= b.nash;
  const gt = a.average > b.average || a.leastMisery > b.leastMisery || a.nash > b.nash;
  return ge && gt;
}

export function paretoFrontier(feasible: PlanScore[]): Set<string> {
  const ids = new Set<string>();
  for (const plan of feasible) {
    const worse = feasible.some((other) => other.item.id !== plan.item.id && dominates(other, plan));
    if (!worse) ids.add(plan.item.id);
  }
  return ids;
}

function pickBest(plans: PlanScore[], strategy: Strategy): PlanScore | undefined {
  if (!plans.length) return undefined;
  const key = strategy === "average" ? "average" : strategy === "leastMisery" ? "leastMisery" : "nash";
  return [...plans].sort((a, b) => b[key] - a[key] || b.nash - a.nash || b.average - a.average)[0];
}

function why(plan: PlanScore, strategy: Strategy, betterThan?: PlanScore): string {
  const lowest = [...plan.byPerson].sort((a, b) => a.score - b.score)[0];
  const minutes = walkMinutes(plan.item.distanceMeters);
  const names = plan.byPerson.map((row) => row.name).join(", ");
  const lens =
    strategy === "leastMisery"
      ? "chosen by least misery (best worst-off score, not the group average)"
      : strategy === "nash"
        ? "chosen by Nash welfare so raising the lowest scores still keeps group utility"
        : "chosen by average satisfaction among leftover feasible plans";
  const vs = betterThan && betterThan.item.id !== plan.item.id
    ? betterThan.feasible
      ? `better than ${betterThan.item.name} on the worst-off person`
      : `better than ${betterThan.item.name}, which breaks ${betterThan.byPerson.find((row) => row.hardViolations[0])?.hardViolations[0] ?? "a hard constraint"}`
    : "no one is blocked on budget, time, or access";
  return `Fits ${names} (${minutes} min walk; ${lowest?.name ?? "the group"} is the lowest score); ${lens}; ${vs}.`;
}

/**
 * Feasible plans only. Top 3 mix least-misery, Nash, and average so one loved / one excluded
 * average winner cannot be the only answer.
 */
export function selectGroupPlans(
  recommendations: Recommendation[],
  members: MemberConstraints[],
  offset = 0,
): GroupPlanResult {
  const scored = recommendations.map((item) => scorePlan(item, members));
  const infeasible = scored.filter((plan) => !plan.feasible);
  const feasible = scored.filter((plan) => plan.feasible);
  const pareto = paretoFrontier(feasible);

  const pool = feasible.length ? feasible : [];
  const used = new Set<string>();
  const ordered: RankedPlan[] = [];

  const take = (strategy: Strategy, from: PlanScore[]) => {
    const next = pickBest(from.filter((plan) => !used.has(plan.item.id)), strategy);
    if (!next) return;
    used.add(next.item.id);
    const rival = infeasible[0] ?? pickBest(from.filter((plan) => plan.item.id !== next.item.id), "average");
    ordered.push({
      item: next.item,
      strategy,
      onPareto: pareto.has(next.item.id),
      score: next,
      reason: why(next, strategy, rival),
    });
  };

  const frontierFirst = pool.filter((plan) => pareto.has(plan.item.id));
  const rest = pool.filter((plan) => !pareto.has(plan.item.id));
  take("leastMisery", frontierFirst.length ? frontierFirst : pool);
  take("nash", frontierFirst.length ? frontierFirst : pool);
  take("average", frontierFirst.length ? [...frontierFirst, ...rest] : pool);

  while (ordered.length < 3) {
    const leftoverPool = pool.filter((plan) => !used.has(plan.item.id));
    if (!leftoverPool.length) break;
    take("average", leftoverPool);
  }

  const all = [
    ...ordered,
    ...pool
      .filter((plan) => !used.has(plan.item.id))
      .sort((a, b) => b.leastMisery - a.leastMisery || b.nash - a.nash || b.average - a.average)
      .map((plan) => ({
        item: plan.item,
        strategy: "average" as const,
        onPareto: pareto.has(plan.item.id),
        score: plan,
        reason: why(plan, "average"),
      })),
  ];

  return {
    members,
    ranked: all.slice(offset, offset + 3),
    leftover: all.slice(offset + 3),
    infeasible,
  };
}
