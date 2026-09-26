# Gemini Maps grounding vs Google Maps Platform

Sources checked 2026-09-26:

- [Grounding with Google Maps](https://ai.google.dev/gemini-api/docs/maps-grounding) (Interactions)
- [generateContent Maps grounding](https://ai.google.dev/gemini-api/docs/generate-content/maps-grounding)
- [Routes API transit](https://developers.google.com/maps/documentation/routes/transit-route)

## What the current Gemini docs say

Maps grounding is enabled with `GEMINI_API_KEY` only:

```ts
tools: [{ googleMaps: {} }]
toolConfig: { retrievalConfig: { latLng: { latitude, longitude } } }
```

The docs describe the tool as a **textual search tool** that behaves like searching on Maps. Retrieved data is documented as places, reviews, photos, addresses, and opening hours. A successful grounded response includes `groundingMetadata.groundingChunks[].maps` with `title`, `uri`, and `placeId`, plus `groundingSupports` that link text spans to those sources.

The docs say grounding is useful for geo-specific questions, trip planners, and “getting directions.” They do **not** document structured route objects, duration fields, transit steps, transfers, or live service status.

## Classification

| Capability | Status | Why |
| --- | --- | --- |
| Place lookup | SUPPORTED BY GEMINI MAPS GROUNDING | Place chunks are the documented grounding payload |
| Nearby places | SUPPORTED BY GEMINI MAPS GROUNDING | Official “near me” examples |
| Place disambiguation | PARTIALLY SUPPORTED | Multiple chunks / model text; not a Places result list |
| Origin / destination resolution | PARTIALLY SUPPORTED | Names and citations, not guaranteed lat/lng |
| Approximate transportation advice | PARTIALLY SUPPORTED | Possible in grounded text; must check metadata |
| Walking vs transit comparison | PARTIALLY SUPPORTED | May appear in grounded text; not a structured compare |
| Subway route | PARTIALLY SUPPORTED | Sometimes in grounded prose; not a transit itinerary API |
| Station names | PARTIALLY SUPPORTED | Only if cited / present in grounded text |
| Transfers | PARTIALLY SUPPORTED | Same as subway route |
| Exact travel / walk / transit duration | REQUIRES GOOGLE MAPS PLATFORM | Not in grounding schema; use Routes `computeRoutes` |
| Live transit status | REQUIRES GOOGLE MAPS PLATFORM / UNKNOWN | Not documented on the grounding tool |
| Turn-by-turn directions | REQUIRES GOOGLE MAPS PLATFORM | Routes API, not Maps grounding |

This repo’s default transportation path is Gemini-only. It treats a reply as grounded only when `groundingChunks` contain Maps sources. Optional `GOOGLE_MAPS_API_KEY` can still supply structured Routes/Places.

Live probe: `npm run transport:gemini-live` (needs `GEMINI_API_KEY` only).

## Live experiment (2026-09-26)

Ran with `GEMINI_API_KEY` only. `GOOGLE_MAPS_API_KEY` was unset. `gemini-3.8-flash` returned quota 429; the probe used `gemini-3.5-flash-lite`, which the docs list as Maps-grounding capable.

Grounding was counted only when `groundingChunks[].maps` was present. Plausible prose without Maps chunks was marked FAIL.

| Question | Grounding | Sources | Result |
| --- | --- | --- | --- |
| Columbia University → Times Square | YES | 116 St - Columbia University, Times Sq-42 St | PASS — transit/station names, no invented duration |
| Times Square → Grand Central subway | NO | none | FAIL — model said information was insufficient |
| Walk vs subway, Washington Square → Union Square | YES | Washington Square Park | PASS — walk recommended |
| Columbia → Washington Square Park | YES | Columbia University review | PARTIAL — “train or bus,” no specific route |
| Nearest station to Katz’s | YES | Katz's, 2 Av, Delancey St–Essex St | PASS |
| Katz’s → Brooklyn Bridge | YES | Katz's Delicatessen | PARTIAL — destination found, no route |

Conclusion: Gemini-only is viable for place-backed transportation answers in iMessage. It is **not** a replacement for Routes API exact durations or guaranteed subway itineraries. This repo therefore uses Gemini as the default and keeps Routes/Places optional.
