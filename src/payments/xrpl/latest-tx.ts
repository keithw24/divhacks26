import { Client, isValidClassicAddress } from "xrpl";
import { config } from "../../config.js";
import { assertRippleTestUrl, XRPL_TESTNET_NETWORK_ID } from "../ripple.js";
import { testnetAccountUrl, testnetTransactionUrl } from "./explorer.js";

const HASH = /(?:https:\/\/testnet\.xrpl\.org)?\/transactions\/([A-Fa-f0-9]{64})/g;

export type LatestTestnetTx =
  | { url: string; hash: string }
  | { failed: true };

export interface LatestTestnetTxLookup {
  (input: { account: string }): Promise<LatestTestnetTx>;
}

function firstExplorerHash(html: string): string | undefined {
  HASH.lastIndex = 0;
  const match = HASH.exec(html);
  return match?.[1]?.toUpperCase();
}

async function hashFromAccountPage(account: string, fetchPage: (url: string) => Promise<string>): Promise<string | undefined> {
  const page = testnetAccountUrl(account);
  if (!page) return undefined;
  const html = await fetchPage(page);
  return firstExplorerHash(html);
}

async function hashFromLedger(account: string, serverUrl: string): Promise<string | undefined> {
  assertRippleTestUrl(serverUrl);
  const client = new Client(serverUrl, { timeout: 20_000 });
  await client.connect();
  try {
    if (client.networkID !== XRPL_TESTNET_NETWORK_ID) return undefined;
    const response = await client.request({ command: "account_tx", account, limit: 20, forward: false });
    for (const item of response.result.transactions) {
      const tx = item.tx_json;
      if (!tx || tx.TransactionType !== "Payment" || !item.hash) continue;
      const meta = item.meta;
      const result = typeof meta === "string" ? undefined : meta && "TransactionResult" in meta ? String(meta.TransactionResult) : undefined;
      if (result && result !== "tesSUCCESS") continue;
      if (item.validated === false) continue;
      return item.hash.toUpperCase();
    }
    return undefined;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/**
 * After a send, open the recipient's Testnet account page and take the newest
 * transaction link. If the page has no hashes (it is a client-rendered app),
 * read the same account from the Testnet ledger.
 */
export async function latestTestnetPaymentLink(input: {
  account: string;
  serverUrl?: string;
  fetchPage?: (url: string) => Promise<string>;
  ledgerHash?: (account: string) => Promise<string | undefined>;
}): Promise<LatestTestnetTx> {
  if (!isValidClassicAddress(input.account)) return { failed: true };
  const serverUrl = input.serverUrl ?? config.xrplTestnetUrl;
  const fetchPage =
    input.fetchPage ??
    (async (url: string) => {
      const response = await fetch(url, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`explorer http ${response.status}`);
      return response.text();
    });
  const ledgerHash = input.ledgerHash ?? ((account: string) => hashFromLedger(account, serverUrl));

  let hash: string | undefined;
  try {
    hash = await hashFromAccountPage(input.account, fetchPage);
  } catch {
    hash = undefined;
  }
  if (!hash) {
    try {
      hash = await ledgerHash(input.account);
    } catch {
      return { failed: true };
    }
  }
  const url = hash ? testnetTransactionUrl(hash) : null;
  if (!url) return { failed: true };
  return { url, hash };
}

export function createLatestTestnetTxLookup(serverUrl: string): LatestTestnetTxLookup {
  return (input) => latestTestnetPaymentLink({ account: input.account, serverUrl });
}
