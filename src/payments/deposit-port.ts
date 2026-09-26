import type { PaymentRecord, PaymentStatus } from "./types.js";

export interface DepositSyncInput {
  spaceId: string;
  senderId: string;
  senderName?: string;
  reservationId: string;
  merchantName: string;
  destination: string;
  amountUsd: number;
  memo: string;
  /** Deterministic key for this payment obligation. Reused on retry so the ledger sees one invoice. */
  idempotencyKey?: string;
}

export interface DepositExecuteInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  paymentId: string;
}

export type DepositExecuteOutcome =
  | "succeeded"
  | "already_succeeded"
  | "failed"
  | "uncertain"
  | "unauthorized"
  | "in_progress";

export interface DepositExecuteResult {
  outcome: DepositExecuteOutcome;
  payment?: PaymentRecord;
  reply?: string;
}

export interface DepositPaymentPort {
  syncDeposit(input: DepositSyncInput): PaymentRecord;
  /** Settled or in-flight record for this obligation key, if any. */
  findDeposit(idempotencyKey: string): PaymentRecord | undefined;
  executeDeposit(input: DepositExecuteInput): Promise<DepositExecuteResult>;
  cancelDeposit(input: { spaceId: string; senderId?: string; paymentId: string }): {
    cancelled: boolean;
    unauthorized?: boolean;
    status?: PaymentStatus;
  };
}
