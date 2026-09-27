import { fromBookingFields } from "../../calendar/from.js";
import { withCalendarLine } from "../../calendar/links.js";
import { formatClockTime } from "../constraints.js";

export const FAILED_REPLY = "I couldn't complete the reservation online or by phone.";
export const WONT_CALL_REPLY = "I couldn't book that online, and I won't call the restaurant.";

export function confirmedOnlineReply(input: {
  restaurantName: string;
  partySize?: number;
  confirmedTime: string;
  confirmationId?: string;
  requestedDate?: string;
  location?: string;
}): string {
  const party = input.partySize ?? "your party";
  const when = clock(input.confirmedTime);
  const confirmation = input.confirmationId ? ` Confirmation: ${input.confirmationId}.` : "";
  return withCalendarLine(
    `Booked ${input.restaurantName} for ${party} at ${when}.${confirmation}`,
    fromBookingFields({
      title: input.restaurantName,
      date: input.requestedDate,
      time: input.confirmedTime,
      location: input.location,
    }),
  );
}

export function confirmedPhoneReply(input: {
  partySize?: number;
  confirmedTime: string;
  confirmationName?: string;
  confirmationId?: string;
  restaurantName?: string;
  requestedDate?: string;
  location?: string;
}): string {
  const party = input.partySize ?? "your party";
  const when = clock(input.confirmedTime);
  const who = input.confirmationName ? ` under ${input.confirmationName}` : "";
  const confirmation = input.confirmationId ? ` Confirmation: ${input.confirmationId}.` : "";
  return withCalendarLine(
    `Online booking wasn't available, so I called the restaurant. You're booked for ${party} at ${when}${who}.${confirmation}`,
    fromBookingFields({
      title: input.restaurantName ?? "Reservation",
      date: input.requestedDate,
      time: input.confirmedTime,
      location: input.location,
    }),
  );
}

export function alternativeReply(time: string): string {
  return `They offered ${clock(time)}, which is outside the time you asked for. Want me to take it?`;
}

export function missingDetailReply(reason: string): string {
  if (reason === "missing_party_size") return "How many people?";
  if (reason === "missing_time") return "What time?";
  if (reason === "missing_date") return "What day?";
  return "I need a restaurant, a party size, a date, and a time before I can book.";
}

function clock(time: string): string {
  return /^\d{2}:\d{2}$/.test(time) ? formatClockTime(time) : time;
}
