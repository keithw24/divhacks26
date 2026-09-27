import { createOutboundCaller } from "../elevenlabs/calls.js";
import type { NormalizedCompletion } from "./result.js";
import { RestaurantCallService } from "../phone/service.js";
import { createMemoryStateStore } from "../store/state.js";
import { startWebhookServer } from "../elevenlabs/server.js";
import type { MockScenario } from "../elevenlabs/types.js";
import type { StateStore } from "../store/state.js";
import type { DepositPaymentPort } from "../payments/deposit-port.js";
import { createMerchantDirectory } from "../payments/merchants.js";
import { createGuardedReservationPayments, type DepositAuditSink } from "../payments/reservation-deposits.js";
import { createXrplReservationPayments, type ReservationXrplService } from "../payments/reservation-xrpl.js";
import { loadDemoDepositCatalog } from "./deposits.js";
import { createGeminiReservationInterpreter } from "./gemini.js";
import { ReservationOrchestrator } from "./orchestrator.js";
import { RippleBistroProvider, type ReservationProvider } from "./providers.js";
import { createRestaurantDirectory } from "./restaurant.js";
import { ReservationStore } from "./state.js";

const SCENARIOS = new Set<MockScenario>([
  "exact_time",
  "alternative_within_window",
  "alternative_outside_window",
  "fully_booked",
  "asks_for_name",
  "asks_for_phone",
  "deposit_required",
  "voicemail",
  "no_answer",
  "api_error",
  "malformed_completion",
]);

export interface ReservationRuntimeEnv {
  /** Non-reservation ElevenLabs calls (friend calls) get first look at completions. */
  otherCallCompletion?: (completion: NormalizedCompletion) => Promise<boolean>;
  callMode: "mock" | "live";
  mockScenario?: string;
  allowGazetteerDial?: boolean;
  geminiApiKey?: string;
  geminiModel?: string;
  googleMapsApiKey?: string;
  elevenLabsApiKey?: string;
  elevenLabsAgentId?: string;
  elevenLabsAgentPhoneNumberId?: string;
  webhookSecret?: string;
  timeZone?: string;
  callTimeoutMs?: number;
  /** When omitted, mock mode completes the call in-process and live mode waits for the webhook. */
  autoComplete?: boolean;
  stateStore?: StateStore;
  notify?: (spaceId: string, text: string) => Promise<void>;
  depositsJson?: string;
  merchantsJson?: string;
  paymentMode?: "mock" | "ripple_test";
  /** Mock-mode deposits only. Nothing here reaches a ledger. */
  depositPayments?: DepositPaymentPort;
  /** ripple_test deposits. The shared XRPL payment service signs; reservations never see a seed. */
  xrplDeposits?: ReservationXrplService;
  /** Guardrail limits shared with every other XRPL payment. */
  paymentsMaxUsd?: number;
  paymentsDailyMaxUsd?: number;
  xrpPerUsd?: number;
  xrplTestnetUrl?: string;
  paymentAudit?: DepositAuditSink;
  providers?: ReservationProvider[];
  depositHoldMinutes?: number;
}

export function createReservationRuntime(env: ReservationRuntimeEnv) {
  const mockScenario = SCENARIOS.has(env.mockScenario as MockScenario)
    ? (env.mockScenario as MockScenario)
    : "alternative_within_window";
  const caller = createOutboundCaller({
    mode: env.callMode,
    apiKey: env.elevenLabsApiKey,
    agentId: env.elevenLabsAgentId,
    agentPhoneNumberId: env.elevenLabsAgentPhoneNumberId,
    scenario: mockScenario,
  });
  const directory = createRestaurantDirectory({
    googleMapsApiKey: env.googleMapsApiKey,
    allowGazetteerFallback: env.callMode !== "live" || env.allowGazetteerDial === true,
  });
  const interpreter = env.geminiApiKey
    ? createGeminiReservationInterpreter({ apiKey: env.geminiApiKey, model: env.geminiModel })
    : undefined;
  const paymentMode = env.paymentMode ?? "mock";
  const serverUrl = env.xrplTestnetUrl ?? "wss://s.altnet.rippletest.net:51233";
  const merchants = createMerchantDirectory({ mode: paymentMode, json: env.merchantsJson });
  const limits = {
    merchants,
    serverUrl,
    xrpPerUsd: env.xrpPerUsd ?? 1,
    maxUsd: env.paymentsMaxUsd ?? 500,
    dailyMaxUsd: env.paymentsDailyMaxUsd ?? 1000,
    audit: env.paymentAudit,
  };
  const payments =
    paymentMode === "ripple_test"
      ? env.xrplDeposits
        ? createXrplReservationPayments({ ...limits, xrpl: env.xrplDeposits })
        : undefined
      : env.depositPayments
        ? createGuardedReservationPayments({ ...limits, payments: env.depositPayments, mode: "mock" })
        : undefined;
  const phone = new RestaurantCallService({
    state: env.stateStore ?? createMemoryStateStore(),
    caller,
    notify: env.notify,
    agentId: env.elevenLabsAgentId,
    agentPhoneNumberId: env.elevenLabsAgentPhoneNumberId,
    refuseGazetteer: env.callMode === "live" && env.allowGazetteerDial !== true,
  });
  const orchestrator = new ReservationOrchestrator({
    directory,
    caller,
    phone,
    interpreter,
    notify: env.notify,
    autoComplete: env.autoComplete ?? env.callMode === "mock",
    mockScenario,
    webhookSecret: env.webhookSecret,
    otherCallCompletion: env.otherCallCompletion,
    timeZone: env.timeZone,
    callTimeoutMs: env.callTimeoutMs,
    store: env.stateStore ? ReservationStore.open(env.stateStore) : undefined,
    deposits: loadDemoDepositCatalog(env.depositsJson),
    payments,
    merchants,
    providers: env.providers ?? [new RippleBistroProvider()],
    paymentMode,
    depositHoldMinutes: env.depositHoldMinutes,
  });
  return {
    orchestrator,
    caller,
    payments,
    listen(port: number) {
      return startWebhookServer(
        port,
        (body, signature) => orchestrator.handleWebhook(body, signature),
        (path, query) => paymentTraceRoute(orchestrator, path, query),
      );
    },
  };
}

/** Local read-only trace. A space id or reservation id is required; nothing lists every conversation. */
export function paymentTraceRoute(
  orchestrator: ReservationOrchestrator,
  path: string,
  query: URLSearchParams,
): { status: number; body: unknown } | undefined {
  if (path === "/reservations/payments") {
    const spaceId = query.get("spaceId");
    if (!spaceId) return { status: 400, body: { error: "spaceId_required" } };
    return { status: 200, body: { traces: orchestrator.paymentTraces(spaceId) } };
  }
  const match = /^\/reservations\/([^/]+)\/payment$/.exec(path);
  if (!match?.[1]) return undefined;
  const trace = orchestrator.paymentTrace(decodeURIComponent(match[1]));
  return trace ? { status: 200, body: trace } : { status: 404, body: { error: "not_found" } };
}
