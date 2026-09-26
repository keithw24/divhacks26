import "dotenv/config";
import { config } from "../config.js";
import { REGISTERED_CUSTOMERS, findRegisteredCustomer } from "./xrpl/customers.js";
import { createLiveRippleGuard, XRPL_DEMO_FILES } from "./xrpl/runtime.js";
import { redactText } from "./xrpl/redact.js";

/**
 * Funds registered Testnet wallets from the official XRPL Testnet faucet
 * (faucet.altnet.rippletest.net). A new name gets a new account. A name that
 * already has a wallet is topped up at the same address.
 *
 *   npm run faucet
 *   npm run faucet -- Rohan Keith
 *
 * Seeds stay in data/ripple-demo/secrets.json and are not printed.
 * Testnet XRP has no value. This command refuses every network except Testnet.
 */
async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => arg !== "--");
  const names = requested.length > 0 ? requested : REGISTERED_CUSTOMERS.map((customer) => customer.customerName);
  const customers = names.map((name) => {
    const customer = findRegisteredCustomer(name);
    if (!customer) throw new Error(`unknown customer cannot be funded: ${name}`);
    return customer;
  });
  const unique = [...new Map(customers.map((customer) => [customer.customerId, customer])).values()];

  const { guard, ledger, secrets } = createLiveRippleGuard({ autoProvision: false, autonomousEnabled: false });
  let failed = false;
  try {
    await ledger.connect();
    console.info(`Connected to XRPL Testnet (${config.xrplTestnetUrl}), network id ${ledger.networkId}.`);
    console.info("Asking the official Testnet faucet for XRP. Testnet XRP has no monetary value.");
    for (const customer of unique) {
      try {
        const funded = await guard.registry.fundTestnetWallet(customer.customerId, `faucet:${customer.customerId}`);
        const balance = funded.funding?.balanceXrp ?? funded.wallet.lastKnownBalance?.xrp ?? "unknown";
        const action = funded.created ? "created" : "topped up";
        const tx = funded.funding?.fundingTransactionHash ? `  funding tx ${funded.funding.fundingTransactionHash}` : "";
        console.info(`${customer.customerName} ${funded.wallet.xrplAddress}  ${balance} XRP  ${action}${tx}`);
      } catch (error) {
        failed = true;
        console.error(`${customer.customerName}: ${redactText(error instanceof Error ? error.message : "faucet failed", secrets.knownSecrets())}`);
      }
    }
    console.info(`Public addresses: ${XRPL_DEMO_FILES.wallets}`);
    console.info("Seeds were not printed. Run the judge demo with: npm run demo:ripple");
  } catch (error) {
    failed = true;
    console.error(redactText(error instanceof Error ? error.message : "faucet failed", secrets.knownSecrets()));
  } finally {
    await ledger.close();
  }
  if (failed) process.exitCode = 1;
}

void main();
