import type { Budget, Recommendation, RouteResult, SkillResult } from "../domain/contracts.js";
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

const miles = (meters: number) => meters < 1200 ? `${Math.max(1, Math.round(meters / 80))} min walk` : `${(meters / 1609.344).toFixed(1)} mi away`;
const eventWhen = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : undefined;

export function renderResponse(input: {
  picks: RankedRecommendation[];
  safety?: SkillResult<BlockSafetyReport | null>;
  safetyLine?: string;
  route?: SkillResult<RouteResult>;
  warnings: string[];
  groupText?: string;
  offerMore?: boolean;
}): string {
  const lines: string[] = [];
  if (input.groupText) {
    lines.push(input.groupText);
  } else {
    input.picks.forEach(({ item, reason }, index) => {
      const facts = [miles(item.distanceMeters)];
      if (item.startsAt) facts.push(`starts ${eventWhen(item.startsAt)}`);
      if (item.kind === "event" && item.location.label && item.location.label !== item.name) {
        facts.push(`at ${item.location.label}`);
      }
      if (item.openNow === true) facts.push("open now");
      if (item.rating) facts.push(`${item.rating.toFixed(1)}★`);
      if (item.priceLevel) facts.push(item.priceLevel.replace("PRICE_LEVEL_", "").toLowerCase());
      lines.push(`${index + 1}. ${item.name} — ${facts.join(", ")}; ${reason}`);
      if (item.url) lines.push(item.url);
    });
    if (input.offerMore) {
      lines.push("If none of these work, say “show more” and I’ll list the next options that still fit everyone’s hard limits.");
    }
  }

  if (input.safetyLine) lines.push(input.safetyLine);
  if (input.route) {
    lines.push(`Route: ${input.route.data.summary}`);
    lines.push(input.route.data.directionsUrl);
    if (input.route.data.mode === "WALK" || input.route.data.mode === "BICYCLE") {
      lines.push("Google walking and cycling routes are beta; check current path conditions.");
    }
  }
  if (!lines.length) lines.push("I couldn't find a verified match right now. Try a wider area or a different time.");
  const uniqueWarnings = [...new Set(input.warnings)].filter(Boolean);
  if (uniqueWarnings.length && lines.length < 12) lines.push(`Note: ${uniqueWarnings[0]}`);
  return lines.join("\n").slice(0, 1900);
}
