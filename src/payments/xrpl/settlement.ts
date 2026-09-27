import { isValidClassicAddress } from "xrpl";
import { REGISTERED_CUSTOMERS, findRegisteredCustomer, type RegisteredCustomer } from "./customers.js";
import type { XrplPaymentExecutor } from "./executor.js";
import type { PaymentExecution } from "./types.js";
import type { TigerProfileDirectory } from "../../profiles/tiger.js";

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
  /** Existing Testnet address only. Missing means do not process the payment. */
  lookupRecipientAddress?(customerId: string): string | undefined;
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
    private readonly lookupAddress?: (customerId: string) => string | undefined,
    private readonly tiger?: TigerProfileDirectory,
  ) {
    this.sendersFn = typeof senders === "function" ? senders : () => senders;
  }

  private senderMap(): Map<string, string> {
    return new Map(Object.entries(this.sendersFn()).map(([id, customerId]) => [normalizeSenderId(id), customerId]));
  }

  resolveSender(input: { senderId?: string }): RegisteredCustomer | undefined {
    if (!input.senderId) return undefined;
    const customerId = this.senderMap().get(normalizeSenderId(input.senderId));
    const customer = customerId ? findRegisteredCustomer(customerId) : undefined;
    if (customer && this.tiger && !this.tiger.walletForCustomer(customer.customerId)) return undefined;
    return customer;
  }

  resolveRecipient(name: string): RegisteredCustomer | undefined {
    return this.tiger?.resolveName(name, true) ?? findRegisteredCustomer(name);
  }

  lookupRecipientAddress(customerId: string): string | undefined {
    const address = (this.tiger?.walletForCustomer(customerId) ?? this.lookupAddress?.(customerId))?.trim();
    return address && isValidClassicAddress(address) ? address : undefined;
  }

  knownNames(): string[] {
    return [
      ...new Set([
        ...(this.tiger?.names() ?? []),
        ...REGISTERED_CUSTOMERS.map((customer) => customer.customerName),
        ...(this.extraNames?.() ?? []),
      ]),
    ];
  }

  settle(input: SettlementRequest): Promise<PaymentExecution> {
    if (this.tiger) {
      const senderAddress = this.tiger.walletForCustomer(input.senderCustomerId);
      const recipient = this.tiger.resolveName(input.recipientName);
      const recipientAddress = recipient ? this.tiger.walletForCustomer(recipient.customerId) : undefined;
      if (senderAddress && recipientAddress && recipient) {
        if (this.executor.walletAddressFor(input.senderCustomerId) !== senderAddress) {
          throw new Error("Tiger sender wallet does not match the signing wallet");
        }
        if (this.executor.walletAddressFor(recipient.customerId) !== recipientAddress) {
          throw new Error("Tiger recipient wallet does not match the registered wallet");
        }
      }
    }
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
