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
  return `Send ${input.recipientName} ${formatUsd(input.amountUsd)}${forClause(input.memo)}?`;
}

export function successText(input: {
  recipientName: string;
  amountUsd: number;
  memo: string | null;
  transactionId?: string;
}): string {
  const base = `Sent ${formatUsd(input.amountUsd)} to ${input.recipientName}${forClause(input.memo)}.`;
  if (!input.transactionId) return base;
  const shown = input.transactionId.length > 12 ? input.transactionId.slice(0, 8) : input.transactionId;
  return `${base} Test tx: ${shown}.`;
}

export function alreadySentText(input: { recipientName: string; amountUsd: number; memo: string | null }): string {
  return `Already sent ${formatUsd(input.amountUsd)} to ${input.recipientName}${forClause(input.memo)}.`;
}

export function failureText(amountUsd: number): string {
  return `I couldn't send the ${formatUsd(amountUsd)} payment. Nothing was charged.`;
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

export function xrplSuccessText(input: {
  recipientName: string;
  amountUsd: number;
  memo: string | null;
  xrp: string;
  explorerUrl: string | null;
  transactionHash: string;
}): string {
  const base = `Sent ${formatUsd(input.amountUsd)} to ${input.recipientName}${forClause(input.memo)} as ${input.xrp} test XRP on XRPL Testnet (no real money).`;
  return `${base} Validated: ${input.explorerUrl ?? input.transactionHash}`;
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
