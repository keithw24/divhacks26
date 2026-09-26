import { Spectrum, type Message } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { handleInboundMessage } from "./agent/inbound.js";
import { suggestNext } from "./agent/suggest.js";
import { errorCategory } from "./agent/turn.js";
import { lastLocation, locationsForSpace, recordLocation, recordMessage, transcript } from "./chat/context.js";
import { senderDisplayName } from "./chat/invoke.js";
import { parseLatLng } from "./chat/location.js";
import { config } from "./config.js";
import { createBackboardMemoryService } from "./memory/backboard.js";
import { openAgentStateStore } from "./store/state.js";
import { createPaymentRuntime } from "./payments/runtime.js";
import { XrplDashboardBuilder } from "./payments/xrpl/dashboard.js";
import { DASHBOARD_PATH, startXrplDashboardServer } from "./payments/xrpl/dashboard-server.js";
import { xrplPayments } from "./payments/xrpl/payments.js";
import { createLiveRippleGuard } from "./payments/xrpl/runtime.js";
import { CustomerWalletSettlement, parseCustomerSenders } from "./payments/xrpl/settlement.js";
import { createReservationRuntime } from "./reservations/runtime.js";
import { geocodeNyc } from "./geocode.js";
import { createMerchantDirectory } from "./payments/merchants.js";
import { createTicketingRuntime } from "./ticketing/runtime.js";
import { createMeetupRuntime } from "./meetup/runtime.js";
import { createTransportationServiceFromEnv } from "./transport/factory.js";
import { sendVoiceReply, transcribeVoiceMemo, voiceEnabled, wantsVoiceReply } from "./voice/index.js";
import { createBackboardClient } from "./backboard/client.js";
import { startWebRuntime } from "./web/runtime.js";
import { createMailer } from "./web/email.js";

const UNHEARD_VOICE_MEMO = "[sent a voice memo]";

const transport = createTransportationServiceFromEnv({
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  googleMapsApiKey: config.googleMapsApiKey,
  databaseUrl: config.databaseUrl,
});
const spaceSenders = new Map<string, (text: string) => Promise<unknown>>();
const agentState = openAgentStateStore(config.agentStatePath);
const xrpl = config.paymentsMode === "ripple_test" ? createLiveRippleGuard() : undefined;
const customerSenders = parseCustomerSenders(config.xrplCustomerSendersJson);
// Merchant payees must be real Testnet addresses whenever the provider submits to XRPL.
const merchantPaymentMode =
  config.paymentsMode === "ripple_test" || config.paymentsMode === "nessie_ripple" ? "ripple_test" : "mock";
const payments = createPaymentRuntime({
  settlement: xrpl ? new CustomerWalletSettlement(xrpl.guard.executor, customerSenders) : undefined,
  mode: config.paymentsMode,
  maxUsd: config.paymentsMaxUsd,
  xrpPerUsd: config.paymentsXrpPerUsd,
  timeoutMs: config.paymentsTimeoutMs,
  serverUrl: config.xrplTestnetUrl,
  seed: config.xrplTestnetSeed,
  recipientsJson: config.paymentsRecipientsJson,
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  stateStore: agentState,
  nessieApiKey: config.nessieApiKey,
  nessieBaseUrl: config.nessieBaseUrl,
  nessieCustomerId: config.nessieCustomerId,
  nessieAccountId: config.nessieAccountId,
});
const meetup = createMeetupRuntime({
  googleMapsApiKey: config.googleMapsApiKey,
  timeZone: config.timezone,
  stateStore: agentState,
});
const reservations = createReservationRuntime({
  callMode: config.reservationCallMode,
  mockScenario: config.reservationMockScenario,
  allowGazetteerDial: config.reservationAllowGazetteerDial,
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  googleMapsApiKey: config.googleMapsApiKey,
  elevenLabsApiKey: config.elevenLabsApiKey,
  elevenLabsAgentId: config.elevenLabsAgentId,
  elevenLabsAgentPhoneNumberId: config.elevenLabsAgentPhoneNumberId,
  webhookSecret: config.elevenLabsWebhookSecret,
  timeZone: config.timezone,
  callTimeoutMs: config.reservationCallTimeoutMs,
  stateStore: agentState,
  depositsJson: config.reservationDepositsJson,
  merchantsJson: config.paymentsMerchantsJson,
  paymentMode: merchantPaymentMode,
  depositPayments: payments.service,
  paymentsMaxUsd: config.paymentsMaxUsd,
  paymentsDailyMaxUsd: config.paymentsDailyMaxUsd,
  xrpPerUsd: config.paymentsXrpPerUsd,
  xrplTestnetUrl: config.xrplTestnetUrl,
  xrplDeposits: config.paymentsMode === "ripple_test" ? xrplPayments : undefined,
  paymentAudit: xrpl?.guard.audit,
  notify: async (spaceId, text) => {
    recordMessage(spaceId, config.agentName, text);
    const send = spaceSenders.get(spaceId);
    if (!send) {
      console.info(JSON.stringify({ event: "reservation_result_undelivered", spaceId }));
      return;
    }
    await send(text);
  },
});
const ticketing = createTicketingRuntime({
  provider: config.ticketingProvider,
  purchaseMode: config.ticketingPurchaseMode,
  ticketmasterApiKey: config.ticketmasterApiKey,
  ticketmasterPartnerApiKey: config.ticketmasterPartnerApiKey,
  timeZone: config.timezone,
  defaultCity: config.ticketingDefaultCity,
  resolvePlace: async (query) => {
    const place = await geocodeNyc(query);
    return place ? { latitude: place.latitude, longitude: place.longitude, label: place.label } : undefined;
  },
  onEventSelected: (spaceId, event) => {
    if (!event.venue) return;
    transport.noteDestination(spaceId, {
      name: event.venue,
      address: event.address,
      latitude: event.latitude,
      longitude: event.longitude,
      source: "context",
      confidence: 0.9,
    });
  },
  payments: {
    provider: payments.provider,
    mode: merchantPaymentMode,
    merchants: createMerchantDirectory({ mode: merchantPaymentMode, json: config.paymentsMerchantsJson }),
    merchantName: config.ticketingMerchantName,
    xrpPerUsd: config.paymentsXrpPerUsd,
    maxUsd: config.paymentsMaxUsd,
    timeoutMs: config.paymentsTimeoutMs,
  },
});
const memory = config.backboardApiKey
  ? createBackboardMemoryService({
      apiKey: config.backboardApiKey,
      store: agentState,
      memoryPro: config.backboardMemoryPro,
      writeMode: config.backboardMemoryMode,
    })
  : undefined;

async function connect() {
  if (config.chatProvider === "imessage") {
    if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
      throw new Error(
        "CHAT_PROVIDER=imessage needs SPECTRUM_PROJECT_ID/SPECTRUM_PROJECT_SECRET or PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET",
      );
    }
    return Spectrum({
      projectId: config.spectrumProjectId,
      projectSecret: config.spectrumProjectSecret,
      providers: [imessage.config()],
    });
  }
  return Spectrum({ providers: [terminal.config()] });
}

/** Turn any inbound message into text for the transcript, capturing shared locations on the way. */
async function readMessage(spaceId: string, who: string, message: Message): Promise<string | null> {
  const content = message.content;
  switch (content.type) {
    case "text": {
      const loc = parseLatLng(content.text);
      if (loc) recordLocation(spaceId, who, loc);
      return content.text;
    }
    case "richlink": {
      const loc = parseLatLng(content.url);
      if (loc) recordLocation(spaceId, who, loc);
      return loc ? "[shared a location]" : `[shared a link: ${content.url}]`;
    }
    case "attachment": {
      const isVcard = /vcard|vlocation/i.test(content.mimeType) || content.name.toLowerCase().endsWith(".vcf");
      if (isVcard && (content.size ?? 0) < 64_000) {
        const loc = parseLatLng((await content.read()).toString("utf8"));
        if (loc) {
          recordLocation(spaceId, who, loc);
          return "[shared a location]";
        }
      }
      return `[sent ${content.mimeType || "a file"}]`;
    }
    case "voice": {
      // Transcribed with ElevenLabs when configured; otherwise just noted in the transcript.
      const said = await transcribeVoiceMemo(content).catch((err) => {
        console.error(`voice transcription failed: ${errorCategory(err)} ${err instanceof Error ? err.message : ""}`);
        return null;
      });
      return said ?? UNHEARD_VOICE_MEMO;
    }
    default:
      return null;
  }
}

/** `npm start -- --text +14155551234` opens a 1:1 iMessage chat with that number and says hi. */
async function startChatWith(app: Awaited<ReturnType<typeof connect>>, rawNumber: string) {
  if (config.chatProvider !== "imessage") throw new Error("--text needs CHAT_PROVIDER=imessage");
  const digits = rawNumber.replace(/[^\d+]/g, "");
  const number = digits.startsWith("+") ? digits : `+1${digits}`;
  const space = await imessage(app as any).space.create(number);
  const intro =
    `Hey! I'm ${config.agentName}, your NYC sidekick. Tell me where you are and ask ` +
    `"what should we do?" and I'll suggest a few things nearby. Add me to a group chat and mention me by name too.`;
  await space.send(intro);
  recordMessage(space.id, config.agentName, intro);
  console.log(`Started a chat with ${number}`);
}

const app = await connect();
console.log(`${config.agentName} is listening on ${config.chatProvider}`);
if (!config.backboardApiKey) {
  console.warn("BACKBOARD_API_KEY is not set; persistent memory is disabled. @agent will use recent group context only.");
}
if (!config.geminiApiKey) {
  console.info("GEMINI_API_KEY is not set; transportation and Maps-grounded suggestions will fall back.");
}
console.info(
  voiceEnabled()
    ? `ElevenLabs voice on (voice replies: ${config.voiceReplies}).`
    : "ELEVENLABS_API_KEY is not set; voice memos won't be transcribed.",
);
if (config.googleMapsApiKey) {
  console.info("GOOGLE_MAPS_API_KEY is set; structured Routes/Places will supplement Gemini grounding.");
}
console.info(
  config.reservationCallMode === "live"
    ? "Reservations: live ElevenLabs outbound calls are enabled."
    : "Reservations: mock mode (no real phone calls).",
);
console.info(
  `Ticketing: ${ticketing.provider.name} provider, ${ticketing.service.effectiveMode} checkout` +
    (ticketing.service.effectiveMode === "link" ? " (official purchase links only; nothing is bought)." : "."),
);
if (xrpl) {
  console.info("Payments: XRPL Testnet. Person payments are signed by each customer's own Testnet wallet. No real money moves.");
  console.info(
    `XRPL customer wallets: ${xrpl.guard.registry.listPublic().map((w) => `${w.customerName} ${w.xrplAddress}`).join(", ") || "none yet"}.`,
  );
  const linked = Object.keys(customerSenders).length;
  if (linked === 0) {
    console.warn("XRPL_CUSTOMER_SENDERS_JSON is empty. No Photon sender is linked to a customer wallet, so person payments will be refused.");
  } else {
    console.info(`${linked} Photon sender(s) linked to XRPL Testnet customer wallets.`);
  }
  const depositWallet = reservations.payments?.senderAddress;
  if (depositWallet) {
    console.info(`Reservation deposits: XRPL Testnet through the shared payment service, from test wallet ${depositWallet}.`);
  } else {
    console.warn("No XRPL test wallet is configured for the payment service. Reservation deposits will be refused (run npm run xrpl:status).");
  }
  const dashboard = new XrplDashboardBuilder({
    registry: xrpl.guard.registry,
    audit: xrpl.guard.audit,
    ledger: xrpl.ledger,
    secrets: () => xrpl.secrets.knownSecrets(),
    operatorPayments: () => xrplPayments.listPublicTransactions({ limit: 20 }),
  });
  void startXrplDashboardServer(config.xrplDashboardPort, () => dashboard.build())
    .then((server) => console.info(`XRPL Testnet dashboard: http://127.0.0.1:${server.port}${DASHBOARD_PATH}`))
    .catch((error) => console.warn(`XRPL dashboard did not start: ${errorCategory(error)}`));
} else if (config.paymentsMode === "nessie_ripple") {
  console.info("Payments: XRPL Testnet. Dollar amounts are converted to test XRP. No real money moves.");
  if (!config.xrplTestnetSeed) {
    console.warn("PAYMENTS_MODE includes ripple_test but XRPL_TESTNET_SEED is missing. Confirmed ledger payments will fail closed.");
  }
}
if (config.autonomousPaymentsEnabled) {
  console.info(
    `Autonomous XRPL Testnet payments are enabled up to $${config.autonomousMaxUsd}. Photon transfers still wait for a human yes.`,
  );
}
if (config.paymentsMode === "nessie" || config.paymentsMode === "nessie_ripple") {
  console.info(
    config.nessieApiKey
      ? "Payments: Nessie mock bank (Capital One hackathon API). No real money moves."
      : "PAYMENTS_MODE includes Nessie but NESSIE_API_KEY is missing. Confirmed Nessie payments will fail closed.",
  );
}
if (config.paymentsMode === "mock") {
  console.info("Payments: mock mode (no Nessie or Ripple transaction is submitted).");
}
const web =
  config.webApiPort === "off"
    ? undefined
    : startWebRuntime({
        port: Number(config.webApiPort) || 8788,
        host: config.webApiHost,
        statePath: config.webStatePath,
        maxUsers: config.webMaxUsers,
        allowedOrigins: config.webAllowedOrigins,
        secret: config.webAuthSecret,
        agentName: config.agentName,
        appName: config.appName,
        agentNumber: config.agentNumber,
        mailer: createMailer({
          host: config.smtpHost,
          port: config.smtpPort,
          user: config.smtpUser,
          pass: config.smtpPass,
          from: config.emailFrom,
          devLog: config.chatProvider === "terminal",
        }),
        async sendText(phone, text) {
          if (config.chatProvider !== "imessage") {
            // Local development without iMessage: print instead of sending (includes login codes).
            console.info(`[dev] text to ${phone.slice(0, 2)}•••${phone.slice(-4)}: ${text}`);
            return;
          }
          const space = await imessage(app as never).space.create(phone);
          await space.send(text);
        },
        memory,
        backboard: config.backboardApiKey ? createBackboardClient({ apiKey: config.backboardApiKey }) : undefined,
        agentState,
        handleElevenLabsWebhook: (body, signature) => reservations.orchestrator.handleWebhook(body, signature),
      });
if (!web) {
  void reservations.listen(config.reservationWebhookPort).catch((error) => {
    console.error(`reservation webhook failed to listen: ${errorCategory(error)}`);
  });
}

const textFlag = process.argv.indexOf("--text");
if (textFlag !== -1) {
  const number = process.argv[textFlag + 1];
  if (!number) throw new Error("Usage: npm start -- --text +14155551234");
  // A failed intro (e.g. a bad number) shouldn't stop the agent from answering everyone else.
  await startChatWith(app, number).catch((err) => console.error(`Could not text ${number}:`, err.details ?? err.message));
}

for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound" || message.sender?.kind === "agent") continue;

  const isGroup =
    config.chatProvider === "terminal"
      ? config.terminalAsGroup
      : (space as { type?: string }).type === "group";
  const who = message.sender?.id ?? "someone";

  const text = await readMessage(space.id, who, message).catch((err) => {
    console.error(`could not read message: ${errorCategory(err)}`);
    return null;
  });
  if (text === null) continue;

  const isVoice = message.content.type === "voice";
  if (message.content.type !== "text") {
    // Which kind of non-text message arrived (e.g. voice vs audio attachment) — metadata only.
    const c = message.content as { type: string; mimeType?: string };
    console.info(`inbound.content ${JSON.stringify({ type: c.type, mimeType: c.mimeType, answerable: text !== UNHEARD_VOICE_MEMO })}`);
  }
  const canInvoke = message.content.type === "text" || (isVoice && text !== UNHEARD_VOICE_MEMO);
  const location = lastLocation(space.id);
  spaceSenders.set(space.id, (replyText) => space.send(replyText));
  await handleInboundMessage(
    {
      spaceId: space.id,
      messageId: message.id,
      senderId: who,
      senderName: senderDisplayName(message.sender),
      text,
      timestamp: message.timestamp.toISOString(),
      isGroup,
      canInvoke,
      direction: "inbound",
      senderKind: message.sender?.kind,
    },
    {
      reply: (replyText) => message.reply(replyText),
      send: (replyText) => space.send(replyText),
      react: (emoji) => message.react(emoji),
      responding: (fn) => space.responding(fn),
    },
    {
      autoReply: config.autoReply,
      store: agentState,
      memory,
      memoryPro: config.backboardMemoryPro,
      writeMode: config.backboardMemoryMode,
      verboseMemory: config.backboardVerboseMemory,
      secrets: [
        config.backboardApiKey,
        config.geminiApiKey,
        config.googleMapsApiKey,
        config.elevenLabsApiKey,
        config.elevenLabsWebhookSecret,
        config.xrplTestnetSeed,
        ...(xrpl?.secrets.knownSecrets() ?? []),
      ].filter(Boolean),
      reservations: reservations.orchestrator,
      payments: payments.service,
      ticketing: ticketing.service,
      meetup: meetup.service,
      liveLocations: (spaceId) => locationsForSpace(spaceId),
      transport,
      suggest: (input) => suggestNext(input),
      transcript: () => transcript(space.id),
      location,
      recordChatMessage: recordMessage,
      recordAssistant: (replyText) => {
        recordMessage(space.id, config.agentName, replyText);
        // A signed-up user's own voice setting from the website wins over the global default.
        if (wantsVoiceReply(web?.voicePreference(who) ?? config.voiceReplies, isVoice)) {
          void sendVoiceReply(space, replyText).catch((err) => {
            console.error(`voice reply failed: ${errorCategory(err)} ${err instanceof Error ? err.message : ""}`);
          });
        }
      },
      noteCoordinates: () => {
        if (location) transport.noteCoordinates(space.id, location);
      },
      loadParticipants: async () => {
        if (!isGroup) return undefined;
        try {
          const members = await space.getMembers();
          return members.map((member) => ({
            id: member.id,
            displayName: senderDisplayName(member),
          }));
        } catch {
          return undefined;
        }
      },
    },
  ).catch((err) => {
    console.error(`reply failed: ${errorCategory(err)}`);
  });
}
