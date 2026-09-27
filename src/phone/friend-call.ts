import { randomUUID } from "node:crypto";
import type { OutboundCaller } from "../elevenlabs/types.js";
import type { StateStore } from "../store/state.js";

/**
 * "@agent call Alex and ask if they're in for dinner at 8"
 *
 * The ElevenLabs agent phones the friend (through the Twilio number already
 * used for restaurant calls), says it's an AI assistant calling for the
 * person who asked, delivers the message or question, and the result comes
 * back into the same iMessage chat when the call ends.
 *
 * Safety: every call needs an explicit "yes" from the person asking, the
 * number is shown masked before confirming, the agent always says it's an AI
 * at the start, and each chat is capped at a few calls an hour.
 */

export interface FriendCallRequest {
  /** A name ("Alex") or a phone number as typed. */
  target: string;
  /** What to ask or tell, e.g. "ask if they're in for dinner at 8". */
  purpose: string;
}

export interface PendingFriendCall {
  id: string;
  friendName: string;
  /** E.164, or empty while we're waiting for the person to send the number. */
  phone: string;
  purpose: string;
  callerName: string;
  createdAt: string;
}

export interface FriendCallRecord {
  id: string;
  spaceId: string;
  friendName: string;
  phone: string;
  purpose: string;
  callerName: string;
  conversationId?: string;
  placedAt: string;
  status: "calling" | "done" | "no_answer" | "failed";
}

export interface FriendCallState {
  /** Waiting for "yes" (or for the number), per chat. */
  pending: Record<string, PendingFriendCall>;
  calls: Record<string, FriendCallRecord>;
  /** Numbers people taught us per chat: lowercase name → E.164. */
  contacts: Record<string, Record<string, string>>;
}

export interface CallCompletion {
  conversationId: string;
  callId?: string;
  failed: boolean;
  /** Turns from ElevenLabs: role "user" is the friend, "agent" is our AI. */
  transcript: Array<{ role?: string; message?: string }>;
  terminationReason?: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_CALLS_PER_HOUR = 3;
const CALL_ID_PREFIX = "friend:";

const NOT_A_FRIEND = /\b(uber|lyft|taxi|cab|ride|restaurant|reservation|reserve|book|table|911|police|ambulance|me back)\b/i;

/** US numbers: "(917) 555-0142", "+1 917 555 0142" → "+19175550142". */
export function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

export const maskPhone = (phone: string) => `•••-${phone.slice(-4)}`;

const PHONE_IN_TEXT = /(\+?1?[\s.-]?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4})/;

/** "call Alex and ask if they're in for 8", "phone Maya to tell her we're late". */
export function parseFriendCallRequest(text: string): FriendCallRequest | null {
  const t = text.replace(/@agent\b[:,]?/gi, "").trim();
  if (NOT_A_FRIEND.test(t)) return null;
  const match = t.match(
    /^(?:can you |could you |pls |please )?(?:call|phone|ring|give)\s+(?:a call to\s+)?(?:my friend\s+)?(.+?)(?:\s+a call)?\s+(?:and|to)\s+(ask|tell|say|let|check|see|remind|invite)\b(.*)$/i,
  );
  if (!match) return null;
  const target = match[1]!.trim().replace(/[,.]$/, "");
  const purpose = `${match[2]!.toLowerCase()}${match[3]!}`.trim().replace(/[?.!]+$/, "");
  if (!target || target.length > 40 || purpose.length < 6) return null;
  return { target, purpose };
}

/** "Alex is 917-555-0142" / "Alex's number is (917) 555 0142". */
export function parseContactShare(text: string): { name: string; phone: string } | null {
  const m = text.match(/^\s*([A-Za-z][A-Za-z .'-]{0,30}?)(?:'s number)?\s+is\s+(.+)$/i);
  if (!m) return null;
  const name = m[1]!.trim();
  if (/^(my|your|his|her|our|their|the|this|that|it)\b/i.test(name)) return null;
  const phone = normalizeUsPhone(m[2]!);
  return phone ? { name, phone } : null;
}

const YES = /^\s*(y|yes|yep|yeah|yup|sure|ok|okay|do it|go|call( them| (him|her))?)\s*[.!]*\s*$/i;
const NO = /^\s*(n|no|nope|cancel|stop|don'?t|never ?mind)\b/i;

export interface FriendCallDeps {
  store: StateStore;
  caller?: OutboundCaller;
  /** People we can resolve by name in this chat (group members, onboarded users). */
  knownPeople(spaceId: string): Array<{ name: string; phone: string }>;
  notify(spaceId: string, text: string): Promise<void>;
  now?: () => Date;
}

function state(store: StateStore): FriendCallState {
  return store.getState().friendCalls ?? { pending: {}, calls: {}, contacts: {} };
}

function update(store: StateStore, mutate: (s: FriendCallState) => void): void {
  store.update((draft) => {
    draft.friendCalls ??= { pending: {}, calls: {}, contacts: {} };
    mutate(draft.friendCalls);
  });
}

export function friendCallPrompt(input: { friendName: string; callerName: string; purpose: string }) {
  const { friendName, callerName, purpose } = input;
  return {
    firstMessage: `Hi ${friendName}, this is @agent, an AI assistant calling for ${callerName}. ${callerName} asked me to ${purpose}.`,
    systemPrompt: `You are @agent, an AI assistant placing a short phone call to ${friendName} on behalf of their friend ${callerName}.
Your only job: ${purpose}.
- You already said you're an AI assistant calling for ${callerName}. If asked, say so plainly. Never claim to be human or to be ${callerName}.
- Keep it under a minute. Listen to their answer, confirm it back in one sentence, then say you'll pass it on to ${callerName} and say goodbye.
- If they want to talk to ${callerName} directly, say you'll let ${callerName} know to reach out.
- If you reach voicemail, leave one short message: who you are, who you're calling for, and the message, then hang up.
- Don't ask for personal information, payments, or passwords. Don't discuss anything else.`,
  };
}

/** The friend's side of the call, as a short quote for the chat. */
export function summarizeCall(completion: CallCompletion): { answered: boolean; quote: string } {
  const theirs = completion.transcript
    .filter((turn) => turn.role === "user" && turn.message?.trim())
    .map((turn) => turn.message!.trim());
  if (!theirs.length) return { answered: false, quote: "" };
  const quote = theirs.join(" ").replace(/\s+/g, " ");
  return { answered: true, quote: quote.length > 280 ? `${quote.slice(0, 277)}…` : quote };
}

export function isFriendCallId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(CALL_ID_PREFIX));
}

export function createFriendCallService(deps: FriendCallDeps) {
  const now = () => deps.now?.() ?? new Date();

  function resolve(spaceId: string, target: string): { name: string; phone: string } | null {
    const typed = target.match(PHONE_IN_TEXT)?.[1];
    const direct = typed ? normalizeUsPhone(typed) : normalizeUsPhone(target);
    if (direct) return { name: target.replace(PHONE_IN_TEXT, "").trim() || maskPhone(direct), phone: direct };
    const key = target.toLowerCase();
    const saved = state(deps.store).contacts[spaceId]?.[key];
    if (saved) return { name: target, phone: saved };
    const known = deps.knownPeople(spaceId).find(
      (p) => p.name.toLowerCase() === key || p.name.toLowerCase().split(/\s+/)[0] === key,
    );
    return known ? { name: known.name, phone: known.phone } : null;
  }

  function callsThisHour(spaceId: string): number {
    const cutoff = now().getTime() - 60 * 60 * 1000;
    return Object.values(state(deps.store).calls).filter(
      (c) => c.spaceId === spaceId && Date.parse(c.placedAt) > cutoff,
    ).length;
  }

  function confirmText(p: PendingFriendCall): string {
    return `I'll call ${p.friendName} (${maskPhone(p.phone)}) and ${p.purpose}. I'll say I'm an AI assistant calling for you, then text you what they say. Reply "yes" to call or "no" to cancel.`;
  }

  async function place(spaceId: string, pending: PendingFriendCall): Promise<string> {
    if (!deps.caller) return "Phone calls aren't set up on this agent (ElevenLabs outbound calling isn't configured).";
    if (callsThisHour(spaceId) >= MAX_CALLS_PER_HOUR) {
      return "That's a lot of calls for one hour. Try again a bit later.";
    }
    const prompt = friendCallPrompt(pending);
    try {
      const placed = await deps.caller.placeCall({
        toNumber: pending.phone,
        reservationId: pending.id,
        spaceId,
        systemPrompt: prompt.systemPrompt,
        firstMessage: prompt.firstMessage,
        dynamicVariables: {
          friend_name: pending.friendName,
          caller_name: pending.callerName,
          purpose: pending.purpose,
          call_kind: "friend",
        },
      });
      update(deps.store, (s) => {
        delete s.pending[spaceId];
        s.calls[pending.id] = {
          id: pending.id,
          spaceId,
          friendName: pending.friendName,
          phone: pending.phone,
          purpose: pending.purpose,
          callerName: pending.callerName,
          conversationId: placed.conversationId,
          placedAt: now().toISOString(),
          status: "calling",
        };
      });
      return `Calling ${pending.friendName} now. I'll text you here when the call ends.`;
    } catch (error) {
      update(deps.store, (s) => delete s.pending[spaceId]);
      console.warn(`friend.call failed: ${error instanceof Error ? error.name : "Error"}`);
      return `I couldn't place the call to ${pending.friendName} right now. Try again in a minute.`;
    }
  }

  async function handleTurn(input: {
    spaceId: string;
    senderName?: string;
    text: string;
  }): Promise<{ handled: boolean; reply?: string; acknowledgement?: string }> {
    const { spaceId, text } = input;
    const pending = state(deps.store).pending[spaceId];
    const fresh = pending && now().getTime() - Date.parse(pending.createdAt) < PENDING_TTL_MS;

    if (fresh && pending) {
      // Waiting for the friend's number.
      if (!pending.phone) {
        const phone = normalizeUsPhone(text.match(PHONE_IN_TEXT)?.[1] ?? "");
        if (phone) {
          const next = { ...pending, phone };
          update(deps.store, (s) => {
            s.pending[spaceId] = next;
            (s.contacts[spaceId] ??= {})[pending.friendName.toLowerCase()] = phone;
          });
          return { handled: true, reply: confirmText(next) };
        }
        if (NO.test(text)) {
          update(deps.store, (s) => delete s.pending[spaceId]);
          return { handled: true, reply: "Okay, no call." };
        }
      } else if (YES.test(text)) {
        return { handled: true, acknowledgement: "👍", reply: await place(spaceId, pending) };
      } else if (NO.test(text)) {
        update(deps.store, (s) => delete s.pending[spaceId]);
        return { handled: true, reply: `Okay, I won't call ${pending.friendName}.` };
      }
    }

    const share = parseContactShare(text);
    if (share) {
      update(deps.store, (s) => {
        (s.contacts[spaceId] ??= {})[share.name.toLowerCase()] = share.phone;
      });
      return { handled: true, reply: `Saved ${share.name} (${maskPhone(share.phone)}). Say "call ${share.name} and ask…" any time.` };
    }

    const request = parseFriendCallRequest(text);
    if (!request) return { handled: false };
    const contact = resolve(spaceId, request.target);
    const next: PendingFriendCall = {
      id: `${CALL_ID_PREFIX}${randomUUID()}`,
      friendName: contact?.name ?? request.target,
      phone: contact?.phone ?? "",
      purpose: request.purpose,
      callerName: input.senderName?.trim() || "your friend",
      createdAt: now().toISOString(),
    };
    update(deps.store, (s) => {
      s.pending[spaceId] = next;
    });
    if (!contact) {
      return { handled: true, reply: `What's ${request.target}'s number? Send it here and I'll confirm before calling.` };
    }
    return { handled: true, reply: confirmText(next) };
  }

  /** ElevenLabs post-call result for a friend call. Returns false if it isn't one of ours. */
  async function handleCompletion(completion: CallCompletion): Promise<boolean> {
    const calls = state(deps.store).calls;
    const record =
      (completion.callId ? calls[completion.callId] : undefined) ??
      Object.values(calls).find((c) => c.conversationId === completion.conversationId);
    if (!record || record.status !== "calling") return Boolean(record);
    const summary = summarizeCall(completion);
    const status: FriendCallRecord["status"] = completion.failed ? "failed" : summary.answered ? "done" : "no_answer";
    update(deps.store, (s) => {
      const target = s.calls[record.id];
      if (target) target.status = status;
    });
    const text =
      status === "done"
        ? `Called ${record.friendName}. They said: "${summary.quote}"`
        : status === "no_answer"
          ? `${record.friendName} didn't pick up. If it went to voicemail, I left your message.`
          : `The call to ${record.friendName} didn't go through. Want me to try again later?`;
    await deps.notify(record.spaceId, text);
    return true;
  }

  return { handleTurn, handleCompletion };
}

export type FriendCallService = ReturnType<typeof createFriendCallService>;
