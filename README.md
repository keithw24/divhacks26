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
  → existing turn (reservation, then transportation, then Gemini)
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
