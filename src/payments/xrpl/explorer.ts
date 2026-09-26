import { isValidClassicAddress } from "xrpl";

/** XRPL Explorer (maintained by Ripple) for the public Testnet. Not the Mainnet explorer. */
export const XRPL_TESTNET_EXPLORER = "https://testnet.xrpl.org";

const HASH = /^[A-F0-9]{64}$/i;

export function testnetTransactionUrl(hash: string | null | undefined): string | null {
  if (!hash || !HASH.test(hash)) return null;
  return `${XRPL_TESTNET_EXPLORER}/transactions/${hash.toUpperCase()}`;
}

export function testnetAccountUrl(address: string | null | undefined): string | null {
  if (!address || !isValidClassicAddress(address)) return null;
  return `${XRPL_TESTNET_EXPLORER}/accounts/${address}`;
}
