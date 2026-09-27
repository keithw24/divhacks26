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
}

export async function handlePlanInvite(input: PlanInviteInput): Promise<ReservationHandlerResult> {
  if (!isPlanInviteRequest(input.text)) return { handled: false };
  const names = extractInviteeNames(input.text);
  const senderKey = input.senderName?.trim().toLowerCase();
  const targets = names.filter((name) => name.toLowerCase() !== senderKey);

  const sentNames: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const directoryOnly: string[] = [];
  const resolved: InviteContact[] = [];

  for (const name of targets) {
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
    resolved.push(match);
  }

  if (!targets.length) return { handled: false };

  const plan = (await buildPlanText(input, resolved)).trim();
  if (!plan) {
    return {
      handled: true,
      acknowledgement: "👀",
      reply: "I couldn't put a plan together yet. Tell me a neighborhood or time and I'll invite them.",
    };
  }

  const guestBody = formatGuestInvite(input.senderName || "A friend", plan);
  for (const contact of resolved) {
    try {
      await input.sendInvite(contact.photonSenderId, guestBody);
      sentNames.push(contact.displayName);
    } catch (error) {
      console.error(`plan invite send failed: ${error instanceof Error ? error.name : "Error"}`);
      missing.push(contact.displayName);
    }
  }

  return {
    handled: true,
    acknowledgement: sentNames.length ? "👍" : "👀",
    reply: formatHostInviteAck(plan, sentNames, missing, ambiguous, directoryOnly),
  };
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
