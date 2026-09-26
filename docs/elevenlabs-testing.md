# Testing ElevenLabs without a Google Maps key

Run `npm run integrations:check-elevenlabs` to verify access to the Agents API,
the configured agent and connected phone number, and the presence of a webhook
secret. This command never dials, needs no Maps key, and does not overwrite the
full integration-health dashboard snapshot. Passing it does not prove webhook
delivery or a completed phone call.

For outbound reservation tests, configure:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_AGENT_ID`: create/configure an ElevenLabs restaurant calling agent.
- `ELEVENLABS_AGENT_PHONE_NUMBER_ID`: connect an outbound Twilio phone number in ElevenLabs.
- `ELEVENLABS_WEBHOOK_SECRET`: match the signed post-call webhook configured for the deployed application.

The restaurant prompt is in `src/phone/elevenlabs.ts`. Enable prompt and first-message
overrides on the agent so each call can supply its own instructions.

Set `ELEVENLABS_TEST_NUMBER` to a number you control, then explicitly start one
short real call with:

```sh
npm run integrations:test-call -- --confirm
```

For a reservation conversation against your own test phone, set
`RESTAURANT_CALL_TEST_NUMBER` and preview the payload:

```sh
npm run demo:restaurant-call -- --restaurant="Test Restaurant" --name=Rohan --party=2 --date=2026-09-27 --time=19:00
```

Add `--live` to place the call. The explicitly supplied operator test number
bypasses restaurant lookup, so this test does not require Google Places.
This standalone demo uses in-memory state; use the running application's signed
webhook path for a full iMessage reservation-result test.

The regular live chat reservation flow still needs a verified restaurant phone
source. Enabling ElevenLabs alone does not replace Google Places lookup. Do not
turn on gazetteer dialing merely to work around missing lookup credentials.

Payments remain sponsor sandbox integrations: Capital One Nessie and Ripple
XRPL Testnet. No real restaurant funds are needed for these tests.
