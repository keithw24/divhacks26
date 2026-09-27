export interface LedgerShare {
  key: string;
  name: string;
  cents: number;
}

export interface LedgerEntry {
  id: string;
  spaceId: string;
  createdAt: string;
  kind: "expense" | "transfer";
  payerKey: string;
  payerName: string;
  amountCents: number;
  memo: string | null;
  payeeKey?: string;
  payeeName?: string;
  shares?: LedgerShare[];
  paymentId?: string;
  explorerUrl?: string;
}

export interface LedgerMember {
  key: string;
  name: string;
}

export interface SuggestedTransfer {
  fromKey: string;
  fromName: string;
  toKey: string;
  toName: string;
  cents: number;
}

export interface SettledPersonPayment {
  spaceId: string;
  fromName: string;
  toName: string;
  amountUsd: number;
  paymentId: string;
  explorerUrl?: string;
}
