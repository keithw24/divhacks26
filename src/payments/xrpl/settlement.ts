import { REGISTERED_CUSTOMERS, findRegisteredCustomer, type RegisteredCustomer } from "./customers.js";
import type { XrplPaymentExecutor } from "./executor.js";
import type { PaymentExecution } from "./types.js";

export interface SettlementRequest {
  paymentId: string;
  senderCustomerId: string;
  recipientName: string;
  amountUsd: number;
  memo: string | null;
  spaceId: string;
}

/**
 * What PaymentService needs to settle a confirmed person-to-person payment
 * between customer wallets. Lookups are read-only: resolving a name never creates a wallet.
 */
export interface CustomerSettlementPort {
  resolveSender(input: { senderId?: string; senderName?: string }): RegisteredCustomer | undefined;
  resolveRecipient(name: string): RegisteredCustomer | undefined;
  knownNames(): string[];
  settle(input: SettlementRequest): Promise<PaymentExecution>;
}

/**
 * Photon sender → registered customer comes only from an explicit map (XRPL_CUSTOMER_SENDERS_JSON).
 * A display name is never enough to spend from someone's wallet.
 */
export class CustomerWalletSettlement implements CustomerSettlementPort {
  private readonly sendersFn: () => Record<string, string>;

  constructor(
    private readonly executor: XrplPaymentExecutor,
    senders: Record<string, string> | (() => Record<string, string>),
    private readonly extraNames?: () => string[],
  ) {
    this.sendersFn = typeof senders === "function" ? senders : () => senders;
  }

  private senderMap(): Map<string, string> {
    return new Map(Object.entries(this.sendersFn()).map(([id, customerId]) => [normalizeSenderId(id), customerId]));
  }

  resolveSender(input: { senderId?: string }): RegisteredCustomer | undefined {
    if (!input.senderId) return undefined;
    const customerId = this.senderMap().get(normalizeSenderId(input.senderId));
    return customerId ? findRegisteredCustomer(customerId) : undefined;
  }

  resolveRecipient(name: string): RegisteredCustomer | undefined {
    return findRegisteredCustomer(name);
  }

  knownNames(): string[] {
    return [...new Set([...REGISTERED_CUSTOMERS.map((customer) => customer.customerName), ...(this.extraNames?.() ?? [])])];
  }

  settle(input: SettlementRequest): Promise<PaymentExecution> {
    return this.executor.execute({
      paymentId: input.paymentId,
      senderCustomerId: input.senderCustomerId,
      recipientName: input.recipientName,
      amountUsd: input.amountUsd,
      memo: input.memo,
      spaceId: input.spaceId,
      mode: "confirmed",
      humanConfirmed: true,
    });
  }
}

/** {"+15551234567":"rohan","keith@example.com":"keith"}. Entries for unregistered customers are dropped. */
export function parseCustomerSenders(json: string | undefined): Record<string, string> {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.warn("XRPL_CUSTOMER_SENDERS_JSON is not valid JSON; no Photon sender is linked to a wallet.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [senderId, value] of Object.entries(parsed)) {
    const customer = typeof value === "string" ? findRegisteredCustomer(value) : undefined;
    if (customer && senderId.trim()) out[senderId.trim()] = customer.customerId;
  }
  return out;
}

export function normalizeSenderId(id: string): string {
  const trimmed = id.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.replace(/[\s().-]/g, "");
}
