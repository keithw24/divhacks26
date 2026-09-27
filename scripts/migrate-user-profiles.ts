import "dotenv/config";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import pg from "pg";
import { TigerUserProfileStore } from "../src/profiles/tiger.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
try {
  new URL(databaseUrl);
} catch {
  throw new Error("DATABASE_URL is not a valid PostgreSQL URL; replace the placeholder/redacted value in .env");
}

const sql = await readFile(new URL("../sql/007_user_profiles.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
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
