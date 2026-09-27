import type { ReservationHandlerResult } from "../agent/turn.js";
import { askedForTestWallet, continuesCapabilityThread, isAgentCapabilityTopic } from "../agent/thread.js";
import { classifyPaymentMessage } from "./intent.js";
import { testnetAccountUrl } from "./xrpl/explorer.js";
import type { AccountOnboardingService } from "./xrpl/onboarding.js";

export interface WalletChatInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  recentTexts?: string[];
}

export interface WalletChatDeps {
  onboarding?: AccountOnboardingService;
}

function howToPay(address?: string): string {
  const wallet = address
    ? `Your XRPL Testnet wallet is ${address}. ${testnetAccountUrl(address) ?? ""}`.trim()
    : "Once this number has a Testnet wallet, you can send from chat.";
  return `${wallet} To pay someone, text Send Keith $1 (or another registered name). I'll quote the amount and wait for yes — nothing leaves without that. Test XRP only, not real money.`;
}

function classify(text: string, recent: readonly string[]): "create" | "howto" | "none" {
  const payment = classifyPaymentMessage(text).kind;
  if (payment !== "none") return "none";
  if (askedForTestWallet(text)) return "create";
  if (isAgentCapabilityTopic(text) || continuesCapabilityThread(text, recent)) return "howto";
  return "none";
}

export class WalletChatService {
  constructor(private readonly deps: WalletChatDeps = {}) {}

  async handleTurn(input: WalletChatInput): Promise<ReservationHandlerResult> {
    const recent = input.recentTexts ?? [];
    const kind = classify(input.text, recent);
    if (kind === "none") return { handled: false };

    if (kind === "howto") {
      const existing = input.senderId ? this.deps.onboarding?.publicView(input.senderId) : undefined;
      return { handled: true, reply: howToPay(existing?.xrplAddress), acknowledgement: "👍" };
    }

    if (!this.deps.onboarding || !input.senderId) {
      return {
        handled: true,
        reply: "I can set up an XRPL Testnet wallet for this iMessage number, but wallet creation isn't enabled in this process. Use the site wallet button, or ask again after onboarding is on.",
        acknowledgement: "👀",
      };
    }

    try {
      const enrolled = await this.deps.onboarding.enroll({
        photonSenderId: input.senderId,
        displayName: input.senderName,
        provisionWallet: true,
      });
      if (!enrolled.xrplAddress) {
        return {
          handled: true,
          reply: "I linked this number, but couldn't fund a Testnet wallet just now. Try again in a minute.",
          acknowledgement: "👀",
        };
      }
      const prefix = enrolled.created ? "Made you an XRPL Testnet wallet." : "You already have an XRPL Testnet wallet.";
      return {
        handled: true,
        reply: `${prefix} ${howToPay(enrolled.xrplAddress)}`,
        acknowledgement: "👍",
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
      if (code === "invalid_photon_sender") {
        return {
          handled: true,
          reply: "I need this chat to be tied to your iMessage number before I can make a Testnet wallet.",
          acknowledgement: "👀",
        };
      }
      return {
        handled: true,
        reply: "Couldn't create a Testnet wallet right now. Chat still works; try again in a bit.",
        acknowledgement: "👀",
      };
    }
  }
}
