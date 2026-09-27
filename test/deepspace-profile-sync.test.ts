import { describe, expect, it, vi } from "vitest";
import { syncDeepSpaceProfiles } from "../src/deepspace/profile-sync.js";
import { TigerUserProfileStore, photonIdentifierHash } from "../src/profiles/tiger.js";

describe("DeepSpace to Tiger profile sync", () => {
  it("stores user id, name, wallet and only a hash of the Photon identity", async () => {
    const address = "rBQUYX8GqNYUdRJeSkuessmd6x4eiUW2JD";
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ user_id: "deep-user", display_name: "Keith", wallet_address: address, backboard_assistant_id: null }],
        rowCount: 1,
      });
    const profiles = new TigerUserProfileStore({ query } as never);
    const client = {
      directory: vi.fn(async () => [{
        userId: "deep-user",
        displayName: "Keith",
        xrplAddress: address,
        photonIdentifier: "+19175550199",
      }]),
    };

    await expect(syncDeepSpaceProfiles(client, profiles)).resolves.toBe(1);
    const params = query.mock.calls[1]?.[1] as unknown[];
    expect(params).toEqual(["deep-user", "Keith", photonIdentifierHash("+19175550199"), address, null]);
    expect(params).not.toContain("+19175550199");
  });

  it("stores literal zero when a registered user has no wallet", async () => {
    const upsert = vi.fn(async () => ({ userId: "maya", displayName: "Maya", walletAddress: "0" }));
    const count = await syncDeepSpaceProfiles(
      { directory: async () => [{ userId: "maya", displayName: "Maya", xrplAddress: "0" }] },
      { upsert },
    );
    expect(count).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: "maya", displayName: "Maya", walletAddress: "0" }));
  });
});
