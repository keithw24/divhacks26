import { PaymentAuditLog } from "./audit.js";
import { XrplPaymentExecutor } from "./executor.js";
import { PolicyEngine, type PolicyConfig } from "./policy.js";
import type { SecretStore } from "./secrets.js";
import { TestnetFaucetService } from "./testnet-faucet.js";
import { XrplAgentTools } from "./tools.js";
import type { LedgerPort, TestnetFaucet } from "./types.js";
import { WalletRegistry } from "./wallets.js";

export interface RippleGuardOptions {
  serverUrl: string;
  /** Faucet transport. Wrapped in TestnetFaucetService, which enforces Testnet and verifies balances. */
  faucet: TestnetFaucet;
  ledger: LedgerPort;
  secrets: SecretStore;
  xrpPerUsd: number;
  policy: PolicyConfig;
  autoProvision: boolean;
  authorizedSenderIds?: readonly string[];
  allowTamperHook?: boolean;
  publicWalletPath?: string;
  /** JSON Lines file. Without it the audit is in memory only. */
  auditPath?: string;
  faucetTimeoutMs?: number;
  now?: () => Date;
}

export function createRippleGuard(options: RippleGuardOptions) {
  const audit = new PaymentAuditLog(() => options.secrets.knownSecrets(), options.auditPath);
  const faucet = new TestnetFaucetService({
    transport: options.faucet,
    ledger: options.ledger,
    serverUrl: options.serverUrl,
    timeoutMs: options.faucetTimeoutMs,
    now: options.now,
  });
  const registry = new WalletRegistry({
    faucet,
    secrets: options.secrets,
    autoProvision: options.autoProvision,
    now: options.now,
    publicPath: options.publicWalletPath,
    onEvent: (event) => audit.appendEvent(event),
  });
  const engine = new PolicyEngine(options.policy);
  const executor = new XrplPaymentExecutor({
    registry,
    ledger: options.ledger,
    audit,
    engine,
    serverUrl: options.serverUrl,
    xrpPerUsd: options.xrpPerUsd,
    authorizedSenderIds: options.authorizedSenderIds,
    allowTamperHook: options.allowTamperHook,
    now: options.now,
  });
  const tools = new XrplAgentTools(registry, options.ledger, audit, executor);
  return { audit, faucet, registry, engine, executor, tools, secrets: options.secrets, ledger: options.ledger };
}

export type RippleGuard = ReturnType<typeof createRippleGuard>;
