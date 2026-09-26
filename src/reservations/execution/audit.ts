import { logReservation } from "../log.js";
import type { BookingExecutionRecord, ReservationAuditEvent } from "./types.js";

const SECRET = /secret|seed|private|api[_-]?key|authorization|password|token|transcript/i;

export function emitAudit(event: ReservationAuditEvent, sink?: (event: ReservationAuditEvent) => void): void {
  const safe: ReservationAuditEvent = {
    event: event.event,
    executionId: event.executionId,
    spaceId: event.spaceId,
    restaurant: event.restaurant,
    timestamp: event.timestamp,
    channel: event.channel,
    reason: event.reason && SECRET.test(event.reason) ? "redacted" : event.reason,
    status: event.status,
    provider: event.provider,
    phase: event.phase,
  };
  sink?.(safe);
  logReservation(safe.event, {
    executionId: safe.executionId,
    spaceId: safe.spaceId,
    restaurant: safe.restaurant,
    timestamp: safe.timestamp,
    channel: safe.channel,
    reason: safe.reason,
    status: safe.status,
    provider: safe.provider,
    phase: safe.phase,
  });
}

export interface ExecutionTraceStep {
  label: string;
  detail?: string;
  provider?: string;
  status?: string;
}

/** Renderable decision path. Safe to show: no secrets and no wallet keys. */
export function executionTimeline(record: BookingExecutionRecord | undefined): ExecutionTraceStep[] {
  if (!record) return [];
  const steps: ExecutionTraceStep[] = [];
  for (const event of record.events) {
    if (event.event === "reservation.online.check.started") {
      steps.push({ label: "ONLINE CHECK", provider: event.provider, status: "started" });
    } else if (event.event === "reservation.online.check.unavailable") {
      steps.push({ label: "ONLINE CHECK", provider: event.provider, detail: "No matching availability", status: event.status });
    } else if (event.event === "reservation.online.check.unsupported") {
      steps.push({ label: "ONLINE CHECK", provider: event.provider, detail: "No supported online booking", status: event.status });
    } else if (event.event === "reservation.online.check.failed") {
      steps.push({ label: "ONLINE CHECK", provider: event.provider, detail: "Online booking could not be completed", status: event.status });
    } else if (event.event === "reservation.fallback.phone.selected") {
      steps.push({ label: "FALLBACK", detail: "Phone selected", status: event.reason });
    } else if (event.event === "reservation.phone.started") {
      steps.push({ label: "CALL", provider: event.provider ?? "phone", detail: event.reason, status: "started" });
    } else if (event.event === "reservation.phone.confirmed" || event.event === "reservation.execution.confirmed") {
      const party = record.partySize ? `${record.partySize} people` : undefined;
      const when = record.confirmedTime;
      steps.push({
        label: "CONFIRMED",
        detail: [party, when].filter(Boolean).join(" · ") || undefined,
        provider: event.provider,
        status: "CONFIRMED",
      });
    } else if (event.event === "reservation.execution.failed" || event.event === "reservation.phone.failed") {
      steps.push({ label: "FAILED", detail: "Reservation was not confirmed", status: event.status });
    }
  }
  return steps;
}
