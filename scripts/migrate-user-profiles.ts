import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { TigerUserProfileStore } from "../src/profiles/tiger.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

function postgresConnectionString(raw: string | undefined): string {
  let value = (raw ?? "").trim().replace(/^\uFEFF/, "");
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) {
    throw new Error("DATABASE_URL is required. Set it in .env to your Tiger Cloud connection string.");
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new Error("DATABASE_URL must start with postgresql:// or postgres://");
  }
  if (/PASSWORD@HOST|:PORT\/|:password@.*host/i.test(value) || /<[^>]+>/.test(value)) {
    throw new Error(
      "DATABASE_URL still looks like the .env.example placeholder. Paste the string from `tiger db connection-string --with-password`.",
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return value;
  } catch {
    // Passwords often contain @ # or /. Encode userinfo so pg and URL parsers agree.
    const schemeEnd = value.indexOf("://");
    const at = value.lastIndexOf("@");
    if (schemeEnd < 0 || at < schemeEnd) {
      throw new Error(
        "DATABASE_URL could not be parsed. Percent-encode reserved characters in the password (for example @ → %40).",
      );
    }
    const userinfo = value.slice(schemeEnd + 3, at);
    const colon = userinfo.indexOf(":");
    if (colon < 0) return value;
    const user = userinfo.slice(0, colon);
    const password = userinfo.slice(colon + 1);
    return `${value.slice(0, schemeEnd + 3)}${encodeURIComponent(user)}:${encodeURIComponent(password)}${value.slice(at)}`;
  }
}

const databaseUrl = postgresConnectionString(process.env.DATABASE_URL);

const sql = await readFile(new URL("../sql/007_user_profiles.sql", import.meta.url), "utf8");
// Same as src/safety.ts: an sslmode in the URL would override the ssl option below.
const client = new pg.Client({
  connectionString: databaseUrl.replace(/[?&]sslmode=[^&]*/g, ""),
  ssl: { rejectUnauthorized: false },
});
try {
  await client.connect();
  await client.query(sql);
  // One-time bridge for wallets created before Tiger became authoritative.
  // This file is local and gitignored; only public address metadata is copied.
  try {
    const parsed = JSON.parse(readFileSync("data/ripple-demo/accounts.json", "utf8")) as {
      accounts?: Array<{ userId?: string; photonSenderId?: string; customerName?: string; xrplAddress?: string }>;
    };
    const profiles = new TigerUserProfileStore(client);
    for (const account of parsed.accounts ?? []) {
      if (!account.userId || !account.photonSenderId) continue;
      await profiles.upsert({
        userId: account.userId,
        photonIdentifier: account.photonSenderId,
        displayName: account.customerName,
        walletAddress: account.xrplAddress ?? "0",
      });
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  const result = await client.query<{ count: string; without_wallet: string }>(
    `SELECT count(*)::text AS count,
            count(*) FILTER (WHERE wallet_address = '0')::text AS without_wallet
       FROM user_profiles`,
  );
  console.info(`user_profiles ready (${result.rows[0]?.count ?? "0"} users, ${result.rows[0]?.without_wallet ?? "0"} without wallets)`);
} finally {
  await client.end();
}
