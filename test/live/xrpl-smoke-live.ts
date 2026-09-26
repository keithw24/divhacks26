import "dotenv/config";
import { XRPL_TESTNET_NETWORK_ID } from "../../src/payments/ripple.js";
import { LiveXrplClient, resolveXrplNetwork } from "../../src/payments/xrpl/client.js";
import { testnetAccountUrl } from "../../src/payments/xrpl/explorer.js";
import { redactText } from "../../src/payments/xrpl/redact.js";
import { WalletCredentialsError, dropsToXrpNumber, loadTestWallet } from "../../src/payments/xrpl/wallet.js";

/**
 * Read-only XRPL Testnet smoke test for the configured wallet. It connects, checks the network id,
 * reads the balance, confirms the account exists, and exits. It never signs or sends anything.
 *
 *   npm run test:xrpl-live
 */
async function main(): Promise<number> {
  const network = resolveXrplNetwork();
  let wallet;
  try {
    wallet = loadTestWallet();
  } catch (error) {
    if (error instanceof WalletCredentialsError) {
      console.error(`SKIP: no wallet configured (${error.code}). Set: ${error.missing.join(", ") || "XRPL_TESTNET_SEED"}`);
      return 1;
    }
    throw error;
  }
  const client = new LiveXrplClient(network);
  try {
    await client.connect();
    const networkOk = client.networkId === XRPL_TESTNET_NETWORK_ID;
    console.info(`Server: ${network.url} (network id ${client.networkId})`);
    console.info(`Wallet: ${wallet.address} (source: ${wallet.source})`);
    const account = await client.getAccount(wallet.address);
    console.info(`Account exists: ${account.exists ? "yes" : "no"}`);
    console.info(`Balance: ${dropsToXrpNumber(account.balanceDrops)} XRP`);
    console.info(`Explorer: ${testnetAccountUrl(wallet.address)}`);
    const ok = networkOk && account.exists;
    console.info(ok ? "PASS: XRPL Testnet wallet is reachable. No funds were moved." : "FAIL: see above. No funds were moved.");
    return ok ? 0 : 1;
  } catch (error) {
    console.error(`FAIL: ${redactText(error instanceof Error ? error.message : "Error", wallet.redactionList())}`);
    return 1;
  } finally {
    await client.disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`FAIL: ${error instanceof Error ? error.message.replace(/s[1-9A-HJ-NP-Za-km-z]{25,}/g, "[redacted]") : "Error"}`);
    process.exitCode = 1;
  },
);
