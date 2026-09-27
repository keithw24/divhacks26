import "dotenv/config";
import { Client } from "xrpl";
import { config } from "../../src/config.js";
import { unlinkedSenderText } from "../../src/payments/format.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import { createPaymentRuntime } from "../../src/payments/runtime.js";
import { createRippleTestProvider } from "../../src/payments/ripple.js";
import { PaymentService } from "../../src/payments/service.js";
import { CustomerWalletSettlement, parseCustomerSenders } from "../../src/payments/xrpl/settlement.js";
import { loadTestWallet } from "../../src/payments/xrpl/wallet.js";
import { createLiveRippleGuard } from "../../src/payments/xrpl/runtime.js";
import { AccountOnboardingStore, ONBOARDING_ACCOUNTS_PATH } from "../../src/payments/xrpl/onboarding.js";

/**
 * Live bugtest: two wallets + the same confirmation path the iMessage agent uses.
 * Prints addresses, balances, replies, and explorer URLs. Never prints a seed.
 */
async function account(client: Client, address: string) {
  try {
    const info = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return { exists: true, xrp: Number(info.result.account_data.Balance) / 1_000_000 };
  } catch {
    return { exists: false, xrp: 0 };
  }
}

async function main(): Promise<number> {
  const url = config.xrplTestnetUrl;
  const directory = loadRecipientDirectory(config.paymentsRecipientsJson);
  const names = directory.knownNames();
  console.info(`PAYMENTS_MODE=${config.paymentsMode}`);
  console.info(`Recipient directory: ${names.join(", ") || "(empty)"}`);

  let operator: { address: string } | undefined;
  try {
    const wallet = loadTestWallet();
    operator = { address: wallet.address };
    console.info(`Operator wallet: ${wallet.address} (source ${wallet.source})`);
  } catch (error) {
    console.info(`Operator wallet: not loadable (${error instanceof Error ? error.name : "Error"})`);
  }

  const client = new Client(url, { timeout: 45_000 });
  await client.connect();
  console.info(`Ledger network id: ${client.networkID}`);
  if (operator) {
    const op = await account(client, operator.address);
    console.info(`Operator on ledger: exists=${op.exists} balance=${op.xrp} XRP`);
  }
  for (const name of names) {
    const dest = directory.resolve(name)!.rippleDestination;
    const info = await account(client, dest);
    console.info(`${name} ${dest}: exists=${info.exists} balance=${info.xrp} XRP`);
  }
  await client.disconnect();

  const onboarding = new AccountOnboardingStore(ONBOARDING_ACCOUNTS_PATH);
  const onboarded = onboarding.list();
  console.info(`Onboarded Photon wallets: ${onboarded.length}`);
  for (const row of onboarded) {
    console.info(`  ${row.customerName} ${row.xrplAddress ?? "(no address yet)"}`);
  }
  const senders = parseCustomerSenders(config.xrplCustomerSendersJson);
  console.info(`XRPL_CUSTOMER_SENDERS_JSON entries: ${Object.keys(senders).length}`);

  const xrpl = createLiveRippleGuard({ autoProvision: false, autonomousEnabled: false });
  try {
    const settlement = new CustomerWalletSettlement(xrpl.guard.executor, { ...senders, ...onboarding.senderMap() }, () =>
      onboarding.displayNames(),
    );
    const prod = createPaymentRuntime({
      settlement,
      mode: config.paymentsMode,
      maxUsd: config.paymentsMaxUsd,
      xrpPerUsd: config.paymentsXrpPerUsd,
      timeoutMs: config.paymentsTimeoutMs,
      serverUrl: config.xrplTestnetUrl,
      seed: config.xrplTestnetSeed,
      recipientsJson: config.paymentsRecipientsJson,
      nessieApiKey: config.nessieApiKey,
      nessieBaseUrl: config.nessieBaseUrl,
    });

    const keith = names.includes("Keith") ? "Keith" : names[0];
    if (!keith) {
      console.info("No directory recipient to send to.");
      return 1;
    }

    const unlinked = await prod.service.handleTurn({
      spaceId: "bugtest-p2p",
      senderId: "+15550001111",
      senderName: "Rohan",
      text: `Send ${keith} $1 for coffee`,
      messageId: `bugtest-unlinked-${Date.now()}`,
    });
    console.info(`Agent P2P (unmapped Photon sender): ${unlinked.reply}`);
    const unlinkedExpected = unlinked.reply === unlinkedSenderText();
    console.info(`Unlinked-sender guard: ${unlinkedExpected ? "PASS" : "UNEXPECTED"}`);

    const mappedId = Object.keys(senders)[0] ?? onboarded[0]?.photonSenderId;
    if (mappedId) {
      const pending = await prod.service.handleTurn({
        spaceId: "bugtest-p2p-mapped",
        senderId: mappedId,
        senderName: "Rohan",
        text: `Send ${keith} $1 for coffee`,
        messageId: `bugtest-mapped-${Date.now()}`,
      });
      console.info(`Agent P2P (mapped sender): ${pending.reply}`);
      if (pending.reply && /Send \$1/.test(pending.reply) && /yes/i.test(pending.reply ?? "")) {
        const yes = await prod.service.handleTurn({
          spaceId: "bugtest-p2p-mapped",
          senderId: mappedId,
          senderName: "Rohan",
          text: "yes",
          messageId: `bugtest-mapped-yes-${Date.now()}`,
        });
        console.info(`Agent P2P confirm: ${yes.reply}`);
      }
    } else {
      console.info("No Photon sender → customer wallet map, so customer-wallet P2P cannot confirm.");
    }

    if (operator && directory.resolve(keith)) {
      const provider = createRippleTestProvider({
        serverUrl: config.xrplTestnetUrl,
        seed: config.xrplTestnetSeed,
        xrpPerUsd: config.paymentsXrpPerUsd || 1,
        timeoutMs: 45_000,
      });
      const operatorPay = new PaymentService({
        provider,
        directory,
        maxUsd: config.paymentsMaxUsd || 500,
        timeoutMs: 45_000,
      });
      const ask = await operatorPay.handleTurn({
        spaceId: "bugtest-operator",
        senderId: "operator-test",
        senderName: "Rohan",
        text: `Send ${keith} $1 for bugtest`,
        messageId: `bugtest-op-${Date.now()}`,
      });
      console.info(`Operator-wallet ask: ${ask.reply}`);
      const yes = await operatorPay.handleTurn({
        spaceId: "bugtest-operator",
        senderId: "operator-test",
        senderName: "Rohan",
        text: "yes",
        messageId: `bugtest-op-yes-${Date.now()}`,
      });
      console.info(`Operator-wallet confirm: ${yes.reply}`);
      const rec = operatorPay.payments.active("bugtest-operator");
      console.info(`Operator-wallet status: ${rec?.status ?? "none"} tx=${rec?.transactionId ?? "none"}`);
      if (rec?.status !== "SUCCEEDED") return 1;
    }
    return 0;
  } finally {
    await xrpl.ledger.close().catch(() => undefined);
  }
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const text = error instanceof Error ? error.message : "Error";
    console.error(text.replace(/\bs[1-9A-HJ-NP-Za-km-z]{25,}/g, "[redacted]"));
    process.exitCode = 1;
  });
