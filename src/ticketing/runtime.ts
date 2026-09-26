import type { MerchantDirectory } from "../payments/merchants.js";
import type { PaymentProvider } from "../payments/types.js";
import type { DiscoveryContext } from "./discovery.js";
import { createSharedTicketPayments } from "./payment.js";
import { MockTicketProvider } from "./providers/mock.js";
import { TicketmasterProvider } from "./providers/ticketmaster.js";
import { TicketingService } from "./service.js";
import type { TicketEvent, TicketingProviderName, TicketProvider, TicketPurchaseMode } from "./types.js";

export interface TicketingRuntimeEnv {
  provider: TicketingProviderName;
  purchaseMode?: TicketPurchaseMode;
  ticketmasterApiKey?: string;
  ticketmasterPartnerApiKey?: string;
  timeZone: string;
  defaultCity?: string;
  resolvePlace?: DiscoveryContext["resolvePlace"];
  onEventSelected?: (spaceId: string, event: TicketEvent) => void;
  /** Shared payment runtime pieces. Demo checkouts settle through these; ticketing adds no wallet of its own. */
  payments?: {
    provider: PaymentProvider;
    mode: "mock" | "ripple_test";
    merchants: MerchantDirectory;
    merchantName: string;
    xrpPerUsd: number;
    maxUsd: number;
    timeoutMs: number;
  };
}

/** Link mode unless a mode is chosen: a live provider never buys by default. The mock provider defaults to demo checkout. */
export function defaultPurchaseMode(provider: TicketingProviderName, requested?: TicketPurchaseMode): TicketPurchaseMode {
  if (requested) return requested;
  return provider === "mock" ? "mock" : "link";
}

export function createTicketingRuntime(env: TicketingRuntimeEnv): { service: TicketingService; provider: TicketProvider; purchaseMode: TicketPurchaseMode } {
  const provider: TicketProvider =
    env.provider === "ticketmaster"
      ? new TicketmasterProvider({ apiKey: env.ticketmasterApiKey, partnerApiKey: env.ticketmasterPartnerApiKey })
      : new MockTicketProvider({ timeZone: env.timeZone });
  const purchaseMode = defaultPurchaseMode(env.provider, env.purchaseMode);
  const payments = env.payments ? createSharedTicketPayments(env.payments) : undefined;
  const service = new TicketingService({
    provider,
    purchaseMode,
    payments,
    merchantName: env.payments?.merchantName,
    timeZone: env.timeZone,
    defaultCity: env.defaultCity,
    resolvePlace: env.resolvePlace,
    onEventSelected: env.onEventSelected,
  });
  return { service, provider, purchaseMode };
}
