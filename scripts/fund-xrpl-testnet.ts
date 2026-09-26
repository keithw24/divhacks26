/**
 * Funds an XRPL Testnet sender and Keith/Ben/Sarah destinations, then writes
 * XRPL_TESTNET_SEED and PAYMENTS_RECIPIENTS_JSON into .env (gitignored).
 */
import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { faucetTestnetAccount } from "../src/payments/faucet.js";

loadEnv();

function upsertEnv(path: string, updates: Record<string, string>): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const keys = new Set(Object.keys(updates));
  const lines = text.split("\n").filter((line, index, all) => !(index === all.length - 1 && line === ""));
  const out: string[] = [];
  for (const line of lines) {
    const key = line.split("=", 1)[0];
    if (key && keys.has(key)) {
      out.push(`${key}=${updates[key]}`);
      keys.delete(key);
    } else {
      out.push(line);
    }
  }
  for (const key of keys) out.push(`${key}=${updates[key]}`);
  writeFileSync(path, `${out.join("\n")}\n`);
}

async function main() {
  const sender = process.env.XRPL_TESTNET_SEED
    ? null
    : await faucetTestnetAccount();
  const keith = await faucetTestnetAccount();
  const ben = await faucetTestnetAccount();
  const sarah = await faucetTestnetAccount();
  const recipients = {
    Keith: { displayName: "Keith", rippleDestination: keith.address },
    Ben: { displayName: "Ben", rippleDestination: ben.address },
    Sarah: { displayName: "Sarah", rippleDestination: sarah.address },
  };
  const updates: Record<string, string> = {
    PAYMENTS_MODE: "nessie_ripple",
    PAYMENTS_RECIPIENTS_JSON: JSON.stringify(recipients),
  };
  if (sender) updates.XRPL_TESTNET_SEED = sender.seed;
  upsertEnv(".env", updates);
  console.info("Linked Nessie to XRPL Testnet (PAYMENTS_MODE=nessie_ripple). Funded Keith/Ben/Sarah receive addresses.");
  if (sender) console.info(`Sender address ${sender.address} (seed written to .env, not printed).`);
}

await main();
