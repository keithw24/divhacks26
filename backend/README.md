# Plans Around Us — DeepSpace backend

The shared backend for accounts, the 100-person beta, cross-channel identity
and shared plans. It is a [DeepSpace](https://deep.space) app (Cloudflare
Workers + Durable Objects) and deploys to `plans-around-us.app.space`.

The iMessage agent in the repo root keeps doing the conversation work
(Gemini, Maps, Tiger, reservations). It now also acts as the **iMessage
channel adapter** for this backend.

```text
iMessage ─ Photon ─ Node agent (repo root, droplet) ─┐   signed HTTP
Android  ─ website / SMS adapter (later) ────────────┤──────────────▶  DeepSpace backend (this folder)
Voice    ─ ElevenLabs adapter (later) ───────────────┘                 users · channel identities · plans
Website  ─ DeepSpace sign-in ─ /api/actions/* ─────────────────────▶   preferences · notification outbox
```

## What works today

| Area | Where | Status |
|---|---|---|
| Sign-in, users, roles | DeepSpace built-in | ✅ |
| Beta admission with invite codes, 100-user cap enforced server-side | `src/domain/beta.ts` | ✅ |
| Link iMessage / SMS to an account (website code → text `LINK 123456`) | `src/domain/identity.ts` | ✅ |
| Shared plans across separate conversations, join codes, membership checks | `src/domain/plans.ts` | ✅ |
| Per-plan preferences, private or shared | `src/domain/plans.ts` | ✅ |
| Notifications to each member on their own channel (leased outbox) | `src/domain/channels.ts` | ✅ |
| Signed adapter API used by the Photon agent | `src/server/channel-routes.ts`, `../src/deepspace/client.ts` | ✅ |
| Minimal beta console website | `src/pages/(app)/home.tsx` | ✅ |
| ElevenLabs voice on the same plan (step 4) | — | ⏳ later |
| Demo-credit wallet + expense splitting (step 5) | — | ⏳ later |
| XRPL Testnet payments with approvals (step 6) | root `src/payments/` stays for now | ⏳ later |

## Layout

```text
backend/
  worker.ts                     Worker assembly: DeepSpace routes + our channel routes
  wrangler.toml                 App identity (DEEPSPACE_APP_ID), BETA_MAX_USERS
  src/
    domain/                     All business rules. Plain functions over a Store — unit-testable.
      contracts.ts              Shared types (mirrored in ../src/deepspace/client.ts)
      beta.ts identity.ts plans.ts channels.ts codes.ts store.ts
      domain.test.ts            Unit tests (in-memory fake store in testing/)
    schemas/plans-schema.ts     Collections + read permissions
    actions/index.ts            Website API: POST /api/actions/<name> (signed-in user)
    server/channel-routes.ts    Adapter API: /api/channels/* (HMAC-signed)
    lib/actions.ts              Browser client for the actions
    pages/(app)/home.tsx        Beta console page
```

**The one rule:** browsers never write records directly. Every collection is
read-only to users; writes go through `src/actions/` or the signed channel
routes, which call `src/domain/`. Those tools run with DeepSpace's per-record
permissions off, so each domain function checks beta admission and plan
membership itself. Keep it that way when you add features.

## APIs

### Website actions (signed-in user, `Authorization: Bearer <DeepSpace JWT>`)

`POST /api/actions/<name>` with a JSON body. Response: `{ success, data }` or
`{ success: false, error, code }`.

| Action | Params | Notes |
|---|---|---|
| `betaStatus` | — | `{ admitted }` |
| `redeemBetaInvite` | `code` | Enforces invite validity and the cap |
| `createBetaInvite` | `label?`, `maxUses?`, `expiresInDays?` | Owner/admin only; returns the code once |
| `startChannelLink` | `channel: imessage\|sms\|voice` | Returns a 6-digit code valid 10 min |
| `myChannels` | — | Linked channels (numbers masked) |
| `createWallet` | `wantWallet: true` | Provisions a Testnet wallet, stores the address on this `userId` |
| `myWallet` | — | `{ status: none }` or `{ status: ready, userId, xrplAddress, … }` |
| `createPlan` | `title`, `when?`, `area?` | Creator becomes organizer |
| `myPlans` / `getPlan` | `planId` | `getPlan` returns members + shared preferences only |
| `createPlanInvite` / `joinPlan` | `planId` / `code` | Any member can invite; codes last 72 h |
| `setPreferences` | `planId`, `budget?`, `diet?`, `maxTravelMinutes?`, `notes?`, `shared?` | Notifies other members when shared |
| `setNotifyChannel` / `leavePlan` | `planId`, `channel` / `planId` | |

### Adapter routes (server-to-server)

Signed with `CHANNEL_ADAPTER_SECRET`:
`X-Plans-Timestamp: <unix s>` and
`X-Plans-Signature: hex(HMAC-SHA256(secret, "<ts>.<METHOD>.<path+query>.<body>"))`,
valid for 5 minutes. `../src/deepspace/client.ts` implements it.

| Route | Purpose |
|---|---|
| `POST /api/channels/inbound` | Every inbound message: dedupe, handle `LINK 123456`, return `{ userId, betaMember, activePlans, reply }` |
| `GET /api/channels/outbox?channel=imessage` | Claim pending notifications (60 s lease) |
| `POST /api/channels/outbox/ack` | `{ channel, ids, status: sent\|failed }` |
| `GET /api/channels/directory` | Pull registered user IDs, names, wallet-or-`0`, and transient channel identity for Tiger synchronization |
| `GET /api/channels/health` | Is the adapter secret configured |

No message text or phone number is logged. Inbound message text is not stored.
The directory route is server-to-server only: its channel identity is hashed by
the Node adapter before Tiger stores it and is never included in Gemini context.

## Set up DeepSpace (one person, once)

DeepSpace is driven from its CLI; the website at <https://deep.space> is
where you sign up and see your apps. The **owner** (one person) does this:

1. **Create an account** at <https://deep.space> and sign in in the browser.
2. **Install and sign in the CLI**, from this folder:
   ```bash
   cd backend
   npm install
   npx deepspace auth login        # opens the browser; finish sign-in there
   npx deepspace auth whoami       # confirm it's the owner account
   ```
3. **Register the app** (mints the permanent app id into `wrangler.toml`):
   ```bash
   npx deepspace app init
   git add wrangler.toml && git commit -m "Register DeepSpace app" && git push
   ```
   Everyone else now uses this id. Nobody else should run `app init`.
4. **Set the adapter secret** (a long random string; also goes in the droplet's `.env`):
   ```bash
   openssl rand -hex 32                              # copy the output
   npx deepspace secrets set CHANNEL_ADAPTER_SECRET --stdin   # paste it, Enter, Ctrl+D
   npx deepspace secrets set AGENT_ONBOARDING_SECRET --stdin  # same value as the agent's DEEPSPACE_ONBOARDING_SECRET
   ```
   In wrangler `[vars]`, set `AGENT_WALLET_URL` to the agent's public origin (no path). The DeepSpace `createWallet` action posts `{ userId, photonSenderId, wantWallet: true }` to that host.
5. **Deploy**:
   ```bash
   npx deepspace deploy
   ```
   This repo has a GitHub remote, so the first deploy makes **GitHub the
   app's source of truth, permanently**. Never run `npx deepspace push` —
   keep using `git push` to GitHub.
6. **Check it's live**: open `https://plans-around-us.app.space` (or the URL
   the deploy prints) and `https://<that-url>/api/channels/health` — it should
   say `"adapterSecretConfigured": true`.
7. **Give teammates deploy access**:
   ```bash
   npx deepspace app collaborators add <teammate-email>
   ```
   Collaborators can deploy and **read every secret**, so add only people who
   need to deploy. Everyone else can develop locally without it (see below).
8. **Mint beta invites**: sign in on the site as the owner. Owners and app
   admins are admitted automatically and see an **Admin: beta invites** panel.
   Press **New invite** once per tester and hand each person their code (it is
   shown once). For now only the owner (and any user with the DeepSpace
   `admin` role) can mint invites; there is no role-editing page yet.
9. **Point the Photon agent at it**: in the droplet's `.env` add
   ```dotenv
   DEEPSPACE_API_URL=https://plans-around-us.app.space
   DEEPSPACE_CHANNEL_SECRET=<same value as step 4>
   ```
   then `docker compose up -d --build`. The agent log should say
   `DeepSpace backend: https://…`.

## Teammate workflow

```bash
git checkout main && git pull
cd backend && npm install
npx deepspace auth login     # your own DeepSpace account
npx deepspace dev start      # local site + worker with its own local data
```

- Unit tests: `npm run test:unit` (no login needed). Type-check: `npm run type-check`. Lint: `npm run lint`.
- Branch per task (`alan/…`, `keith/…`, `rohan/…`), PR into `main`. CI runs the backend job.
- Put rules in `src/domain/` with a test next to them; keep actions and routes thin.
- Changing a wire type? Update `src/domain/contracts.ts` **and** `../src/deepspace/client.ts`.
- Only collaborators run `npx deepspace deploy`. Deploy from an up-to-date `main`.
- Secrets live only in `npx deepspace secrets` — never in `.dev.vars`, commits or chat.

Suggested ownership, matching the team plan: **Keith** — website / sign-in UX
on top of these actions; **Rohan** — plan state, routes into plans; **Alan** —
safety context on plans; **events owner** — events on plans. The Photon adapter
integration lives in the repo root (`src/index.ts`, `src/deepspace/`).

## Try the whole flow

1. Owner signs in and mints two invite codes (step 8).
2. Two people sign in on the site, redeem a code each.
3. Person A: **Link iMessage** → texts `LINK 123456` to the agent → gets "You're linked!".
4. Person B: **Create** a plan → **Invite** → gives A the code; A **Joins** on the site.
5. B saves preferences → A receives an iMessage: *"A member updated their preferences for …"*.

## Known limits (beta)

- The 100-seat cap is count-then-insert; two people taking the very last seat
  at the same instant could both get in. Acceptable for the beta.
- Only iMessage has an adapter today. SMS needs a provider (e.g. Twilio) and a
  second adapter calling the same routes with `channel: "sms"`.
- The website console is intentionally plain; the real UI belongs in `frontend/`.
