import { geocodeNyc } from "./geocode.js";
import { currentHourEt, lookupBlockSafety, parseRequestedHour } from "./safety.js";
import { formatSafetyReply } from "./formatReport.js";

export interface BoroughReply {
  acknowledgement: string;
  response: string;
}

export async function createBoroughReply(
  input: string,
  databaseUrl: string,
): Promise<BoroughReply> {
  const normalized = input.trim();

  if (!normalized) {
    return {
      acknowledgement: "👀",
      response:
        "Send a NYC street, intersection, or neighborhood (optionally “at 11pm”) and I’ll pull a block-level complaint sketch from city data.",
    };
  }

  const place = await geocodeNyc(normalized);
  if (!place) {
    return {
      acknowledgement: "👀",
      response:
        "I couldn’t pin that to an NYC block. Try an intersection, landmark, or neighborhood — e.g. “Columbia University” or “116th and Broadway at 9pm”.",
    };
  }

  const clock = currentHourEt();
  const hourEt = parseRequestedHour(normalized, clock.hourEt);
  const asOfEt =
    hourEt === clock.hourEt
      ? clock.asOfEt
      : `${clock.asOfEt}; asked for ${hourEt}:00 ET`;
  const report = await lookupBlockSafety(
    databaseUrl,
    place.latitude,
    place.longitude,
    hourEt,
    asOfEt,
  );

  return {
    acknowledgement: "👍",
    response: formatSafetyReply(place, report).slice(0, 1800),
  };
}
