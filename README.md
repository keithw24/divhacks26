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

### Current limitations

- In-memory context only (clears on process restart). Backboard is not wired.
- Shared-pool Photon lines have limited group-event support; DMs work on all plans.
- Location pins are parsed when they contain NYC coordinates; other attachments are ignored.
- Ambiguous chains like “Joe’s Pizza” ask one short clarification.
- Destinations outside NYC are labeled; the agent will not invent a route.
- Event, food, and safety requests use the unified skill orchestrator; transportation requests use the dedicated context-aware handler.
