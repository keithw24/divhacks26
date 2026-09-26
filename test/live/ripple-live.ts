import "dotenv/config";
import { Client, Wallet } from "xrpl";
import { PaymentService } from "../../src/payments/service.js";
import { MapRecipientDirectory } from "../../src/payments/recipients.js";
import {
  XRPL_TESTNET_NETWORK_ID,
  assertRippleTestUrl,
  createRippleTestProvider,
  describeSandboxAmount,
} from "../../src/payments/ripple.js";

const url = (process.env.XRPL_TESTNET_URL || "wss://s.altnet.rippletest.net:51233").trim();
const xrpPerUsd = positive(process.env.PAYMENTS_XRP_PER_USD, 1);
const amountUsd = 1;

/**
 * Opt-in XRPL Testnet payment. Refuses every host except the public Testnet,
 * and refuses the connection unless the server reports Testnet network id 1.
 * Prints addresses and the transaction hash. Never prints a seed.
 */
async function main(): Promise<void> {
  try {
    assertRippleTestUrl(url);
  } catch (error) {
    console.error(safe(error));
    process.exitCode = 1;
    return;
  }

  const client = new Client(url, { timeout: 60_000 });
  let senderSeed = process.env.XRPL_TESTNET_SEED?.trim() || "";
  let destination = "";
  try {
    await client.connect();
    if (client.networkID !== XRPL_TESTNET_NETWORK_ID) {
      console.error(`Refusing to run: server network id ${String(client.networkID)} is not XRPL Testnet (${XRPL_TESTNET_NETWORK_ID}).`);
      process.exitCode = 1;
      return;
    }
    console.info(`Connected to XRPL Testnet (${url}).`);
    if (!senderSeed) {
      console.info("XRPL_TESTNET_SEED is unset. Funding a temporary Testnet sender from the official faucet.");
      const funded = await client.fundWallet();
      senderSeed = funded.wallet.seed ?? "";
      console.info(`Sender address: ${funded.wallet.address}`);
      console.info(`Sender balance: ${funded.balance} XRP`);
    } else {
      const sender = Wallet.fromSeed(senderSeed);
      console.info(`Sender address: ${sender.address}`);
    }
    console.info("Funding a temporary Testnet destination for Keith.");
    const receiver = await client.fundWallet();
    destination = receiver.wallet.classicAddress;
    console.info(`Keith destination: ${destination}`);
  } catch (error) {
    console.error(safe(error, senderSeed));
    process.exitCode = 1;
    return;
  } finally {
    await client.disconnect().catch(() => undefined);
  }

  if (!senderSeed || !destination) {
    console.error("Testnet funding did not return a sender and destination.");
    process.exitCode = 1;
    return;
  }

  const quoted = describeSandboxAmount({ destination, amountUsd, idempotencyKey: "preview" }, xrpPerUsd);
  const provider = createRippleTestProvider({
    serverUrl: url,
    seed: senderSeed,
    xrpPerUsd,
    timeoutMs: 40_000,
  });
  const service = new PaymentService({
    provider,
    directory: new MapRecipientDirectory({
      Keith: { displayName: "Keith", rippleDestination: destination },
    }),
    maxUsd: 500,
    timeoutMs: 45_000,
  });

  const pending = await service.handleTurn({
    spaceId: "ripple-live",
    senderId: "demo-user",
    senderName: "Rohan",
    text: "Send Keith $1 for coffee",
    messageId: "live-request",
  });
  console.info(`Photon: ${pending.reply ?? ""}`);
  const record = service.payments.active("ripple-live");
  if (!record || record.status !== "AWAITING_CONFIRMATION") {
    console.error("Expected a pending payment before confirmation.");
    process.exitCode = 1;
    return;
  }

  const confirmed = await service.handleTurn({
    spaceId: "ripple-live",
    senderId: "demo-user",
    senderName: "Rohan",
    text: "Yes",
    messageId: "live-confirm",
  });
  const settled = service.payments.get(record.id);
  console.info(`Photon: ${confirmed.reply ?? ""}`);
  console.info(
    JSON.stringify(
      {
        paymentId: record.id,
        destination,
        amountUsd,
        submittedAsset: settled?.submittedAsset ?? quoted.asset,
        submittedAmount: settled?.submittedAmount ?? quoted.amount,
        submittedDrops: settled?.submittedDrops ?? quoted.drops,
        xrpPerUsd,
        transactionId: settled?.transactionId ?? null,
        status: settled?.status ?? "unknown",
        providerStatus: settled?.providerStatus ?? null,
      },
      null,
      2,
    ),
  );

  if (settled?.status !== "SUCCEEDED" || !settled.transactionId) {
    console.error("Ripple did not confirm tesSUCCESS. No success is claimed.");
    process.exitCode = 1;
  }
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safe(error: unknown, seed?: string): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "Error";
  if (!seed) return text;
  return text.split(seed).join("[redacted]");
}

void main().catch((error: unknown) => {
  console.error(safe(error, process.env.XRPL_TESTNET_SEED));
  process.exitCode = 1;
});
