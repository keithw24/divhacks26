import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client, Wallet } from "xrpl";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { createMerchantDirectory } from "../../src/payments/merchants.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import {
  createGuardedReservationPayments,
  createTestnetBalanceReader,
  createTestnetTransactionReader,
} from "../../src/payments/reservation-deposits.js";
import { XRPL_TESTNET_NETWORK_ID, assertRippleTestUrl, createRippleTestProvider } from "../../src/payments/ripple.js";
import { PaymentService } from "../../src/payments/service.js";
import { XrplDashboardBuilder } from "../../src/payments/xrpl/dashboard.js";
import { createLiveRippleGuard } from "../../src/payments/xrpl/runtime.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import { RippleBistroProvider } from "../../src/reservations/providers.js";
import { createMemoryDirectory, DEMO_RESTAURANTS } from "../../src/reservations/restaurant.js";
import { formatPaymentTrace } from "../../src/reservations/trace.js";

const url = (process.env.XRPL_TESTNET_URL || "wss://s.altnet.rippletest.net:51233").trim();
/** Faucet wallets hold about 100 XRP, so the $100 demo deposit is sent as 10 test XRP by default. */
const xrpPerUsd = positive(process.env.DEPOSIT_LIVE_XRP_PER_USD, 0.1);
const OUTPUT = "data/reservation-deposit/last-run.json";
const SPACE = "ripple-bistro-live";

/**
 * Opt-in end-to-end Ripple Bistro booking on XRPL Testnet:
 *   npm run test:reservation-deposit-live
 * Funds a sender and a restaurant wallet from the Testnet faucet (unless XRPL_TESTNET_SEED is set),
 * then runs the same orchestrator, guardrail, and PaymentService path as the agent.
 * Prints addresses and the transaction hash. Never prints a seed.
 */
async function main(): Promise<void> {
  assertRippleTestUrl(url);
  const client = new Client(url, { timeout: 60_000 });
  let senderSeed = process.env.XRPL_TESTNET_SEED?.trim() || "";
  let merchant = "";
  try {
    await client.connect();
    if (client.networkID !== XRPL_TESTNET_NETWORK_ID) {
      throw new Error(`server network id ${String(client.networkID)} is not XRPL Testnet (${XRPL_TESTNET_NETWORK_ID})`);
    }
    if (!senderSeed) {
      console.info("Funding a Photon sender wallet from the XRPL Testnet faucet…");
      const funded = await client.fundWallet();
      senderSeed = funded.wallet.seed ?? "";
    }
    console.info("Funding the Ripple Bistro restaurant wallet from the XRPL Testnet faucet…");
    merchant = (await client.fundWallet()).wallet.classicAddress;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
  const senderAddress = Wallet.fromSeed(senderSeed).classicAddress;
  console.info(`Sender (Photon) wallet: ${senderAddress}`);
  console.info(`Ripple Bistro wallet:   ${merchant}`);

  const payments = new PaymentService({
    provider: createRippleTestProvider({ serverUrl: url, seed: senderSeed, xrpPerUsd, timeoutMs: 40_000 }),
    directory: loadRecipientDirectory(),
    maxUsd: 500,
    timeoutMs: 45_000,
  });
  const merchants = createMerchantDirectory({ mode: "ripple_test", json: JSON.stringify({ "Ripple Bistro": merchant }) });
  const xrpl = createLiveRippleGuard({ autoProvision: false, autonomousEnabled: false });
  const audit = xrpl.guard.audit;
  const bistro = new RippleBistroProvider();
  const caller = new MockOutboundCaller("exact_time");
  const orchestrator = new ReservationOrchestrator({
    directory: createMemoryDirectory(DEMO_RESTAURANTS),
    caller,
    autoComplete: true,
    mockScenario: "exact_time",
    timeZone: "America/New_York",
    providers: [bistro],
    merchants,
    paymentMode: "ripple_test",
    payments: createGuardedReservationPayments({
      payments,
      merchants,
      mode: "ripple_test",
      serverUrl: url,
      xrpPerUsd,
      maxUsd: 500,
      dailyMaxUsd: 1000,
      senderAddress,
      balanceDrops: createTestnetBalanceReader(url),
      ledgerTransaction: createTestnetTransactionReader(url),
      audit,
    }),
  });

  const turn = async (text: string, messageId: string) => {
    console.info(`\nRohan: ${text}`);
    const result = await orchestrator.handleTurn({ spaceId: SPACE, senderId: "rohan", senderName: "Rohan", text, messageId });
    console.info(`@agent: ${result.reply ?? ""}`);
    return result;
  };

  await turn("@agent book Ripple Bistro for 4 tomorrow at 8", "live-book");
  const pending = orchestrator.reservations.active(SPACE);
  if (pending?.status !== "AWAITING_DEPOSIT" || bistro.confirmations.length > 0) {
    throw new Error("Expected the agent to ask for the deposit before paying or booking.");
  }
  await turn("Book it", "live-not-authorization");
  await turn("yes", "live-yes");
  await turn("yes", "live-yes");

  const reservation = orchestrator.reservations.get(pending.id);
  const trace = orchestrator.paymentTrace(pending.id);
  orchestrator.dispose();
  if (!reservation || !trace) throw new Error("Reservation disappeared.");
  console.info(`\n${formatPaymentTrace(trace)}`);
  const events = audit.snapshot().events.filter((event) => event.paymentId === trace.obligationId);
  console.info(`\nGuardrail audit: ${events.map((event) => event.eventType).join(" → ")}`);
  const dashboard = await new XrplDashboardBuilder({
    registry: xrpl.guard.registry,
    audit,
    ledger: xrpl.ledger,
    secrets: () => [senderSeed, ...xrpl.secrets.knownSecrets()],
  }).build();
  await xrpl.ledger.close();
  const shown = dashboard.transactions.find((tx) => tx.paymentId === trace.obligationId);
  console.info(
    shown
      ? `Website XRPL dashboard: ${shown.recipient.name} ${shown.amount.xrp} XRP, verified on ledger: ${shown.verifiedOnLedger}`
      : "Website XRPL dashboard: deposit not listed (ledger evidence could not be verified).",
  );
  if (JSON.stringify(dashboard).includes(senderSeed)) throw new Error("Seed reached the dashboard model.");

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify({ ranAt: new Date().toISOString(), xrpPerUsd, trace }, null, 2)}\n`);
  console.info(`\nWrote ${OUTPUT}`);

  if (trace.ledgerResult !== "tesSUCCESS" || !trace.transactionHash) {
    throw new Error("XRPL Testnet did not confirm tesSUCCESS. No success is claimed.");
  }
  if (reservation.status !== "BOOKED") throw new Error("Payment confirmed but the reservation was not booked.");
  console.info(`\nExplorer: ${trace.explorerUrl}`);
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

void main().catch((error: unknown) => {
  const seed = process.env.XRPL_TESTNET_SEED?.trim();
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "Error";
  console.error(seed ? text.split(seed).join("[redacted]") : text);
  process.exitCode = 1;
});
