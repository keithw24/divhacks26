import { userIdFor } from "../identity/users.js";
import { normalizePhotonIdentifier, type UpsertTigerUserProfile } from "./tiger.js";

export interface RippleDemoAccount {
  userId?: string;
  photonSenderId?: string;
  customerName?: string;
  customerId?: string;
  xrplAddress?: string;
}

export interface RippleDemoWallet {
  customerId?: string;
  customerName?: string;
  xrplAddress?: string;
}

/** Map gitignored ripple-demo files onto Tiger upserts. Photon handles are hashed by the store. */
export function profilesFromRippleDemo(input: {
  accounts?: RippleDemoAccount[];
  wallets?: RippleDemoWallet[];
}): UpsertTigerUserProfile[] {
  const walletByCustomer = new Map<string, string>();
  for (const wallet of input.wallets ?? []) {
    const id = wallet.customerId?.trim();
    const address = wallet.xrplAddress?.trim();
    if (id && address) walletByCustomer.set(id, address);
  }

  const rows: UpsertTigerUserProfile[] = [];
  const seen = new Set<string>();
  for (const account of input.accounts ?? []) {
    const photonSenderId = account.photonSenderId?.trim();
    const handle = photonSenderId ? normalizePhotonIdentifier(photonSenderId) : undefined;
    const userId = account.userId?.trim() || (handle ? userIdFor(handle) : "");
    if (!userId || seen.has(userId)) continue;
    const walletAddress = account.xrplAddress?.trim() || (account.customerId ? walletByCustomer.get(account.customerId) : undefined);
    if (!handle && !walletAddress) continue;
    seen.add(userId);
    rows.push({
      userId,
      ...(handle ? { photonIdentifier: handle } : {}),
      ...(account.customerName?.trim() ? { displayName: account.customerName.trim() } : {}),
      ...(walletAddress ? { walletAddress } : {}),
    });
  }
  return rows;
}
