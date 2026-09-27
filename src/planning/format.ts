import { fromRecommendation } from "../calendar/from.js";
import { calendarLine } from "../calendar/links.js";
import type { GroupPlanResult } from "./types.js";

const MORE_LINE = "If none of these work, say “show more” and I’ll list the next options that still fit everyone’s hard limits.";

export function formatGroupPlans(result: GroupPlanResult): string {
  if (!result.ranked.length) {
    const hit = result.infeasible[0]?.byPerson.find((row) => row.hardViolations.length)?.hardViolations[0];
    return hit
      ? `I don’t have a plan that keeps every hard constraint (budget, time, accessibility). Closest miss: ${hit}. Relax one limit or ask for a different area.`
      : "I couldn't find a verified match right now. Try a wider area or a different time.";
  }

  const lines = result.ranked.map((plan, index) => {
    const facts = [
      plan.onPareto ? "on the trade-off frontier" : "feasible, not on the frontier",
      plan.strategy === "leastMisery"
        ? "least misery"
        : plan.strategy === "nash"
          ? "Nash welfare"
          : "average satisfaction",
    ];
    const cal = calendarLine(fromRecommendation(plan.item));
    return `${index + 1}. ${plan.item.name} — ${facts.join(", ")}. ${plan.reason}${plan.item.url ? `\n${plan.item.url}` : ""}${cal ? `\n${cal}` : ""}`;
  });

  if (result.because) lines.push(result.because);
  for (const line of result.counterfactuals) lines.push(`- ${line}`);

  if (result.leftover.length) lines.push(MORE_LINE);
  return lines.join("\n").slice(0, 1900);
}

export const GROUP_MORE_LINE = MORE_LINE;
