import { describe, expect, it } from "vitest";
import { latestTestnetPaymentLink } from "../../src/payments/xrpl/latest-tx.js";

const ACCOUNT = "rBQUYX8GqNYUdRJeSkuessmd6x4eiUW2JD";
const NEWEST = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OLDER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("latest Testnet transaction link", () => {
  it("takes the first transaction link on the account page", async () => {
    const found = await latestTestnetPaymentLink({
      account: ACCOUNT,
      fetchPage: async () =>
        `<a href="/transactions/${NEWEST}">newest</a><a href="/transactions/${OLDER}">older</a>`,
      ledgerHash: async () => {
        throw new Error("ledger should not run");
      },
    });
    expect(found).toEqual({
      url: `https://testnet.xrpl.org/transactions/${NEWEST}`,
      hash: NEWEST,
    });
  });

  it("falls back to the ledger when the page has no hashes", async () => {
    const found = await latestTestnetPaymentLink({
      account: ACCOUNT,
      fetchPage: async () => "<html></html>",
      ledgerHash: async () => NEWEST,
    });
    expect(found).toEqual({
      url: `https://testnet.xrpl.org/transactions/${NEWEST}`,
      hash: NEWEST,
    });
  });

  it("notes failure when neither the page nor the ledger has a transaction", async () => {
    await expect(
      latestTestnetPaymentLink({
        account: ACCOUNT,
        fetchPage: async () => {
          throw new Error("page down");
        },
        ledgerHash: async () => undefined,
      }),
    ).resolves.toEqual({ failed: true });
  });
});
