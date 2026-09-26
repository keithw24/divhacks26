import { weekdayNameFromIso } from "./clock.js";
import { formatClockTime, formatTimeRange, shortTime } from "./constraints.js";
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
  let summary: string;
  if (flexibility?.alternativeTimesAllowed && flexibility.earliestTime && flexibility.latestTime) {
    const range = formatTimeRange(flexibility.earliestTime, flexibility.latestTime);
    summary = `I have ${reservation.restaurant.name} for ${party} people ${day}, ideally ${ideal}, with ${range} okay.`;
  } else {
    summary = `I have ${reservation.restaurant.name} for ${party} people ${day} at ${ideal}.`;
  }
  if (reservation.restaurant.openNow === true) summary += " They're listed as open now.";
  if (reservation.restaurant.websiteUrl) {
    return `${summary} Their site: ${reservation.restaurant.websiteUrl}. I can't see live OpenTable/Resy inventory. Want me to call?`;
  }
  return `${summary} Want me to call?`;
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
    return `Booked — ${reservation.restaurant.name} for ${party} ${day} at ${when}${who}.${number}`;
  }
  if (result.outcome === "UNAVAILABLE") {
    return `${reservation.restaurant.name} doesn't have availability in the time range you gave me.`;
  }
  if (result.outcome === "NEEDS_USER_INPUT") {
    if (result.offeredTime) {
      const preferred = reservation.requestedTime ? formatClockTime(reservation.requestedTime) : "that time";
      return `${reservation.restaurant.name} couldn't do ${preferred}. They offered ${formatClockTime(result.offeredTime)} instead. Want me to take it?`;
    }
    if (result.questionForUser) return result.questionForUser;
    return "They asked for something I don't have. What should I tell them?";
  }
  const name = reservation.restaurant.name || "them";
  return `I couldn't reach ${name}. Want me to try again?`;
}
