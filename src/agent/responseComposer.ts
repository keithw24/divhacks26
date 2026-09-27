/**
 * Centralized user-facing response composer for iMessage.
 *
 * Implements the response-priority layer:
 * 1. Direct answer to current user intent always comes first
 * 2. Information required to act on that intent follows
 * 3. Helpful secondary context only when relevant (at most 1 concise sentence)
 * 4. Warnings / explanations only when the user's requested data could not be retrieved
 *
 * Internal evidence/provenance/diagnostics are kept strictly internal and never leak to the user.
 */

export interface ResponseComposerInput {
  /** The user's primary intent for this turn (e.g. "ticket_pricing", "restaurant_availability", "safety", etc.) */
  primaryIntent?: string;
  /** Direct natural language answer to the user's question */
  directAnswer: string;
  /** Actionable details or next steps */
  actionResult?: {
    status?: "success" | "pending" | "failed" | "confirmed";
    details?: string;
  };
  /** Supplementary context from secondary agents */
  supplementaryContext?: Array<{
    kind: "safety" | "timing" | "venue" | "route" | "general";
    text: string;
    priority?: number;
    relevant?: boolean;
  }>;
  /** User-facing conversational explanation if requested data is unavailable */
  warnings?: string[];
  /** Natural prompt for the next turn (e.g. "Want me to grab two?") */
  nextPrompt?: string;
  /** Internal metadata - strictly separated, never rendered to the user */
  provenance?: unknown;
  /** Internal diagnostics - strictly separated, never rendered to the user */
  diagnostics?: unknown;
}

export const FORBIDDEN_DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  /source unavailable/i,
  /no supported claims returned/i,
  /partial results/i,
  /dataset freshness is unknown/i,
  /dataset freshness/i,
  /evidence unavailable/i,
  /tool failed/i,
  /tool error/i,
  /provider error/i,
  /confidence threshold/i,
  /claim unsupported/i,
  /supported claims/i,
  /Note:\s*(?:food|events|safety|route):/i,
  /Historical complaints do not represent live conditions/i,
  /Only explicit request constraints are checked/i,
  /Confidence is provenance strength/i,
  /Evidence records what a source returned/i,
  /\bnull\b/,
  /\bundefined\b/,
  /\[stale source; recheck\]/i,
];

/**
 * Returns true if a string contains internal evidence/pipeline diagnostics.
 */
export function containsInternalDiagnostics(text: string): boolean {
  return FORBIDDEN_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Cleans machine/report-style formatting into natural texting prose.
 */
export function humanizeText(text: string): string {
  let cleaned = text.trim();

  // Strip report-style numbered prefixes like "1. Bowery Ballroom; starts ..." -> "Bowery Ballroom ..."
  cleaned = cleaned.replace(/^\d+\.\s+/, "");

  // Strip formal prefixes like "Historical context. 267 historical reported complaints within 800 m at 20:00 ET over 2 years"
  cleaned = cleaned.replace(
    /^Historical context\.\s*\d+\s+historical reported complaints within \d+\s*m(?: at \d+:00 ET)?(?: over \d+ years)?\.?/i,
    "Looks pretty normal for that area based on historical reports.",
  );

  // Convert "Route duration: 14 minutes. Transportation mode: walking." -> "It's about a 14-minute walk."
  cleaned = cleaned.replace(
    /Route duration:\s*(\d+)\s*minutes?\.?\s*(?:Transportation mode:\s*(walking|transit|driving|bicycling)\.?)?/i,
    (_match, mins, mode) => {
      const modeWord = mode?.toLowerCase() === "walking" || !mode ? "walk" : mode.toLowerCase();
      return `It's about a ${mins}-minute ${modeWord}.`;
    },
  );

  // Convert "Route. 14 min walk along the route (route estimate)..." -> "It's about a 14-minute walk."
  cleaned = cleaned.replace(
    /^Route\.\s*(\d+)\s*min\s*(walk|transit|drive|bike)(?:\s*\([^)]*\))?[^;.]*(?:;\s*)?/i,
    (_match, mins, mode) => `It's about a ${mins}-minute ${mode}. `,
  );

  // Convert formal "Ticket pricing results: Minimum ticket price: $X. Maximum ticket price: $Y." -> "Tickets are $X–$Y right now."
  cleaned = cleaned.replace(
    /Ticket pricing results:\s*Minimum ticket price:\s*\$(\d+(?:\.\d{2})?)\.?\s*Maximum ticket price:\s*\$(\d+(?:\.\d{2})?)\.?/i,
    "Tickets are $$1–$$2 right now.",
  );

  // Convert semicolons used as field delimiters into natural commas or periods
  cleaned = cleaned.replace(/;\s*/g, ", ");

  return cleaned.trim();
}

/**
 * Strips diagnostic lines and forbidden phrases from text.
 */
export function sanitizeUserFacingText(text: string): string {
  const lines = text.split("\n");
  const cleanLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (containsInternalDiagnostics(trimmed)) continue;
    cleanLines.push(trimmed);
  }

  let result = cleanLines.join("\n").trim();

  // Strip any lingering forbidden phrases in-line
  for (const pattern of FORBIDDEN_DIAGNOSTIC_PATTERNS) {
    result = result.replace(pattern, "").trim();
  }

  // Remove leftover empty "Note:" artifacts or double punctuation
  result = result.replace(/^Note:\s*/gim, "");
  result = result.replace(/[ \t]{2,}/g, " ");
  result = result.replace(/,\s*,/g, ",");
  result = result.replace(/\.\s*\./g, ".");

  return result.trim();
}

/**
 * Natural formatting for ticket prices.
 */
export function naturalTicketPriceReply(input: {
  eventName: string;
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  options?: number[];
  checkoutUrl?: string;
  nextPrompt?: string;
}): string {
  const { eventName, minPrice, maxPrice, currency = "USD", options, checkoutUrl, nextPrompt } = input;
  const currSymbol = currency === "USD" ? "$" : `${currency} `;

  if (minPrice === undefined) {
    const link = checkoutUrl ? ` Here's the official link to check: ${checkoutUrl}` : "";
    return `I couldn't get ticket prices for ${eventName} right now.${link}`;
  }

  const start = `${currSymbol}${Math.round(minPrice)}`;
  let priceText = `Tickets start at ${start} right now`;

  if (options && options.length > 1) {
    const distinct = [...new Set(options)].sort((a, b) => a - b);
    if (distinct.length === 2) {
      priceText = `Tickets start at ${start} right now. I found options at ${currSymbol}${distinct[0]} and ${currSymbol}${distinct[1]}`;
    } else if (distinct.length > 2) {
      priceText = `Tickets start at ${start} right now. I found options at ${currSymbol}${distinct[0]}, ${currSymbol}${distinct[1]}, and ${currSymbol}${distinct[2]}`;
    }
  } else if (maxPrice && maxPrice > minPrice) {
    priceText = `Tickets are ${start}–${currSymbol}${Math.round(maxPrice)} right now`;
  }

  const prompt = nextPrompt ?? "Want me to grab two?";
  return `Yep — ${priceText}. ${prompt}`;
}

/**
 * Natural formatting for a route.
 */
export function naturalRouteReply(input: {
  durationMinutes: number;
  mode: string;
  directionsUrl?: string;
}): string {
  const modeWord = input.mode.toLowerCase() === "walk" ? "walk" : input.mode.toLowerCase() === "transit" ? "subway ride" : "drive";
  const url = input.directionsUrl ? ` Directions: ${input.directionsUrl}` : "";
  return `It's about a ${input.durationMinutes}-minute ${modeWord}.${url}`;
}

/**
 * Natural formatting for secondary safety observations.
 * Unobtrusive, calm, no raw crime statistics dumps.
 */
export function naturalSafetyNote(report: {
  placeName?: string;
  hourEt?: number;
  hourVsNyc?: number | null;
  areaVsNyc?: number | null;
}): string {
  const ratio = report.hourVsNyc ?? report.areaVsNyc;
  const place = report.placeName ? `around ${report.placeName}` : "that area";
  const hour = report.hourEt ? `around ${report.hourEt % 12 || 12} ${report.hourEt >= 12 ? "PM" : "AM"}` : "that time of night";

  if (ratio != null && Number.isFinite(ratio)) {
    if (ratio < 0.7) {
      return `One other thing: the area ${place} historically sees fewer reported incidents than typical NYC for ${hour}.`;
    }
    if (ratio <= 1.3) {
      return `One other thing: the area ${place} has about the usual number of reported incidents for ${hour} based on historical data.`;
    }
    if (ratio <= 2.0) {
      return `One other thing: the area ${place} historically sees slightly more activity for ${hour}, so keep usual city awareness.`;
    }
    return `One other thing: that area historically sees more reported incidents for ${hour}, so stay aware of your surroundings.`;
  }

  return `One other thing: the area ${place} looks pretty normal for ${hour} based on historical reports.`;
}

/**
 * Central response composer.
 * Composes direct answer first, actionable context, ranked secondary context, and natural next steps.
 * Guarantees zero internal diagnostics in user-facing text.
 */
export function composeResponse(input: ResponseComposerInput): string {
  const sections: string[] = [];

  // 1. Direct answer to primary intent
  let direct = humanizeText(input.directAnswer);
  direct = sanitizeUserFacingText(direct);

  if (direct) {
    sections.push(direct);
  }

  // 2. Action result details if required to act on the intent
  if (input.actionResult?.details) {
    const actionText = sanitizeUserFacingText(humanizeText(input.actionResult.details));
    if (actionText && !sections.includes(actionText)) {
      sections.push(actionText);
    }
  }

  // 3. Supplementary secondary context (ranked, max 1 concise note)
  if (input.supplementaryContext?.length) {
    const validContexts = input.supplementaryContext
      .filter((ctx) => ctx.relevant !== false && ctx.text.trim().length > 0)
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

    for (const ctx of validContexts) {
      const clean = sanitizeUserFacingText(humanizeText(ctx.text));
      if (!clean) continue;
      // Do not duplicate something already in the direct answer
      if (sections.some((s) => s.toLowerCase().includes(clean.toLowerCase()))) continue;
      sections.push(clean);
      // Limit to 1 supplementary note to keep iMessages concise (1–3 sentences)
      break;
    }
  }

  // 4. Conversational warnings if requested information could not be retrieved
  if (input.warnings?.length) {
    for (const warning of input.warnings) {
      const cleanWarning = sanitizeUserFacingText(warning);
      if (cleanWarning && !sections.includes(cleanWarning)) {
        sections.push(cleanWarning);
      }
    }
  }

  // 5. Next prompt if not already present
  if (input.nextPrompt) {
    const cleanPrompt = sanitizeUserFacingText(input.nextPrompt);
    const existing = sections.join(" ");
    if (cleanPrompt && !existing.toLowerCase().includes(cleanPrompt.toLowerCase())) {
      // Append naturally to the last sentence or as its own sentence
      if (sections.length > 0) {
        sections[sections.length - 1] = `${sections[sections.length - 1]} ${cleanPrompt}`;
      } else {
        sections.push(cleanPrompt);
      }
    }
  }

  // Join into natural message
  const finalMessage = sections.join("\n\n").trim();

  // Final sanity check: never emit forbidden strings
  return sanitizeUserFacingText(finalMessage);
}
