import { describe, expect, it } from "vitest";
import { dmPeerFromSpaceId, resolvePhotonPersonId } from "../src/chat/identity.js";
import { photonSenderFromUserId, userIdFor } from "../src/identity/users.js";

describe("Photon person identity", () => {
  it("does not use a missing sender as a shared someone id", () => {
    expect(resolvePhotonPersonId({ senderKind: "user" })).toBeUndefined();
    expect(resolvePhotonPersonId({ senderId: "someone" })).toBeUndefined();
  });

  it("prefers the message sender over the shared project line", () => {
    const resolved = resolvePhotonPersonId({
      senderId: "+19175550101",
      spaceId: "any;-;+19175550999",
    });
    expect(resolved).toEqual({ id: "+19175550101", source: "sender" });
  });

  it("falls back to the DM peer encoded in the space id when sender is missing", () => {
    expect(dmPeerFromSpaceId("any;-;+19175550101")).toBe("+19175550101");
    expect(
      resolvePhotonPersonId({
        spaceId: "any;-;keith@icloud.com",
      }),
    ).toEqual({ id: "keith@icloud.com", source: "dm_space" });
  });

  it("does not treat a group chat guid as a person", () => {
    expect(dmPeerFromSpaceId("iMessage;+;chat123")).toBeUndefined();
    expect(resolvePhotonPersonId({ spaceId: "iMessage;+;chat123" })).toBeUndefined();
  });

  it("recovers a sendable Photon handle from a photon: Tiger user id", () => {
    expect(photonSenderFromUserId(userIdFor("+15555550123"))).toBe("+15555550123");
    expect(photonSenderFromUserId("site:a8a3ad6d30df29e0c6404b3eb8a6c85a")).toBeUndefined();
  });
});
