const NYC_ADDRESS = {
  street_number: "599",
  street_name: "Broadway",
  city: "New York",
  state: "NY",
  zip: "10012",
};

export interface NessieAccount {
  _id?: string;
  nickname?: string;
  balance?: number;
}

export interface NessiePurchase {
  id: string;
  amount: number;
  merchantId: string;
  status: string;
}

type Json = Record<string, unknown>;

export class NessieClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "http://api.nessieisreal.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getCustomers(): Promise<Array<{ _id?: string; first_name?: string; last_name?: string }>> {
    const data = await this.request("GET", "/customers");
    return Array.isArray(data) ? data : [];
  }

  async createCustomer(input: { firstName: string; lastName: string }): Promise<string> {
    const data = await this.request("POST", "/customers", {
      first_name: input.firstName,
      last_name: input.lastName,
      address: NYC_ADDRESS,
    });
    const id = createdId(data);
    if (!id) throw new Error("Nessie did not return a customer id");
    return id;
  }

  async getAccounts(customerId: string): Promise<NessieAccount[]> {
    const data = await this.request("GET", `/customers/${customerId}/accounts`);
    return Array.isArray(data) ? (data as NessieAccount[]) : [];
  }

  async createAccount(customerId: string, nickname: string, balance: number): Promise<string> {
    const data = await this.request("POST", `/customers/${customerId}/accounts`, {
      type: "Checking",
      nickname,
      rewards: 0,
      balance,
    });
    const id = createdId(data);
    if (!id) throw new Error("Nessie did not return an account id");
    return id;
  }

  async getAccount(accountId: string): Promise<NessieAccount> {
    return (await this.request("GET", `/accounts/${accountId}`)) as NessieAccount;
  }

  async createMerchant(name: string): Promise<string> {
    const data = await this.request("POST", "/merchants", {
      name,
      address: NYC_ADDRESS,
      geocode: { lat: 40.8075, lng: -73.9626 },
    });
    const id = createdId(data);
    if (!id) throw new Error("Nessie did not return a merchant id");
    return id;
  }

  async createPurchase(input: {
    accountId: string;
    merchantId: string;
    amount: number;
    description: string;
    purchaseDate: string;
  }): Promise<NessiePurchase> {
    const data = await this.request("POST", `/accounts/${input.accountId}/purchases`, {
      merchant_id: input.merchantId,
      medium: "balance",
      purchase_date: input.purchaseDate,
      amount: input.amount,
      status: "pending",
      description: input.description.slice(0, 100),
    });
    const id = createdId(data);
    if (!id) throw new Error("Nessie did not return a purchase id");
    return {
      id,
      amount: input.amount,
      merchantId: input.merchantId,
      status: "pending",
    };
  }

  private async request(method: string, path: string, body?: Json): Promise<unknown> {
    const bases = uniqueBases(this.baseUrl);
    let lastError: Error | undefined;
    for (const base of bases) {
      try {
        return await this.requestOnce(base, method, path, body);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!shouldRetryNessie(lastError)) throw lastError;
      }
    }
    throw lastError ?? new Error(`Nessie ${method} ${path} failed`);
  }

  private async requestOnce(baseUrl: string, method: string, path: string, body?: Json): Promise<unknown> {
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    url.searchParams.set("key", this.apiKey);
    const response = await this.fetchImpl(url, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { raw: text.slice(0, 180) };
      }
    }
    const code = nessieCode(parsed);
    if ((!response.ok && (code == null || code >= 400)) || (code != null && code >= 400)) {
      throw new Error(`Nessie ${method} ${path} failed (${response.status}${code != null ? `/${code}` : ""})${nessieHint(parsed)}`);
    }
    return parsed;
  }
}

function uniqueBases(preferred: string): string[] {
  const extras = ["http://api.nessieisreal.com", "https://api.nessieisreal.com", "http://api.reimaginebanking.com"];
  return [...new Set([preferred.replace(/\/+$/, ""), ...extras])];
}

function shouldRetryNessie(error: Error): boolean {
  const text = error.message;
  if (/failed \(4\d\d/.test(text)) return false;
  return /failed \(5\d\d|fetch failed|ECONN|ENOTFOUND|network/i.test(text) || !/failed \(/.test(text);
}

function nessieCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function nessieHint(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? `: ${message.trim().slice(0, 120)}` : "";
}

function createdId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const row = payload as { objectCreated?: { _id?: string }; _id?: string };
  return row.objectCreated?._id || row._id;
}

export function todayEt(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}
