import type { PaymentAuditLog } from "./audit.js";
import type { PaymentInput, XrplPaymentExecutor } from "./executor.js";
import type { LedgerPort } from "./types.js";
import type { WalletRegistry } from "./wallets.js";

export interface AutonomousPaymentRequest {
  senderCustomerId: string;
  recipientName: string;
  amountUsd: number;
  memo?: string | null;
  spaceId?: string;
}

/**
 * Safe read models for an agent. These functions do not accept or return seeds.
 * The only state-changing call is xrpl_execute_autonomous_payment, which goes
 * through PolicyEngine before any signature. It takes a customer name, never an address.
 *
 * The external XRPL MCP server is not mounted here. It would duplicate the
 * xrpl.js client this process already uses, and a second signer would be another
 * place a seed could leak. Policy ALLOW/DENY stays in PolicyEngine.
 */
export class XrplAgentTools {
  constructor(
    private readonly registry: WalletRegistry,
    private readonly ledger: LedgerPort,
    private readonly audit: PaymentAuditLog,
    private readonly executor: XrplPaymentExecutor,
  ) {}

  xrpl_get_customer_wallet(customerId: string) {
    return this.registry.getWallet(customerId) ?? null;
  }

  async xrpl_get_balance(customerId: string) {
    const wallet = this.xrpl_get_customer_wallet(customerId);
    if (!wallet) return { error: "unknown-or-unprovisioned-customer" as const };
    const drops = await this.ledger.getBalanceDrops(wallet.xrplAddress);
    this.registry.recordBalance(wallet.customerId, drops);
    return { customerId: wallet.customerId, xrplAddress: wallet.xrplAddress, drops };
  }

  async xrpl_get_transaction(hash: string) {
    const local = this.audit.findByHash(hash);
    if (local) return local;
    if (!this.ledger.getTransaction) return null;
    const remote = await this.ledger.getTransaction(hash);
    if (!remote?.hash) return null;
    return {
      hash: remote.hash,
      engineResult: remote.engineResult,
      validated: remote.validated,
      ledgerIndex: remote.ledgerIndex,
    };
  }

  xrpl_get_payment_evidence(paymentId: string) {
    return this.audit.evidenceFor(paymentId) ?? null;
  }

  xrpl_get_policy_result(paymentId: string) {
    return this.audit.policyFor(paymentId) ?? null;
  }

  xrpl_execute_autonomous_payment(input: AutonomousPaymentRequest) {
    const request: PaymentInput = {
      senderCustomerId: input.senderCustomerId,
      recipientName: input.recipientName,
      amountUsd: input.amountUsd,
      memo: input.memo ?? null,
      spaceId: input.spaceId,
      mode: "autonomous",
    };
    return this.executor.execute(request);
  }
}
