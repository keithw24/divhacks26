import { runConversationTurn, type TurnActions, type TurnOutcome } from "../agent/turn.js";
import type { SuggestInput } from "../agent/suggest.js";
import type { TransportationService } from "./service.js";

export interface PhotonTextMessage {
  spaceId: string;
  senderId?: string;
  senderKind?: string;
  direction?: "inbound" | "outbound";
  text: string;
  isGroup?: boolean;
}

export interface PhotonActions extends TurnActions {}

/**
 * Testable inbound path used by the Photon listener.
 * Transportation is handled first. Other messages go to the Gemini suggest path.
 */
export async function processPhotonTextMessage(
  message: PhotonTextMessage,
  actions: PhotonActions,
  options: {
    autoReply: boolean;
    transport: TransportationService;
    suggest?: (input: SuggestInput) => Promise<string>;
    transcript?: SuggestInput["transcript"];
    location?: SuggestInput["location"];
    recordAssistant?: (text: string) => void;
  },
): Promise<TurnOutcome> {
  return runConversationTurn(
    {
      spaceId: message.spaceId,
      senderId: message.senderId,
      senderKind: message.senderKind,
      direction: message.direction ?? "inbound",
      isGroup: message.isGroup ?? false,
      question: message.text.trim() ? message.text : null,
    },
    actions,
    {
      autoReply: options.autoReply,
      handleTransport: (request) => options.transport.handle(request),
      suggest:
        options.suggest ??
        (async () => {
          throw new Error("GEMINI_API_KEY is not set");
        }),
      transcript: () => options.transcript ?? [],
      location: options.location,
      recordAssistant: options.recordAssistant ?? (() => undefined),
    },
  );
}
