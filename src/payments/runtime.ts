import type { StateStore } from "../store/state.js";
import type { PaymentsMode } from "../config.js";
import { createGeminiPaymentInterpreter } from "./gemini.js";
import { MockPaymentProvider } from "./mock.js";
import { NessieClient } from "./nessie.js";
import { ChainedPaymentProvider, NessiePaymentProvider } from "./nessieProvider.js";
import { loadRecipientDirectory } from "./recipients.js";
import { createRippleTestProvider } from "./ripple.js";
import { PaymentService } from "./service.js";
import { PaymentStore } from "./state.js";
import type { PaymentProvider } from "./types.js";
import type { CustomerSettlementPort } from "./xrpl/settlement.js";

export interface PaymentRuntimeEnv {
  mode: PaymentsMode;
  maxUsd: number;
  xrpPerUsd: number;
  timeoutMs: number;
  serverUrl: string;
  seed?: string;
  recipientsJson?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  stateStore?: StateStore;
  /** ripple_test only. Person transfers settle between customer wallets instead of the shared seed. */
  settlement?: CustomerSettlementPort;
  nessieApiKey?: string;
  nessieBaseUrl?: string;
  nessieCustomerId?: string;
  nessieAccountId?: string;
}

export function createPaymentRuntime(env: PaymentRuntimeEnv) {
  const directory = loadRecipientDirectory(env.recipientsJson);
  const provider = buildProvider(env);
  const interpreter = env.geminiApiKey
    ? createGeminiPaymentInterpreter({ apiKey: env.geminiApiKey, model: env.geminiModel })
    : undefined;
  const service = new PaymentService({
    provider,
    directory,
    store: env.stateStore ? PaymentStore.open(env.stateStore) : undefined,
    maxUsd: env.maxUsd,
    timeoutMs: env.timeoutMs,
    interpreter,
    settlement: env.mode === "ripple_test" ? env.settlement : undefined,
  });
  return { service, provider };
}

function buildProvider(env: PaymentRuntimeEnv): PaymentProvider {
  const wantsNessie = env.mode === "nessie" || env.mode === "nessie_ripple";
  const wantsRipple = env.mode === "ripple_test" || env.mode === "nessie_ripple";
  const nessie = wantsNessie && env.nessieApiKey
    ? new NessiePaymentProvider({
        client: new NessieClient(env.nessieApiKey, env.nessieBaseUrl),
        customerId: env.nessieCustomerId,
        accountId: env.nessieAccountId,
      })
    : undefined;
  if (wantsNessie && !nessie) {
    console.warn("PAYMENTS_MODE needs NESSIE_API_KEY. Confirmed Nessie payments will fail closed.");
    return {
      async sendPayment() {
        return { success: false, status: "not_configured", error: "NESSIE_API_KEY is missing" };
      },
    };
  }
  const ripple = wantsRipple
    ? createRippleTestProvider({
        serverUrl: env.serverUrl,
        seed: env.seed,
        xrpPerUsd: env.xrpPerUsd,
        timeoutMs: env.timeoutMs,
      })
    : undefined;
  if (nessie && ripple) return new ChainedPaymentProvider(nessie, ripple);
  if (nessie) return nessie;
  if (ripple) return ripple;
  const mock = new MockPaymentProvider();
  mock.xrpPerUsd = env.xrpPerUsd;
  return mock;
}
