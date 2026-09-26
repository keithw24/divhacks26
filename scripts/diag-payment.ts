import "dotenv/config";
import { config } from "../src/config.js";
import { createPaymentRuntime } from "../src/payments/runtime.js";

const runtime = createPaymentRuntime({
  mode: config.paymentsMode,
  maxUsd: config.paymentsMaxUsd,
  xrpPerUsd: config.paymentsXrpPerUsd,
  timeoutMs: config.paymentsTimeoutMs,
  serverUrl: config.xrplTestnetUrl,
  seed: config.xrplTestnetSeed,
  recipientsJson: config.paymentsRecipientsJson,
  nessieApiKey: config.nessieApiKey,
  nessieBaseUrl: config.nessieBaseUrl,
  nessieCustomerId: config.nessieCustomerId,
  nessieAccountId: config.nessieAccountId,
});

const jsonOk = Boolean(config.paymentsRecipientsJson && config.paymentsRecipientsJson.startsWith("{"));
console.info(
  JSON.stringify({
    mode: config.paymentsMode,
    hasSeed: Boolean(config.xrplTestnetSeed),
    hasNessie: Boolean(config.nessieApiKey),
    recipientsJsonOk: jsonOk,
    recipientsJsonLen: config.paymentsRecipientsJson?.length ?? 0,
  }),
);

const result = await runtime.provider.sendPayment({
  destination: "PLACEHOLDER",
  amountUsd: 1,
  memo: "diag",
  idempotencyKey: `diag-${Date.now()}`,
  recipientName: "Keith",
});

const dest = (() => {
  try {
    const parsed = JSON.parse(config.paymentsRecipientsJson || "{}") as Record<string, { rippleDestination?: string }>;
    return parsed.Keith?.rippleDestination;
  } catch {
    return undefined;
  }
})();

if (dest) {
  const paid = await runtime.provider.sendPayment({
    destination: dest,
    amountUsd: 1,
    memo: "diag",
    idempotencyKey: `diag-pay-${Date.now()}`,
    recipientName: "Keith",
  });
  console.info(
    JSON.stringify({
      event: "diag_result",
      success: paid.success,
      status: paid.status,
      error: paid.error,
      hasTx: Boolean(paid.transactionId),
      asset: paid.submittedAsset,
      nessie: Boolean(paid.nessiePurchaseId),
    }),
  );
} else {
  console.info(JSON.stringify({ event: "diag_result", success: result.success, status: result.status, error: result.error }));
}
