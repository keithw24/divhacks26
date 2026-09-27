import { receivedPaymentText } from "./format.js";
import type { AccountOnboardingStore, OnboardedAccount } from "./xrpl/onboarding.js";

export interface PaymentNotice {
  spaceId: string;
  fromName: string;
  toName: string;
  amountUsd: number;
  paymentId: string;
  explorerUrl?: string;
  destination?: string;
  recipientCustomerId?: string;
  initiatorId?: string;
}

export interface PaymentNotifyPorts {
  onboarding: AccountOnboardingStore;
  /** iMessage (or other channel) address to deliver to. Never logged. */
  sendToExternalId: (externalId: string, body: string) => Promise<void>;
  /** DeepSpace: resolve userId from wallet address and queue an outbox notice. */
  notifyDeepSpace?: (input: {
    xrplAddress?: string;
    userId?: string;
    body: string;
  }) => Promise<{ queued: boolean; userId?: string | null }>;
}

function accountFor(notice: PaymentNotice, store: AccountOnboardingStore): OnboardedAccount | undefined {
  if (notice.destination) {
    const byAddress = store.findByAddress(notice.destination);
    if (byAddress) return byAddress;
  }
  if (notice.recipientCustomerId) {
    const byCustomer = store.findByCustomerId(notice.recipientCustomerId);
    if (byCustomer) return byCustomer;
  }
  const byName = store.findByDisplayName(notice.toName);
  if (!byName) return undefined;
  return store.list().find((row) => row.customerId === byName.customerId);
}

/**
 * Tell the payee a Testnet payment arrived. Prefers the Photon id tied to the
 * destination wallet; otherwise asks DeepSpace to look up the userId for that address.
 */
export async function notifyPaymentReceived(notice: PaymentNotice, ports: PaymentNotifyPorts): Promise<boolean> {
  if (notice.amountUsd <= 0) return false;
  const account = accountFor(notice, ports.onboarding);
  if (account?.photonSenderId && notice.initiatorId && account.photonSenderId === notice.initiatorId) {
    return false;
  }
  const body = receivedPaymentText({
    fromName: notice.fromName,
    amountUsd: notice.amountUsd,
    explorerUrl: notice.explorerUrl,
  });

  if (account?.photonSenderId) {
    await ports.sendToExternalId(account.photonSenderId, body);
    return true;
  }

  if (ports.notifyDeepSpace) {
    const result = await ports.notifyDeepSpace({
      xrplAddress: notice.destination || account?.xrplAddress,
      userId: account?.userId,
      body,
    });
    return Boolean(result.queued);
  }
  return false;
}
