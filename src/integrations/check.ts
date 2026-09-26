import "dotenv/config";
import pg from "pg";
import { cloud, SpectrumCloudError } from "spectrum-ts";
import { createBackboardClient } from "../backboard/client.js";
import { config } from "../config.js";
import { geocodeNyc } from "../geocode.js";
import { findFood } from "../skills/foodSkill.js";
import { TicketProviderError } from "../ticketing/types.js";
import { TicketmasterProvider } from "../ticketing/providers/ticketmaster.js";
import { createGoogleRoutesProvider, createPlacesResolver } from "../transport/routing.js";
import { logIntegration, redactSecrets } from "./log.js";
import { writeIntegrationHealth, type PublicIntegration, type PublicIntegrationStatus } from "./report.js";

process.env.INTEGRATIONS_CHECK = "1";

const TIMES_SQUARE = { name: "Times Square", latitude: 40.758, longitude: -73.9855, source: "user" as const, confidence: 1 };
const EMPIRE_STATE = { name: "Empire State Building", latitude: 40.748817, longitude: -73.985428, source: "user" as const, confidence: 1 };

let elevenLabsResult: Promise<ProbeResult> | undefined;

function elevenLabsOnce(): Promise<ProbeResult> {
  elevenLabsResult ??= checkElevenLabs();
  return elevenLabsResult;
}

const REQUIRED = [
  "google-places",
  "google-routes",
  "restaurants",
  "reservations",
  "ticketmaster",
  "elevenlabs",
  "backboard",
  "photon",
  "nyc-data",
  "tiger",
] as const;

interface Probe {
  id: string;
  label: string;
  run: () => Promise<ProbeResult>;
}

interface ProbeResult {
  status: PublicIntegrationStatus;
  detail: string;
  httpStatus?: number;
  missingEnv?: string;
  passedLive: boolean;
}

async function main(): Promise<void> {
  const started = new Date();
  const probes: Probe[] = [
    { id: "google-places", label: "Google Places", run: checkPlaces },
    { id: "google-routes", label: "Google Routes", run: checkRoutes },
    { id: "restaurants", label: "Restaurants", run: checkRestaurants },
    { id: "reservations", label: "Reservations", run: checkReservations },
    { id: "ticketmaster", label: "Ticketmaster", run: checkTicketmaster },
    { id: "elevenlabs", label: "ElevenLabs", run: elevenLabsOnce },
    { id: "backboard", label: "Backboard", run: checkBackboard },
    { id: "photon", label: "Photon", run: checkPhoton },
    { id: "nyc-data", label: "NYC Data", run: checkNyc },
    { id: "tiger", label: "Tiger", run: checkTiger },
    { id: "gemini", label: "Gemini", run: checkGemini },
    { id: "geocoder", label: "Geocoder", run: checkGeocoder },
    { id: "ripple", label: "Ripple", run: checkRipple },
  ];

  const results = new Map<string, ProbeResult>();
  for (const probe of probes) {
    results.set(probe.id, await runProbe(probe));
  }

  console.log("");
  console.log("LIVE INTEGRATION CHECK");
  console.log("");
  for (const probe of probes) {
    const result = results.get(probe.id)!;
    const mark = result.passedLive ? "PASS" : result.status === "MOCK" ? "MOCK" : "FAIL";
    const line = `${probe.label.padEnd(20)} ${mark}   ${result.detail}`;
    console.log(line);
    if (!result.passedLive && result.status !== "MOCK") {
      console.log(`  provider: ${probe.label}`);
      if (result.httpStatus) console.log(`  HTTP status: ${result.httpStatus}`);
      console.log(`  error: ${result.detail}`);
      if (result.missingEnv) console.log(`  missing env: ${result.missingEnv}`);
    }
  }

  const requiredHits = REQUIRED.filter((id) => results.get(id)?.passedLive).length;
  const scored = [...REQUIRED, "gemini", "geocoder"] as const;
  const verified = scored.filter((id) => results.get(id)?.passedLive).length;
  console.log("");
  console.log(`${requiredHits}/${REQUIRED.length} LIVE`);
  console.log(`LIVE DEMO READINESS: ${verified}/${scored.length} integrations verified live`);
  console.log("");
  console.log("Smoke checks stopped before any reservation call, ticket purchase, or payment.");

  const integrations: PublicIntegration[] = probes.map((probe) => {
    const result = results.get(probe.id)!;
    return { id: probe.id, label: probe.label, status: result.status, detail: result.detail };
  });
  await writeIntegrationHealth({ checkedAt: started.toISOString(), integrations });

  if (verified !== scored.length) process.exitCode = 1;
}

async function runProbe(probe: Probe): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const result = await probe.run();
    if (result.passedLive) {
      logIntegration(probe.label.toUpperCase().replace(/\s+/g, "_"), "LIVE", `${result.detail} (${Date.now() - started}ms)`);
    }
    return result;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "request failed");
    const httpStatus = statusOf(error);
    return {
      status: "ERROR",
      detail: message,
      ...(httpStatus ? { httpStatus } : {}),
      passedLive: false,
    };
  }
}

async function checkPlaces(): Promise<ProbeResult> {
  if (!config.googleMapsApiKey) return missing("GOOGLE_MAPS_API_KEY");
  const started = Date.now();
  const resolved = await createPlacesResolver(config.googleMapsApiKey).resolve("Times Square");
  const place = resolved.places[0];
  if (!place?.name || place.latitude == null || place.longitude == null) {
    return fail("Places returned no name or coordinates");
  }
  logIntegration("GOOGLE", "LIVE", `place ${place.name} returned in ${Date.now() - started}ms`);
  return pass(`live response received (${place.name})`);
}

async function checkRoutes(): Promise<ProbeResult> {
  if (!config.googleMapsApiKey) return missing("GOOGLE_MAPS_API_KEY");
  const started = Date.now();
  const route = await createGoogleRoutesProvider(config.googleMapsApiKey).getRoute(TIMES_SQUARE, EMPIRE_STATE, "WALK");
  if (!route || route.durationSeconds == null || route.distanceMeters == null) {
    return fail("Routes returned no duration or distance");
  }
  logIntegration("GOOGLE", "LIVE", `route returned in ${Date.now() - started}ms`);
  return pass(`real route returned (${route.durationSeconds}s, ${route.distanceMeters}m)`);
}

async function checkRestaurants(): Promise<ProbeResult> {
  if (!config.googleMapsApiKey) return missing("GOOGLE_MAPS_API_KEY");
  const started = Date.now();
  const found = await findFood({
    origin: { label: "Times Square", latitude: TIMES_SQUARE.latitude, longitude: TIMES_SQUARE.longitude },
    cuisine: ["Italian"],
    openNow: false,
    apiKey: config.googleMapsApiKey,
    strict: true,
  });
  if (found.status !== "ok" || found.data.length === 0) {
    return fail(found.warnings[0] ?? "Places returned no restaurants");
  }
  const sample = found.data[0]!;
  if (sample.placeId.startsWith("demo-") || /ripple bistro/i.test(sample.name)) {
    return fail("restaurant result matched fixture data");
  }
  logIntegration("GOOGLE", "LIVE", `${found.data.length} restaurants returned in ${Date.now() - started}ms`);
  return pass(`live restaurant data returned (${sample.name})`);
}

async function checkReservations(): Promise<ProbeResult> {
  const wired = config.liveDemoMode || config.reservationCallMode === "live";
  const eleven = await elevenLabsOnce();
  if (!wired) {
    return {
      status: "MOCK",
      detail: eleven.passedLive
        ? "ElevenLabs is reachable, but RESERVATION_CALL_MODE=mock. Ripple Bistro availability is fixture data. Set LIVE_DEMO_MODE=true."
        : `RESERVATION_CALL_MODE=mock and ElevenLabs is not live. ${eleven.detail}`,
      ...(eleven.httpStatus ? { httpStatus: eleven.httpStatus } : {}),
      ...(eleven.missingEnv ? { missingEnv: eleven.missingEnv } : {}),
      passedLive: false,
    };
  }
  if (!eleven.passedLive) return eleven;
  if (!config.googleMapsApiKey) return missing("GOOGLE_MAPS_API_KEY");
  return pass("provider reachable (ElevenLabs outbound calling; no booking was created)");
}

async function checkTicketmaster(): Promise<ProbeResult> {
  if (!config.ticketmasterApiKey) return missing("TICKETMASTER_API_KEY");
  const wired = config.liveDemoMode || config.ticketingProvider === "ticketmaster";
  const started = Date.now();
  try {
    const provider = new TicketmasterProvider({ apiKey: config.ticketmasterApiKey, timeoutMs: 20_000 });
    const events = await provider.searchEvents({ city: "New York", size: 5 });
    const sample = events[0];
    if (!sample?.id || !sample.name || !(sample.localDate || sample.startTime)) {
      return fail("Discovery response was missing an event id, name, or date");
    }
    if (sample.id.startsWith("mock-") || sample.priceSource === "mock_inventory") {
      return fail("event payload matched the mock catalog");
    }
    logIntegration("TICKETMASTER", "LIVE", `${events.length} events returned in ${Date.now() - started}ms`);
    if (!wired) {
      return {
        status: "MOCK",
        detail: `Discovery returned ${events.length} events, but TICKETING_PROVIDER=mock so the app would not use them. Set LIVE_DEMO_MODE=true.`,
        passedLive: false,
      };
    }
    const where = [sample.venue, sample.localDate ?? sample.startTime].filter(Boolean).join(", ");
    return pass(`live event data returned (${events.length} events; ${sample.name}${where ? `; ${where}` : ""})`);
  } catch (error) {
    if (error instanceof TicketProviderError) {
      const httpStatus = Number(error.message);
      return {
        status: error.kind === "unconfigured" ? "NOT_CONFIGURED" : "ERROR",
        detail: `Ticketmaster ${error.kind}`,
        ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
        passedLive: false,
      };
    }
    throw error;
  }
}

async function checkElevenLabs(): Promise<ProbeResult> {
  if (!config.elevenLabsApiKey) return missing("ELEVENLABS_API_KEY");
  if (!config.elevenLabsAgentId) return missing("ELEVENLABS_AGENT_ID");
  if (!config.elevenLabsAgentPhoneNumberId) return missing("ELEVENLABS_AGENT_PHONE_NUMBER_ID");
  const started = Date.now();
  const user = await eleven("/v1/user");
  if (!user.ok) return httpFail("ElevenLabs authentication failed", user.status);
  const agent = await eleven(`/v1/convai/agents/${encodeURIComponent(config.elevenLabsAgentId)}`);
  if (agent.status === 404) return httpFail("configured ElevenLabs agent was not found", 404);
  if (!agent.ok) return httpFail("ElevenLabs agent lookup failed", agent.status);
  const phones = await eleven("/v1/convai/phone-numbers");
  if (!phones.ok) return httpFail("ElevenLabs phone-number lookup failed", phones.status);
  const ids = collectIds(phones.body);
  if (!ids.includes(config.elevenLabsAgentPhoneNumberId)) {
    return fail("configured agent phone number id was not found on the ElevenLabs account");
  }
  logIntegration("ELEVENLABS", "LIVE", `authenticated API reachable in ${Date.now() - started}ms`);
  return pass("authenticated API reachable (no call placed)");
}

async function checkBackboard(): Promise<ProbeResult> {
  if (!config.backboardApiKey) return missing("BACKBOARD_API_KEY");
  const started = Date.now();
  const client = createBackboardClient({ apiKey: config.backboardApiKey, timeoutMs: 20_000 });
  const assistant = await client.createAssistant({
    name: "divhacks-integration-health",
    systemPrompt: "You are a health check. Reply with exactly OK.",
  });
  const thread = await client.createThread(assistant.assistantId);
  const sent = await client.sendMessage({
    assistantId: assistant.assistantId,
    threadId: thread.threadId,
    content: "Integration health check. Reply with OK.",
    memory: "off",
    sendToLlm: true,
  });
  if (!sent.content?.trim()) return fail("Backboard returned an empty response");
  logIntegration("BACKBOARD", "LIVE", `request successful in ${Date.now() - started}ms`);
  return pass("authenticated API reachable");
}

async function checkPhoton(): Promise<ProbeResult> {
  if (!config.spectrumProjectId) return missing("SPECTRUM_PROJECT_ID or PHOTON_PROJECT_ID");
  if (!config.spectrumProjectSecret) return missing("SPECTRUM_PROJECT_SECRET or PHOTON_PROJECT_SECRET");
  const started = Date.now();
  try {
    const project = await cloud.getProject(config.spectrumProjectId, config.spectrumProjectSecret);
    if (!project || typeof project !== "object") return fail("Photon returned an empty project");
  } catch (error) {
    if (error instanceof SpectrumCloudError) {
      return httpFail(redactSecrets(error.message || "Photon authentication failed"), error.status);
    }
    throw error;
  }
  logIntegration("PHOTON", "LIVE", `bridge authenticated in ${Date.now() - started}ms`);
  if (config.chatProvider !== "imessage") {
    return {
      status: "ERROR",
      detail: "Photon project authenticated, but CHAT_PROVIDER is not imessage so replies are not delivered to the bridge",
      passedLive: false,
    };
  }
  return pass("bridge/service reachable (no iMessage sent)");
}

async function checkNyc(): Promise<ProbeResult> {
  const datasets: Array<{ dataset: string; name: string; fields: string[][]; where?: string }> = [
    { dataset: process.env.NYPD_DATASET?.trim() || "5uac-w243", name: "NYPD complaints", fields: [["cmplnt_num"], ["latitude"], ["longitude"], ["ofns_desc"]], where: "latitude IS NOT NULL" },
    { dataset: config.parksEventsDataset || "w3wp-dpdi", name: "NYC Parks events", fields: [["title"], ["starttime"]] },
    { dataset: config.permittedEventsDataset || "tvpp-9vvx", name: "NYC permitted events", fields: [["event_id"], ["event_name"], ["start_date_time"]] },
    { dataset: "833y-fsy8", name: "NYPD shootings", fields: [["incident_key"], ["latitude"], ["longitude"]], where: "latitude IS NOT NULL" },
    { dataset: "h9gi-nx95", name: "NYC collisions", fields: [["collision_id"], ["latitude"], ["longitude"]], where: "latitude IS NOT NULL" },
    { dataset: "erm2-nwe9", name: "NYC 311", fields: [["unique_key"], ["complaint_type"]], where: "latitude IS NOT NULL" },
    { dataset: "tg4x-b46p", name: "NYC film permits", fields: [["eventid", "event_id"], ["startdatetime", "start_date_time"]] },
  ];
  const started = Date.now();
  const summaries: string[] = [];
  for (const dataset of datasets) {
    const params = new URLSearchParams({ $limit: "1" });
    if (dataset.where) params.set("$where", dataset.where);
    const url = `https://data.cityofnewyork.us/resource/${dataset.dataset}.json?${params}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "BoroughOS-DivHacks26/0.1 (integration check)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return httpFail(`${dataset.name} query failed`, response.status);
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body) || !body[0] || typeof body[0] !== "object") {
      return fail(`${dataset.name} returned no record`);
    }
    const row = body[0] as Record<string, unknown>;
    const missing = dataset.fields.filter((options) => !options.some((field) => row[field] != null && row[field] !== ""));
    if (missing.length) return fail(`${dataset.name} record is missing ${missing.map((options) => options.join(" or ")).join(", ")}`);
    summaries.push(dataset.name);
  }
  logIntegration("NYC", "LIVE", `${summaries.length} datasets returned in ${Date.now() - started}ms`);
  return pass(`live dataset/query returned (${summaries.length} datasets)`);
}

async function checkTiger(): Promise<ProbeResult> {
  if (!config.databaseUrl) return missing("DATABASE_URL");
  const started = Date.now();
  let client: pg.Client | undefined;
  try {
    client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 15_000 });
    await client.connect();
    const complaints = await client.query<{
      cmplnt_num: string;
      offense: string | null;
      borough: string | null;
      latitude: number | null;
      longitude: number | null;
      occurred_at: Date | null;
    }>(
      `SELECT cmplnt_num, offense, law_category, borough, latitude, longitude, occurred_at
       FROM nypd_complaints
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       LIMIT 1`,
    );
    const row = complaints.rows[0];
    if (!row?.cmplnt_num || row.latitude == null || row.longitude == null || !row.occurred_at) {
      return fail("nypd_complaints returned no row with the fields the safety query expects");
    }
    await client.query(
      `SELECT source, source_id, title, starts_at, latitude, longitude
       FROM city_events
       LIMIT 1`,
    );
    logIntegration("TIGER", "LIVE", `nypd_complaints row returned in ${Date.now() - started}ms`);
    return pass("live dataset/query returned (nypd_complaints)");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tiger query failed";
    if (/invalid url/i.test(message)) {
      return fail("DATABASE_URL is set but is not a valid Postgres URL. Percent-encode reserved characters in the password.");
    }
    return fail(redactSecrets(message));
  } finally {
    await client?.end().catch(() => undefined);
  }
}

async function checkGemini(): Promise<ProbeResult> {
  if (!config.geminiApiKey) return missing("GEMINI_API_KEY");
  const started = Date.now();
  const model = encodeURIComponent(config.geminiModel);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
    headers: { "x-goog-api-key": config.geminiApiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) return httpFail("Gemini authentication failed", response.status);
  if (!response.ok) return httpFail("Gemini model lookup failed", response.status);
  logIntegration("GEMINI", "LIVE", `model reachable in ${Date.now() - started}ms`);
  return pass("authenticated API reachable");
}

async function checkGeocoder(): Promise<ProbeResult> {
  const started = Date.now();
  const place = await geocodeNyc("Times Square, New York");
  if (!place) return fail("geocodeNyc returned no NYC place");
  logIntegration("GEOCODER", "LIVE", `${place.label} returned in ${Date.now() - started}ms`);
  return pass(`live place returned (${place.label})`);
}

async function checkRipple(): Promise<ProbeResult> {
  if (config.paymentsMode === "mock") {
    return {
      status: "MOCK",
      detail: "PAYMENTS_MODE=mock. No ledger request was sent.",
      passedLive: false,
    };
  }
  const started = Date.now();
  const { Client } = await import("xrpl");
  const client = new Client(config.xrplTestnetUrl);
  try {
    await client.connect();
    const info = await client.request({ command: "server_info" });
    const state = info.result.info?.server_state;
    if (!state) return fail("XRPL server_info returned no server state");
    logIntegration("RIPPLE", "LIVE", `server_info ${state} in ${Date.now() - started}ms`);
    return pass(`XRPL Testnet reachable (${state}; no payment submitted)`);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function eleven(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": config.elevenLabsApiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = {};
    }
  }
  return { ok: response.ok, status: response.status, body };
}

function collectIds(body: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "phone_number_id" || key === "agent_phone_number_id") && typeof item === "string") ids.push(item);
      else visit(item);
    }
  };
  visit(body);
  return ids;
}

function pass(detail: string): ProbeResult {
  return { status: "LIVE", detail, passedLive: true };
}

function fail(detail: string): ProbeResult {
  return { status: "ERROR", detail: redactSecrets(detail), passedLive: false };
}

function missing(name: string): ProbeResult {
  return { status: "NOT_CONFIGURED", detail: `${name} is not set`, missingEnv: name, passedLive: false };
}

function httpFail(detail: string, httpStatus: number): ProbeResult {
  const status: PublicIntegrationStatus = httpStatus === 401 || httpStatus === 403 ? "ERROR" : "ERROR";
  return { status, detail: redactSecrets(detail), httpStatus, passedLive: false };
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof SpectrumCloudError) return error.status;
  if (error instanceof TicketProviderError && Number.isInteger(Number(error.message))) return Number(error.message);
  const match = /\b(?:HTTP|status)\s+(\d{3})\b|\breturned\s+(\d{3})\b/.exec(error instanceof Error ? error.message : "");
  const value = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(value) ? value : undefined;
}

await main();
