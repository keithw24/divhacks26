import { displayName } from "../transport/locations.js";
import { formatClock, formatDuration, GRACE_MS } from "./clock.js";
import type { MeetupMember, MeetupPlan, PersonLocation } from "./types.js";

function who(member: MeetupMember): string {
  return member.displayName || "someone";
}

function modePhrase(member: MeetupMember): string {
  if (member.mode === "TRANSIT") return member.summary ? `via ${member.summary}` : "on transit";
  if (member.mode === "WALK") return "walking";
  if (member.mode === "DRIVE") return "by car";
  return "on the way";
}

export function formatLeaveTimes(plan: MeetupPlan, timeZone: string, missing: PersonLocation["senderId"][] = [], names: Record<string, string> = {}): string {
  const dest = displayName(plan.destination);
  const meet = formatClock(plan.meetAtIso, timeZone);
  const lines = [`Meet at ${dest} at ${meet}.`];
  const timed = plan.members.filter((member) => member.leaveByIso && member.durationSeconds);
  for (const member of timed) {
    const from = member.origin?.name ? ` from ${member.origin.name}` : "";
    lines.push(
      `${who(member)}: leave by ${formatClock(member.leaveByIso!, timeZone)} (${formatDuration(member.durationSeconds!)} ${modePhrase(member)}${from}).`,
    );
  }
  for (const id of missing) {
    const label = names[id] ?? "Someone";
    lines.push(`${label}: share a location (or neighborhood) so I can time the leave.`);
  }
  if (!timed.length && !missing.length) {
    lines.push("I need everyone’s location pin or neighborhood to time the leaves.");
  }
  return lines.join("\n");
}

export function formatLateUpdate(input: {
  plan: MeetupPlan;
  member: MeetupMember;
  timeZone: string;
  now: Date;
}): string {
  const dest = displayName(input.plan.destination);
  const meetAt = new Date(input.plan.meetAtIso);
  const meet = formatClock(input.plan.meetAtIso, input.timeZone);
  const eta = input.member.etaIso ? new Date(input.member.etaIso) : undefined;
  const delay = input.member.delayMinutes ? ` (+${input.member.delayMinutes} min)` : "";
  const etaLabel = eta ? formatClock(input.member.etaIso!, input.timeZone) : "unknown";
  const travel = input.member.durationSeconds
    ? `${formatDuration(input.member.durationSeconds)} ${modePhrase(input.member)}`
    : "updated travel time";

  if (!eta) {
    return `${who(input.member)} is running late, but I couldn’t recompute their leg yet. Share a fresh pin.`;
  }

  const slipMs = eta.getTime() - meetAt.getTime();
  if (slipMs <= GRACE_MS) {
    return `${who(input.member)} is running late${delay}. Recomputed ${travel}: they’d still make ${dest} around ${etaLabel}, so the ${meet} plan still works.`;
  }

  const slipMin = Math.max(1, Math.round(slipMs / 60_000));
  const pushed = formatClock(new Date(meetAt.getTime() + slipMin * 60_000).toISOString(), input.timeZone);
  return `${who(input.member)} is running late${delay}. Recomputed ${travel}: arrival around ${etaLabel}, about ${slipMin} min after ${meet}. The original plan won’t hold unless you wait, or push the meet to ${pushed}.`;
}

export function formatNeedWhen(): string {
  return "What time is the meetup? I’ll time each person’s leave from their pin.";
}

export function formatNeedWhere(): string {
  return "Where are you meeting? I’ll time each person’s leave from their pin.";
}

export function formatNeedGroup(): string {
  return "Add me to the group and have everyone share a location pin (Photon location or a neighborhood) and I can time the leaves.";
}
