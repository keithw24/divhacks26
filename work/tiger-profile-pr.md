Tiger is now the authoritative directory for public XRPL Testnet wallet lookup. A new `user_profiles` table stores the stable user ID, hashed Photon identity, wallet address (`0` when absent), and Backboard assistant link; Gemini receives the Tiger profile plus user-specific Backboard memory, and payment settlement refreshes Tiger and fails closed on missing or mismatched wallets.

Validation:

- `npm run build`
- 106 focused profile, Backboard, wallet, payment, and guardrail tests pass
- Full suite remains affected by existing `backend-old` Playwright discovery and meetup test failures

Deployment step after merge:

```powershell
npm run db:migrate:user-profiles
```

The current local `.env` has an invalid/placeholder `DATABASE_URL`, so the live Tiger migration has not yet been applied.
