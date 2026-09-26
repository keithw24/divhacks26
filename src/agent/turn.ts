import type { SuggestInput } from "./suggest.js";
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
  senderKind?: string;
  direction: "inbound" | "outbound";
  isGroup: boolean;
  /** Text the agent should answer. Null when a group message was not addressed to the agent. */
  question: string | null;
  messageId?: string;
}

export interface TurnDeps {
  autoReply: boolean;
  handleTransport(request: TransportationRequest): Promise<TransportationResult>;
  suggest(input: SuggestInput): Promise<string>;
  transcript(): SuggestInput["transcript"];
  location?: SuggestInput["location"];
  recordAssistant(text: string): void;
  noteCoordinates?(): void;
  handleReservation?(input: {
    spaceId: string;
    senderId?: string;
    text: string;
    transcript: SuggestInput["transcript"];
    messageId?: string;
  }): Promise<ReservationHandlerResult>;
}

export interface ReservationHandlerResult {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
  afterReply?: () => Promise<void>;
}

export type TurnOutcome = "ignored" | "unaddressed" | "silent" | "reservation" | "transport" | "gemini" | "failed";

export function errorCategory(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** Send once. A skipped threaded reply falls back to a normal space send. */
export async function deliverOnce(actions: Pick<TurnActions, "reply" | "send">, text: string): Promise<void> {
  const sent = await actions.reply(text);
  if (sent == null && actions.send) await actions.send(text);
}

/**
 * Photon inbound turn. Reservation handling runs first when a handler is configured.
 * Transportation runs next; everything else goes to Gemini.
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
      if (deps.handleReservation) {
        const reservation = await deps.handleReservation({
          spaceId: input.spaceId,
          senderId: input.senderId,
          text: input.question ?? "",
          transcript: deps.transcript(),
          messageId: input.messageId,
        });
        if (reservation.handled && reservation.reply) {
          outcome = "reservation";
          answer = reservation.reply;
          if (actions.react) await actions.react(reservation.acknowledgement ?? "👍").catch(() => undefined);
          await deliverOnce(actions, answer);
          delivered = true;
          if (reservation.afterReply) await reservation.afterReply();
          return;
        }
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
        if (actions.react) await actions.react(transportation.acknowledgement).catch(() => undefined);
      } else {
        outcome = "gemini";
        answer = await deps.suggest({
          isGroup: input.isGroup,
          asker: input.senderId ?? "someone",
          question: input.question ?? "",
          transcript: deps.transcript(),
          location: deps.location,
        });
        if (actions.react) await actions.react("👍").catch(() => undefined);
      }

      await deliverOnce(actions, answer);
      delivered = true;
    });
    if (delivered) deps.recordAssistant(answer);
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
