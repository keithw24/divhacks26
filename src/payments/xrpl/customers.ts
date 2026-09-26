/** Demo customers who may receive a Testnet wallet. An unknown name is not in this list. */
export interface RegisteredCustomer {
  customerId: string;
  customerName: string;
}

export const REGISTERED_CUSTOMERS: readonly RegisteredCustomer[] = Object.freeze([
  { customerId: "rohan", customerName: "Rohan" },
  { customerId: "keith", customerName: "Keith" },
  { customerId: "ben", customerName: "Ben" },
  { customerId: "sarah", customerName: "Sarah" },
]);

export function findRegisteredCustomer(idOrName: string): RegisteredCustomer | undefined {
  const key = idOrName.trim().toLowerCase();
  if (!key) return undefined;
  return REGISTERED_CUSTOMERS.find(
    (customer) => customer.customerId === key || customer.customerName.toLowerCase() === key,
  );
}

export function isRegisteredCustomer(idOrName: string): boolean {
  return findRegisteredCustomer(idOrName) !== undefined;
}
