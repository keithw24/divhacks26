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

import { composeResponse, naturalSafetyNote } from "./responseComposer.js";
import { wantsSafetySketch } from "../safetyIntent.js";

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
  intent?: import("../domain/contracts.js").UserIntent;
  question?: string;
  origin?: import("../domain/contracts.js").Location;
}): string {
  const graph = input.graph ?? buildEvidenceGraph(input);
  // Ensure the underlying evidence plan has rendered claims and metrics computed for audit
  renderEvidencePlan(graph);

  const directParts: string[] = [];
  const supplementaryContext: Array<{ kind: "safety" | "timing" | "venue" | "route" | "general"; text: string; priority?: number }> = [];

  const userAskedSafety =
    (input.intent?.needs.length === 1 && input.intent.needs[0] === "safety") ||
    Boolean(input.question && wantsSafetySketch(input.question));

  const candidateLocation = input.origin?.label || input.intent?.locationQuery;
  const neighborhoodMatch = candidateLocation && !/shared location/i.test(candidateLocation)
    ? candidateLocation.split(/[,;-]/)[0]?.trim()
    : undefined;
  const neighborhood =
    neighborhoodMatch && neighborhoodMatch.length >= 3 && neighborhoodMatch.length <= 40 && !/^\d+/.test(neighborhoodMatch) && !/^(?:new york|nyc|manhattan)$/i.test(neighborhoodMatch)
      ? neighborhoodMatch
      : undefined;

  if (userAskedSafety && input.safety?.data && input.safety.status !== "unavailable") {
    directParts.push(
      `Looks pretty normal for that area around ${input.safety.data.hourEt % 12 || 12} ${input.safety.data.hourEt >= 12 ? "PM" : "AM"} based on historical reports.`
    );
    if (input.picks.length > 0) {
      supplementaryContext.push({
        kind: "general",
        text: `Also nearby: ${input.picks.map((p) => p.item.name).join(", ")}.`,
        priority: 40,
      });
    }
  } else if (input.picks.length > 0) {
    if (input.picks.length === 1) {
      const item = input.picks[0]!.item;
      const venue = item.location.label && item.location.label !== item.name ? ` at ${item.location.label}` : "";
      const dateStr = item.startsAt && !isNaN(Date.parse(item.startsAt))
        ? ` on ${new Date(item.startsAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`
        : "";
      const priceStr = item.priceLevel ? ` (${item.priceLevel.replace(/^PRICE_LEVEL_/, "").toLowerCase()})` : "";
      const urlStr = item.url ? ` ${item.url}` : "";
      directParts.push(`There's ${item.name}${venue}${dateStr}${priceStr}.${urlStr}`);
    } else {
      const lines = input.picks.slice(0, 3).map((p, idx) => {
        const item = p.item;
        const venue = item.location.label && item.location.label !== item.name ? ` at ${item.location.label}` : "";
        const dateStr = item.startsAt && !isNaN(Date.parse(item.startsAt))
          ? ` on ${new Date(item.startsAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}`
          : "";
        return `${idx + 1}. ${item.name}${venue}${dateStr}`;
      });
      const whenStr = input.intent?.when && input.intent.when !== "now" ? ` ${input.intent.when}` : "";
      const intro = neighborhood
        ? `You're in ${neighborhood}, so there are a few things nearby${whenStr}:\n${lines.join("\n")}`
        : `Here are a few good options:\n${lines.join("\n")}`;
      directParts.push(intro);
    }

    if (input.route?.data && input.route.status !== "unavailable") {
      const mode = input.route.data.mode.toLowerCase() === "walk" ? "walk" : "transit";
      const mins = input.route.data.durationMinutes;
      const durationText = mins
        ? input.picks.length > 1 && input.picks[0]
          ? `${input.picks[0].item.name} is the closest at about ${mins} minutes away.`
          : `It's about a ${mins}-minute ${mode}.`
        : "";
      const betaNote = input.route.data.mode === "WALK" || input.route.data.mode === "BICYCLE"
        ? "Google walking and cycling routes are beta; check current path conditions."
        : "";
      const routeText = [durationText, betaNote, input.route.data.directionsUrl].filter(Boolean).join(" ");
      if (routeText) {
        supplementaryContext.push({ kind: "route", text: routeText, priority: 20 });
      }
    }

    if (input.safety?.data && input.safety.status !== "unavailable") {
      const note = naturalSafetyNote({
        placeName: input.picks[0]?.item.location.label,
        hourEt: input.safety.data.hourEt,
        hourVsNyc: input.safety.data.baselines?.hourVsNyc,
        areaVsNyc: input.safety.data.baselines?.areaVsNyc,
      });
      supplementaryContext.push({ kind: "safety", text: note, priority: 30 });
    }
  } else if (input.route?.data && input.route.status !== "unavailable") {
    const mode = input.route.data.mode.toLowerCase() === "walk" ? "walk" : "transit";
    const mins = input.route.data.durationMinutes;
    const durationText = mins ? `It's about a ${mins}-minute ${mode}.` : "Here are the directions.";
    const betaNote = input.route.data.mode === "WALK" || input.route.data.mode === "BICYCLE"
      ? "Google walking and cycling routes are beta; check current path conditions."
      : "";
    const routeText = [durationText, betaNote, input.route.data.directionsUrl].filter(Boolean).join(" ");
    directParts.push(routeText);
  } else if (input.safety?.data && input.safety.status !== "unavailable") {
    directParts.push(
      `Looks pretty normal for that area around ${input.safety.data.hourEt % 12 || 12} ${input.safety.data.hourEt >= 12 ? "PM" : "AM"} based on historical reports.`
    );
  } else {
    const warning = input.warnings.find((w) => !/source unavailable|partial results|supported claims/i.test(w));
    if (warning) {
      directParts.push(warning);
    } else if (neighborhood) {
      directParts.push(`I couldn't find a verified match right around ${neighborhood} right now. Try a wider area or a different time.`);
    } else {
      directParts.push("I couldn't find a verified match right now. Try a wider area or a different time.");
    }
  }

  const composed = composeResponse({
    primaryIntent: input.picks.length ? "picks" : input.route?.data ? "route" : input.safety?.data ? "safety" : "general",
    directAnswer: directParts.join("\n\n"),
    supplementaryContext,
    nextPrompt: input.picks.length > 1 ? "Want something more like nightlife, music, or an activity?" : undefined,
  });

  graph.response = composed;
  return composed;
}