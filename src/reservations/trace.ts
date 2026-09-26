import type { PaymentHistoryEntry, ReservationPaymentState } from "./payment.js";
import type { ReservationRequest, ReservationStatus } from "./types.js";

export interface ReservationPaymentTrace {
  reservationId: string;
  restaurant: string;
  restaurantId?: string;
  reservationDate?: string;
  reservationTime?: string;
  partySize?: number;
  reservationStatus: ReservationStatus;
  confirmationNumber?: string;
  depositRequired: boolean;
  paymentType?: string;
  amountUsd?: number;
  perPersonUsd?: number;
  currency: "USD";
  source?: string;
  obligationId?: string;
  paymentId?: string;
  paymentState?: ReservationPaymentState;
  network: "xrpl-testnet" | "mock";
  senderWallet?: string;
  recipientWallet?: string;
  transactionHash?: string;
  explorerUrl?: string;
  ledgerResult?: string;
  paidAt?: string;
  expiresAt?: string;
  guardrail?: { decision: string; reasonCode: string; checks: { code: string; passed: boolean }[]; notApplicable?: string[] };
  /** Public XRPL evidence. validated is the only paid state. */
  payment?: {
    network: "xrpl-testnet";
    status: "validated" | "pending" | "failed";
    amountXrp: number;
    destination: string;
    transactionHash: string | null;
    ledgerIndex: number | null;
    validatedAt: string | null;
    explorerUrl: string | null;
    idempotencyKey: string;
  };
  failureCode?: string;
  stages: PaymentTraceStage[];
  timeline: PaymentHistoryEntry[];
}

export type PaymentTraceStageName =
  | "reservation_request"
  | "availability_lookup"
  | "deposit_requirement"
  | "authorization_request"
  | "user_authorization"
  | "terms_recheck"
  | "guardrail_approval"
  | "xrpl_submission"
  | "ledger_validation"
  | "reservation_confirmation";

export interface PaymentTraceStage {
  stage: PaymentTraceStageName;
  status: "done" | "pending" | "failed" | "not_reached";
  at?: string;
  detail?: string;
}

const XRPL_HASH = /^[0-9A-F]{64}$/i;

/**
 * Everything a judge needs to verify a restaurant payment, and nothing that can sign one.
 * Built field by field so a seed on some other object cannot leak through.
 */
export function reservationPaymentTrace(reservation: ReservationRequest, mode: "mock" | "ripple_test"): ReservationPaymentTrace {
  const deposit = reservation.deposit;
  const requirement = deposit?.requirement;
  const proof = deposit?.proof;
  const hash = deposit?.transactionId ?? proof?.transactionHash ?? undefined;
  const paid = deposit?.status === "PAID" || proof?.status === "validated";
  const history = deposit?.history ?? [];
  return {
    reservationId: reservation.id,
    restaurant: reservation.restaurant.name,
    restaurantId: requirement?.restaurantId ?? reservation.restaurant.placeId,
    reservationDate: requirement?.reservationDate ?? reservation.requestedDate,
    reservationTime: reservation.result?.confirmedTime ?? requirement?.reservationTime ?? reservation.requestedTime,
    partySize: requirement?.partySize ?? reservation.partySize,
    reservationStatus: reservation.status,
    confirmationNumber: reservation.result?.confirmationNumber,
    depositRequired: deposit?.required ?? false,
    paymentType: requirement?.paymentType ?? deposit?.paymentType,
    amountUsd: requirement?.amountUsd ?? deposit?.amountUsd,
    perPersonUsd: requirement?.perPersonUsd,
    currency: "USD",
    source: requirement?.source ?? deposit?.source,
    obligationId: requirement?.obligationId,
    paymentId: deposit?.paymentId,
    paymentState: deposit?.state,
    network: mode === "ripple_test" ? "xrpl-testnet" : "mock",
    senderWallet: deposit?.senderAddress,
    recipientWallet: requirement?.recipient,
    transactionHash: hash,
    explorerUrl:
      proof?.explorerUrl ??
      (paid && hash && XRPL_HASH.test(hash) && mode === "ripple_test" ? `https://testnet.xrpl.org/transactions/${hash}` : undefined),
    ledgerResult: deposit?.ledgerResult,
    paidAt: deposit?.paidAt,
    expiresAt: requirement?.expiresAt,
    guardrail: deposit?.policy
      ? {
          decision: deposit.policy.decision,
          reasonCode: deposit.policy.reasonCode,
          checks: deposit.policy.checks.map((check) => ({ code: check.code, passed: check.passed })),
          notApplicable: deposit.policy.notApplicable,
        }
      : undefined,
    payment: proof
      ? {
          network: "xrpl-testnet",
          status: proof.status,
          amountXrp: proof.amountXrp,
          destination: proof.destination,
          transactionHash: proof.transactionHash,
          ledgerIndex: proof.ledgerIndex,
          validatedAt: proof.validatedAt,
          explorerUrl: proof.explorerUrl,
          idempotencyKey: proof.idempotencyKey,
        }
      : undefined,
    failureCode: deposit?.failureCode,
    stages: paymentStages(history),
    timeline: history.map((entry) => ({ ...entry })),
  };
}

/**
 * The ten steps from request to booking. Steps after the latest ask only count
 * entries from the current attempt, so a failed earlier attempt does not read as done.
 */
function paymentStages(history: PaymentHistoryEntry[]): PaymentTraceStage[] {
  const askIndex = lastIndex(history, (entry) => entry.state === "PAYMENT_REQUIRED");
  const current = askIndex >= 0 ? history.slice(askIndex) : history;
  const first = (list: PaymentHistoryEntry[], states: ReservationPaymentState[]) => list.find((entry) => states.includes(entry.state));
  const latest = (list: PaymentHistoryEntry[], states: ReservationPaymentState[]) => [...list].reverse().find((entry) => states.includes(entry.state));
  const stage = (name: PaymentTraceStageName, found: PaymentHistoryEntry | undefined, status?: PaymentTraceStage["status"]): PaymentTraceStage =>
    found ? { stage: name, status: status ?? "done", at: found.at, ...(found.detail ? { detail: found.detail } : {}) } : { stage: name, status: "not_reached" };

  const requested = first(history, ["RESERVATION_PENDING"]) ?? history[0];
  const ask = askIndex >= 0 ? history[askIndex] : undefined;
  const guard = latest(current, ["GUARDRAIL_APPROVED", "GUARDRAIL_DENIED"]);
  const submitIndex = lastIndex(current, (entry) => entry.state === "PAYMENT_SUBMITTED");
  const settled = submitIndex >= 0 ? latest(current.slice(submitIndex), ["PAYMENT_CONFIRMED", "PAYMENT_PENDING", "PAYMENT_FAILED", "PAYMENT_UNCERTAIN"]) : undefined;
  const booking = latest(current, ["RESERVATION_CONFIRMED", "RESERVATION_FAILED_AFTER_PAYMENT"]);

  return [
    stage("reservation_request", requested),
    stage("availability_lookup", first(history, ["RESERVATION_PENDING"])),
    stage("deposit_requirement", ask),
    stage("authorization_request", ask),
    stage("user_authorization", latest(current, ["PAYMENT_AUTHORIZED"])),
    stage("terms_recheck", latest(current, ["TERMS_RECHECKED"])),
    stage("guardrail_approval", guard, guard?.state === "GUARDRAIL_DENIED" ? "failed" : "done"),
    stage("xrpl_submission", submitIndex >= 0 ? current[submitIndex] : undefined),
    stage(
      "ledger_validation",
      settled,
      settled?.state === "PAYMENT_CONFIRMED" ? "done" : settled?.state === "PAYMENT_PENDING" || settled?.state === "PAYMENT_UNCERTAIN" ? "pending" : "failed",
    ),
    stage("reservation_confirmation", booking, booking?.state === "RESERVATION_FAILED_AFTER_PAYMENT" ? "failed" : "done"),
  ];
}

function lastIndex<T>(list: T[], test: (item: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) if (test(list[index]!)) return index;
  return -1;
}

/** Plain-text chain for the demo script and logs. */
export function formatPaymentTrace(trace: ReservationPaymentTrace): string {
  const lines = trace.timeline.map((entry) => `  ${entry.at}  ${entry.state}${entry.detail ? `  ${entry.detail}` : ""}`);
  return [
    `${trace.restaurant} · party ${trace.partySize ?? "?"} · ${trace.reservationDate ?? "?"} ${trace.reservationTime ?? "?"}`,
    `  reservation ${trace.reservationStatus}${trace.confirmationNumber ? ` (${trace.confirmationNumber})` : ""}`,
    `  ${trace.paymentType ?? "payment"} ${trace.amountUsd != null ? `$${trace.amountUsd}` : "?"} ${trace.currency} from ${trace.source ?? "?"}`,
    `  sender ${trace.senderWallet ?? "?"} → recipient ${trace.recipientWallet ?? "?"}`,
    `  tx ${trace.transactionHash ?? "none"} ${trace.ledgerResult ?? ""}`.trimEnd(),
    trace.explorerUrl ? `  ${trace.explorerUrl}` : "",
    trace.payment ? `  xrpl ${trace.payment.status} ${trace.payment.amountXrp} XRP ledger ${trace.payment.ledgerIndex ?? "-"} key ${trace.payment.idempotencyKey}` : "",
    `  stages ${trace.stages.map((step) => `${step.stage}:${step.status}`).join(" ")}`,
    trace.guardrail
      ? `  guardrail ${trace.guardrail.decision} (${trace.guardrail.checks.filter((check) => check.passed).length}/${trace.guardrail.checks.length} checks passed${trace.guardrail.decision === "DENY" ? `, ${trace.guardrail.reasonCode}` : ""})`
      : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}
