# DivHacks 26 — NYC crime data on Tiger

Hackathon weekend starter for **Concrete Jungle**. Public [NYPD complaint data](https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Current-Year-To-Date-/5uac-w243) (NYC Open Data, no login) lands in a **Tiger Cloud** Timescale hypertable so you can query by time, borough, precinct, and offense.

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

It deliberately uses only `spectrum-ts` 12.2.0. Do not mix this code with the
older Advanced iMessage Kit API; its constructor and event model are different.

### Add Photon credentials

In the [Photon dashboard](https://app.photon.codes), open your project settings
and copy its project ID and secret key. Then create `.env` from `.env.example`:

```powershell
Copy-Item .env.example .env
```

Fill in:

```dotenv
PHOTON_PROJECT_ID=your-project-id
PHOTON_PROJECT_SECRET=your-project-secret
BOROUGHOS_AUTOREPLY=true
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
