import type { Budget, Recommendation } from "../domain/contracts.js";

export interface MemberConstraints {
  id: string;
  name: string;
  /** Hard cap. Plans above this are ineligible. */
  maxBudget?: Budget;
  /** Hard. Stairs-only / not-accessible venues fail. Unknown is a soft penalty. */
  needsAccessible: boolean;
  /** Hard walk/travel cap from the pin, in minutes. */
  maxTravelMinutes?: number;
  cuisine?: string[];
  avoid?: string[];
  dietary?: Array<"vegan" | "vegetarian" | "gluten-free" | "peanut-free">;
  /** True when this person stated the constraint in the current group thread. */
  discloseConstraints: boolean;
}

export interface PersonScore {
  memberId: string;
  name: string;
  /** 0 when a hard constraint is broken; otherwise (0, 1]. */
  score: number;
  hardViolations: string[];
}

export interface PlanScore {
  item: Recommendation;
  byPerson: PersonScore[];
  feasible: boolean;
  average: number;
  leastMisery: number;
  nash: number;
}

export type Strategy = "average" | "leastMisery" | "nash";

export interface RankedPlan {
  item: Recommendation;
  strategy: Strategy;
  onPareto: boolean;
  score: PlanScore;
  /** One sentence: constraints + why this ranks where it does. */
  reason: string;
}

export interface GroupPlanResult {
  members: MemberConstraints[];
  ranked: RankedPlan[];
  leftover: RankedPlan[];
  infeasible: PlanScore[];
  because?: string;
  counterfactuals: string[];
}
