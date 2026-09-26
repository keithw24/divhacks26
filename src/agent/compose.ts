import type { Budget, Recommendation, RouteResult, SkillResult } from "../domain/contracts.js";
import type { EvidencePlan } from "../domain/evidence.js";
import { buildEvidenceGraph, renderEvidencePlan } from "../evidence/graph.js";
import type { BlockSafetyReport } from "../safety.js";
import { asksForMorePlans, membersFromTranscript } from "../planning/constraints.js";
import { formatGroupPlans } from "../planning/format.js";
import { selectGroupPlans } from "../planning/select.js";
import type { GroupPlanResult } from "../planning/types.js";

const sessionOffset = new Map<string, { fingerprint: string; offset: number }>();

function fingerprint(ids: string[]): string {
  return ids.slice().sort().join("|");
}

function sessionKey(spaceId: string | undefined, ids: string[]): string {
  return `${spaceId ?? "local"}:${fingerprint(ids)}`;
}

export interface RankedRecommendation {
  item: Recommendation;
  reason: string;
}

export interface RankResult {
  picks: RankedRecommendation[];
  offerMore: boolean;
  groupText?: string;
}

export function rankRecommendationsSync(
  question: string,
  recommendations: Recommendation[],
  transcript: Array<{ who: string; text: string }>,
  defaults?: { budget?: Budget; maxTravelMinutes?: number },
  spaceId?: string,
  extras?: { privateLines?: Array<{ who: string; text: string }>; now?: Date },
): RankResult {
  if (!recommendations.length) return { picks: [], offerMore: false };
  const members = membersFromTranscript(transcript, defaults, extras?.privateLines);
  const key = sessionKey(spaceId, recommendations.map((item) => item.id));
  const fp = fingerprint(recommendations.map((item) => item.id));
  const more = asksForMorePlans(question);
  const prior = sessionOffset.get(key);
  const offset = more && prior?.fingerprint === fp ? prior.offset : 0;
  const selected: GroupPlanResult = selectGroupPlans(recommendations, members, offset, extras?.now);
  const nextOffset = offset + selected.ranked.length;
  sessionOffset.set(key, { fingerprint: fp, offset: selected.leftover.length ? nextOffset : 0 });
  return {
    picks: selected.ranked.map((plan) => ({ item: plan.item, reason: plan.reason })),
    offerMore: selected.leftover.length > 0,
    groupText: formatGroupPlans(selected),
  };
}

/** @deprecated Gemini ID-picking is replaced by per-person scoring. Async wrapper keeps orchestrate tests stable. */
export async function rankRecommendations(
  question: string,
  recommendations: Recommendation[],
  transcript: Array<{ who: string; text: string }>,
  _memoryContext?: string,
  defaults?: { budget?: Budget; maxTravelMinutes?: number },
  spaceId?: string,
): Promise<RankedRecommendation[]> {
  return rankRecommendationsSync(question, recommendations, transcript, defaults, spaceId).picks;
}

/** Legacy safetyLine/reason strings are deliberately ignored: only graph claims can be rendered. */
export function renderResponse(input: {
  picks: RankedRecommendation[];
  safety?: SkillResult<BlockSafetyReport | null>;
  safetyLine?: string;
  route?: SkillResult<RouteResult>;
  warnings: string[];
  groupText?: string;
  offerMore?: boolean;
  graph?: EvidencePlan;
}): string {
  return renderEvidencePlan(input.graph ?? buildEvidenceGraph(input));
}