import { randomUUID } from "node:crypto";
import { fromRecommendation } from "../calendar/from.js";
import { googleCalendarUrl } from "../calendar/links.js";
import type { Recommendation, RouteResult, SkillResult, Source, UserIntent } from "../domain/contracts.js";
import type { Evidence, EvidenceCall, EvidenceNode, EvidencePlan } from "../domain/evidence.js";
import type { BlockSafetyReport } from "../safety.js";

export interface GraphInput {
  picks: Array<{ item: Recommendation; reason: string }>;
  safety?: SkillResult<BlockSafetyReport | null>;
  route?: SkillResult<RouteResult>;
  calls?: EvidenceCall[];
  intent?: UserIntent;
  routeTargetId?: string;
  safetyTargetId?: string;
  now?: Date;
  eventWindow?: { from: string; to: string };
}

export function publicUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const text = (s: string) => s.replace(/[\r\n\t]+/g, " ").slice(0, 220);
const date = (s?: string) => s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined;
const budgetLevels = { free: ["FREE"], low: ["INEXPENSIVE"], medium: ["MODERATE"], high: ["EXPENSIVE", "VERY_EXPENSIVE"] };

/** Build allowlisted factual claims from structured fields. Never ingest model reasons/descriptions. */
export function buildEvidenceGraph(input: GraphInput): EvidencePlan {
  const now = input.now ?? new Date();
  const plan: EvidencePlan = {
    id: randomUUID(), version: 1, createdAt: now.toISOString(), nodes: [], claims: [],
    toolCalls: [...(input.calls ?? [])], unavailable: [],
    limitations: ["Evidence records what a source returned; it does not independently verify reality.",
      "Confidence is provenance strength, not a calibrated probability.",
      "Only explicit request constraints are checked; private memories are not included in this audit."],
    response: "", renderedClaimIds: [],
    metrics: { renderedClaims: 0, supportedClaims: 0, coverage: null, staleClaims: 0, unknownFreshnessClaims: 0 },
  };
  function callFor(skill: EvidenceCall["skill"], status: EvidenceCall["status"] = "ok") {
    let call = plan.toolCalls.find(c => c.skill === skill);
    if (!call) {
      call = { id: randomUUID(), skill, status, startedAt: now.toISOString(), retrievedAt: now.toISOString() };
      plan.toolCalls.push(call);
    }
    return call;
  }
  function add(node: EvidenceNode, field: string, claim: string, source: Source, call: EvidenceCall,
    basis: Evidence["basis"] = "reported", ttl = 86400, live = false) {
    if (!source.name.trim()) return;
    const updated = date(source.updatedAt);
    const sourceAge = updated ? Math.max(0, (now.getTime() - Date.parse(updated)) / 1000) : undefined;
    const age = Math.max(0, (now.getTime() - Date.parse(call.retrievedAt)) / 1000);
    const freshness = sourceAge !== undefined ? (sourceAge > ttl ? "stale" : "fresh")
      : live ? (age > ttl ? "stale" : "fresh") : "unknown";
    const claimId = `${node.id}:${field}`;
    plan.claims.push({ claimId, claim, source: source.name, sourceUrl: publicUrl(source.url),
      retrievedAt: call.retrievedAt, freshnessSeconds: age, confidence: basis === "derived" ? 0.8 : 1,
      toolCallId: call.id, field, basis, sourceUpdatedAt: updated, sourceTimestampKind: source.updatedAtKind, sourceAgeSeconds: sourceAge,
      freshness, maxAgeSeconds: ttl });
    node.claimIds.push(claimId);
    return claimId;
  }
  for (const { item } of input.picks.slice(0, 3)) {
    if (plan.nodes.some(n => n.id === item.id)) continue;
    const call = callFor(item.kind === "food" ? "food" : "events");
    if (call.status === "unavailable" || !item.source.name.trim()) continue;
    const node: EvidenceNode = { id: item.id, kind: item.kind, claimIds: [], constraints: [] };
    plan.nodes.push(node);
    const record = (field: string, claim: string, basis: Evidence["basis"] = "reported", ttl = 86400) =>
      add(node, field, claim, item.source, call, basis, ttl, item.kind === "food");
    record("name", text(item.name));
    if (finite(item.distanceMeters)) record("distance", `${Math.round(item.distanceMeters)} m straight-line distance`, "derived");
    if (item.location.label && item.location.label !== item.name) record("venue", `at ${text(item.location.label)}`);
    if (date(item.startsAt)) record("startsAt", `starts ${new Date(item.startsAt!).toLocaleString("en-US", {
      timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    })} ET`);
    if (typeof item.openNow === "boolean") record("openNow", item.openNow ? "reported open at lookup" : "reported closed at lookup", "reported", 300);
    if (finite(item.rating) && item.rating <= 5) record("rating", `${item.rating.toFixed(1)}★ rating`);
    const price = item.priceLevel?.replace(/^PRICE_LEVEL_/, "");
    if (price && Object.values(budgetLevels).flat().includes(price)) record("price", price.toLowerCase().replaceAll("_", " "));
    const url = publicUrl(item.url);
    if (url) record("url", url, "link");
    const calendar = fromRecommendation(item);
    if (calendar) {
      const calUrl = googleCalendarUrl(calendar);
      add(node, "calendar", `Calendar: ${calUrl}`, { name: "Generated Google Calendar link", url: calUrl }, call, "link");
    }
    const claimFor = (field: string) => plan.claims.find(c => c.claimId === `${node.id}:${field}`);
    if (input.intent?.budget) {
      const c = claimFor("price");
      node.constraints.push({ label: "Requested budget", status: !c || c.freshness !== "fresh" ? "unverified"
        : budgetLevels[input.intent.budget].includes(price!) ? "satisfied" : "compromise", claimIds: c ? [c.claimId] : [] });
    }
    if (input.intent?.cuisine?.length || input.intent?.categories.length) {
      node.constraints.push({ label: "Cuisine / category fit (not independently checked)", status: "unverified", claimIds: [] });
    }
    if (input.intent?.maxTravelMinutes !== undefined) {
      node.constraints.push({ label: `Travel within ${input.intent.maxTravelMinutes} minutes`, status: "unverified", claimIds: [] });
    }
    if (item.kind === "event" && input.eventWindow) {
      const start = claimFor("startsAt");
      node.constraints.push({ label: "Starts inside the searched time window", status: !start || start.freshness !== "fresh" ? "unverified"
        : Date.parse(item.startsAt!) >= Date.parse(input.eventWindow.from) && Date.parse(item.startsAt!) <= Date.parse(input.eventWindow.to) ? "satisfied" : "compromise",
        claimIds: start ? [start.claimId] : [] });
    }
    if (item.kind === "event") node.constraints.push({ label: "Availability / cancellation / ticket availability", status: "unverified", claimIds: [] });
  }
  if (input.route) {
    const { data, status, sources } = input.route;
    const call = callFor("route", status);
    const node: EvidenceNode = { id: "route", kind: "route", claimIds: [], constraints: [], appliesTo: input.routeTargetId };
    plan.nodes.push(node);
    const source = sources.find(s => s.name === "Google Routes");
    if (status !== "unavailable" && source && finite(data.durationMinutes)) {
      add(node, "duration", `${data.durationMinutes} min ${data.mode.toLowerCase()} (route estimate)`, source, call, "reported", 300, true);
      if (finite(data.distanceMeters)) add(node, "distance", `${Math.round(data.distanceMeters)} m along the route`, source, call, "reported", 300, true);
    } else plan.unavailable.push("Route duration could not be verified. The directions link is not a travel-time estimate.");
    const url = publicUrl(data.directionsUrl);
    if (url) add(node, "url", url, { name: "Generated Google Maps directions link", url }, call, "link", 86400, true);
    const duration = plan.claims.find(c => c.claimId === "route:duration");
    const target = plan.nodes.find(n => n.id === input.routeTargetId);
    const check = target?.constraints.find(c => c.label.startsWith("Travel within"));
    if (check && duration && input.intent?.maxTravelMinutes !== undefined) {
      check.status = duration.freshness !== "fresh" ? "unverified"
        : data.durationMinutes! <= input.intent.maxTravelMinutes ? "satisfied" : "compromise";
      check.claimIds = [duration.claimId];
    }
    if (data.mode === "WALK" || data.mode === "BICYCLE") plan.limitations.push("Google walking and cycling routes are beta; check current path conditions.");
  }
  if (input.safety?.data && input.safety.status !== "unavailable") {
    const report = input.safety.data;
    const source = input.safety.sources[0];
    const call = callFor("safety", input.safety.status);
    const node: EvidenceNode = { id: "safety", kind: "safety", claimIds: [], constraints: [], appliesTo: input.safetyTargetId };
    plan.nodes.push(node);
    if (source && finite(report.hourNeighborhoodCount) && finite(report.neighborhoodMeters) && finite(report.years) && finite(report.hourEt)) {
      add(node, "historicalCount", `${report.hourNeighborhoodCount} historical reported complaints within ${report.neighborhoodMeters} m at ${report.hourEt}:00 ET over ${report.years} years`, source, call);
    } else plan.unavailable.push("Historical complaint evidence is incomplete.");
    plan.limitations.push("Historical complaints do not represent live conditions or predict personal safety. Dataset freshness is unknown unless explicitly supplied.");
  }
  for (const call of plan.toolCalls) {
    if (call.status !== "ok") plan.unavailable.push(`${call.skill}: ${call.status === "unavailable" ? "source unavailable" : "partial results"}.`);
    if (!plan.claims.some(c => c.toolCallId === call.id)) plan.unavailable.push(`${call.skill}: no supported claims returned.`);
  }
  plan.unavailable = [...new Set(plan.unavailable)];
  return plan;
}

/** Exact claim text only. No free-form model prose can enter the factual response. */
export function renderEvidencePlan(plan: EvidencePlan, maxLength = 1900): string {
  const lines: string[] = [];
  const rendered: string[] = [];
  const byId = new Map(plan.claims.map(c => [c.claimId, c]));
  // Internal diagnostic objects must never be rendered into user-facing text (Requirement 2 & 7)
  const notes = [...plan.unavailable, ...plan.limitations.filter(l => /routes are beta|requested travel mode/.test(l))]
    .filter(n => !/source unavailable|no supported claims returned|partial results|supported claims|dataset freshness|Historical complaints/i.test(n));
  const noteText = notes.map(n => `Note: ${n}`).join("\n");
  const limit = Math.max(0, maxLength - noteText.length - 1);
  function append(line: string, ids: string[] = []) {
    if ([...lines, line].join("\n").length > limit) return false;
    lines.push(line); rendered.push(...ids); return true;
  }
  let index = 0;
  for (const node of plan.nodes) {
    const prefix = node.kind === "route" ? "Route" : node.kind === "safety" ? "Historical context" : `${++index}`;
    const claims = node.claimIds.map(id => byId.get(id)).filter((c): c is Evidence => !!c &&
      plan.toolCalls.some(call => call.id === c.toolCallId && (call.status !== "unavailable" || c.basis === "link")));
    const facts = claims.filter(c => c.field !== "url" && c.field !== "calendar");
    const links = claims.filter(c => c.field === "url" || c.field === "calendar");
    const line = facts.map(c => `${c.claim}${c.freshness === "stale" ? " [stale source; recheck]" : ""}`).join("; ");
    if (line && !append(`${prefix}. ${line}`, facts.map(c => c.claimId))) continue;
    for (const c of links) append(c.claim, [c.claimId]);
  }
  if (!rendered.length) append("I couldn't find a verified match right now. Try a wider area or a different time.");
  if (noteText) lines.push(noteText);
  plan.response = lines.join("\n");
  plan.renderedClaimIds = [...new Set(rendered)];
  const emitted = plan.renderedClaimIds.map(id => byId.get(id)!);
  plan.metrics = { renderedClaims: emitted.length, supportedClaims: emitted.length,
    coverage: emitted.length ? 1 : null,
    staleClaims: emitted.filter(c => c.freshness === "stale").length,
    unknownFreshnessClaims: emitted.filter(c => c.freshness === "unknown").length };
  return plan.response;
}
