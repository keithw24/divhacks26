import { attachment, Spectrum, type Message, type Space } from "spectrum-ts";
import { saveEvidencePlan } from "./evidence/history.js";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { ConversationInbox } from "./chat/inbox.js";
import { handleInboundMessage } from "./agent/inbound.js";
import { suggestNext } from "./agent/suggest.js";
import { errorCategory } from "./agent/turn.js";
import { lastLocation, locationsForSpace, recordLocation, recordMessage, transcript } from "./chat/context.js";
import { senderDisplayName } from "./chat/invoke.js";
import { parseLatLng } from "./chat/location.js";
import { setCalendarIcsBase } from "./calendar/links.js";
import { config } from "./config.js";
import { safetyChartImage } from "./safetyChart.js";
import { createAlertService, startAreaAlertWatcher } from "./alerts/service.js";
import { liveDemoProblems } from "./integrations/live-demo.js";
import { logIntegration } from "./integrations/log.js";
import { createBackboardMemoryService } from "./memory/backboard.js";
import { openAgentStateStore } from "./store/state.js";
import { createPaymentRuntime } from "./payments/runtime.js";
import { createLedgerService } from "./ledger/service.js";
import { XrplDashboardBuilder } from "./payments/xrpl/dashboard.js";
import { DASHBOARD_PATH, startXrplDashboardServer } from "./payments/xrpl/dashboard-server.js";
import { xrplPayments } from "./payments/xrpl/payments.js";
import { createLiveRippleGuard } from "./payments/xrpl/runtime.js";
import { CustomerWalletSettlement, parseCustomerSenders } from "./payments/xrpl/settlement.js";
import { AccountOnboardingService, AccountOnboardingStore, ONBOARDING_ACCOUNTS_PATH } from "./payments/xrpl/onboarding.js";
import { WalletChatService } from "./payments/wallet-chat.js";
import { createReservationRuntime } from "./reservations/runtime.js";
import { geocodeNyc } from "./geocode.js";
import { createMerchantDirectory } from "./payments/merchants.js";
import { createTicketingRuntime } from "./ticketing/runtime.js";
import { publicTicketPurchase } from "./ticketing/service.js";
import { createMeetupRuntime } from "./meetup/runtime.js";
import { ConversationContextStore } from "./orchestration/context.js";
import { createPlacesRestaurantSearch } from "./orchestration/dining.js";
import { CrossDomainOrchestrator } from "./orchestration/orchestrator.js";
import { createTransportationServiceFromEnv } from "./transport/factory.js";
import { createBackboardClient } from "./backboard/client.js";
import { startWebRuntime } from "./web/runtime.js";
import { createMailer } from "./web/email.js";
import { readSocialContext } from "./agent/social.js";
import { INSTANCE_ID, createMessageClaimer } from "./chat/claim.js";
import { createDeepSpaceClient, startOutboxPoller, type InboundResult } from "./deepspace/client.js";
import { createDirectoryCache, mergePeopleDirectory, type PeopleDirectoryEntry } from "./deepspace/directory.js";
import { notifyPaymentReceived } from "./payments/notify.js";
import { getPool } from "./safety.js";
import { shouldSpeak } from "./voice/decide.js";
import { sendVoiceReply, transcribeVoiceMemo, voiceEnabled } from "./voice/index.js";

const UNHEARD_VOICE_MEMO = "[sent a voice memo]";

const liveProblems = liveDemoProblems(config);
if (liveProblems.length) {
  console.error("LIVE_DEMO_MODE startup check failed:");
  for (const problem of liveProblems) console.error(`- ${problem}`);
  throw new Error("LIVE_DEMO_MODE refused to start");
}
if (config.liveDemoMode) {
  logIntegration("DEMO", "LIVE", "mock ticket, reservation, and gazetteer fallbacks are disabled");
}
const reservationCallMode = config.liveDemoMode ? "live" : config.reservationCallMode;
const ticketingProviderName = config.liveDemoMode ? "ticketmaster" : config.ticketingProvider;

const transport = createTransportationServiceFromEnv({
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  googleMapsApiKey: config.googleMapsApiKey,
  databaseUrl: config.databaseUrl,
});
const spaceSenders = new Map<string, (text: string) => Promise<unknown>>();
const agentState = openAgentStateStore(config.agentStatePath);
const onboardingStore = new AccountOnboardingStore(ONBOARDING_ACCOUNTS_PATH);
const usesCustomerWallets = config.paymentsMode === "ripple_test" || config.paymentsMode === "nessie_ripple";
const xrpl = usesCustomerWallets || Boolean(config.deepspaceOnboardingSecret) ? createLiveRippleGuard() : undefined;
const onboarding = new AccountOnboardingService(onboardingStore, xrpl?.guard.registry);
const walletChat = new WalletChatService({ onboarding });
const customerSenders = parseCustomerSenders(config.xrplCustomerSendersJson);
const liveSenders = () => ({ ...customerSenders, ...onboardingStore.senderMap() });
const paymentNotice: {
  sendToExternalId: (externalId: string, body: string) => Promise<void>;
  notifyDeepSpace?: (input: { xrplAddress?: string; userId?: string; body: string }) => Promise<{ queued: boolean; userId?: string | null }>;
} = {
  sendToExternalId: async () => undefined,
};
const peopleSnapshot: { current: PeopleDirectoryEntry[] } = { current: [] };
const ledger = createLedgerService({
  query: config.databaseUrl
    ? (sql, params) => getPool(config.databaseUrl).query(sql, params)
    : undefined,
  agentName: config.agentName,
});
// Merchant payees must be real Testnet addresses whenever the provider submits to XRPL.
const merchantPaymentMode =
  config.paymentsMode === "ripple_test" || config.paymentsMode === "nessie_ripple" ? "ripple_test" : "mock";
const payments = createPaymentRuntime({
  settlement:
    xrpl && usesCustomerWallets
      ? new CustomerWalletSettlement(
          xrpl.guard.executor,
          liveSenders,
          () => onboardingStore.displayNames(),
          (customerId) => xrpl.guard.registry.getAddress(customerId) ?? onboardingStore.findByCustomerId(customerId)?.xrplAddress,
        )
      : undefined,
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
  onPersonSettled: async (event) => {
    await ledger.recordSettledPayment(event);
    await notifyPaymentReceived(event, {
      onboarding: onboardingStore,
      sendToExternalId: (externalId, body) => paymentNotice.sendToExternalId(externalId, body),
      notifyDeepSpace: paymentNotice.notifyDeepSpace,
    }).catch((error) => {
      console.error(`payment notify failed: ${error instanceof Error ? error.name : "Error"}`);
    });
  },
  audit: xrpl?.guard.audit,
  peopleDirectory: () =>
    peopleSnapshot.current.length
      ? peopleSnapshot.current
      : onboardingStore.peopleDirectory(),
});
const meetup = createMeetupRuntime({
  googleMapsApiKey: config.googleMapsApiKey,
  timeZone: config.timezone,
  stateStore: agentState,
});
const reservations = createReservationRuntime({
  callMode: reservationCallMode,
  providers: config.liveDemoMode ? [] : undefined,
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
const alerts = createAlertService({ store: agentState, geocode: geocodeNyc });
// Unprompted area alerts only reach chats that opted in with "watch …"; "stop alerts" ends them.
startAreaAlertWatcher({
  store: agentState,
  send: async (spaceId, text) => {
    const send = spaceSenders.get(spaceId);
    if (!send) {
      console.info(JSON.stringify({ event: "area_alert_undelivered", spaceId }));
      return;
    }
    recordMessage(spaceId, config.agentName, text);
    await send(text);
  },
});
const conversationContext = ConversationContextStore.open(agentState);
const ticketing = createTicketingRuntime({
  provider: ticketingProviderName,
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
    conversationContext.noteEvent(spaceId, event);
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
const orchestration = new CrossDomainOrchestrator({
  context: conversationContext,
  ticketing: ticketing.service,
  reservations: reservations.orchestrator,
  payments: payments.service,
  transport,
  restaurants: createPlacesRestaurantSearch({ apiKey: config.googleMapsApiKey, strict: config.liveDemoMode }),
  resolvePlace: async (query) => {
    const place = await geocodeNyc(query);
    return place ? { latitude: place.latitude, longitude: place.longitude, label: place.label } : undefined;
  },
  paymentMode: merchantPaymentMode,
  timeZone: config.timezone,
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

/** Sounds heard in the last voice memo per message id (tone cues for the social read). */
const heardAudioEvents = new Map<string, string[]>();

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
      const heard = await transcribeVoiceMemo(content).catch((err) => {
        console.error(`voice transcription failed: ${errorCategory(err)} ${err instanceof Error ? err.message : ""}`);
        return null;
      });
      if (heard?.audioEvents.length) heardAudioEvents.set(message.id, heard.audioEvents);
      return heard?.text ?? UNHEARD_VOICE_MEMO;
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
  reservationCallMode === "live"
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
  const linked = Object.keys(liveSenders()).length;
  if (linked === 0) {
    console.warn("No Photon sender is linked to a customer wallet (XRPL_CUSTOMER_SENDERS_JSON or DeepSpace onboarding). Person payments will be refused.");
  } else {
    console.info(`${linked} Photon sender(s) linked to XRPL Testnet customer wallets.`);
  }
  if (config.deepspaceOnboardingSecret) {
    console.info("DeepSpace onboarding API is enabled at POST /api/deepspace/accounts (Bearer DEEPSPACE_ONBOARDING_SECRET).");
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
    ticketPurchases: () => ticketing.service.store.listPurchases(20).map(publicTicketPurchase),
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
setCalendarIcsBase(config.calendarPublicUrl);

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
        deepspaceOnboardingSecret: config.deepspaceOnboardingSecret || undefined,
        enrollPhotonUser: (input) =>
          onboarding.enroll({
            photonSenderId: input.photonSenderId,
            displayName: input.displayName,
            provisionWallet: input.provisionWallet,
            userId: input.userId,
          }),
        lookupPhotonUser: async (photonSenderId) => onboarding.publicView(photonSenderId),
        lookupPhotonUserByUserId: async (userId) => onboarding.publicViewByUserId(userId),
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

// Two agents on one Photon project (e.g. a laptop and the droplet) would both answer every message.
const claims = createMessageClaimer({
  query:
    config.chatProvider === "imessage" && config.databaseUrl && config.messageClaims
      ? (sql, params) => getPool(config.databaseUrl).query(sql, params)
      : undefined,
});
console.info(`agent instance ${INSTANCE_ID} (message claims: ${config.chatProvider === "imessage" && config.databaseUrl && config.messageClaims ? "database" : "this process only"})`);

// DeepSpace backend: identity, shared plans and cross-channel notifications.
const deepspace =
  config.chatProvider === "imessage" && config.deepspaceApiUrl && config.deepspaceChannelSecret
    ? createDeepSpaceClient({ baseUrl: config.deepspaceApiUrl, secret: config.deepspaceChannelSecret })
    : undefined;
console.info(deepspace ? `DeepSpace backend: ${config.deepspaceApiUrl}` : "DeepSpace backend: off (set DEEPSPACE_API_URL and DEEPSPACE_CHANNEL_SECRET).");
if (deepspace) {
  paymentNotice.notifyDeepSpace = (input) => deepspace.notifyPayment(input);
  startOutboxPoller({
    client: deepspace,
    channel: "imessage",
    intervalMs: config.deepspaceOutboxPollMs,
    send: async (item) => {
      const chat = await imessage(app as never).space.create(item.externalId);
      await chat.send(item.body);
      recordMessage(chat.id, config.agentName, item.body);
    },
  });
}
const loadDeepSpaceDirectory = createDirectoryCache(async () => (deepspace ? deepspace.directory() : []));
paymentNotice.sendToExternalId = async (externalId, body) => {
  if (config.chatProvider !== "imessage") return;
  const chat = await imessage(app as never).space.create(externalId);
  await chat.send(body);
  recordMessage(chat.id, config.agentName, body);
};

/** Tell the backend who is talking. Fails open: the agent still answers if DeepSpace is down. */
async function checkInWithBackend(space: Space, message: Message, who: string, text: string): Promise<InboundResult | null> {
  if (!deepspace || who === "someone") return null;
  return deepspace
    .inbound({
      deliveryId: message.id,
      channel: "imessage",
      externalId: who,
      conversationId: space.id,
      displayName: senderDisplayName(message.sender),
      text,
      receivedAt: message.timestamp.toISOString(),
    })
    .catch((error) => {
      console.error(`deepspace inbound failed: ${error instanceof Error ? error.message.slice(0, 160) : "Error"}`);
      return null;
    });
}

async function processMessages(items: { space: Space; message: Message }[]) {
  const { space, message } = items[items.length - 1]!;

  const isGroup =
    config.chatProvider === "terminal"
      ? config.terminalAsGroup
      : (space as { type?: string }).type === "group";
  const who = message.sender?.id ?? "someone";

  const texts: string[] = [];
  for (const item of items) {
    const part = await readMessage(space.id, who, item.message).catch((err) => {
      console.error(`could not read message: ${errorCategory(err)}`);
      return null;
    });
    if (part !== null) texts.push(part);
  }
  if (!texts.length) return;
  const text = texts.join("\n");

  const backend = await checkInWithBackend(space, message, who, text);
  if (backend?.userId && who !== "someone") {
    const existing = onboardingStore.findByPhoton(who);
    if (existing) onboardingStore.upsert({ ...existing, userId: backend.userId });
  }
  if (backend?.duplicate) return;
  if (backend?.reply) {
    // The backend handled it (e.g. "LINK 123456"); don't also run the agent on it.
    recordMessage(space.id, who, text);
    const sent = await message.reply(backend.reply).catch(() => undefined);
    if (sent == null) await space.send(backend.reply).catch(() => undefined);
    recordMessage(space.id, config.agentName, backend.reply);
    return;
  }

  const isVoice = message.content.type === "voice";
  if (message.content.type !== "text") {
    // Which kind of non-text message arrived (e.g. voice vs audio attachment) — metadata only.
    const c = message.content as { type: string; mimeType?: string };
    console.info(`inbound.content ${JSON.stringify({ type: c.type, mimeType: c.mimeType, answerable: text !== UNHEARD_VOICE_MEMO })}`);
  }
  const canInvoke = message.content.type === "text" || (isVoice && text !== UNHEARD_VOICE_MEMO);
  const location = lastLocation(space.id);
  const audioEvents = heardAudioEvents.get(message.id);
  heardAudioEvents.delete(message.id);
  spaceSenders.set(space.id, (replyText) => space.send(replyText));
  await handleInboundMessage(
    {
      spaceId: space.id,
      messageId: message.id,
      messageIds: items.map((item) => item.message.id),
      senderId: who,
      senderName: senderDisplayName(message.sender),
      text,
      timestamp: message.timestamp.toISOString(),
      isGroup,
      canInvoke,
      direction: "inbound",
      senderKind: message.sender?.kind,
      isVoice,
      audioEvents,
    },
    {
      reply: (replyText) => space.send(replyText),
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
      wallets: walletChat,
      ticketing: ticketing.service,
      meetup: meetup.service,
      ledger,
      alerts,
      orchestration,
      liveLocations: (spaceId) => locationsForSpace(spaceId),
      transport,
      peopleDirectory: async () => {
        const merged = mergePeopleDirectory(onboardingStore.peopleDirectory(), await loadDeepSpaceDirectory());
        peopleSnapshot.current = merged;
        return merged;
      },
      suggest: (input) =>
        suggestNext({
          ...input,
          onEvidence: (plan) => saveEvidencePlan(agentState, who, plan),
          // The chart follows the text card; it is dropped if Gemini's restyle fails the read-back check.
          onSafetyReport: (report) => {
            if (config.chatProvider !== "imessage") return;
            void safetyChartImage(report)
              .then((image) =>
                image
                  ? space.send(attachment(image.data, { mimeType: image.mimeType, name: "reports-by-hour.png" }))
                  : undefined,
              )
              .catch((err) => console.warn(`safety.chart send failed: ${errorCategory(err)}`));
          },
        }),
      transcript: () => transcript(space.id),
      location,
      recordChatMessage: recordMessage,
      recordAssistant: (replyText, meta) => {
        recordMessage(space.id, config.agentName, replyText);
        // A signed-up user's own voice setting from the website wins over the global default.
        const speak = shouldSpeak({
          mode: web?.voicePreference(who) ?? config.voiceReplies,
          enabled: voiceEnabled(),
          inboundWasVoice: isVoice,
          social: meta?.social,
          outcome: meta?.outcome,
        });
        if (speak) {
          void sendVoiceReply(space, replyText, meta?.social).catch((err) => {
            console.error(`voice reply failed: ${errorCategory(err)} ${err instanceof Error ? err.message : ""}`);
          });
        }
      },
      readSocial: config.geminiApiKey ? (input) => readSocialContext(input) : undefined,
      speakLast: voiceEnabled()
        ? async (social) => {
            const last = [...transcript(space.id)].reverse().find((line) => line.who === config.agentName);
            if (!last) return false;
            await sendVoiceReply(space, last.text, social);
            return true;
          }
        : undefined,
      timeZone: config.timezone,
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

// Keep consuming arrivals while a turn is running so corrections can be collected.
const inbox = new ConversationInbox<{ space: Space; message: Message }>({
  delayMs: config.messageBatchDelayMs,
  identify: ({ space, message }) => ({
    spaceId: space.id,
    messageId: message.id,
    senderId: message.sender?.id ?? "someone",
    mergeable: message.content.type === "text",
  }),
  process: processMessages,
  onError: (error) => console.error(`inbound failed: ${errorCategory(error)}`),
});
for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound" || message.sender?.kind === "agent") continue;
  if (!(await claims.claim(message.id))) {
    console.info(`inbound.skipped ${JSON.stringify({ reason: "already_claimed", instance: INSTANCE_ID })}`);
    continue;
  }
  console.info(`inbound.claimed ${JSON.stringify({ instance: INSTANCE_ID })}`);
  const key = JSON.stringify([space.id, message.id]);
  if (agentState.getState().handledMessageIds?.includes(key)) continue;
  inbox.push({ space, message });
}
