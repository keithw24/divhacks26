# DivHacks 26 — Around Me iMessage agent

Hackathon project for **Concrete Jungle**: one Photon iMessage agent that combines
NYC events, restaurants, historical safety context, and real routes. Public
[NYPD complaint data](https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Current-Year-To-Date-/5uac-w243)
and official city events land in Tiger Data; Gemini routes intent between the
skills, and Google Maps Platform supplies factual places and directions.

Fits **Hack the City** (messy urban data, visual + actionable) and **Know Your City**.

Confirmed live: YTD dataset `5uac-w243` ≈ **279,513** complaints; historic `qgea-i56i` ≈ **10.1M**.

## 1. Create a Tiger Cloud database

You need a free [Tiger Cloud](https://console.cloud.tigerdata.com) account (browser signup). Then, in a terminal on this machine:

```bash
brew install --cask timescale/tap/tiger-cli
tiger auth login
tiger service create --name divhacks26 --cpu shared --memory shared --region us-east-1 --with-password
tiger db connection-string --with-password
```

Shared CPU/memory is the **free** tier (us-east-1 only, beta). Copy the URL into `.env`.

Or create the service in [Tiger Console](https://console.cloud.tigerdata.com) → New service → download the config file.

## 2. Schema + ingest

```bash
cp .env.example .env
# paste DATABASE_URL

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

psql "$DATABASE_URL" -f sql/001_schema.sql
python scripts/ingest_nypd.py
psql "$DATABASE_URL" -f sql/002_queries.sql
```

Default ingest is **20k** recent YTD rows so a free service stays small. Raise `INGEST_LIMIT` in `.env` (or set `0` to page until the API is empty). Switch `NYPD_DATASET=qgea-i56i` only if you have room for historic data.

## Source

- API: `https://data.cityofnewyork.us/resource/5uac-w243.json`
- SoQL: `$limit`, `$offset`, `$order`, `$where` — default page size is 1,000

## Photon Spectrum iMessage infrastructure

This folder contains the first BoroughOS vertical slice: a hosted Photon
Spectrum listener that receives real iMessage messages, acknowledges them with a
tapback, shows a typing indicator, and replies in-thread.

It uses current `spectrum-ts` (12.10+). Do not mix this code with the
older Advanced iMessage Kit API; its constructor and event model are different.

### Add Photon credentials

In the [Photon dashboard](https://app.photon.codes), open your project settings
and copy its project ID and secret key. Then create `.env` from `.env.example`:

```powershell
Copy-Item .env.example .env
```

Fill in:

```dotenv
CHAT_PROVIDER=imessage
SPECTRUM_PROJECT_ID=your-project-id
SPECTRUM_PROJECT_SECRET=your-project-secret
# PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET are also accepted
BOROUGHOS_AUTOREPLY=true
GEMINI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-3.8-flash
```

Never commit `.env` or paste credentials into source code.

### Install and run

```powershell
npm install
npm run typecheck
npm test
npm run dev
```

Send a text message to the iMessage line connected to the Photon project. A
working round-trip produces a 👍 tapback, typing indicator, and BoroughOS reply.

## Deploy to DigitalOcean

The production stack runs the Photon worker/API, Keith's frontend, and Caddy on
one DigitalOcean Droplet. Agent JSON state and TLS certificates use persistent
Docker volumes. Follow the [DigitalOcean deployment guide](docs/digitalocean-deployment.md).

### Current boundary

- Photon/Spectrum owns conversation transport.
- Incoming text is geocoded (Photon/Komoot, NYC-biased), then Tiger is queried
  for NYPD complaints near that block (~250m) and neighborhood (~800m), split
  by hour in `America/New_York`.
- Transportation questions (“How should I get there?”) are handled by `src/transport` via Gemini Maps grounding.
- Other questions use `src/agent/suggest.ts` (Gemini + Maps, including the Tiger block sketch when `DATABASE_URL` is set).
- Replies go out with `message.reply`, falling back to `space.send` when a threaded reply is skipped. Conversation state is keyed by `space.id`.
- Incoming content is treated as untrusted. The app ignores its own outbound
  messages and does not log message bodies, credentials, or contact data.

Text the iMessage line a place, optionally with a time: `Columbia University at 9pm`.

### Dashboard checklist

1. Create or select a Photon project.
2. Copy the project ID and secret from project settings into local `.env`.
3. Confirm an iMessage provider/line is connected to the project.
4. Start this listener and send a real text to that line.
5. Keep shared-line quota and routing limits in mind during the demo; use the
   project’s dedicated line if Photon assigned one.

No webhook is required for this listener-based milestone. If the service later
moves to a serverless host, use Spectrum Cloud’s signed-webhook adapter and
deduplicate at-least-once deliveries before triggering financial side effects.

## Unified four-skill agent

The Photon listener now sends every addressed message through one Gemini intent
router. The router dispatches only the skills needed for that turn:

- `safety`: historical NYPD complaint context from Tiger Data
- `events`: NYC Parks and permitted events from Tiger Data, optionally enriched by Tavily
- `food`: verified restaurants from Google Places API (New)
- `route`: travel time and a directions link from Google Routes API

Gemini selects only IDs returned by these skills. Names, times, counts,
distances, and URLs are rendered from structured API results so the model cannot
invent places or city-data facts.

### Event schema and ingestion

Apply the shared event table after the NYPD schema, then load the two official
NYC event feeds:

```powershell
psql $env:DATABASE_URL -f sql/004_city_events.sql
python scripts/ingest_events.py
```

Run `ingest_events.py` daily on the deployment host. Rows without usable
coordinates are retained for source coverage but excluded from nearby searches.

### Required service configuration

Copy the new names from `.env.example` into the untracked `.env`:

```dotenv
GOOGLE_MAPS_API_KEY=       # Places API (New) and Routes API
TAVILY_API_KEY=            # optional event enrichment
```

Keep `CHAT_PROVIDER=terminal` while developing and switch to `imessage` only for
the shared Photon demo. Restrict the Google key to Places and Routes APIs and
never commit any API key.

### Team module boundaries

- Alan owns `src/skills/safetySkill.ts` and the NYPD/Tiger query.
- The events owner owns `src/skills/eventsSkill.ts`, `scripts/ingest_events.py`, and `sql/004_city_events.sql`.
- Keith owns `src/agent/intent.ts`, `src/agent/orchestrate.ts`, and food ranking.
- Rohan owns `src/skills/routeSkill.ts` and Google Routes behavior.
- Only `src/index.ts` consumes Photon messages or sends user-visible replies.

Before merging a skill branch:

```powershell
npm run typecheck
npm test
```

## How should I get there?

The agent answers NYC transportation questions inside iMessage: directions,
walk vs subway, nearby places, and follow-ups like “Can I walk instead?”
Conversation context is stored per Photon `space.id`, so two group chats
cannot leak destinations into each other.

```
iMessage
  → Photon Spectrum
  → transportation handler
  → Gemini API + native Google Maps grounding
  → optional Google Routes / Places
  → Photon
  → iMessage
```

`GEMINI_API_KEY` is the only Google credential required for the normal path.
If Maps grounding metadata is missing, the agent says it could not get reliable
route details instead of inventing a subway line.

### Photon setup

1. Create a project at [app.photon.codes](https://app.photon.codes).
2. Connect an iMessage line.
3. Copy `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` (or `PHOTON_*`) into `.env`.
4. Set `CHAT_PROVIDER=imessage` and `npm run dev`. Spectrum listens over gRPC; no webhook is required.

The listener still uses current Spectrum APIs from
[photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts):
`Spectrum()`, `imessage.config()`, `terminal.config()`, `app.messages`,
`space.send`, and `space.responding`.

### Gemini setup

1. Create a key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Set `GEMINI_API_KEY`.
3. Optional: `GEMINI_MODEL` (default `gemini-3.8-flash`).

Gemini is called with the official Maps grounding tool:

```ts
tools: [{ googleMaps: {} }]
toolConfig: { retrievalConfig: { latLng: { latitude, longitude } } }
```

That is how place names, nearby results, and geographic context are resolved.
`GEMINI_API_KEY` is not a Google Maps Platform key.

### Google Maps grounding + optional routing

- **Default:** Gemini Maps grounding with `GEMINI_API_KEY` only.
- Grounded replies include `Google Maps` source titles from `groundingChunks`.
- If no Maps grounding chunks come back, the user gets a limited fallback.
- **Optional:** `GOOGLE_MAPS_API_KEY` adds structured Routes/Places. It is not
  required and is not interchangeable with the Gemini key.
- See `docs/gemini-maps-capabilities.md` for what grounding can and cannot prove.

### Required environment variables

| Variable | Required to start | Used for |
| --- | --- | --- |
| `CHAT_PROVIDER` | no (default terminal) | `terminal` or `imessage` |
| `SPECTRUM_PROJECT_ID` / `PHOTON_PROJECT_ID` | for iMessage | Spectrum Cloud |
| `SPECTRUM_PROJECT_SECRET` / `PHOTON_PROJECT_SECRET` | for iMessage | Spectrum Cloud |
| `GEMINI_API_KEY` | for transport + suggestions | Maps grounding |
| `GEMINI_MODEL` | no | default `gemini-3.8-flash` |
| `GOOGLE_MAPS_API_KEY` | optional | structured Routes/Places |
| `DATABASE_URL` | only for Tiger ingest | NYPD crime hypertable |
| `BACKBOARD_API_KEY` | optional | persistent per-person memory |
| `BACKBOARD_MEMORY_MODE` | no (default `Auto`) | `Auto`, `Readonly`, or `off` |
| `BACKBOARD_MEMORY_PRO` | no (default false) | use Memory Pro instead of Memory Lite |

### Run locally

```bash
cp .env.example .env
# fill Photon + Gemini + optional Maps keys
npm install
npm run typecheck
npm test
npm run dev
```

Without iMessage, you can still exercise the transportation path:

```bash
npm run transport:demo
npm run transport:gemini-live
```

### Test

```bash
npm test
```

Automated tests mock Gemini and Maps. They do not make paid API calls.

### Example iMessage interaction

```
You: How should I get from Columbia University to Times Square?
Agent: Take the 1 from 116 St-Columbia University to Times Sq-42 St. About 35 min.
       Walking would take much longer, so transit makes more sense here.

You: I’m at Columbia University.
You: How should I get to Washington Square Park?
Agent: Take the 1 downtown and transfer to the A/C/E at 14 St. About 25 min.

You: Can I walk instead?
Agent: Walking is about 40 min.
       Walking would take much longer, so transit makes more sense here.
```

Times and station names only appear when Maps grounding or optional Routes
data actually supported them.

## @agent in a group chat

In a group, ordinary messages are stored as recent context and do not call Gemini.
Someone invokes the agent by writing `@agent` (any capitalization):

```
Keith: Want to leave at 6?
Rohan: Yeah, but I don't like walking through Midtown.
Rohan: @agent how should we get to Times Square?
```

The listener keeps the Photon `space.id`, message id, sender id, display name when Photon provides one, timestamp, and participants. The reply goes back to that same space. `@agent` is stripped before reasoning, so the model sees `how should we get to Times Square?`.

Direct chats still reply to normal messages. Group chats still reply when mentioned by `AGENT_NAME`. `@agent` is an additional explicit invocation, not a replacement for that.

### Identity

Each human is keyed by their Photon sender id, not their display name.

```
Photon sender id → photon:<id> → one Backboard assistant_id
```

That assistant id is stored in `data/agent-state.json` and reused across group chats, direct chats, and restarts. Each person gets their own assistant so one person's preferences cannot land in someone else's memory. A Photon space is not a Backboard assistant. A Backboard thread is just that person's session inside one space; the memories live on the assistant and are available from every thread.

### Memory

Durable lines such as "I don't eat meat" or "I always take the subway instead of Uber" are sent to that sender's assistant with `memory` set to `Auto` (or `memory_pro` when `BACKBOARD_MEMORY_PRO=true`) and `send_to_llm` false. No iMessage reply is generated for that.

Short chatter such as "lol" or "see you in 5" is not stored. The classifier is local and conservative: `DURABLE_PREFERENCE`, `DURABLE_FACT`, `EPHEMERAL`, or `UNCERTAIN`. Only the first two are ingested.

On `@agent`, Gemini still decides the reply. Backboard is asked for relevant memory with `Readonly` (or `memory_pro=Readonly`). If the request is about the group ("where should all four of us eat?"), other participants are queried separately and each fact stays labeled with that person.

Those memories change decisions. A walk through an area someone avoids is dropped when another route exists. "Get us an Uber" still means a car, even if an older memory prefers the subway. A newer line in the chat ("I've started liking sushi") overrides the older memory.

The group reply should use the preference without announcing where it came from. It should not say that someone revealed a fact in an earlier private chat, and it should not quote another person's unrelated memory.

### Backboard setup

1. Create a key at [app.backboard.io](https://app.backboard.io).
2. Put it in `.env` as `BACKBOARD_API_KEY`. It is only used on the server. It is never sent to iMessage or written to logs.
3. Optional: `BACKBOARD_MEMORY_MODE=Auto` and `BACKBOARD_MEMORY_PRO=false`.
4. `BACKBOARD_VERBOSE_MEMORY=true` prints retrieved memory text. Leave it false.

If `BACKBOARD_API_KEY` is missing, the process still starts, logs one warning, and `@agent` answers from recent group context plus Gemini.

If Backboard times out or returns 401, 403, 429, 500, or malformed JSON, the turn continues with recent chat context and Gemini. The iMessage reply does not include the API error or the key.

### Local testing

```bash
npm test
npm run typecheck
```

Automated tests mock Backboard. They do not need an account.

### Live Backboard check

This is not part of `npm test`.

```bash
npm run test:backboard-live
```

With `BACKBOARD_API_KEY` set, it stores a subway preference on one assistant, asks again from a second thread, and checks that the preference comes back. The script prints diagnostics and never prints the key. Without a key it exits without calling the API.

## Restaurant reservations

Photon can collect a reservation and, after an explicit yes, ask ElevenLabs to call the restaurant. The listener, Gemini suggestions, transportation, and per-space memory stay in place. Each reservation is tied to its Photon `space.id`. In-progress reservations are also written into the agent state file (`AGENT_STATE_PATH`, default `data/agent-state.json`) so a restart can still match the ElevenLabs conversation id to that space. One chat cannot see another's restaurant or call.

```
iMessage
  → Photon listener
  → existing turn (payment request, then reservation, then payment confirmation, then transportation, then Gemini)
  → reservation state for that space
  → Gemini slot extraction when a key is set (text only, not audio)
  → Google Places phone lookup when GOOGLE_MAPS_API_KEY is set
  → ElevenLabs outbound call
  → post-call webhook
  → the same Photon space
```

A vague mention such as "I heard Carbone is good" does not place a call. "Call them" uses the restaurant mentioned in that space. Directions such as "How do I get to Carbone?" still go to transportation.

### ElevenLabs

Official docs used:

- [Outbound call via Twilio](https://elevenlabs.io/docs/api-reference/integrations/twilio/outbound-call) — `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` with `xi-api-key`, `agent_id`, `agent_phone_number_id`, `to_number`, and `conversation_initiation_client_data` (dynamic variables plus the per-call system prompt and first message).
- [Personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization) — `conversation_config_override` and `dynamic_variables`. Overrides must be enabled on the agent Security tab or the dashboard prompt is used instead.
- [Post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks) — `post_call_transcription` and `call_initiation_failure`. Audio webhooks should be turned off. Authenticity is HMAC-SHA256 over `timestamp.rawBody`, header `ElevenLabs-Signature: t=<unix>,v0=<hex>`, 30-minute window, matching the official SDK `constructEvent`.

The voice agent is prompted as an AI assistant calling on behalf of the customer. It does not claim to be the customer. It may accept a time only inside the window the user authorized.

Dashboard setup:

1. Create a Conversational AI agent and a Twilio number linked to it.
2. Copy the agent id and the agent phone number id.
3. Enable system prompt and first message overrides on the agent Security tab.
4. Add a post-call webhook in ElevenAgents settings pointing at `https://<your-host>/webhooks/elevenlabs`.
5. Put the webhook signing secret in `ELEVENLABS_WEBHOOK_SECRET`.
6. Turn off "Send audio data". Transcription and call-initiation failure events are the ones this app uses.

The local listener serves `POST /webhooks/elevenlabs` on `RESERVATION_WEBHOOK_PORT` (default `8787`). For a laptop demo, expose that port with a tunnel so ElevenLabs can reach it.

### Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `RESERVATION_CALL_MODE` | `mock` | `mock` or `live` |
| `RESERVATION_MOCK_SCENARIO` | `alternative_within_window` | Simulated restaurant outcome |
| `RESERVATION_WEBHOOK_PORT` | `8787` | Local webhook listener |
| `RESERVATION_CALL_TIMEOUT_MS` | `600000` | Wait for a terminal webhook before `CALL_FAILED`. Values under one minute are ignored |
| `RESERVATION_ALLOW_GAZETTEER_DIAL` | false | Allow the built-in 555-number directory when live |
| `ELEVENLABS_API_KEY` | | `xi-api-key` |
| `ELEVENLABS_AGENT_ID` | | `agent_id` |
| `ELEVENLABS_AGENT_PHONE_NUMBER_ID` | | `agent_phone_number_id` |
| `ELEVENLABS_WEBHOOK_SECRET` | | HMAC secret |
| `GOOGLE_MAPS_API_KEY` | | Verified restaurant phone via Places `places:searchText` |

`RESERVATION_CALL_MODE` defaults to `mock`. Mock mode records the call payload and finishes it in-process. It does not contact ElevenLabs or a restaurant. The built-in directory uses NANP 555 numbers so a misconfigured live flag still does not reach L'Artusi.

Live mode dials only after the user confirms, and only a phone number returned by Google Places (`internationalPhoneNumber` or `nationalPhoneNumber`, source `places`). A number typed by the user or produced by Gemini is ignored. Set `RESERVATION_ALLOW_GAZETTEER_DIAL=true` only if you intentionally want the local 555 directory.

### Mock mode

```bash
RESERVATION_CALL_MODE=mock npm run dev
```

Then, in the terminal chat:

```
Let's go to L'Artusi Friday.
4 people. 8 would be ideal, anything 7:30-8:30 works.
Rohan.
Yes.
```

Photon asks for whatever is missing, confirms, says it is calling, and the mock scenario replies. `alternative_within_window` books 7:45. Other scenarios: `exact_time`, `alternative_outside_window`, `fully_booked`, `asks_for_name`, `asks_for_phone`, `voicemail`, `no_answer`, `api_error`, `malformed_completion`.

A full mock lifecycle, using the same orchestrator and webhook path and dialing nobody:

```bash
npm run demo:reservation
```

### Tests without calling

```bash
npm test
npm run typecheck
```

Reservation tests use the mock caller and a fake Places client. They never dial.

### Controlled live test

Do this only when you mean to call a real restaurant.

1. Set `RESERVATION_CALL_MODE=live`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, and `GOOGLE_MAPS_API_KEY`.
2. Leave `RESERVATION_ALLOW_GAZETTEER_DIAL` unset.
3. Start the listener and tunnel port `8787` to the webhook URL configured in ElevenLabs.
4. In a Photon chat, name a restaurant, give party size, date, time window, and name, then answer yes to "Want me to call?"
5. Photon sends "Calling … now." The webhook later posts the result back into that same space.

A second copy of the same Photon confirmation does not start a second call. A second webhook for the same conversation does not send a second result.

### Current limitations

- Recent chat and the Photon user → Backboard assistant map are stored in `data/agent-state.json`. Transportation place memory inside a space is still in-process and clears on restart.
- Backboard extraction is asynchronous. A fact from the same second as `@agent` is also applied locally when the chat text contradicts older memory.
- Shared-pool Photon lines have limited group-event support; DMs work on all plans.
- Location pins are parsed when they contain NYC coordinates; other attachments are ignored.
- Ambiguous chains like “Joe’s Pizza” ask one short clarification.
- Destinations outside NYC are labeled; the agent will not invent a route.
- Event, food, and safety requests use the unified skill orchestrator; transportation requests use the dedicated context-aware handler.
- Participant memory is retrieved only for group requests that are clearly about the group (everyone, dinner for us, and similar). A one-person directions question does not pull other people's memories.

## Conversational payments

Photon can send a test payment after an explicit yes. The listener, reservations, transportation, and Gemini suggestions stay in place. A payment request is another branch of the same turn.

```
iMessage
  → Photon listener
  → existing turn
  → payment intent (deterministic parse, Gemini only to fill fields)
  → recipient directory for this process
  → pending payment stored on that Photon space
  → user confirms
  → mock provider, or (ripple_test) sender and recipient customer wallets
      → deterministic policy → sign with the sender's own wallet → validated XRPL Testnet result → audit
  → the same Photon space
```

"Send Keith $20 for the Uber" asks "Send Keith $20 for the Uber?" and does not move anything. "Yes" from the same person submits. "No" drops the pending payment. "Actually make it $15" updates the pending payment and waits for a new yes. The yes that applied to $20 is not reused.

Gemini may extract a recipient, amount, and memo. It never chooses a wallet and never submits. Amount checks, the directory lookup, the confirmation gate, and the provider call are ordinary TypeScript.

### What the sandbox actually records

Chat amounts are US dollars. XRPL Testnet does not settle bank dollars. In `ripple_test`, the app converts USD to testnet XRP at `PAYMENTS_XRP_PER_USD` (default **1 USD = 1 testnet XRP**) and submits that as drops (1 XRP = 1,000,000 drops). Testnet XRP has no monetary value. This is not a market rate, not RLUSD, and not a mainnet payment. A reply says "Sent" only after the ledger result is `tesSUCCESS` and includes a transaction hash. Timeouts and unknown results are failures: "Nothing was charged."

`mock` (the default) runs the same pending and confirmation flow and returns a fake transaction id. It does not open a socket.

In `ripple_test`, a chat payment between people settles between customer wallets. The Photon sender must be mapped to a registered customer in `XRPL_CUSTOMER_SENDERS_JSON`. Display names are never trusted for this. The recipient must be a registered customer: Rohan, Keith, Ben, or Sarah. After the yes, `XrplPaymentExecutor` builds a frozen intent and runs the deterministic `PolicyEngine`. Only then does it sign with the sender's own Testnet wallet and wait for a validated ledger. The reply says "Sent" only when the result is `tesSUCCESS`, the transaction is validated, a hash exists, and the delivered amount matches. That reply links the hash on [testnet.xrpl.org](https://testnet.xrpl.org). Unmapped senders and unknown recipients are refused before confirmation, and no wallet is created for them.

Reservation deposits (merchant payments) still use the `XRPL_TESTNET_SEED` provider described below.

`nessie` records a completed **purchase** on Capital One's Nessie hackathon API (fake USD, fake merchants). That is not a real bank debit. `nessie_ripple` writes that Nessie purchase first, then submits the same dollar amount as test XRP on XRPL Testnet (peg `PAYMENTS_XRP_PER_USD`). The XRPL memo includes `nessie:<purchaseId>` so the two records match. Fund a Testnet sender with `npm run payments:fund-testnet`.

### Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `PAYMENTS_MODE` | `mock` | `mock`, `nessie`, `ripple_test`, or `nessie_ripple` |
| `NESSIE_API_KEY` | | Capital One Nessie hackathon key. Never commit it |
| `NESSIE_BASE_URL` | `http://api.nessieisreal.com` | Nessie host |
| `NESSIE_CUSTOMER_ID` | | Optional existing Nessie customer |
| `NESSIE_ACCOUNT_ID` | | Optional existing Nessie checking account |
| `PAYMENTS_MAX_USD` | `500` | Reject larger requests before confirmation |
| `PAYMENTS_DAILY_MAX_USD` | `1000` | Deterministic daily cap for the autonomous policy engine |
| `XRPL_AUTO_PROVISION_TESTNET` | `false` | Fund a registered customer from the Testnet faucet when they have no wallet. Unknown names are not provisioned |
| `XRPL_CUSTOMER_SENDERS_JSON` | | Photon sender id (phone or email) to customer id, e.g. `{"+15551234567":"rohan"}`. Required for chat payments in `ripple_test` |
| `XRPL_DASHBOARD_PORT` | `8790` | Read-only `GET /api/xrpl/dashboard` on 127.0.0.1 for the website's XRPL Testnet section |
| `AUTONOMOUS_PAYMENTS_ENABLED` | `false` | Allow an agent payment with no human yes. Testnet only, and only under `AUTONOMOUS_MAX_USD` |
| `AUTONOMOUS_MAX_USD` | `25` | Stricter cap for autonomous payments |
| `PAYMENTS_XRP_PER_USD` | `1` | Demo peg used only in `ripple_test` |
| `PAYMENTS_TIMEOUT_MS` | `20000` | Give up without claiming success |
| `XRPL_TESTNET_URL` | `wss://s.altnet.rippletest.net:51233` | Official Testnet websocket. Other hosts are refused |
| `XRPL_TESTNET_SEED` | | Testnet sender family seed. Never commit it |
| `PAYMENTS_RECIPIENTS_JSON` | | Optional map of display name to classic address |
| `PAYMENTS_MERCHANTS_JSON` | | Testnet classic addresses for restaurant deposits. Required in `ripple_test` |
| `RESERVATION_DEPOSITS_JSON` | | Demo deposit fixtures. Not a live restaurant policy |

There is no real-money mode. A missing seed in `ripple_test` fails the payment closed instead of pretending it succeeded.

## Reservation deposits

Some restaurants charge a deposit, prepayment, or reservation fee to hold a table. The agent books them in the same Photon conversation, but it never pays without an explicit yes, and it never takes the amount or destination from Gemini or the message.

```
iMessage → Photon → reservation intent/state (per space.id)
  → restaurant integration: booking provider, demo catalog, or the ElevenLabs call
  → grounded ReservationPaymentRequirement (amount, currency, recipient, type, expiry)
  → "Want me to pay the $100 deposit and book it?"
  → explicit yes from the same sender in the same space
  → re-verify terms from their source → XRPL guardrail (PolicyEngine) ALLOW/DENY
  → PaymentService.executeDeposit → XRPL Testnet (idempotent InvoiceID)
  → provider confirm or ElevenLabs callback → reply in the same Photon space
```

```text
@agent book Ripple Bistro for 4 tomorrow at 8
Ripple Bistro has a 8:00 PM table for 4 tomorrow. They require a $100 deposit ($25/person). Want me to pay the $100 deposit and book it?
Book it
I won't pay the $100 deposit unless you say yes. Pay it and book?
yes
Booked Ripple Bistro for 4 tomorrow at 8:00 PM. The $100 deposit was paid successfully on XRPL Testnet (tx FC180461). Confirmation RB-17C5DC.
```

### Where amounts come from

| Source | Used for |
| --- | --- |
| `provider` | A booking API (`src/reservations/providers.ts`). Ripple Bistro is the built-in mock: 5–10 PM on the half hour, $25/person deposit, 9:30 PM always full. |
| `demo` | `RESERVATION_DEPOSITS_JSON` fixtures such as Carbone at $50. Not a claim about the real restaurant. |
| `phone` | The restaurant states it on an ElevenLabs call. The agent is told never to agree to pay or give payment details; it collects `deposit_required`, `deposit_amount_usd`, optional `deposit_type`/`deposit_per_person_usd`, and returns `NEEDS_USER_INPUT`. The amount is accepted only if the restaurant said the same figure in the transcript. After payment the agent calls back with `deposit_paid_usd`/`deposit_reference`. |

The destination is the provider-published wallet or `PAYMENTS_MERCHANTS_JSON` (`{"Ripple Bistro":"r..."}`); two different answers means no destination. Mock mode uses `mock:merchant:{name}` and submits nothing. Card holds cannot be settled on XRPL and are refused with a clear reply.

### Authorization, idempotency, and failure

- "Book X" or "Book it" is not authorization. Only a clear yes (`yes`, `pay it`, `confirm`, …) from the person who asked, in the same space, before the 15-minute expiry. A stale yes re-quotes; a changed party re-quotes and cancels the old pending payment.
- Each obligation has a deterministic id (`resv-pay-…`, a hash of space, reservation, restaurant, recipient, type, amount, party, date, time). It is the PaymentService idempotency key and the ledger `InvoiceID`, so duplicate yeses, Photon redeliveries, and restarts find the existing payment instead of paying again.
- States are kept separately on the reservation: `PAYMENT_REQUIRED → PAYMENT_AUTHORIZED → PAYMENT_SUBMITTED → PAYMENT_CONFIRMED → RESERVATION_CONFIRMED`, plus `PAYMENT_FAILED`, `PAYMENT_REJECTED`, `PAYMENT_UNCERTAIN`, `PAYMENT_EXPIRED`, and `RESERVATION_FAILED_AFTER_PAYMENT`. A failed or blocked payment never says booked. If the restaurant fails after payment, the reply says so and `try again` retries the booking without paying again.
- Every deposit goes through `src/payments/reservation-deposits.ts`, which runs the XRPL guardrail `PolicyEngine` (limits, daily limit, duplicate, network, balance, intent-vs-payload) plus merchant checks, and writes to the same audit log as person payments.

### Trace

`GET http://127.0.0.1:$RESERVATION_WEBHOOK_PORT/reservations/payments?spaceId=…` and `/reservations/{id}/payment` return restaurant, time, party, deposit, sender and recipient wallets, tx hash, explorer link, ledger result, guardrail checks, and the state timeline. No seeds. Only direct local requests are served; anything arriving through a tunnel gets 404.

On the website, the existing XRPL Testnet panel (`npm run xrpl:dashboard`) lists confirmed deposits as "Ripple Bistro (reservation deposit)" once the hash and balance changes are re-verified on the ledger, and lists guardrail DENYs under guardrails. Both come from the shared guardrail audit log.

### Live Testnet demo

```bash
npm run test:reservation-deposit-live
```

Faucet-funds a sender (unless `XRPL_TESTNET_SEED` is set) and a Ripple Bistro wallet, runs the conversation above through the real guardrail and PaymentService, prints the trace and explorer link, and writes `data/reservation-deposit/last-run.json`. It sends 10 test XRP for the $100 deposit (`DEPOSIT_LIVE_XRP_PER_USD`, default 0.1). It never prints a seed.

For the iMessage agent: `PAYMENTS_MODE=ripple_test`, `XRPL_TESTNET_SEED`, and `PAYMENTS_MERCHANTS_JSON='{"Ripple Bistro":"r..."}'`. A restaurant with no deposit still asks `Want me to call?` and never opens a payment.

### Recipients

`src/payments/recipients.ts` maps Keith, Ben, and Sarah to XRPL classic addresses. Those built-in addresses are public placeholders for mock mode. They are not funded secrets. `PAYMENTS_RECIPIENTS_JSON` overrides them with funded Testnet addresses when you have some. An unknown name gets "I don't have a payment destination for Keith yet." The app does not invent an address.

"Send him $10" uses the latest message in **that** Photon space that names a person. Two different people in that message is ambiguous and is not sent. Another space's messages are not consulted.

The directory is the seam for a later Backboard contact, Photon participant, or handle lookup.

### Confirmation, idempotency, and groups

The pending record is `AWAITING_CONFIRMATION` until the initiating Photon sender says yes, yep, yeah, confirm, send it, do it, or pay it. The store then moves it to `PROCESSING` before the provider is called, then `SUCCEEDED` or `FAILED`. A second yes, a retried Photon delivery of the same message id, or a late network response cannot submit that payment again. The payment id is also the provider idempotency key. On Testnet it is stored as an `InvoiceID` and a memo, and a matching validated `tesSUCCESS` is reused instead of submitted twice.

Cancel (no, cancel, never mind, don't, stop) clears the pending payment.

In a group, only `sender.id` of the person who asked can confirm, change, or cancel. Someone else's "yes" does not send.

Payment state is stored on the agent state file next to reservations (`AGENT_STATE_PATH`, default `data/agent-state.json`), keyed by `space.id`. A yes in another space does not see it. A new process loads the pending payment and can still confirm it once.

### Tests

```bash
npm test
npm run typecheck
```

Payment tests mock the provider. `npm test` does not contact Ripple.

Fund the registered Testnet wallets from the official faucet (`faucet.altnet.rippletest.net`) before paying between them. A new name gets a new account. A name that already has a wallet is topped up at the same address. Seeds stay in `data/ripple-demo/secrets.json` and are not printed. Unknown names are refused.

```bash
npm run faucet
npm run faucet -- Rohan Keith
```

Opt-in Testnet check. It refuses any URL that is not XRPL Testnet, and it refuses a server whose network id is not Testnet (`1`). With no `XRPL_TESTNET_SEED` it funds temporary accounts from the official Testnet faucet and does not print secrets. It prints the payment id, destination address, requested USD, XRP amount and drops submitted, transaction hash, and final status.

```bash
npm run test:ripple-live
```

Do not point `XRPL_TESTNET_URL` at mainnet. The script and the provider both refuse that.

### Ripple guardrails

Photon person payments still ask for a human yes. A separate Testnet path can pay without that yes when `AUTONOMOUS_PAYMENTS_ENABLED=true`. Gemini still does not decide ALLOW or DENY. `PolicyEngine` checks the sender, the recipient, the wallet, the amount, the daily total, duplicates, the balance, and that the signed proposal still matches the frozen intent.

```bash
npm run demo:ripple
```

The demo provisions Rohan and Keith from the official Testnet faucet, or reuses their existing wallets. It then sends a real 1 XRP payment from Rohan to Keith and prints the before and after balances, the hash, the ledger index, the engine result, and the explorer link. After that it runs three attacks against real balances, and each one must leave the ledger untouched:

- a confirmed $500 intent whose payload was tampered to $5,000 (`INTENT_PAYLOAD_MISMATCH`)
- `RandomFakeCustomer` (`UNKNOWN_RECIPIENT`, with no wallet created)
- an autonomous $500 against the $25 cap (`SPENDING_LIMIT_EXCEEDED`)

The demo exits non-zero if any step does not behave as expected. Seeds stay in `data/ripple-demo/secrets.json` (mode 0600, gitignored). Public wallet metadata (`wallets.json`) and the append-only audit log (`audit.jsonl`) are separate files, and the demo checks that neither contains a seed.

The website's XRPL Testnet section reads `GET http://127.0.0.1:8790/api/xrpl/dashboard`. The agent serves it in `ripple_test`, and `npm run xrpl:dashboard` serves it on its own. It lists wallets with live validated balances, recent payments, and attempts that were denied before signing. A hash is linked to the explorer only after it has been re-verified on XRPL Testnet. Set `VITE_XRPL_DASHBOARD_URL` in the frontend to point it elsewhere.

## Social context, emotion and tone

Every addressed message gets a quick **social read** (`src/agent/social.ts`): mood, urgency,
the group's dynamic (aligned, disagreeing, someone left out) and the sender's texting style.
Gemini does it with a 2.5 s timeout; without Gemini, or if the call fails, a keyword read
takes over. Voice memos add the sounds ElevenLabs heard (laughter, sighs) as cues.

The read shapes *how* the agent answers, never the facts:

- the prompt gets tone rules: mirror their length and emoji use, lead with one option when
  someone is stressed or in a hurry, give each side an option when a group disagrees;
- the tapback matches the moment: ❤️ for a rough moment, none at all for frustration or swearing
  (never a 👍 on "fuck"), 😂 / ❤️ / ‼️ for playful, excited or urgent, 👍 otherwise;
- templated answers (places, routes) get one short, fact-free opener ("Ugh, that's annoying.",
  "On it, quickest option first:") so they sound like the agent heard them;
- venting with nothing to look up ("fuck", "today sucked") gets a 1–2 line friend-style reply
  instead of a list of places (`src/agent/support.ts`); crisis language adds the 988 line;
- voice replies change delivery: steadier and slower for stress, brighter for excitement;
- a recurring feeling someone states about themselves ("I always get nervous on the subway
  late") is saved to their own Backboard memory as `Feeling: …` and is never mentioned in groups;
- after a rough moment or a late-night trip in a 1:1 chat, the next reply at least 8 hours later
  opens with one short follow-up line.

Only enum fields from the read are logged (`social.read`), never message text.

**Is it live?** Every addressed message logs one line, e.g.
`social.read {"source":"gemini","mood":"frustrated","urgency":"none",...,"needsSupport":true}`.
`source:"local"` on every line means the Gemini read is failing; the preceding
`social.read fallback <Error>: <reason>` line says why (missing key, 429 quota, timeout).
Try it without iMessage: `CHAT_PROVIDER=terminal npm start`, then type `fuck` or `ugh I'm so tired`.

**Voice beyond voice memos.** `VOICE_REPLIES=smart` (the default) also speaks when someone asks
("send that as audio", "say it out loud" replays the last answer) or is walking or driving and
needs a route. Payment confirmations always stay text-only.
