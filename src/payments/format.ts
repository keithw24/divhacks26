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
