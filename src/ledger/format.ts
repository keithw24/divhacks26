import { formatUsd } from "../payments/format.js";
import type { SuggestedTransfer } from "./types.js";

export function expenseLoggedText(input: {
  payerName: string;
  amountUsd: number;
  memo: string | null;
  splitCount: number;
  shareUsd: number;
}): string {
  const what = input.memo ? ` for ${input.memo}` : "";
  const n = input.splitCount;
  const each = formatUsd(input.shareUsd);
  return (
    `Logged ${formatUsd(input.amountUsd)}${what} on ${input.payerName}, split ${n} way${n === 1 ? "" : "s"} (${each} each). ` +
    `Ask me to settle up when you want the tally.`
  );
}

export function settleText(transfers: SuggestedTransfer[]): string {
  if (transfers.length === 0) return "You're all even.";
  const lines = transfers.map((row) => `• ${row.fromName} → ${row.toName} ${formatUsd(row.cents / 100)}`);
  return (
    `Still open:\n${lines.join("\n")}\n` +
    `I didn't send anything. Each person can say “send <name> $<amount>” and confirm with yes if they want to pay. I won't keep asking.`
  );
}
