import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { isValidClassicAddress } from "xrpl";
import { customerIdForUser } from "../payments/xrpl/onboarding.js";
import { registerOnboardedCustomer, type RegisteredCustomer } from "../payments/xrpl/customers.js";

export const NO_WALLET = "0";

export interface TigerUserProfile {
  userId: string;
  displayName?: string;
  walletAddress: string;
  backboardAssistantId?: string;
}

export interface UpsertTigerUserProfile {
  userId: string;
  displayName?: string;
  photonIdentifier?: string;
  walletAddress?: string;
  backboardAssistantId?: string;
}

export interface UserProfileWriter {
  upsert(input: UpsertTigerUserProfile): Promise<TigerUserProfile>;
}

interface ProfileRow {
  user_id: string;
  display_name: string | null;
  wallet_address: string;
  backboard_assistant_id: string | null;
}

export function normalizePhotonIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.replace(/[\s().-]/g, "");
}

export function photonIdentifierHash(value: string): string {
  return createHash("sha256").update(normalizePhotonIdentifier(value)).digest("hex");
}

function walletOrZero(value: string | undefined): string {
  if (!value || value === NO_WALLET) return NO_WALLET;
  if (!isValidClassicAddress(value)) throw new Error("invalid XRPL classic address");
  return value;
}

function profile(row: ProfileRow): TigerUserProfile {
  return {
    userId: row.user_id,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    walletAddress: row.wallet_address || NO_WALLET,
    ...(row.backboard_assistant_id ? { backboardAssistantId: row.backboard_assistant_id } : {}),
  };
}

/** Tiger is the authority for userId -> public wallet metadata. */
export class TigerUserProfileStore implements UserProfileWriter {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async upsert(input: UpsertTigerUserProfile): Promise<TigerUserProfile> {
    const userId = input.userId.trim();
    if (!userId || userId.length > 160) throw new Error("invalid user id");
    const displayName = input.displayName?.trim().slice(0, 80) || null;
    const photonHash = input.photonIdentifier ? photonIdentifierHash(input.photonIdentifier) : null;
    const walletAddress = walletOrZero(input.walletAddress);
    const assistantId = input.backboardAssistantId?.trim().slice(0, 200) || null;

    // If this Photon identity existed before DeepSpace linking, promote that row
    // to the authenticated user id instead of creating a second person.
    if (photonHash) {
      await this.pool.query(
        `UPDATE user_profiles
            SET user_id = $1,
                display_name = COALESCE($2, display_name),
                wallet_address = CASE WHEN $3 <> '0' THEN $3 ELSE wallet_address END,
                backboard_assistant_id = COALESCE($4, backboard_assistant_id),
                updated_at = now()
          WHERE photon_identifier_hash = $5
            AND user_id <> $1
            AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = $1)`,
        [userId, displayName, walletAddress, assistantId, photonHash],
      );
    }

    const result = await this.pool.query<ProfileRow>(
      `INSERT INTO user_profiles
         (user_id, display_name, photon_identifier_hash, wallet_address, backboard_assistant_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
         photon_identifier_hash = CASE
           WHEN EXCLUDED.photon_identifier_hash IS NULL THEN user_profiles.photon_identifier_hash
           WHEN EXISTS (
             SELECT 1 FROM user_profiles other
              WHERE other.photon_identifier_hash = EXCLUDED.photon_identifier_hash
                AND other.user_id <> EXCLUDED.user_id
           ) THEN user_profiles.photon_identifier_hash
           ELSE EXCLUDED.photon_identifier_hash
         END,
         wallet_address = CASE
           WHEN EXCLUDED.wallet_address <> '0' THEN EXCLUDED.wallet_address
           ELSE user_profiles.wallet_address
         END,
         backboard_assistant_id = COALESCE(EXCLUDED.backboard_assistant_id, user_profiles.backboard_assistant_id),
         updated_at = now()
       RETURNING user_id, display_name, wallet_address, backboard_assistant_id`,
      [userId, displayName, photonHash, walletAddress, assistantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Tiger user profile upsert returned no row");
    return profile(row);
  }

  async findByUserId(userId: string): Promise<TigerUserProfile | undefined> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT user_id, display_name, wallet_address, backboard_assistant_id
         FROM user_profiles WHERE user_id = $1 LIMIT 1`,
      [userId.trim()],
    );
    return result.rows[0] ? profile(result.rows[0]) : undefined;
  }

  async findByPhotonIdentifier(identifier: string): Promise<TigerUserProfile | undefined> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT user_id, display_name, wallet_address, backboard_assistant_id
         FROM user_profiles WHERE photon_identifier_hash = $1 LIMIT 1`,
      [photonIdentifierHash(identifier)],
    );
    return result.rows[0] ? profile(result.rows[0]) : undefined;
  }

  async list(): Promise<TigerUserProfile[]> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT user_id, display_name, wallet_address, backboard_assistant_id
         FROM user_profiles ORDER BY lower(COALESCE(display_name, user_id)), user_id`,
    );
    return result.rows.map(profile);
  }
}

/** Read-through cache for the synchronous payment policy interfaces. */
export class TigerProfileDirectory {
  private profiles: TigerUserProfile[] = [];
  private loadedAt = 0;
  private warned = false;
  constructor(private readonly store: TigerUserProfileStore, private readonly ttlMs = 15_000) {}

  async refresh(force = false): Promise<TigerUserProfile[]> {
    if (!force && Date.now() - this.loadedAt < this.ttlMs) return this.profiles;
    try {
      const rows = await this.store.list();
      this.profiles = rows;
      this.loadedAt = Date.now();
      for (const row of rows) {
        registerOnboardedCustomer({ customerId: customerIdForUser(row.userId), customerName: row.displayName || row.userId });
      }
      return this.profiles;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        const detail = error instanceof Error ? error.message.slice(0, 160) : "Error";
        console.error(`Tiger user_profiles unavailable (${detail}). Payments still run from local wallets. Run npm run db:migrate:user-profiles.`);
      }
      return this.profiles;
    }
  }

  list(): TigerUserProfile[] { return this.profiles.map((row) => ({ ...row })); }

  resolveUser(userId: string): RegisteredCustomer | undefined {
    const row = this.profiles.find((item) => item.userId === userId);
    return row ? { customerId: customerIdForUser(row.userId), customerName: row.displayName || row.userId } : undefined;
  }

  resolveName(name: string, requireWallet = false): RegisteredCustomer | undefined {
    const key = name.trim().toLowerCase();
    const row = this.profiles.find((item) =>
      (item.displayName?.toLowerCase() === key || item.userId.toLowerCase() === key)
      && (!requireWallet || item.walletAddress !== NO_WALLET),
    );
    return row ? { customerId: customerIdForUser(row.userId), customerName: row.displayName || row.userId } : undefined;
  }

  walletForCustomer(customerId: string): string | undefined {
    const row = this.profiles.find((item) => customerIdForUser(item.userId) === customerId);
    return row?.walletAddress && row.walletAddress !== NO_WALLET ? row.walletAddress : undefined;
  }

  names(): string[] { return this.profiles.map((row) => row.displayName).filter((name): name is string => Boolean(name)); }
}
