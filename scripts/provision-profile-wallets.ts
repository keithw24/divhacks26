/**
 * Faucets XRPL Testnet wallets for ripple-demo accounts.json rows that have no address.
 * Seeds stay in data/ripple-demo/secrets.json and are not printed.
 */
import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerOnboardedCustomer } from "../src/payments/xrpl/customers.js";
import { createLiveRippleGuard } from "../src/payments/xrpl/runtime.js";
import { ONBOARDING_ACCOUNTS_PATH, type OnboardedAccount } from "../src/payments/xrpl/onboarding.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const now = new Date().toISOString();

const SEEDED: OnboardedAccount[] = [
  {
    photonSenderId: "REPLACE_WITH_KEITH_IMESSAGE",
    userId: "site:a8a3ad6d30df29e0c6404b3eb8a6c85a",
    customerId: "keith",
    customerName: "Keith",
    createdAt: now,
  },
  {
    photonSenderId: "+15742166599",
    userId: "photon:+15742166599",
    customerId: "onboard_327a5d02bd9f1379",
    customerName: "Mike",
    createdAt: now,
  },
  {
    photonSenderId: "+14847167944",
    userId: "photon:+14847167944",
    customerId: "onboard_3a4201c9ec80271e",
    customerName: "Alan",
    xrplAddress: "r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk",
    createdAt: "2026-09-27T02:41:54.634Z",
  },
  {
    photonSenderId: "+14849190859",
    userId: "photon:+14849190859",
    customerId: "onboard_e6a6fcb1aaeeffec",
    customerName: "Rohan",
    createdAt: now,
  },
];

function loadAccounts(): OnboardedAccount[] {
  try {
    const parsed = JSON.parse(readFileSync(ONBOARDING_ACCOUNTS_PATH, "utf8")) as { accounts?: OnboardedAccount[] };
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts: OnboardedAccount[]): void {
  writeFileSync(ONBOARDING_ACCOUNTS_PATH, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
}

function mergeAccounts(existing: OnboardedAccount[]): OnboardedAccount[] {
  const byKey = new Map<string, OnboardedAccount>();
  for (const row of existing) {
    const key = (row.userId || row.customerId || row.photonSenderId).trim().toLowerCase();
    if (key) byKey.set(key, row);
  }
  for (const seed of SEEDED) {
    const key = (seed.userId || seed.customerId).trim().toLowerCase();
    const prev = byKey.get(key);
    byKey.set(key, {
      ...seed,
      ...prev,
      photonSenderId: prev?.photonSenderId && !prev.photonSenderId.startsWith("REPLACE_") ? prev.photonSenderId : seed.photonSenderId,
      xrplAddress: prev?.xrplAddress || seed.xrplAddress,
      createdAt: prev?.createdAt ?? seed.createdAt,
    });
  }
  return [...byKey.values()];
}

async function main(): Promise<void> {
  const accounts = mergeAccounts(loadAccounts()).filter((row) => !row.photonSenderId.startsWith("REPLACE_") || row.userId);
  for (const row of accounts) {
    registerOnboardedCustomer({ customerId: row.customerId, customerName: row.customerName });
  }

  const { guard, ledger } = createLiveRippleGuard({ autoProvision: false, autonomousEnabled: false });
  try {
    await ledger.connect();
    for (const row of accounts) {
      if (row.photonSenderId.startsWith("REPLACE_")) {
        row.photonSenderId = row.photonSenderId;
      }
      const funded = await guard.registry.fundTestnetWallet(row.customerId, `profile:${row.customerId}`);
      row.xrplAddress = funded.wallet.xrplAddress;
      console.info(`${row.customerName} ${funded.created ? "created" : "kept"} Testnet wallet ${funded.wallet.xrplAddress}`);
    }
    saveAccounts(
      accounts.map((row) => {
        if (row.photonSenderId.startsWith("REPLACE_")) {
          const { photonSenderId: _unused, ...rest } = row;
          return rest as OnboardedAccount;
        }
        return row;
      }),
    );
    console.info(`Wrote ${accounts.length} accounts to ${ONBOARDING_ACCOUNTS_PATH}. Seeds were not printed.`);
  } finally {
    await ledger.close();
  }
}

await main();
