import { timedEvent, type CalendarEvent } from "./links.js";
import type { Recommendation } from "../domain/contracts.js";
import type { MeetupPlan } from "../meetup/types.js";
import type { ReservationRequest, ReservationResult } from "../reservations/types.js";
import { zonedToUtc } from "../ticketing/time.js";
import type { TicketEvent } from "../ticketing/types.js";
import { displayName } from "../transport/locations.js";

const ZONE = "America/New_York";

export function fromRecommendation(item: Recommendation): CalendarEvent | undefined {
  if (item.kind !== "event") return undefined;
  return timedEvent({
    title: item.name,
    start: item.startsAt,
    end: item.endsAt,
    durationMinutes: 120,
    location: item.location.label,
    details: item.url,
  });
}

export function fromTicketEvent(event?: TicketEvent): CalendarEvent | undefined {
  if (!event) return undefined;
  const zone = event.timeZone || ZONE;
  const start =
    event.startTime ||
    (event.localDate && event.localTime ? zonedToUtc(event.localDate, event.localTime, zone).toISOString() : undefined);
  const location = [event.venue, event.address, event.city].filter(Boolean).join(", ");
  return timedEvent({
    title: event.name,
    start,
    durationMinutes: 180,
    location,
    details: event.url,
  });
}

export function fromBookingFields(input: {
  title: string;
  date?: string;
  time?: string;
  location?: string;
  zone?: string;
}): CalendarEvent | undefined {
  if (!input.date || !input.time || !input.title.trim()) return undefined;
  const clock = /^\d{2}:\d{2}$/.test(input.time) ? `${input.time}:00` : input.time;
  return timedEvent({
    title: input.title,
    start: zonedToUtc(input.date, clock, input.zone || ZONE),
    durationMinutes: 90,
    location: input.location || input.title,
    details: "Restaurant reservation",
  });
}

export function fromReservation(
  reservation: ReservationRequest,
  result?: ReservationResult,
  zone = ZONE,
): CalendarEvent | undefined {
  const booked = result ?? reservation.result;
  const date = booked?.confirmedDate ?? reservation.requestedDate;
  const time = booked?.confirmedTime ?? reservation.requestedTime;
  if (!date || !time) return undefined;
  const clock = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const location = [reservation.restaurant.address, reservation.restaurant.name].filter(Boolean).join(" — ");
  return timedEvent({
    title: reservation.restaurant.name,
    start: zonedToUtc(date, clock, zone),
    durationMinutes: 90,
    location: location || reservation.restaurant.name,
    details: "Restaurant reservation",
  });
}

export function fromMeetup(plan: MeetupPlan): CalendarEvent | undefined {
  return timedEvent({
    title: `Meet at ${displayName(plan.destination)}`,
    start: plan.meetAtIso,
    durationMinutes: 60,
    location: plan.destination.address || displayName(plan.destination),
    details: "Group meetup",
  });
}
