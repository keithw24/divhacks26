import { testnetExplorerLink } from "./xrpl/explorer.js";

export function formatUsd(amount: number): string {
  const cents = Math.round(amount * 100);
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function forClause(memo: string | null | undefined): string {
  const cleaned = memo?.trim();
  if (!cleaned) return "";
  return ` for ${cleaned}`;
}

export function confirmationText(input: { recipientName: string; amountUsd: number; memo: string | null }): string {
  const usd = formatUsd(input.amountUsd);
  return (
    `I'm about to send ${input.recipientName} ${usd}${forClause(input.memo)}. ` +
    `Confirm ${usd}? Yes to send it, cancel to stop, or tell me the correct amount.`
  );
}

export function correctionPromptText(input: { recipientName: string; amountUsd: number }): string {
  return (
    `I won't send until I have the correct amount. What should I send ${input.recipientName}? ` +
    `Tracked amount is still ${formatUsd(input.amountUsd)}. Cancel to stop.`
  );
}

export function askNewAmountText(): string {
  return "How much would you like to send instead?";
}

export function cancelledPaymentText(): string {
  return "Okay, I won't send it.";
}

export function expiredConfirmationText(input: { recipientName: string; amountUsd: number }): string {
  return `That payment confirmation request expired. Tell me if you'd still like to send ${formatUsd(input.amountUsd)} to ${input.recipientName}.`;
}

export function successText(input: {
  recipientName: string;
  amountUsd: number;
  memo: string | null;
  transactionId?: string;
  submittedAsset?: string;
  nessiePurchaseId?: string;
  explorerUrl?: string | null;
  explorerLookupFailed?: boolean;
}): string {
  const base = `Sent ${formatUsd(input.amountUsd)} to ${input.recipientName}${forClause(input.memo)}.`;
  const bits: string[] = [base];
  if (input.nessiePurchaseId) {
    const shown = input.nessiePurchaseId.length > 12 ? input.nessiePurchaseId.slice(0, 8) : input.nessiePurchaseId;
    bits.push(`Nessie sim: ${shown}.`);
  } else if (input.submittedAsset === "USD" && input.transactionId && !testnetExplorerLink(input.transactionId)) {
    const shown = input.transactionId.length > 12 ? input.transactionId.slice(0, 8) : input.transactionId;
    bits.push(`Nessie sim: ${shown}.`);
  }
  if (input.explorerLookupFailed) {
    bits.push("The payment went through, but I couldn't load the Testnet transaction link.");
    return bits.join(" ");
  }
  const url = transactionUrl(input.explorerUrl, input.transactionId, input.submittedAsset);
  if (url) bits.push(`XRPL Testnet: ${url}`);
  return bits.join(" ");
}

export function alreadySentText(input: {
  recipientName: string;
  amountUsd: number;
  memo: string | null;
  transactionId?: string;
  explorerUrl?: string | null;
  submittedAsset?: string;
}): string {
  const base = `Already sent ${formatUsd(input.amountUsd)} to ${input.recipientName}${forClause(input.memo)}.`;
  const url = transactionUrl(input.explorerUrl, input.transactionId, input.submittedAsset);
  return url ? `${base} XRPL Testnet: ${url}` : base;
}

function transactionUrl(
  explorerUrl: string | null | undefined,
  transactionId: string | undefined,
  submittedAsset?: string,
): string | null {
  if (explorerUrl?.includes("testnet.xrpl.org/transactions/")) return explorerUrl;
  const fromHash = testnetExplorerLink(transactionId);
  if (fromHash) return fromHash;
  if (submittedAsset === "XRP" && transactionId?.trim()) {
    return `${testnetExplorerLink(transactionId) ?? `https://testnet.xrpl.org/transactions/${transactionId.trim()}`}`;
  }
  return null;
}

/** User-visible line when a send is blocked or the provider fails closed. */
export function rejectedText(reason: string): string {
  const detail = reason
    .trim()
    .replace(/^transaction rejected\.?\s*/i, "")
    .replace(/\.+$/, "");
  return `Transaction rejected. ${detail}.`;
}

export function failureText(amountUsd: number): string {
  return rejectedText(`I couldn't send the ${formatUsd(amountUsd)} payment. Nothing was charged`);
}

export function overMaxText(maxUsd: number): string {
  return `I can only send up to ${formatUsd(maxUsd)} at a time.`;
}

export function missingDestinationText(name: string): string {
  return `I don't have a payment destination for ${name} yet.`;
}

export function unknownCustomerText(name: string): string {
  return `I can't pay ${name}: they aren't a registered customer with an XRPL Testnet wallet. Nothing was sent.`;
}

export function unlinkedSenderText(): string {
  return "Your number isn't linked to an XRPL Testnet customer wallet yet, so I can't send from it.";
}

export function receivedPaymentText(input: {
  fromName: string;
  amountUsd: number;
  explorerUrl?: string;
}): string {
  const base = `${input.fromName} sent you ${formatUsd(input.amountUsd)} in test XRP.`;
  return input.explorerUrl ? `${base} XRPL Testnet: ${input.explorerUrl}` : `${base} Testnet only, not real money.`;
}

export function xrplSuccessText(input: {
  recipientName: string;
  amountUsd: number;
  memo: string | null;
  xrp: string;
  explorerUrl: string | null;
  explorerLookupFailed?: boolean;
  transactionHash: string;
}): string {
  const base = `Sent ${formatUsd(input.amountUsd)} to ${input.recipientName}${forClause(input.memo)} as ${input.xrp} test XRP on XRPL Testnet (no real money).`;
  if (input.explorerLookupFailed) {
    return `${base} The payment went through, but I couldn't load the Testnet transaction link.`;
  }
  const url =
    (input.explorerUrl?.includes("testnet.xrpl.org/transactions/") ? input.explorerUrl : null) ??
    testnetExplorerLink(input.transactionHash) ??
    input.explorerUrl;
  return url ? `${base} ${url}` : `${base} Validated: ${input.transactionHash}`;
}

export function xrplUnconfirmedText(amountUsd: number): string {
  return `I couldn't confirm the ${formatUsd(amountUsd)} payment on XRPL Testnet. I won't retry it; check the XRPL Testnet dashboard before asking again.`;
}

export function xrplLedgerRejectedText(input: { recipientName: string; amountUsd: number; engineResult: string }): string {
  return `XRPL Testnet rejected the ${formatUsd(input.amountUsd)} payment (${input.engineResult}). ${input.recipientName} did not receive it.`;
}

const DENIAL_REASONS: Record<string, string> = {
  UNKNOWN_RECIPIENT: "they aren't a registered customer",
  SELF_PAYMENT: "you can't pay yourself",
  SENDER_MISSING_WALLET: "you don't have an XRPL Testnet wallet yet",
  RECIPIENT_MISSING_WALLET: "they don't have an XRPL Testnet wallet yet",
  UNAUTHORIZED_SENDER: "your account isn't allowed to send payments",
  SPENDING_LIMIT_EXCEEDED: "it's over the spending limit",
  DAILY_SPENDING_LIMIT: "it would go over today's spending limit",
  INSUFFICIENT_BALANCE: "your Testnet wallet doesn't have enough XRP",
  DUPLICATE_PAYMENT: "that payment was already submitted",
  NETWORK_NOT_ALLOWED: "the connection isn't XRPL Testnet",
  INTENT_PAYLOAD_MISMATCH: "the transaction didn't match what you asked for",
  CONFIRMATION_REQUIRED: "it wasn't confirmed",
};

export function xrplDeniedText(input: { recipientName: string; amountUsd: number; reasonCode: string }): string {
  const why = DENIAL_REASONS[input.reasonCode] ?? "a payment safety check failed";
  return `I didn't send ${formatUsd(input.amountUsd)} to ${input.recipientName}: ${why} (${input.reasonCode}). Nothing moved on XRPL Testnet.`;
}
