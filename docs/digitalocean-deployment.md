# DigitalOcean deployment

This repository deploys to a DigitalOcean Droplet with Docker Compose. A
Droplet is intentional: the agent currently stores login, reservation, and
payment workflow state in JSON files. The `agent_data` Docker volume keeps
those files across container rebuilds.

The public surface is one HTTPS origin:

- `/` serves the frontend.
- `/api/*` serves the website API.
- `/webhooks/elevenlabs` receives signed ElevenLabs post-call webhooks.
- `/healthz` and `/readyz` are deployment health endpoints.
- Photon Spectrum maintains the outbound connection to the iMessage service;
  it does not need a separate inbound port.

## 1. Create the host

Create an Ubuntu 24.04 Droplet in NYC or another nearby region. The smallest
shared-CPU plan is sufficient for a demo. Add an SSH key and point an `A`
record such as `app.example.com` at the Droplet IPv4 address.

Install Docker from DigitalOcean's Marketplace image or Docker's official
Ubuntu packages. Then clone the repository on the Droplet.

## 2. Configure secrets

From the repository root:

```sh
cp .env.example .env
chmod 600 .env
```

Set at least:

```dotenv
DOMAIN=app.example.com
CHAT_PROVIDER=imessage
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
DATABASE_URL=postgresql://...
GEMINI_API_KEY=...
GOOGLE_MAPS_API_KEY=...
WEB_AUTH_SECRET=...
AGENT_NUMBER=+1...
```

Generate `WEB_AUTH_SECRET` with `openssl rand -hex 32`. Keep `.env` only on the
server; it is ignored by Git. Enable optional Backboard, Tavily, ElevenLabs,
and payment settings only when those integrations are being demonstrated.

For live reservation calls, configure the ElevenLabs post-call webhook as:

```text
https://app.example.com/webhooks/elevenlabs
```

Set the same signing secret in `ELEVENLABS_WEBHOOK_SECRET`.

## 3. Initialize Tiger Data

The migration service applies every SQL file in filename order and exits:

```sh
docker compose --profile tools run --rm migrate
```

Load the official NYC datasets:

```sh
docker compose --profile tools run --rm ingest
```

The ingest can take time. For the hackathon demo, keep `INGEST_LIMIT` bounded.
Re-run the ingest after the city feeds change; upserts make it safe to repeat.

## 4. Start the application

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f agent
```

Caddy obtains and renews TLS automatically after DNS reaches the Droplet.
Check deployment health with:

```sh
curl --fail https://app.example.com/healthz
curl --fail https://app.example.com/readyz
```

To deploy a new commit:

```sh
git pull --ff-only
docker compose up -d --build
```

The named `agent_data`, `caddy_data`, and `caddy_config` volumes survive that
command. Do not run `docker compose down --volumes` unless you intend to erase
the persisted agent state and TLS cache.

## 5. Schedule refreshes

Use the Droplet's cron to refresh city data daily:

```cron
17 5 * * * cd /opt/divhacks26 && /usr/bin/docker compose --profile tools run --rm ingest >> /var/log/boroughos-ingest.log 2>&1
```

Use the actual clone path instead of `/opt/divhacks26`.

## Operational checks

- `docker compose ps` shows `agent` healthy and all three services running.
- The website loads over HTTPS and sign-in codes arrive through Photon.
- A test iMessage gets one reply.
- ElevenLabs webhook attempts return a non-404 response in Caddy access logs.
- `docker volume inspect boroughos_agent_data` exists before any update.
- Secrets are restricted in Photon, Google Cloud, Gemini, ElevenLabs, and Tiger
  Data dashboards, and are never printed in screenshots or committed.

DigitalOcean App Platform is not the default for this repository because its
container filesystem is ephemeral and App Platform does not attach persistent
volumes. It becomes a good target after the JSON state stores move to Tiger
Data, Postgres, or another managed persistent store.
