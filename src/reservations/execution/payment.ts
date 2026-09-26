import type { ProviderPaymentTerms } from "../providers.js";

export function requiresDeposit(payment: ProviderPaymentTerms | undefined): payment is ProviderPaymentTerms {
  if (!payment) return false;
  if (payment.paymentType === "NONE") return false;
  return payment.amountUsd > 0;
}
