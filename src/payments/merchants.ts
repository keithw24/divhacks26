import { isValidClassicAddress } from "xrpl";

export interface MerchantDestination {
  ok: true;
  destination: string;
  source: "mock" | "configured";
}

export interface MerchantDirectory {
  resolve(name: string): MerchantDestination | { ok: false };
}

/**
 * Mock mode uses a deterministic label and never submits it.
 * ripple_test uses only addresses from PAYMENTS_MERCHANTS_JSON. Missing addresses are not invented.
 */
export function createMerchantDirectory(options: { mode: "mock" | "ripple_test"; json?: string }): MerchantDirectory {
  const configured = parseMerchants(options.json);
  return {
    resolve(name: string) {
      const key = name.trim().toLowerCase();
      const listed = configured.get(key);
      if (options.mode === "ripple_test") {
        if (!listed) return { ok: false };
        return { ok: true, destination: listed, source: "configured" };
      }
      if (listed) return { ok: true, destination: listed, source: "configured" };
      const slug = key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "merchant";
      return { ok: true, destination: `mock:merchant:${slug}`, source: "mock" };
    },
  };
}

function parseMerchants(json?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!json?.trim()) return out;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !name.trim()) continue;
      const address = value.trim();
      if (!isValidClassicAddress(address)) continue;
      out.set(name.trim().toLowerCase(), address);
    }
  } catch {
    console.warn("PAYMENTS_MERCHANTS_JSON was unreadable; no merchant destinations were loaded.");
  }
  return out;
}
