const FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";

export interface FundedTestnetAccount {
  address: string;
  seed: string;
}

/** Testnet-only. Test XRP has no value. */
export async function faucetTestnetAccount(fetchImpl: typeof fetch = fetch): Promise<FundedTestnetAccount> {
  const response = await fetchImpl(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    account?: { classicAddress?: string; address?: string; secret?: string; seed?: string };
    address?: string;
    secret?: string;
    seed?: string;
  };
  const address =
    payload.account?.classicAddress || payload.account?.address || payload.address;
  const seed =
    payload.account?.secret || payload.account?.seed || payload.secret || payload.seed;
  if (!response.ok || !address || !seed) {
    const accountKeys = payload.account ? Object.keys(payload.account).join(",") : "";
    throw new Error(`XRPL Testnet faucet failed (${response.status}) keys=${Object.keys(payload)} accountKeys=${accountKeys}`);
  }
  return { address, seed };
}
