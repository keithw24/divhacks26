/** Dollar-denominated request. Execution never happens from this object alone. */
export interface PaymentExtraction {
  intent: "SEND_PAYMENT" | "NONE";
  recipientName: string | null;
  amountUsd: number | null;
  memo: string | null;
}

export type PaymentStatus =
  | "AWAITING_CONFIRMATION"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface PaymentRecord {
  id: string;
  /** Stable for the life of this pending payment. Sent to the provider as the idempotency key. */
  idempotencyKey: string;
  photonSpaceId: string;
  initiatorId: string;
  initiatorName?: string;
  status: PaymentStatus;
  recipientName: string;
  destination: string;
  amountUsd: number;
  memo: string | null;
  transactionId?: string;
  providerStatus?: string;
  /** What the sandbox actually moved. Demo mode uses testnet XRP, not bank USD. */
  submittedAsset?: string;
  submittedAmount?: string;
  submittedDrops?: string;
  createdAt: string;
  updatedAt: string;
  /** Person transfers are the default. Reservation deposits are merchant payments linked to a booking. */
  purpose?: "PERSON_TRANSFER" | "RESERVATION_DEPOSIT";
  recipientKind?: "PERSON" | "MERCHANT";
  parentReservationId?: string;
  /** Set when a person transfer settles between customer wallets on XRPL Testnet. */
  settlement?: "XRPL_TESTNET_CUSTOMER_WALLET";
  senderCustomerId?: string;
  recipientCustomerId?: string;
  explorerUrl?: string;
  /**
   * Person transfers: confirm_amount waits for yes / cancel / a new number.
   * awaiting_correction means they said the amount is wrong; a number is required before send.
   */
  confirmationPhase?: "confirm_amount" | "awaiting_correction";
}

export interface PaymentSendInput {
  destination: string;
  amountUsd: number;
  memo?: string;
  idempotencyKey: string;
  recipientName?: string;
  /** Effective cap for this submit. Must not exceed the process default. */
  maxUsd?: number;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  status: string;
  error?: string;
  submittedAsset?: string;
  submittedAmount?: string;
  submittedDrops?: string;
  balanceUsd?: number;
  nessiePurchaseId?: string;
}

/**
 * The only path that can move value. Gemini extracts fields. It does not implement this.
 * A confirmed result requires success, a transaction id, and a terminal success status.
 */
export interface PaymentProvider {
  sendPayment(input: PaymentSendInput): Promise<PaymentResult>;
}

export interface PaymentInterpreter {
  extract(input: { text: string; recentTexts: string[] }): Promise<PaymentExtraction>;
}

export interface PaymentTurnInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  messageId?: string;
  recentTexts?: string[];
}

export interface PaymentTurnResult {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
}
