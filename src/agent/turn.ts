import type { SuggestInput } from "./suggest.js";
import { ackFor, reactionFor, type SocialRead } from "./social.js";
import { paymentInterrupts } from "../payments/intent.js";
import { ledgerInterrupts } from "../ledger/intent.js";
import type { TransportationRequest, TransportationResult } from "../transport/service.js";

export const FRIENDLY_FAILURE = "Sorry, something went wrong on my end. Try again in a sec?";

export interface TurnActions {
  /** The adapter chooses one supported delivery method for this reply. */
  reply(text: string): Promise<unknown>;
  /** Optional delivery method for reporting a failure before any answer was attempted. */
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
  handleWallet?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
    recentTexts?: string[];
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
  /** Area alerts: "watch my area", "anything going on near me?", "stop alerts". */
  handleAlerts?(input: { spaceId: string; text: string }): Promise<ReservationHandlerResult>;
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
  handleLedger?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
  }): Promise<ReservationHandlerResult>;
  /**
   * Cross-domain step. Resolves messages that only make sense against another agent's state
   * ("yes" with two things pending, "book the first one" after restaurants, "from dinner to the concert").
   */
  handleOrchestration?(input: {
    spaceId: string;
    senderId?: string;
    senderName?: string;
    text: string;
    isGroup: boolean;
    messageId?: string;
    handleTransport: (request: TransportationRequest) => Promise<TransportationResult>;
  }): Promise<ReservationHandlerResult & { outcome?: "payment" | "reservation" | "ticketing" | "transport" | "orchestration" }>;
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
  | "wallet"
  | "reservation"
  | "ticketing"
  | "meetup"
  | "ledger"
  | "support"
  | "transport"
  | "orchestration"
  | "alerts"
  | "gemini"
  | "failed";

export function errorCategory(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** Tapback when there is one. Undefined means "no tapback" (e.g. someone swearing in frustration). */
async function reactTo(actions: Pick<TurnActions, "react">, emoji: string | undefined): Promise<void> {
  if (emoji && actions.react) await actions.react(emoji).catch(() => undefined);
}

/** An empty provider result is not a safe reason to send the text again. */
export async function deliverOnce(actions: Pick<TurnActions, "reply" | "send">, text: string): Promise<void> {
  await actions.reply(text);
}

/**
 * Photon inbound turn. A new payment request or edit runs first, then the cross-domain step.
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

  let deliveryAttempted = false;
  const deliveryActions = {
    reply: async (text: string) => {
      deliveryAttempted = true;
      return actions.reply(text);
    },
  };
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
          await deliverOnce(deliveryActions, answer);
          delivered = true;
          if (payment.afterReply) await payment.afterReply();
          return;
        }
      }
      if (deps.handleLedger && ledgerInterrupts(question)) {
        const ledger = await deps.handleLedger({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
        });
        if (ledger.handled && ledger.reply) {
          outcome = "ledger";
          answer = ledger.reply;
          await reactTo(actions, ackFor(input.social, ledger.acknowledgement ?? "👍"));
          await deliverOnce(deliveryActions, answer);
          delivered = true;
          return;
        }
      }
      if (deps.handleOrchestration) {
        const orchestrated = await deps.handleOrchestration({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          isGroup: input.isGroup,
          messageId: input.messageId,
          handleTransport: (request) => deps.handleTransport(request),
        });
        if (orchestrated.handled && orchestrated.reply) {
          outcome = orchestrated.outcome ?? "orchestration";
          answer = orchestrated.reply;
          if (actions.react) await actions.react(orchestrated.acknowledgement ?? "👍").catch(() => undefined);
          await deliverOnce(deliveryActions, answer);
          delivered = true;
          if (orchestrated.afterReply) await orchestrated.afterReply();
          return;
        }
      }
      if (deps.handleAlerts) {
        const alerts = await deps.handleAlerts({ spaceId: input.spaceId, text: question });
        if (alerts.handled && alerts.reply) {
          outcome = "alerts";
          answer = alerts.reply;
          await reactTo(actions, ackFor(input.social, alerts.acknowledgement ?? "👍"));
          await deliverOnce(actions, answer);
          delivered = true;
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
        await deliverOnce(deliveryActions, answer);
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
          await deliverOnce(deliveryActions, answer);
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
          await deliverOnce(deliveryActions, answer);
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
          await deliverOnce(deliveryActions, answer);
          delivered = true;
          if (payment.afterReply) await payment.afterReply();
          return;
        }
      }
      if (deps.handleWallet) {
        const wallet = await deps.handleWallet({
          spaceId: input.spaceId,
          senderId: input.senderId,
          senderName: input.senderName,
          text: question,
          recentTexts: deps.transcript().map((line) => line.text),
        });
        if (wallet.handled && wallet.reply) {
          outcome = "wallet";
          answer = wallet.reply;
          await reactTo(actions, ackFor(input.social, wallet.acknowledgement ?? "👍"));
          await deliverOnce(deliveryActions, answer);
          delivered = true;
          return;
        }
      }
      if (await ticketing("fallback")) return;

      if (deps.support && input.social?.needsSupport) {
        outcome = "support";
        answer = await deps.support();
        await reactTo(actions, reactionFor(input.social));
        await deliverOnce(deliveryActions, answer);
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

      await deliverOnce(deliveryActions, answer);
      delivered = true;
    });
    if (delivered) deps.recordAssistant(answer, outcome);
    return outcome;
  } catch (error) {
    console.error(`reply failed: ${errorCategory(error)}`);
    if (!deliveryAttempted) {
      const notify = actions.send ?? actions.reply;
      await notify(FRIENDLY_FAILURE).catch(() => undefined);
    }
    return "failed";
  }
}
