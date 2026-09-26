import { config } from "../../config.js";
import { policyConfig } from "./executor.js";
import { createRippleGuard, type RippleGuard } from "./guard.js";
import { LiveTestnetFaucet, LiveTestnetLedger } from "./live.js";
import { FileSecretStore } from "./secrets.js";

/**
 * Shared by the agent, npm run demo:ripple, npm run faucet, and the dashboard.
 * Everything is under data/, which is gitignored. secrets.json is written with mode 0600.
 */
export const XRPL_DEMO_FILES = {
  wallets: "data/ripple-demo/wallets.json",
  secrets: "data/ripple-demo/secrets.json",
  audit: "data/ripple-demo/audit.jsonl",
} as const;

export interface LiveRippleGuardOptions {
  autoProvision?: boolean;
  autonomousEnabled?: boolean;
  allowTamperHook?: boolean;
}

export function createLiveRippleGuard(options: LiveRippleGuardOptions = {}): {
  guard: RippleGuard;
  ledger: LiveTestnetLedger;
  secrets: FileSecretStore;
} {
  const secrets = new FileSecretStore(XRPL_DEMO_FILES.secrets);
  const ledger = new LiveTestnetLedger(config.xrplTestnetUrl, secrets);
  const guard = createRippleGuard({
    serverUrl: config.xrplTestnetUrl,
    faucet: new LiveTestnetFaucet(ledger),
    ledger,
    secrets,
    xrpPerUsd: config.paymentsXrpPerUsd,
    autoProvision: options.autoProvision ?? config.xrplAutoProvisionTestnet,
    allowTamperHook: options.allowTamperHook ?? false,
    publicWalletPath: XRPL_DEMO_FILES.wallets,
    auditPath: XRPL_DEMO_FILES.audit,
    policy: policyConfig({
      maxSingleUsd: config.paymentsMaxUsd,
      dailyMaxUsd: config.paymentsDailyMaxUsd,
      autonomousMaxUsd: config.autonomousMaxUsd,
      autonomousEnabled: options.autonomousEnabled ?? config.autonomousPaymentsEnabled,
    }),
  });
  return { guard, ledger, secrets };
}
