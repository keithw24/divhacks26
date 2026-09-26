import { weekdayNameFromIso } from "./clock.js";
import { formatBetween, formatClockTime, formatTimeRange, shortTime } from "./constraints.js";
import type { ReservationRequest, ReservationResult } from "./types.js";

export function collectionPrompt(reservation: ReservationRequest): { kind: ReservationRequest["pendingQuestion"]; text: string } | { kind: "ready" } {
  if (reservation.locationOptions && reservation.locationOptions.length > 1 && !reservation.restaurant.phone) {
    const choices = reservation.locationOptions
      .slice(0, 3)
      .map((place) => place.address || place.name)
      .join(", or ");
    return {
      kind: "location",
      text: `Which ${reservation.restaurant.name || "location"} — ${choices}?`,
    };
  }
  if (!reservation.restaurant.name) {
    return { kind: "restaurant", text: "Which restaurant should I call?" };
  }

  const missingTime = !reservation.requestedTime;
  const missingParty = !reservation.partySize;
  const missingDate = !reservation.requestedDate;

  if (missingTime && missingParty && reservation.requestedDate) {
    return { kind: "party_time", text: "Sounds good. What time and for how many people?" };
  }
  if (missingTime && missingParty) {
    return { kind: "party_time", text: "What day, what time, and for how many people?" };
  }
  if (missingDate && missingTime) return { kind: "date", text: "What day and time?" };
  if (missingParty) return { kind: "party", text: "How many people?" };
  if (missingTime) return { kind: "time", text: "What time?" };
  if (missingDate) return { kind: "date", text: "What day?" };
  if (!reservation.flexibilityKnown && reservation.requestedTime) {
    return {
      kind: "flexibility",
      text: `Any flexibility if ${shortTime(reservation.requestedTime)} isn't available?`,
    };
  }
  if (!reservation.customer?.name) {
    return { kind: "name", text: "What name should I put the reservation under?" };
  }
  return { kind: "ready" };
}

export function confirmationText(reservation: ReservationRequest): string {
  const day = reservation.requestedDate ? weekdayNameFromIso(reservation.requestedDate) : "that day";
  const party = reservation.partySize ?? "a";
  const ideal = reservation.requestedTime ? formatClockTime(reservation.requestedTime) : "the time you wanted";
  const flexibility = reservation.flexibility;
  if (flexibility?.alternativeTimesAllowed && flexibility.earliestTime && flexibility.latestTime) {
    const range = formatTimeRange(flexibility.earliestTime, flexibility.latestTime);
    return `I have ${reservation.restaurant.name} for ${party} people ${day}, ideally ${ideal}, with ${range} okay. Want me to call?`;
  }
  return `I have ${reservation.restaurant.name} for ${party} people ${day} at ${ideal}. Want me to call?`;
}

export function callingText(name: string): string {
  return `Calling ${name} now.`;
}

export function resultText(reservation: ReservationRequest, result: ReservationResult): string {
  const day = weekdayNameFromIso(result.confirmedDate ?? reservation.requestedDate ?? "1970-01-01");
  if (result.outcome === "BOOKED") {
    const when = result.confirmedTime ? formatClockTime(result.confirmedTime) : "the requested time";
    const party = result.confirmedPartySize ?? reservation.partySize;
    const name = result.confirmationName ?? reservation.customer?.name;
    const who = name ? ` under ${name}` : "";
    const number = result.confirmationNumber ? ` Confirmation ${result.confirmationNumber}.` : "";
    return `Booked! ${reservation.restaurant.name} confirmed ${party} people ${day} at ${when}${who}.${number}`;
  }
  if (result.outcome === "UNAVAILABLE") {
    const flexibility = reservation.flexibility;
    if (flexibility?.alternativeTimesAllowed && flexibility.earliestTime && flexibility.latestTime && reservation.requestedDate) {
      return `They don't have anything between ${formatBetween(flexibility.earliestTime, flexibility.latestTime)} ${weekdayNameFromIso(reservation.requestedDate)}.`;
    }
    if (reservation.requestedTime && reservation.requestedDate) {
      return `They don't have a table at ${formatClockTime(reservation.requestedTime)} ${weekdayNameFromIso(reservation.requestedDate)}.`;
    }
    return "They don't have a table in the window you allowed.";
  }
  if (result.outcome === "NEEDS_USER_INPUT") {
    if (result.offeredTime && reservation.flexibility?.earliestTime && reservation.flexibility.latestTime) {
      const range = formatTimeRange(reservation.flexibility.earliestTime, reservation.flexibility.latestTime);
      return `They can't do your ${range} window, but they offered ${formatClockTime(result.offeredTime)}. Want me to take it?`;
    }
    if (result.questionForUser) return result.questionForUser;
    return "They asked for something I don't have. What should I tell them?";
  }
  return "I couldn't reach them.";
}
