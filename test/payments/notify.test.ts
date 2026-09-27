import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { notifyPaymentReceived } from "../../src/payments/notify.js";
import { AccountOnboardingStore } from "../../src/payments/xrpl/onboarding.js";
import { resetOnboardedCustomers } from "../../src/payments/xrpl/customers.js";
import { mergePeopleDirectory, formatPeopleDirectory } from "../../src/deepspace/directory.js";
import { buildContext, type SuggestInput } from "../../src/agent/suggest.js";

const ADDRESS = Wallet.generate().classicAddress;
let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  resetOnboardedCustomers();
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "pay-notify-"));
  dirs.push(dir);
  return new AccountOnboardingStore(join(dir, "accounts.json"));
}

describe("payment received notice", () => {
  it("DMs the Photon id tied to the destination wallet", async () => {
    const onboarding = store();
    onboarding.upsert({
      photonSenderId: "+19175550199",
      customerId: "onboard_keith",
      customerName: "Keith",
      xrplAddress: ADDRESS,
      createdAt: new Date().toISOString(),
      userId: "keith-user",
    });
    const sendToExternalId = vi.fn(async (_externalId: string, _body: string) => undefined);
    const sent = await notifyPaymentReceived(
      {
        spaceId: "s",
        fromName: "Alan",
        toName: "Keith",
        amountUsd: 1,
        paymentId: "p1",
        explorerUrl: "https://testnet.xrpl.org/transactions/AA",
        destination: ADDRESS,
        initiatorId: "+19175550000",
      },
      { onboarding, sendToExternalId },
    );
    expect(sent).toBe(true);
    expect(sendToExternalId).toHaveBeenCalledOnce();
    expect(sendToExternalId.mock.calls[0]?.[0]).toBe("+19175550199");
    expect(sendToExternalId.mock.calls[0]?.[1]).toContain("Alan sent you $1");
    expect(sendToExternalId.mock.calls[0]?.[1]).toContain("https://testnet.xrpl.org/transactions/AA");
  });

  it("does not notify the sender", async () => {
    const onboarding = store();
    onboarding.upsert({
      photonSenderId: "+19175550199",
      customerId: "onboard_keith",
      customerName: "Keith",
      xrplAddress: ADDRESS,
      createdAt: new Date().toISOString(),
    });
    const sendToExternalId = vi.fn(async (_externalId: string, _body: string) => undefined);
    const sent = await notifyPaymentReceived(
      {
        spaceId: "s",
        fromName: "Keith",
        toName: "Keith",
        amountUsd: 1,
        paymentId: "p1",
        destination: ADDRESS,
        initiatorId: "+19175550199",
      },
      { onboarding, sendToExternalId },
    );
    expect(sent).toBe(false);
    expect(sendToExternalId).not.toHaveBeenCalled();
  });

  it("asks DeepSpace when the wallet is only known by userId there", async () => {
    const onboarding = store();
    const notifyDeepSpace = vi.fn(async () => ({ queued: true, userId: "keith-user" }));
    const sent = await notifyPaymentReceived(
      {
        spaceId: "s",
        fromName: "Alan",
        toName: "Keith",
        amountUsd: 2,
        paymentId: "p2",
        destination: ADDRESS,
        initiatorId: "+19175550000",
      },
      { onboarding, sendToExternalId: async () => undefined, notifyDeepSpace },
    );
    expect(sent).toBe(true);
    expect(notifyDeepSpace).toHaveBeenCalledWith(
      expect.objectContaining({ xrplAddress: ADDRESS, body: expect.stringContaining("Alan sent you $2") }),
    );
  });
});

describe("Gemini people directory", () => {
  it("merges DeepSpace userId and wallet without phones", () => {
    const people = mergePeopleDirectory(
      [{ displayName: "Keith", xrplAddress: ADDRESS }],
      [{ userId: "keith-user", xrplAddress: ADDRESS }],
    );
    expect(people).toEqual([{ displayName: "Keith", userId: "keith-user", xrplAddress: ADDRESS }]);
    const prompt = formatPeopleDirectory(people).join("\n");
    expect(prompt).toContain("keith-user");
    expect(prompt).toContain(ADDRESS);
    expect(prompt).not.toMatch(/\+1/);
  });

  it("puts the directory in the Gemini user context", () => {
    const input: SuggestInput = {
      isGroup: false,
      asker: "Alan",
      question: "who can I pay?",
      transcript: [],
      personalized: true,
      currentUser: { id: "alan-user", displayName: "Alan" },
      peopleDirectory: [{ displayName: "Keith", userId: "keith-user", xrplAddress: ADDRESS }],
    };
    const context = buildContext(input);
    expect(context).toContain("DEEPSPACE PEOPLE");
    expect(context).toContain("keith-user");
    expect(context).toContain(ADDRESS);
    expect(context).not.toMatch(/\+1917/);
  });
});
