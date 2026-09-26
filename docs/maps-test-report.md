# Maps test report

Run on 2026-09-26 against the working tree (Photon listener + `src/transport`). Automated tests do not call paid APIs. Live tests are separate.

Commands:

```bash
npm test
npm run test:maps-live
```

## Result summary

| Suite | Result |
| --- | --- |
| Automated tests (`npm test`) | 69 PASS, 1 FAIL (70 total) |
| Maps automated tests (`test/maps`) | 39 PASS, 1 FAIL (40 total) |
| Live NYC routes (`npm run test:maps-live`) | 5 FAIL |
| Google Routes API | NOT TESTED — `GOOGLE_MAPS_API_KEY` is not set |
| Gemini Maps grounding, live | FAIL — Gemini was reached and returned HTTP 429 quota exceeded |
| Real iMessage | NOT TESTED |

A green assertion means the behavior under test happened. The live routes are not a pass.

## Automated tests

### Passing

Explicit origin and destination, contextual origin, contextual destination (Katz’s), walk-instead follow-up, destination follow-up (“What about Washington Square Park?”), missing origin (Central Park), missing destination, Joe’s Pizza clarification, walk-vs-subway comparison, Times Square → Grand Central, same-place, nonsense destination, group-chat isolation, Photon chat-store isolation, response quality, Photon reply seam, Routes request body (origin, destination, mode), Places ambiguity, coordinate and duration plausibility, Maps HTTP 401 / 403 / 429 / 500, thrown timeout, hung Routes request, empty Maps payload, malformed Maps payload, Gemini failure after a successful route lookup, and Gemini not being asked to invent a route when the routing provider fails.

When a route payload exists, a grounded Gemini reply that adds a subway line, fare, distance, transfer, or service status is dropped. The user-facing text stays on the payload (duration only, in that test).

### Failing

`does not publish subway, fare, or duration claims from Gemini when no route payload exists`

Expected to fail until route claims are rejected when Google Routes returned nothing.

What happens now: with no routing provider, Gemini is called with an empty route list. If the reply is marked grounded, that text is sent as-is. The test fed a grounded reply that added the 1 train, a fare, a walking distance, a transfer, a delay, and a 20 minute time. All of those appeared in the final text. Grounding metadata alone is not checked against those claims when the route list is empty.

This is the production shape when `GEMINI_API_KEY` is set and `GOOGLE_MAPS_API_KEY` is not.

## Live integration

`GEMINI_API_KEY` was set. `GOOGLE_MAPS_API_KEY` was not. Model: `gemini-3.8-flash`.

The first Gemini place lookup returned HTTP 429 (quota exceeded). Later lookups were skipped so the run would not keep spending quota. No coordinates, duration, or route summary came back from Maps.

For each trip the service reply was the short fallback: it could not get reliable route data. It did not invent a subway line after the 429.

| Trip | Live place resolution | Routes provider | Reply | Status |
| --- | --- | --- | --- | --- |
| Columbia University → Times Square | FAIL, Gemini 429 | NOT TESTED | fallback, no invented line | FAIL |
| Washington Square Park → Union Square | skipped after 429 | NOT TESTED | fallback | FAIL |
| Times Square → Grand Central Terminal | skipped after 429 | NOT TESTED | fallback | FAIL |
| Columbia University → Washington Square Park | skipped after 429 | NOT TESTED | fallback | FAIL |
| Katz’s Delicatessen → Brooklyn Bridge | skipped after 429 | NOT TESTED | fallback | FAIL |

Known place names can still resolve from the local gazetteer inside the service. That is not live Maps data, and this run did not treat it as a pass.

## Integration status

| Piece | Status |
| --- | --- |
| Photon → transportation handler → reply | PASS in the mocked seam (`processPhotonTextMessage` / `runConversationTurn`). Listener source calls `transport.handle` and `transport.observe` with `space.id`. Real iMessage NOT TESTED. |
| Conversation context | PASS in mocked chats. Origin, destination, and mode follow-ups stay on the same space. |
| Group-chat isolation | PASS in mocked chats. Columbia → Times Square stayed out of Washington Square Park → Brooklyn Bridge. Photon transcript storage is also keyed by space id. |
| Google Routes | NOT TESTED live. Mocked provider boundary checks the computeRoutes body and error statuses. |
| Gemini | Mocked phrasing PASS when a route payload exists. Live call FAIL (429). Gemini-only grounded prose can still carry unverified route details (the failing test above). |
| Maps data actually retrieved | No. |

## Hallucination

Caught and blocked when a route payload is present: extra line, fare, distance, transfer, and delay text from Gemini is not shown.

Still open when there is no route payload: grounded Gemini prose is delivered even if it names a line, fare, stop, or time that no tool result contained. Expected to fail until that path checks claims against a route payload or refuses to state them.

The checker used in tests is pattern-based (lines, stops, fares, distances, minute values, delays). It is not a proof that every sentence is entailed by Maps.

## Blockers

- Gemini quota is exhausted for `gemini-3.8-flash`, so live grounding could not be judged.
- No `GOOGLE_MAPS_API_KEY`, so Places and Routes were not called.
- No real iMessage round-trip in this run. Manual steps are in `docs/maps-live-test-checklist.md`.
- Gemini-only replies can still include route facts that were not in a Routes payload.
