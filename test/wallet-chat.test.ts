import { describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { WalletChatService } from "../src/payments/wallet-chat.js";
import type { AccountOnboardingService } from "../src/payments/xrpl/onboarding.js";

const ADDRESS = Wallet.generate().classicAddress;

describe("wallet chat thread", () => {
  it("provisions on an explicit wallet ask, then explains payments on the follow-up", async () => {
    const enroll = vi.fn(async () => ({
      photonSenderId: "+19175550199",
      customerId: "onboard_test",
      customerName: "Alan",
      xrplAddress: ADDRESS,
      created: true,
    }));
    const publicView = vi.fn(() => ({ xrplAddress: ADDRESS }));
    const chat = new WalletChatService({
      onboarding: { enroll, publicView } as unknown as AccountOnboardingService,
    });

    const first = await chat.handleTurn({
      spaceId: "s",
      senderId: "+19175550199",
      senderName: "Alan",
      text: "can you make me an xrp test wallet",
    });
    expect(first.handled).toBe(true);
    expect(first.reply).toContain(ADDRESS);
    expect(first.reply).toMatch(/Send Keith \$1/);
    expect(JSON.stringify(first).toLowerCase()).not.toContain("seed");
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({ provisionWallet: true }));

    const second = await chat.handleTurn({
      spaceId: "s",
      senderId: "+19175550199",
      senderName: "Alan",
      text: "to make payments",
      recentTexts: ["can you make me an xrp test wallet"],
    });
    expect(second.handled).toBe(true);
    expect(second.reply).not.toMatch(/near me|walk|dinner|route/i);
    expect(second.reply).toMatch(/Send Keith \$1/);
  });

  it("does not steal a dinner request", async () => {
    const chat = new WalletChatService();
    const result = await chat.handleTurn({
      spaceId: "s",
      senderId: "+19175550199",
      text: "where should we get dinner near me",
    });
    expect(result.handled).toBe(false);
  });
});
