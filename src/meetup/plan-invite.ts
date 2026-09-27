import type { ReservationHandlerResult } from "../agent/turn.js";
import type { MeetupService } from "./service.js";
import {
  extractInviteeNames,
  formatGuestInvite,
  formatHostInviteAck,
  isPlanInviteRequest,
  nameInTigerDirectory,
  planQuestionForInvite,
  resolveInviteContact,
  type InviteContact,
} from "./invite.js";

export interface PlanInviteInput {
  text: string;
  senderId?: string;
  senderName?: string;
  spaceId: string;
  isGroup: boolean;
  participants?: Array<{ id: string; displayName?: string }>;
  contacts: InviteContact[];
  /** Tiger display names only. Used when a person is known but has no sendable Photon id. */
  tigerPeople?: Array<{ displayName?: string; userId: string }>;
  buildPlan: (question: string) => Promise<string>;
  sendInvite: (photonSenderId: string, body: string) => Promise<void>;
  meetup?: Pick<MeetupService, "handleTurn">;
  now?: Date;
  /** Extra invitees from Gemini intent when the user didn't say "with X". */
  invitees?: string[];
}

export async function handlePlanInvite(input: PlanInviteInput): Promise<ReservationHandlerResult> {
  const knownPeople = [
    ...input.contacts.map((row) => row.displayName),
    ...(input.tigerPeople ?? []).map((row) => row.displayName ?? ""),
  ].filter(Boolean);
  const names = mergeNames(extractInviteeNames(input.text, knownPeople), input.invitees);
  if (!names.length || (!isPlanInviteRequest(input.text, knownPeople) && !input.invitees?.length)) {
    return { handled: false };
  }
  const senderKey = input.senderName?.trim().toLowerCase();
  const targets = names.filter((name) => name.toLowerCase() !== senderKey);
  if (!targets.length) return { handled: false };

  const plan = (await buildPlanText(input, resolveGuests(targets, input.contacts, input.senderId))).trim();
  if (!plan) {
    return {
      handled: true,
      acknowledgement: "👀",
      reply: "I couldn't put a plan together yet. Tell me a neighborhood or time and I'll invite them.",
    };
  }

  const notified = await notifySharedPlan({
    names: targets,
    senderId: input.senderId,
    senderName: input.senderName,
    plan,
    contacts: input.contacts,
    tigerPeople: input.tigerPeople,
    sendInvite: input.sendInvite,
  });
  return {
    handled: true,
    acknowledgement: notified.acknowledgement,
    reply: notified.reply,
  };
}

export async function notifySharedPlan(input: {
  names: string[];
  senderId?: string;
  senderName?: string;
  plan: string;
  contacts: InviteContact[];
  tigerPeople?: Array<{ displayName?: string; userId: string }>;
  sendInvite: (photonSenderId: string, body: string) => Promise<void>;
}): Promise<{ reply: string; acknowledgement: string; sent: string[] }> {
  const sentNames: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const directoryOnly: string[] = [];
  const guestBody = formatGuestInvite(input.senderName || "A friend", input.plan);

  for (const name of input.names) {
    const match = resolveInviteContact(name, input.contacts);
    if (match === "ambiguous") {
      ambiguous.push(name);
      continue;
    }
    if (!match || match.photonSenderId === input.senderId) {
      missing.push(name);
      if (nameInTigerDirectory(name, input.tigerPeople ?? [])) directoryOnly.push(name);
      continue;
    }
    try {
      await input.sendInvite(match.photonSenderId, guestBody);
      sentNames.push(match.displayName);
    } catch (error) {
      console.error(`plan invite send failed: ${error instanceof Error ? error.name : "Error"}`);
      missing.push(match.displayName);
    }
  }

  return {
    sent: sentNames,
    acknowledgement: sentNames.length ? "👍" : "👀",
    reply: formatHostInviteAck(input.plan, sentNames, missing, ambiguous, directoryOnly),
  };
}

export function planLooksSendable(plan: string): boolean {
  const text = plan.trim();
  if (text.length < 24) return false;
  if (/where in nyc are you/i.test(text)) return false;
  if (/couldn't put a plan together/i.test(text)) return false;
  if (/couldn't find a verified match/i.test(text)) return false;
  return true;
}

function mergeNames(left: string[], right?: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...left, ...(right ?? [])]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name.trim());
  }
  return names.slice(0, 5);
}

function resolveGuests(names: string[], contacts: InviteContact[], senderId?: string): InviteContact[] {
  const guests: InviteContact[] = [];
  for (const name of names) {
    const match = resolveInviteContact(name, contacts);
    if (match && match !== "ambiguous" && match.photonSenderId !== senderId) guests.push(match);
  }
  return guests;
}

async function buildPlanText(input: PlanInviteInput, guests: InviteContact[]): Promise<string> {
  const question = planQuestionForInvite(input.text);
  if (input.meetup) {
    const meetup = await input.meetup.handleTurn({
      spaceId: input.spaceId,
      senderId: input.senderId || "someone",
      senderName: input.senderName,
      text: question,
      isGroup: true,
      now: input.now,
      participants: [
        ...(input.senderId ? [{ id: input.senderId, displayName: input.senderName }] : []),
        ...guests.map((guest) => ({ id: guest.photonSenderId, displayName: guest.displayName })),
        ...(input.participants ?? []),
      ],
    });
    if (meetup.handled && meetup.reply && !/Add me to the group|Where are you meeting|What time is the meetup/i.test(meetup.reply)) {
      return meetup.reply;
    }
  }
  return input.buildPlan(question);
}
