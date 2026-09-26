import "dotenv/config";
import { randomUUID } from "node:crypto";
import { resolveXrplNetwork } from "./client.js";
import { testnetTransactionUrl } from "./explorer.js";
import { createXrplPayments, type XrplPayments } from "./payments.js";
import { redactText } from "./redact.js";
import { startXrplTransactionsApi } from "./transactions-api.js";
import { WalletCredentialsError, errorCode, loadTestWallet } from "./wallet.js";

/**
 * XRPL Testnet operator commands. Nothing here runs on agent startup, and only
 * `test-payment` moves test XRP, and only with an explicit destination and amount.
 *
 *   npm run xrpl:status
 *   npm run xrpl:test-payment -- <destination> <amountXrp> [--memo text] [--key idempotency-key]
 *   npm run xrpl:fund [-- --force]
 *   npm run xrpl:transactions
 *   npm run xrpl:api
 */
async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
  let network;
  try {
    network = resolveXrplNetwork();
  } catch (error) {
    console.error(`Refusing to run: ${error instanceof Error ? error.message : "invalid XRPL network"}`);
    return 1;
  }
  if (!preflightWallet()) return 1;
  const payments = createXrplPayments({ network });
  try {
    switch (command) {
      case "status":
        return await status(payments);
      case "test-payment":
        return await testPayment(payments, rest);
      case "fund":
        return await fund(payments, rest.includes("--force"));
      case "transactions":
        return transactions(payments);
      case "api":
        return await api(payments);
      default:
        console.error("Usage: cli.ts status | test-payment <destination> <amountXrp> | fund [--force] | transactions | api");
        return 1;
    }
  } finally {
    if (command !== "api") await payments.close();
  }
}

function preflightWallet(): boolean {
  try {
    loadTestWallet();
    return true;
  } catch (error) {
    if (error instanceof WalletCredentialsError) {
      console.error(`XRPL wallet not configured (${error.code}).`);
      console.error(error.message.replace(/^\w+: /, ""));
      if (error.missing.length) console.error(`Set: ${error.missing.join(", ")}`);
      console.error("No wallet was generated.");
    } else {
      console.error(`XRPL wallet could not be loaded (${errorCode(error)}).`);
    }
    return false;
  }
}

async function status(payments: XrplPayments): Promise<number> {
  const result = await payments.getWalletStatus();
  console.info(`XRPL Network: ${result.network}`);
  console.info(`Wallet: ${result.address ?? "not configured"}${result.walletSource ? ` (source: ${result.walletSource})` : ""}`);
  console.info(`Balance: ${result.balanceXrp ?? "unknown"} XRP`);
  console.info(`Account exists: ${result.accountExists === null ? "unknown" : result.accountExists ? "yes" : "no"}`);
  console.info(`Connection: ${result.connected ? "OK" : `FAILED${result.error ? ` (${result.error})` : ""}`}`);
  if (result.explorerUrl) console.info(`Explorer: ${result.explorerUrl}`);
  return result.connected ? 0 : 1;
}

async function testPayment(payments: XrplPayments, args: string[]): Promise<number> {
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
  const [destination, rawAmount] = positional;
  const amountXrp = Number(rawAmount);
  if (!destination || !rawAmount) {
    console.error("Usage: npm run xrpl:test-payment -- <destination> <amountXrp> [--memo text] [--key idempotency-key]");
    console.error("Nothing was sent.");
    return 1;
  }
  const key = flag(args, "--key") ?? `cli-test-payment:${randomUUID()}`;
  console.info(`Sending ${amountXrp} test XRP on XRPL Testnet to ${destination} (idempotency key ${key}).`);
  const result = await payments.send({
    destination,
    amountXrp,
    memo: flag(args, "--memo"),
    purpose: "cli_test_payment",
    idempotencyKey: key,
  });
  const record = result.record;
  console.info(`Status: ${result.status}${result.replayed ? " (returned the earlier transaction for this key)" : ""}`);
  if (result.error) console.info(`Reason: ${result.error.code} - ${result.error.message}`);
  if (record) {
    console.info(`From: ${record.sender}`);
    console.info(`To: ${record.destination}`);
    console.info(`Amount: ${record.amountXrp} XRP (${record.amountDrops} drops)`);
    console.info(`Transaction: ${record.transactionHash ?? "none"}`);
    console.info(`Ledger: ${record.ledgerIndex ?? "not validated"} ${record.engineResult ?? ""}`.trim());
    const link = record.ledgerIndex !== null ? testnetTransactionUrl(record.transactionHash) : null;
    if (link) console.info(`Explorer: ${link}`);
  }
  return result.ok ? 0 : 1;
}

async function fund(payments: XrplPayments, force: boolean): Promise<number> {
  console.info("Requesting test XRP from the official XRPL Testnet faucet for the existing wallet.");
  const result = await payments.fundTestWallet({ force });
  console.info(`Wallet: ${result.address || "not configured"}`);
  if (result.skipped) {
    console.info(`Balance is already ${result.balanceBefore} XRP; faucet not called. Use --force to top up anyway.`);
    return 0;
  }
  console.info(`Balance before: ${result.balanceBefore} XRP`);
  console.info(`Balance after: ${result.balanceAfter} XRP`);
  if (result.transactionHash) console.info(`Funding transaction: ${result.transactionHash}`);
  if (result.error) console.info(`Result: FAILED (${result.error})`);
  return result.success ? 0 : 1;
}

function transactions(payments: XrplPayments): number {
  const rows = payments.listPublicTransactions({ limit: 20 });
  if (!rows.length) console.info("No XRPL Testnet transactions recorded yet.");
  for (const row of rows) {
    console.info(
      `${row.createdAt}  ${row.type.padEnd(7)} ${row.statusLabel.padEnd(9)} ${row.amountXrp} XRP  ${row.senderShort} -> ${row.destinationShort}  ${row.transactionHash ?? ""}`,
    );
  }
  return 0;
}

async function api(payments: XrplPayments): Promise<number> {
  const port = Number(process.env.XRPL_TRANSACTIONS_API_PORT) || 8791;
  const server = await startXrplTransactionsApi(payments, port, { corsOrigin: process.env.XRPL_TRANSACTIONS_API_CORS_ORIGIN });
  console.info(`XRPL operator API (read-only): http://127.0.0.1:${server.port}/api/xrpl/status`);
  console.info(`Transactions: http://127.0.0.1:${server.port}/api/xrpl/transactions`);
  return new Promise(() => undefined);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    let secrets: readonly string[] = [];
    try {
      secrets = loadTestWallet().redactionList();
    } catch {
      // Nothing to scrub.
    }
    console.error(redactText(error instanceof Error ? `${error.name}: ${error.message}` : "XRPL command failed", secrets));
    process.exitCode = 1;
  });
