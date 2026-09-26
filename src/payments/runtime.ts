import type { StateStore } from "../store/state.js";
import { createGeminiPaymentInterpreter } from "./gemini.js";
import { MockPaymentProvider } from "./mock.js";
import { loadRecipientDirectory } from "./recipients.js";
import { createRippleTestProvider } from "./ripple.js";
import { PaymentService } from "./service.js";
import { PaymentStore } from "./state.js";

export interface PaymentRuntimeEnv {
  mode: "mock" | "ripple_test";
  maxUsd: number;
  xrpPerUsd: number;
  timeoutMs: number;
  serverUrl: string;
  seed?: string;
  recipientsJson?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  stateStore?: StateStore;
}

export function createPaymentRuntime(env: PaymentRuntimeEnv) {
  const directory = loadRecipientDirectory(env.recipientsJson);
  const provider =
    env.mode === "ripple_test"
      ? createRippleTestProvider({
          serverUrl: env.serverUrl,
          seed: env.seed,
          xrpPerUsd: env.xrpPerUsd,
          timeoutMs: env.timeoutMs,
        })
      : new MockPaymentProvider();
  if (provider instanceof MockPaymentProvider) provider.xrpPerUsd = env.xrpPerUsd;
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
  });
  return { service, provider };
}
