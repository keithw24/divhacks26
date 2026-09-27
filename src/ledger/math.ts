import type { LedgerMember, SuggestedTransfer } from "./types.js";

const CENT = (cents: number) => Math.round(cents);

export function splitEven(totalCents: number, members: LedgerMember[]): { key: string; name: string; cents: number }[] {
  if (members.length === 0 || totalCents <= 0) return [];
  const n = members.length;
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  return members.map((member) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { key: member.key, name: member.name, cents: base + extra };
  });
}

/** Net cents: positive means others owe this person. */
export function netBalances(
  members: LedgerMember[],
  movements: {
    kind: "expense" | "transfer";
    payerKey: string;
    amountCents: number;
    payeeKey?: string;
    shares?: { key: string; cents: number }[];
  }[],
): Map<string, number> {
  const net = new Map<string, number>();
  const bump = (key: string, delta: number) => net.set(key, CENT((net.get(key) ?? 0) + delta));
  for (const member of members) bump(member.key, 0);
  for (const row of movements) {
    if (row.kind === "expense") {
      bump(row.payerKey, row.amountCents);
      for (const share of row.shares ?? []) bump(share.key, -share.cents);
    } else if (row.payeeKey) {
      bump(row.payerKey, row.amountCents);
      bump(row.payeeKey, -row.amountCents);
    }
  }
  return net;
}

export function settleTransfers(members: LedgerMember[], net: Map<string, number>): SuggestedTransfer[] {
  const names = new Map(members.map((member) => [member.key, member.name]));
  const debtors = [...net.entries()].filter(([, cents]) => cents < -1).map(([key, cents]) => ({ key, cents: -cents }));
  const creditors = [...net.entries()].filter(([, cents]) => cents > 1).map(([key, cents]) => ({ key, cents }));
  debtors.sort((a, b) => b.cents - a.cents);
  creditors.sort((a, b) => b.cents - a.cents);
  const out: SuggestedTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const owe = debtors[i]!;
    const due = creditors[j]!;
    const cents = Math.min(owe.cents, due.cents);
    if (cents > 1) {
      out.push({
        fromKey: owe.key,
        fromName: names.get(owe.key) ?? "Someone",
        toKey: due.key,
        toName: names.get(due.key) ?? "Someone",
        cents,
      });
    }
    owe.cents -= cents;
    due.cents -= cents;
    if (owe.cents <= 1) i += 1;
    if (due.cents <= 1) j += 1;
  }
  return out;
}
