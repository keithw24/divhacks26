import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";

export type PublicIntegrationStatus = "LIVE" | "NOT_CONFIGURED" | "ERROR" | "MOCK" | "UNVERIFIED";

export interface PublicIntegration {
  id: string;
  label: string;
  status: PublicIntegrationStatus;
  detail: string;
}

export interface IntegrationHealthSnapshot {
  checkedAt: string;
  integrations: PublicIntegration[];
}

const SNAPSHOT_PATH = "data/integration-health.json";
const STATUSES = new Set<PublicIntegrationStatus>(["LIVE", "NOT_CONFIGURED", "ERROR", "MOCK", "UNVERIFIED"]);

export function postureFromConfig(): PublicIntegration[] {
  const maps = config.googleMapsApiKey ? "UNVERIFIED" : "NOT_CONFIGURED";
  const mapsDetail = config.googleMapsApiKey
    ? "Credentials are set. Run npm run integrations:check before treating this as live."
    : "GOOGLE_MAPS_API_KEY is not set";
  const ticketsWired = config.liveDemoMode || config.ticketingProvider === "ticketmaster";
  const callsWired = config.liveDemoMode || config.reservationCallMode === "live";
  return [
    row("google-places", "Google Places", maps, maps === "NOT_CONFIGURED" ? mapsDetail : "Places has not been verified with a live request."),
    row("google-routes", "Google Routes", maps, maps === "NOT_CONFIGURED" ? mapsDetail : "Routes has not been verified with a live request."),
    row("restaurants", "Restaurants", maps, maps === "NOT_CONFIGURED" ? "GOOGLE_MAPS_API_KEY is not set" : "Restaurant search has not been verified with a live request."),
    row(
      "reservations",
      "Reservations",
      callsWired ? (config.elevenLabsApiKey ? "UNVERIFIED" : "NOT_CONFIGURED") : "MOCK",
      callsWired
        ? "Live calls use ElevenLabs after a Google Places phone lookup. Ripple Bistro availability is a fixture and is disabled in LIVE_DEMO_MODE."
        : "RESERVATION_CALL_MODE=mock. No reservation is dialed, and Ripple Bistro availability is fixture data.",
    ),
    row(
      "ticketmaster",
      "Ticketmaster",
      ticketsWired ? (config.ticketmasterApiKey ? "UNVERIFIED" : "NOT_CONFIGURED") : "MOCK",
      ticketsWired
        ? config.ticketmasterApiKey
          ? "Discovery API has not been verified with a live request."
          : "TICKETMASTER_API_KEY is not set"
        : "TICKETING_PROVIDER=mock. Demo events are built in, not loaded from Ticketmaster.",
    ),
    row(
      "elevenlabs",
      "ElevenLabs",
      config.elevenLabsApiKey ? "UNVERIFIED" : "NOT_CONFIGURED",
      config.elevenLabsApiKey ? "The API key is set. Authentication has not been verified." : "ELEVENLABS_API_KEY is not set",
    ),
    row(
      "backboard",
      "Backboard",
      config.backboardApiKey ? "UNVERIFIED" : "NOT_CONFIGURED",
      config.backboardApiKey ? "The API key is set. A live request has not been verified." : "BACKBOARD_API_KEY is not set",
    ),
    row(
      "photon",
      "Photon",
      config.spectrumProjectId && config.spectrumProjectSecret ? "UNVERIFIED" : "NOT_CONFIGURED",
      config.chatProvider === "imessage"
        ? "iMessage delivery uses the Photon Spectrum bridge."
        : "CHAT_PROVIDER is not imessage, so replies are not delivered through Photon.",
    ),
    row("nyc-data", "NYC Data", "UNVERIFIED", "NYC Open Data is queried directly by the health check. The app reads ingested rows from Tiger."),
    row(
      "tiger",
      "Tiger",
      config.databaseUrl ? "UNVERIFIED" : "NOT_CONFIGURED",
      config.databaseUrl ? "Tiger Data / Timescale has not been queried." : "DATABASE_URL is not set",
    ),
    row(
      "gemini",
      "Gemini",
      config.geminiApiKey ? "UNVERIFIED" : "NOT_CONFIGURED",
      config.geminiApiKey ? "GEMINI_API_KEY is set. The model has not been verified." : "GEMINI_API_KEY is not set",
    ),
    row("geocoder", "Geocoder", "UNVERIFIED", "Place lookup uses photon.komoot.io. This is not the iMessage bridge."),
    row(
      "ripple",
      "Ripple",
      config.paymentsMode === "mock" ? "MOCK" : "UNVERIFIED",
      config.paymentsMode === "mock"
        ? "PAYMENTS_MODE=mock. No XRPL transaction is submitted."
        : "XRPL Testnet is configured. A read-only server check has not run.",
    ),
  ];
}

export async function writeIntegrationHealth(snapshot: IntegrationHealthSnapshot): Promise<void> {
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

export async function readPublicIntegrations(): Promise<{ checkedAt: string | null; integrations: PublicIntegration[] }> {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<IntegrationHealthSnapshot>;
    if (!Array.isArray(parsed.integrations) || parsed.integrations.length === 0) {
      return { checkedAt: null, integrations: postureFromConfig() };
    }
    return {
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
      integrations: parsed.integrations.map(sanitize),
    };
  } catch {
    return { checkedAt: null, integrations: postureFromConfig() };
  }
}

function row(id: string, label: string, status: PublicIntegrationStatus, detail: string): PublicIntegration {
  return { id, label, status, detail };
}

function sanitize(value: PublicIntegration): PublicIntegration {
  const status = STATUSES.has(value.status) ? value.status : "ERROR";
  return {
    id: String(value.id ?? "").slice(0, 40),
    label: String(value.label ?? "").slice(0, 40),
    status,
    detail: String(value.detail ?? "").slice(0, 280),
  };
}
