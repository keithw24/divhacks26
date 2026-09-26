import type { SuggestInput } from "./suggest.js";
import { ackFor, reactionFor, type SocialRead } from "./social.js";
import { paymentInterrupts } from "../payments/intent.js";
import type { TransportationRequest, TransportationResult } from "../transport/service.js";

export const FRIENDLY_FAILURE = "Sorry, something went wrong on my end. Try again in a sec?";

export interface TurnActions {
  /** Threaded Photon reply. Undefined means the provider skipped it. */
  reply(text: string): Promise<unknown>;
  /** Used only when reply does not produce a message and the adapter provides it. */
  send?(text: string): Promise<unknown>;
  react?(emoji: string): Promise<unknown>;
  responding<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TurnInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  senderKind?: string;
  direction: "inbound" | "outbound";
  isGroup: boolean;
  /** Text the agent should answer. Null when a group message was not addressed to the agent. */
  question: string | null;
  messageId?: string;
  /** Inferred mood and group dynamic for this turn. Shapes the tapback. */
  social?: SocialRead;
}

export interface TurnDeps {
  autoReply: boolean;
  handleTransport(request: TransportationRequest): Promise<TransportationResult>;
  suggest(input: SuggestInput): Promise<string>;
  transcript(): SuggestInput["transcript"];
  location?: SuggestInput["location"];
  recordAssistant(text: string, outcome?: TurnOutcome): void;
  noteCoordinates?(): void;
  handleReservation?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
    transcript: SuggestInput["transcript"];
    messageId?: string;
  }): Promise<ReservationHandlerResult>;
  handlePayment?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
    messageId?: string;
  }): Promise<ReservationHandlerResult>;
  /**
   * priority runs before reservations (event discovery, prices, purchase quotes).
   * fallback runs after reservations and payments, and only takes yes/no on a pending ticket purchase.
   */
  handleTicketing?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
    messageId?: string;
    phase: "priority" | "fallback";
  }): Promise<ReservationHandlerResult>;
  /** Friend-style reply for venting with nothing to look up. */
  support?(): Promise<string>;
  handleMeetup?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
    isGroup: boolean;
    messageId?: string;
  }): Promise<ReservationHandlerResult>;
}

export interface ReservationHandlerResult {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
  afterReply?: () => Promise<void>;
}

export type TurnOutcome =
  | "ignored"
  | "unaddressed"
  | "silent"
  | "voice"
  | "payment"
  | "reservation"
  | "ticketing"
  | "meetup"
  | "support"
  | "transport"
  | "gemini"
  | "failed";

export function errorCategory(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** Tapback when there is one. Undefined means "no tapback" (e.g. someone swearing in frustration). */
async function reactTo(actions: Pick<TurnActions, "react">, emoji: string | undefined): Promise<void> {
  if (emoji && actions.react) await actions.react(emoji).catch(() => undefined);
}

/** Send once. A skipped threaded reply falls back to a normal space send. */
export async function deliverOnce(actions: Pick<TurnActions, "reply" | "send">, text: string): Promise<void> {
  const sent = await actions.reply(text);
  if (sent == null && actions.send) await actions.send(text);
}

/**
 * Photon inbound turn. A new payment request or edit runs first.
 * Ticket discovery/pricing/quotes come next, then reservation handling, then a pending payment can take yes/no,
 * then a pending ticket purchase can take yes/no.
 * Transportation runs after that; everything else goes to Gemini.
 * Provider work stays inside responding(). One failure returns a short reply and does not throw.
 */
export async function runConversationTurn(
  input: TurnInput,
  actions: TurnActions,
  deps: TurnDeps,
): Promise<TurnOutcome> {
  if (input.direction !== "inbound" || input.senderKind === "agent") return "ignored";
  if (!input.question) return "unaddressed";
  if (!deps.autoReply) return "silent";

  let delivered = false;
  let outcome: TurnOutcome = "gemini";
  try {
    let answer = "";
    await actions.responding(async () => {
      deps.noteCoordinates?.();
      const question = input.question ?? "";
      if (deps.handlePayment && paymentInterrupts(question)) {
        const payment = await deps.handlePayment({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          messageId: input.messageId,
        });
        if (payment.handled && payment.reply) {
          outcome = "payment";
          answer = payment.reply;
          await reactTo(actions, ackFor(input.social, payment.acknowledgement ?? "👍"));
          await deliverOnce(actions, answer);
          delivered = true;
          if (payment.afterReply) await payment.afterReply();
          return;
        }
      }
      const ticketing = async (phase: "priority" | "fallback"): Promise<boolean> => {
        if (!deps.handleTicketing) return false;
        const result = await deps.handleTicketing({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          messageId: input.messageId,
          phase,
        });
        if (!result.handled || !result.reply) return false;
        outcome = "ticketing";
        answer = result.reply;
        await reactTo(actions, ackFor(input.social, result.acknowledgement ?? "👍"));
        await deliverOnce(actions, answer);
        delivered = true;
        if (result.afterReply) await result.afterReply();
        return true;
      };
      if (await ticketing("priority")) return;
      if (deps.handleReservation) {
        const reservation = await deps.handleReservation({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          transcript: deps.transcript(),
          messageId: input.messageId,
        });
        if (reservation.handled && reservation.reply) {
          outcome = "reservation";
          answer = reservation.reply;
          await reactTo(actions, ackFor(input.social, reservation.acknowledgement ?? "👍"));
          await deliverOnce(actions, answer);
          delivered = true;
          if (reservation.afterReply) await reservation.afterReply();
          return;
        }
      }
      if (deps.handleMeetup) {
        const meetup = await deps.handleMeetup({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          isGroup: input.isGroup,
          messageId: input.messageId,
        });
        if (meetup.handled && meetup.reply) {
          outcome = "meetup";
          answer = meetup.reply;
          await reactTo(actions, ackFor(input.social, meetup.acknowledgement ?? "👍"));
          await deliverOnce(actions, answer);
          delivered = true;
          return;
        }
      }
      if (deps.handlePayment) {
        const payment = await deps.handlePayment({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          messageId: input.messageId,
        });
        if (payment.handled && payment.reply) {
          outcome = "payment";
          answer = payment.reply;
          await reactTo(actions, ackFor(input.social, payment.acknowledgement ?? "👍"));
          await deliverOnce(actions, answer);
          delivered = true;
          if (payment.afterReply) await payment.afterReply();
          return;
        }
      }
      if (await ticketing("fallback")) return;

      if (deps.support && input.social?.needsSupport) {
        outcome = "support";
        answer = await deps.support();
        await reactTo(actions, reactionFor(input.social));
        await deliverOnce(actions, answer);
        delivered = true;
        return;
      }

      const transportation = await deps.handleTransport({
        spaceId: input.spaceId,
        senderId: input.senderId,
        text: input.question ?? "",
        isGroup: input.isGroup,
      });

      if (transportation.handled && transportation.reply) {
        outcome = "transport";
        answer = transportation.reply;
        await reactTo(actions, ackFor(input.social, transportation.acknowledgement));
      } else {
        outcome = "gemini";
        answer = await deps.suggest({
          isGroup: input.isGroup,
          asker: input.senderId ?? "someone",
          question: input.question ?? "",
          transcript: deps.transcript(),
          location: deps.location,
        });
        await reactTo(actions, reactionFor(input.social));
      }

      await deliverOnce(actions, answer);
      delivered = true;
    });
    if (delivered) deps.recordAssistant(answer, outcome);
    return outcome;
  } catch (error) {
    console.error(`reply failed: ${errorCategory(error)}`);
    if (!delivered) {
      const notify = actions.send ?? actions.reply;
      await notify(FRIENDLY_FAILURE).catch(() => undefined);
    }
    return "failed";
  }
}
