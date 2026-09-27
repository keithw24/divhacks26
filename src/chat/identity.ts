/**
 * Photon project credentials identify the *agent line*, not the human.
 * People must be keyed by sender id, sender address, or the other party in a DM guid.
 * Never use space.phone on a shared plan (it is a sentinel).
 */

const SENTINELS = new Set(["someone", "any", "shared", "unknown", ""]);

export function dmPeerFromSpaceId(spaceId: string): string | undefined {
  if (!spaceId.includes(";-;")) return undefined;
  const peer = spaceId.split(";-;").pop()?.trim();
  if (!peer || SENTINELS.has(peer.toLowerCase())) return undefined;
  return peer;
}

export function isUsablePhotonPersonId(value: string | undefined): boolean {
  const id = value?.trim() ?? "";
  if (id.length < 8) return false;
  if (SENTINELS.has(id.toLowerCase())) return false;
  return true;
}

export function resolvePhotonPersonId(input: {
  senderId?: string;
  senderAddress?: string;
  senderKind?: string;
  spaceId?: string;
}): { id: string; source: "sender" | "sender_address" | "dm_space" } | undefined {
  if (input.senderKind === "agent") return undefined;
  if (isUsablePhotonPersonId(input.senderId)) {
    return { id: input.senderId!.trim(), source: "sender" };
  }
  if (isUsablePhotonPersonId(input.senderAddress)) {
    return { id: input.senderAddress!.trim(), source: "sender_address" };
  }
  const peer = input.spaceId ? dmPeerFromSpaceId(input.spaceId) : undefined;
  if (isUsablePhotonPersonId(peer)) return { id: peer!, source: "dm_space" };
  return undefined;
}

export function senderAddressField(sender: object | undefined): string | undefined {
  if (!sender) return undefined;
  const extra = sender as { address?: unknown };
  return typeof extra.address === "string" && extra.address.trim() ? extra.address.trim() : undefined;
}
