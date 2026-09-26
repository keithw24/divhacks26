import { weekdayNameFromIso } from "./clock.js";
import { formatClockTime, formatTimeRange, partyWord, spokenTime } from "./constraints.js";
import type { ReservationRequest } from "./types.js";

export function openingLine(reservation: ReservationRequest): string {
  const name = reservation.customer?.name ?? "a customer";
  const party = partyWord(reservation.partySize ?? 0);
  const day = reservation.requestedDate ? weekdayNameFromIso(reservation.requestedDate) : "the requested day";
  const time = reservation.requestedTime ? spokenTime(reservation.requestedTime) : "the requested time";
  return `Hi, I'm calling on behalf of ${name} to see if you have a reservation available for ${party} people this ${day} around ${time}.`;
}

export function reservationAgentPrompt(reservation: ReservationRequest, timeZone = "America/New_York"): string {
  const name = reservation.customer?.name ?? "the customer";
  const earliest = reservation.flexibility?.earliestTime || reservation.requestedTime || "";
  const latest = reservation.flexibility?.latestTime || reservation.requestedTime || "";
  const requests = reservation.specialRequests?.length ? reservation.specialRequests.join("; ") : "none";
  const phone = reservation.customer?.phone
    ? `If they ask for a callback number, you may give ${reservation.customer.phone}.`
    : "If they ask for a phone number, say you do not have one and end the call politely. Do not invent a number.";
  const window = earliest && latest ? `${formatClockTime(earliest)} through ${formatClockTime(latest)}` : "only the structured time below";

  return [
    "You are an AI assistant calling a restaurant to request a reservation.",
    `You are calling on behalf of ${name}. You are not ${name}.`,
    "Never claim to be the customer.",
    "If asked whether you are a human, say you are an AI assistant calling on behalf of the customer.",
    "The AUTHORITATIVE_CONSTRAINTS block is already resolved. Do not reinterpret the date or the times.",
    "AUTHORITATIVE_CONSTRAINTS",
    `restaurant=${reservation.restaurant.name}`,
    `date=${reservation.requestedDate ?? ""}`,
    `party_size=${reservation.partySize ?? ""}`,
    `reservation_name=${reservation.customer?.name ?? ""}`,
    `ideal_time=${reservation.requestedTime ?? ""}`,
    `earliest_allowed_time=${earliest}`,
    `latest_allowed_time=${latest}`,
    `special_requests=${requests}`,
    `timezone=${timeZone}`,
    reservation.restaurant.address ? `address=${reservation.restaurant.address}` : "",
    `Spoken date: ${reservation.requestedDate ? weekdayNameFromIso(reservation.requestedDate) : "unspecified"}.`,
    `Spoken ideal time: ${reservation.requestedTime ? formatClockTime(reservation.requestedTime) : "unspecified"}.`,
    `Authorized window: ${window}.`,
    earliest && latest ? `Accept a time only inside ${formatTimeRange(earliest, latest)}.` : "Accept only the exact requested time.",
    "Never accept a time outside earliest_allowed_time and latest_allowed_time.",
    "Never change the date.",
    "Never change the party size.",
    "Never fabricate customer information, a phone number, an email, a credit card, a confirmation number, an allergy, or an occasion.",
    "Never claim a reservation succeeded unless the restaurant explicitly confirms it.",
    "If they require a decision outside these constraints, do not agree. End the call politely and return NEEDS_USER_INPUT so the customer can authorize it.",
    "If the restaurant offers a time inside the authorized window, accept it and ask them to book it.",
    "If they offer only a time outside the window, do not accept it. Ask whether anything inside the window is available. If nothing inside the window exists, thank them and end the call.",
    phone,
    "Do not treat voicemail as a booking. If you reach voicemail, hang up without leaving a reservation request.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function dynamicVariables(reservation: ReservationRequest, timeZone = "America/New_York"): Record<string, string | number | boolean> {
  return {
    reservation_id: reservation.id,
    photon_space_id: reservation.photonSpaceId,
    restaurant_name: reservation.restaurant.name,
    customer_name: reservation.customer?.name ?? "",
    party_size: reservation.partySize ?? 0,
    requested_date: reservation.requestedDate ?? "",
    requested_time: reservation.requestedTime ?? "",
    earliest_time: reservation.flexibility?.earliestTime ?? "",
    latest_time: reservation.flexibility?.latestTime ?? "",
    alternative_times_allowed: reservation.flexibility?.alternativeTimesAllowed ?? false,
    special_requests: reservation.specialRequests?.join("; ") ?? "",
    customer_phone: reservation.customer?.phone ?? "",
    timezone: timeZone,
  };
}
