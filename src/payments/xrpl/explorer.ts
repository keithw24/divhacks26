import { isValidClassicAddress } from "xrpl";

/** XRPL Explorer (maintained by Ripple) for the public Testnet. Not the Mainnet explorer. */
export const XRPL_TESTNET_EXPLORER = "https://testnet.xrpl.org";

const HASH = /^[A-F0-9]{64}$/i;

export function testnetTransactionUrl(hash: string | null | undefined): string | null {
  if (!hash || !HASH.test(hash)) return null;
  return `${XRPL_TESTNET_EXPLORER}/transactions/${hash.toUpperCase()}`;
}

/** Reply-safe Testnet explorer URL. Prefers a validated 64-char hash; still links other ledger ids. */
export function testnetExplorerLink(hash: string | null | undefined): string | null {
  const canonical = testnetTransactionUrl(hash);
  if (canonical) return canonical;
  const trimmed = hash?.trim();
  if (!trimmed || trimmed.length < 8) return null;
  if (/^[0-9A-Fa-f]+$/.test(trimmed)) return `${XRPL_TESTNET_EXPLORER}/transactions/${trimmed.toUpperCase()}`;
  if (/^[0-9A-Za-z]+$/.test(trimmed)) return `${XRPL_TESTNET_EXPLORER}/transactions/${trimmed}`;
  return null;
}

export function testnetAccountUrl(address: string | null | undefined): string | null {
  if (!address || !isValidClassicAddress(address)) return null;
  return `${XRPL_TESTNET_EXPLORER}/accounts/${address}`;
}
