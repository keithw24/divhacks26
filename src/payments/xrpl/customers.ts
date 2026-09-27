/** Demo customers plus users enrolled through DeepSpace / website onboarding. */
export interface RegisteredCustomer {
  customerId: string;
  customerName: string;
}

export const REGISTERED_CUSTOMERS: readonly RegisteredCustomer[] = Object.freeze([
  { customerId: "rohan", customerName: "Rohan" },
  { customerId: "keith", customerName: "Keith" },
  { customerId: "mike", customerName: "Mike" },
  { customerId: "alan", customerName: "Alan" },
]);

const onboarded = new Map<string, RegisteredCustomer>();

export function registerOnboardedCustomer(customer: RegisteredCustomer): void {
  const id = customer.customerId.trim().toLowerCase();
  const name = customer.customerName.trim();
  if (!id || !name) return;
  onboarded.set(id, { customerId: id, customerName: name });
}

export function resetOnboardedCustomers(): void {
  onboarded.clear();
}

export function onboardedCustomers(): RegisteredCustomer[] {
  return [...onboarded.values()];
}

export function findRegisteredCustomer(idOrName: string): RegisteredCustomer | undefined {
  const key = idOrName.trim().toLowerCase();
  if (!key) return undefined;
  const builtin = REGISTERED_CUSTOMERS.find(
    (customer) => customer.customerId === key || customer.customerName.toLowerCase() === key,
  );
  if (builtin) return builtin;
  const byId = onboarded.get(key);
  if (byId) return byId;
  return [...onboarded.values()].find((customer) => customer.customerName.toLowerCase() === key);
}

export function isRegisteredCustomer(idOrName: string): boolean {
  return findRegisteredCustomer(idOrName) !== undefined;
}
