# Tiger user profiles

Tiger is the source of truth for the public wallet directory used by Gemini
and the payment resolver. DeepSpace remains responsible for website accounts,
channel linking, plans, and notifications.

## Create the table

Set a real Tiger connection string in the root `.env`, then run:

```powershell
npm run db:migrate:user-profiles
```

The migration is idempotent. It creates `user_profiles` and imports every
`data/ripple-demo/accounts.json` row that has a `photonSenderId` (Photon id).
A missing `userId` becomes `photon:<normalized handle>`. Public wallet
addresses may come from that file or `wallets.json`. Seeds are never copied.

## Data contract

| Column | Meaning |
| --- | --- |
| `user_id` | Stable authenticated ID; DeepSpace's user ID when linked |
| `display_name` | Human-facing name used for recipient matching |
| `photon_identifier_hash` | SHA-256 of normalized Photon phone/email identity |
| `wallet_address` | Public XRPL Testnet address; literal `0` means none |
| `backboard_assistant_id` | Server-side link to this user's Backboard memory |

Raw Photon identifiers, Backboard memories, wallet seeds, and private keys are
not stored in this table.

## Runtime flow

1. Photon forwards the sender to DeepSpace and gets the linked `userId`.
2. The Node agent upserts that identity into Tiger with wallet `0` if needed.
3. Wallet provisioning updates the same Tiger row with its public address.
4. Backboard creates or reuses one assistant per user; the assistant ID is
   mirrored into Tiger while memories remain in Backboard.
5. Before a payment request is interpreted, the agent refreshes its Tiger
   directory. The recipient must have a non-zero wallet in Tiger.
6. Before signing, the resolved Tiger address must exactly match the locally
   controlled Testnet signing wallet. A mismatch fails closed.

## Useful checks

```sql
SELECT user_id, display_name, wallet_address,
       backboard_assistant_id IS NOT NULL AS backboard_linked,
       updated_at
FROM user_profiles
ORDER BY updated_at DESC;

SELECT count(*) AS users_without_wallet
FROM user_profiles
WHERE wallet_address = '0';
```
