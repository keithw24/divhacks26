import "dotenv/config";
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { formatXrp, usdToDrops } from "./amount.js";
import { formatUsd } from "./format.js";
import { testnetAccountUrl, testnetTransactionUrl } from "./xrpl/explorer.js";
import type { RippleGuard } from "./xrpl/guard.js";
import type { LiveTestnetLedger } from "./xrpl/live.js";
import { redactText } from "./xrpl/redact.js";
import { createLiveRippleGuard, XRPL_DEMO_FILES } from "./xrpl/runtime.js";
import type { CustomerWallet, PaymentExecution } from "./xrpl/types.js";

const SPACE = "ripple-demo";
const LINE = "=".repeat(40);
const RULE = "-".repeat(40);
/** Top up from the faucet below this, so the 1 XRP payment never trips the balance check. */
const MIN_DEMO_BALANCE_DROPS = 20_000_000n;
const UNKNOWN_NAME = "RandomFakeCustomer";

interface CaseResult {
  pass: boolean;
  lines: string[];
}

/**
 * Judge demo on XRPL Testnet. Never Mainnet, never real money.
 *   npm run demo:ripple
 * One real 1 XRP payment Rohan → Keith, then three attacks that must not reach the ledger.
 */
async function main(): Promise<void> {
  const { guard, ledger, secrets } = createLiveRippleGuard({ autonomousEnabled: true, allowTamperHook: true });
  const limits = guard.executor.policyLimits;
  const summary: string[] = [];
  let failed = false;
  try {
    await ledger.connect();
    console.info(LINE);
    console.info("XRPL TESTNET DEMO · NO REAL MONEY");
    console.info(LINE);
    console.info(`server: ${config.xrplTestnetUrl} (network id ${ledger.networkId})`);
    console.info(`peg: $1 = ${config.paymentsXrpPerUsd} testnet XRP`);
    console.info(
      `demo policy: autonomous payments on for this run, autonomous limit ${formatUsd(limits.autonomousMaxUsd)}, single-payment limit ${formatUsd(limits.maxSingleUsd)}, daily limit ${formatUsd(limits.dailyMaxUsd)}`,
    );

    step(1, "Ensure Rohan's Testnet wallet exists");
    const rohan = await ensureWallet(guard, "rohan");
    step(2, "Ensure Keith's Testnet wallet exists");
    const keith = await ensureWallet(guard, "keith");
    step(3, "Fund through the faucet if needed");
    await topUpIfLow(guard, ledger, rohan);
    await topUpIfLow(guard, ledger, keith);

    step(4, "Wallet addresses and balances (read from a validated ledger)");
    for (const wallet of [rohan, keith]) {
      console.info("");
      console.info(wallet.customerName.toUpperCase());
      console.info(`address: ${wallet.xrplAddress}`);
      console.info(`balance: ${xrp(await ledger.getBalanceDrops(wallet.xrplAddress))} XRP`);
      console.info(`explorer: ${testnetAccountUrl(wallet.xrplAddress)}`);
    }

    step(5, "Autonomous, policy-approved Testnet payment: Rohan → Keith");
    step(6, "Wait for ledger validation");
    step(7, "Before/after balances and transaction hash");
    const success = await caseSuccess(guard, ledger, rohan, keith);
    summary.push("REAL TRANSACTION", success.pass ? "PASS" : "FAIL", "", ...success.lines);
    failed = !success.pass || failed;

    step(8, "Tampering attack: canonical intent $500, compromised proposal $5,000");
    step(9, "Prove it was blocked and balances did not change");
    const tamper = await caseTamper(guard, ledger, rohan, keith);
    summary.push(RULE, "", "GUARDRAIL: AMOUNT TAMPERING", tamper.pass ? "PASS" : "FAIL", "", ...tamper.lines);
    failed = !tamper.pass || failed;

    step(10, `Unknown-recipient attack: pay ${UNKNOWN_NAME} $5`);
    const unknown = await caseUnknown(guard, ledger, rohan);
    summary.push(RULE, "", "GUARDRAIL: UNKNOWN RECIPIENT", unknown.pass ? "PASS" : "FAIL", "", ...unknown.lines);
    failed = !unknown.pass || failed;

    step(11, `Spending-limit attack: autonomous $500 with a ${formatUsd(limits.autonomousMaxUsd)} limit`);
    const limit = await caseLimit(guard, ledger, rohan, keith);
    summary.push(RULE, "", "GUARDRAIL: SPENDING LIMIT", limit.pass ? "PASS" : "FAIL", "", ...limit.lines);
    failed = !limit.pass || failed;

    assertNoSecrets(guard, secrets.knownSecrets());

    console.info("");
    console.info(LINE);
    console.info("");
    console.info("XRPL TESTNET DEMO");
    console.info("");
    for (const line of summary) console.info(line);
    console.info("");
    console.info(LINE);
  } catch (error) {
    failed = true;
    console.error("");
    console.error("DEMO STOPPED");
    console.error(redactText(error instanceof Error ? `${error.name}: ${error.message}` : "Error", secrets.knownSecrets()));
  } finally {
    console.info(`Audit trail (append-only JSON lines): ${XRPL_DEMO_FILES.audit}`);
    console.info(`Public wallet metadata: ${XRPL_DEMO_FILES.wallets}`);
    console.info("Website data: npm run xrpl:dashboard, then cd frontend && npm run dev");
    await ledger.close();
  }
  if (failed) process.exitCode = 1;
}

async function ensureWallet(guard: RippleGuard, customerId: string): Promise<CustomerWallet> {
  const existed = guard.registry.hasWallet(customerId);
  const wallet = await guard.registry.ensureCustomerTestnetWallet(customerId, {
    paymentId: `demo-provision-${customerId}`,
    spaceId: SPACE,
  });
  if (existed) {
    console.info(`${wallet.customerName}: existing Testnet wallet ${wallet.xrplAddress} (no faucet call)`);
  } else {
    const funding = guard.faucet.getFundingResult(wallet.xrplAddress);
    console.info(`${wallet.customerName}: new wallet ${wallet.xrplAddress} funded by ${funding?.faucetHost ?? "the Testnet faucet"}`);
    if (funding?.fundingTransactionHash) {
      console.info(`  faucet funding tx: ${funding.fundingTransactionHash} (ledger ${funding.fundingLedgerIndex ?? "?"})`);
    }
    console.info(`  balance after funding (validated ledger): ${funding?.balanceXrp ?? "unknown"} XRP`);
  }
  return wallet;
}

async function topUpIfLow(guard: RippleGuard, ledger: LiveTestnetLedger, wallet: CustomerWallet): Promise<void> {
  const drops = BigInt(await ledger.getBalanceDrops(wallet.xrplAddress));
  if (drops >= MIN_DEMO_BALANCE_DROPS) {
    console.info(`${wallet.customerName}: ${xrp(drops.toString())} XRP, no top-up needed`);
    return;
  }
  const funded = await guard.registry.fundTestnetWallet(wallet.customerId, `demo-topup-${wallet.customerId}`, SPACE);
  console.info(`${wallet.customerName}: topped up by the faucet to ${funded.funding?.balanceXrp ?? "?"} XRP`);
}

async function caseSuccess(
  guard: RippleGuard,
  ledger: LiveTestnetLedger,
  rohan: CustomerWallet,
  keith: CustomerWallet,
): Promise<CaseResult> {
  const amountUsd = 1;
  const quote = usdToDrops(amountUsd, config.paymentsXrpPerUsd);
  const result = await guard.executor.execute({
    senderCustomerId: rohan.customerId,
    recipientName: keith.customerName,
    amountUsd,
    memo: "judge demo",
    spaceId: SPACE,
    mode: "autonomous",
  });
  const evidence = result.evidence;
  if (!evidence) {
    console.error("FAIL: no validated tesSUCCESS came back. Nothing is reported as sent.");
    console.error(summarize(result));
    return { pass: false, lines: [`reason: ${result.policy.reasonCode}`, `submitted to XRPL: ${yes(result.submittedToLedger)}`] };
  }
  const recheck = await ledger.getTransaction(evidence.transactionHash);
  const independentlyValidated = recheck?.validated === true && recheck.engineResult === "tesSUCCESS";
  const senderDelta = BigInt(evidence.senderBalanceBefore) - BigInt(evidence.senderBalanceAfter);
  const recipientDelta = BigInt(evidence.recipientBalanceAfter) - BigInt(evidence.recipientBalanceBefore);

  console.info("");
  console.info("XRPL TESTNET PAYMENT");
  console.info("");
  console.info("FROM:");
  console.info(evidence.senderName);
  console.info(evidence.senderAddress);
  console.info("");
  console.info("TO:");
  console.info(evidence.recipientName);
  console.info(evidence.recipientAddress);
  console.info("");
  console.info("AMOUNT:");
  console.info(`${evidence.amount.xrp} testnet XRP (${formatUsd(amountUsd)} at the demo peg, ${quote.drops} drops)`);
  console.info("");
  console.info("BEFORE:");
  console.info(`Rohan: ${xrp(evidence.senderBalanceBefore)} XRP`);
  console.info(`Keith: ${xrp(evidence.recipientBalanceBefore)} XRP`);
  console.info("");
  console.info("AFTER:");
  console.info(`Rohan: ${xrp(evidence.senderBalanceAfter)} XRP  (−${xrp(senderDelta.toString())}: ${evidence.amount.xrp} XRP + ${evidence.networkFeeDrops} drop network fee)`);
  console.info(`Keith: ${xrp(evidence.recipientBalanceAfter)} XRP  (+${xrp(recipientDelta.toString())})`);
  console.info("");
  console.info("TRANSACTION:");
  console.info(`hash: ${evidence.transactionHash}`);
  console.info(`ledger index: ${evidence.ledgerIndex ?? "unknown"}`);
  console.info(`engine result: ${evidence.engineResult}`);
  console.info(`validated: ${evidence.validated}`);
  console.info(`independent re-check via tx: validated=${recheck?.validated ?? "no answer"} result=${recheck?.engineResult ?? "no answer"}`);
  console.info(`explorer: ${evidence.explorerUrl}`);
  console.info(`policy: ${result.policy.decision} (${result.policy.checks.map((check) => check.code).join(", ")})`);

  const pass =
    result.policy.decision === "ALLOW" &&
    evidence.source === "XRPL_TESTNET" &&
    evidence.engineResult === "tesSUCCESS" &&
    evidence.validated === true &&
    independentlyValidated &&
    recipientDelta === BigInt(evidence.amount.drops);
  return {
    pass,
    lines: [
      "Rohan",
      evidence.senderAddress,
      `before: ${xrp(evidence.senderBalanceBefore)} XRP`,
      `after: ${xrp(evidence.senderBalanceAfter)} XRP`,
      "",
      "Keith",
      evidence.recipientAddress,
      `before: ${xrp(evidence.recipientBalanceBefore)} XRP`,
      `after: ${xrp(evidence.recipientBalanceAfter)} XRP`,
      "",
      "hash:",
      evidence.transactionHash,
      "",
      `ledger index: ${evidence.ledgerIndex ?? "unknown"}`,
      `engine result: ${evidence.engineResult}`,
      "validated:",
      String(evidence.validated && independentlyValidated),
      "",
      `explorer: ${testnetTransactionUrl(evidence.transactionHash)}`,
      "",
    ],
  };
}

async function caseTamper(
  guard: RippleGuard,
  ledger: LiveTestnetLedger,
  rohan: CustomerWallet,
  keith: CustomerWallet,
): Promise<CaseResult> {
  const before = await pair(ledger, rohan, keith);
  const result = await guard.executor.execute({
    senderCustomerId: rohan.customerId,
    recipientName: keith.customerName,
    amountUsd: 500,
    memo: "tamper test",
    spaceId: SPACE,
    mode: "confirmed",
    humanConfirmed: true,
    tamperedProposal: { amountUsd: 5000, drops: usdToDrops(5000, config.paymentsXrpPerUsd).drops },
  });
  const after = await pair(ledger, rohan, keith);
  const unchanged = before.sender === after.sender && before.recipient === after.recipient;
  const alsoFailed = result.policy.checks.filter((check) => !check.passed && check.reasonCode !== result.policy.reasonCode);

  console.info("");
  console.info(`canonical intent: Pay Keith ${formatUsd(result.intent.requestedAmountUsd)} (confirmed by Rohan)`);
  console.info(`transaction proposal: Pay Keith ${formatUsd(result.proposal?.amountUsd ?? 0)} (${xrp(result.proposal?.drops ?? "0")} XRP)`);
  console.info(`decision: ${result.policy.decision}`);
  console.info(`reasonCode: ${result.policy.reasonCode}`);
  console.info(`detail: ${result.policy.reasons[0] ?? ""}`);
  if (alsoFailed.length) {
    console.info(`other checks that also failed: ${alsoFailed.map((check) => check.reasonCode).join(", ")}`);
  }
  console.info(`submittedToLedger: ${result.submittedToLedger}`);
  console.info(`transactionHash: ${result.transactionHash}`);
  printUnchanged(before, after);

  const pass =
    result.policy.decision === "DENY" &&
    result.policy.reasonCode === "INTENT_PAYLOAD_MISMATCH" &&
    !result.submittedToLedger &&
    result.transactionHash === null &&
    result.evidence === null &&
    unchanged;
  return {
    pass,
    lines: [
      "intent: $500",
      "attempted: $5,000",
      `reason: ${result.policy.reasonCode}`,
      `submitted to XRPL: ${yes(result.submittedToLedger)}`,
      `hash: ${result.transactionHash ?? "NONE"}`,
      `balances changed: ${yes(!unchanged)}`,
      "",
    ],
  };
}

async function caseUnknown(guard: RippleGuard, ledger: LiveTestnetLedger, rohan: CustomerWallet): Promise<CaseResult> {
  const walletsBefore = guard.registry.listPublic().length;
  const faucetBefore = faucetRequests(guard, UNKNOWN_NAME);
  const senderBefore = await ledger.getBalanceDrops(rohan.xrplAddress);
  const result = await guard.executor.execute({
    senderCustomerId: rohan.customerId,
    recipientName: UNKNOWN_NAME,
    amountUsd: 5,
    spaceId: SPACE,
    mode: "autonomous",
  });
  const senderAfter = await ledger.getBalanceDrops(rohan.xrplAddress);
  const noWallet =
    guard.registry.getWallet(UNKNOWN_NAME) === undefined &&
    guard.registry.listPublic().length === walletsBefore &&
    faucetRequests(guard, UNKNOWN_NAME) === faucetBefore;

  console.info("");
  console.info(`decision: ${result.policy.decision}`);
  console.info(`reasonCode: ${result.policy.reasonCode}`);
  console.info(`wallet created for ${UNKNOWN_NAME}: ${yes(!noWallet)}`);
  console.info(`submittedToLedger: ${result.submittedToLedger}`);
  console.info(`transactionHash: ${result.transactionHash}`);
  console.info(`Rohan balance: before = ${xrp(senderBefore)} XRP, after = ${xrp(senderAfter)} XRP`);

  const pass =
    result.policy.reasonCode === "UNKNOWN_RECIPIENT" &&
    !result.submittedToLedger &&
    result.transactionHash === null &&
    noWallet &&
    senderBefore === senderAfter;
  return {
    pass,
    lines: [
      `recipient: ${UNKNOWN_NAME}`,
      `reason: ${result.policy.reasonCode}`,
      `wallet created: ${yes(!noWallet)}`,
      `submitted to XRPL: ${yes(result.submittedToLedger)}`,
      "",
    ],
  };
}

async function caseLimit(
  guard: RippleGuard,
  ledger: LiveTestnetLedger,
  rohan: CustomerWallet,
  keith: CustomerWallet,
): Promise<CaseResult> {
  const before = await pair(ledger, rohan, keith);
  const result = await guard.executor.execute({
    senderCustomerId: rohan.customerId,
    recipientName: keith.customerName,
    amountUsd: 500,
    spaceId: SPACE,
    mode: "autonomous",
  });
  const after = await pair(ledger, rohan, keith);
  const unchanged = before.sender === after.sender && before.recipient === after.recipient;

  console.info("");
  console.info(`attempt: ${formatUsd(500)} autonomous`);
  console.info(`limit: ${formatUsd(guard.executor.policyLimits.autonomousMaxUsd)}`);
  console.info(`decision: ${result.policy.decision}`);
  console.info(`reasonCode: ${result.policy.reasonCode}`);
  console.info(`submittedToLedger: ${result.submittedToLedger}`);
  console.info(`transactionHash: ${result.transactionHash}`);
  printUnchanged(before, after);

  const pass =
    result.policy.reasonCode === "SPENDING_LIMIT_EXCEEDED" &&
    !result.submittedToLedger &&
    result.transactionHash === null &&
    unchanged;
  return {
    pass,
    lines: [
      `attempt: $500 (limit ${formatUsd(guard.executor.policyLimits.autonomousMaxUsd)})`,
      `reason: ${result.policy.reasonCode}`,
      `submitted to XRPL: ${yes(result.submittedToLedger)}`,
      "",
    ],
  };
}

function printUnchanged(before: { sender: string; recipient: string }, after: { sender: string; recipient: string }): void {
  console.info("");
  console.info("ROHAN BALANCE:");
  console.info(`before = ${xrp(before.sender)}`);
  console.info(`after = ${xrp(after.sender)}`);
  console.info("");
  console.info("KEITH BALANCE:");
  console.info(`before = ${xrp(before.recipient)}`);
  console.info(`after = ${xrp(after.recipient)}`);
  console.info("");
  console.info("TRANSFER OCCURRED:");
  console.info(before.sender === after.sender && before.recipient === after.recipient ? "NO" : "YES (balances moved; see above)");
}

function faucetRequests(guard: RippleGuard, name: string): number {
  const key = name.toLowerCase();
  return guard.audit
    .snapshot()
    .events.filter((event) => event.eventType === "FAUCET_FUNDING_REQUESTED" && event.customerId.toLowerCase() === key).length;
}

function assertNoSecrets(guard: RippleGuard, known: readonly string[]): void {
  const audit = JSON.stringify(guard.audit.snapshot());
  const auditFile = safeRead(XRPL_DEMO_FILES.audit);
  const wallets = safeRead(XRPL_DEMO_FILES.wallets);
  for (const secret of known) {
    if (audit.includes(secret) || auditFile.includes(secret) || wallets.includes(secret)) {
      throw new Error("a public demo artifact contains a wallet seed");
    }
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function pair(ledger: LiveTestnetLedger, sender: CustomerWallet, recipient: CustomerWallet): Promise<{ sender: string; recipient: string }> {
  return {
    sender: await ledger.getBalanceDrops(sender.xrplAddress),
    recipient: await ledger.getBalanceDrops(recipient.xrplAddress),
  };
}

function step(n: number, label: string): void {
  console.info("");
  console.info(`STEP ${n}  ${label}`);
}

function xrp(drops: string): string {
  return formatXrp(Number(drops));
}

function yes(value: boolean): string {
  return value ? "YES" : "NO";
}

function summarize(result: PaymentExecution): string {
  return JSON.stringify(
    {
      reasonCode: result.policy.reasonCode,
      decision: result.policy.decision,
      reasons: result.policy.reasons,
      submittedToLedger: result.submittedToLedger,
      transactionHash: result.transactionHash,
      engineResult: result.ledgerRejection?.engineResult ?? null,
    },
    null,
    2,
  );
}

void main();
