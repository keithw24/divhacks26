# Transportation integration audit

Baseline: `main` at `2f2e008` (“Set up Photon Spectrum iMessage infrastructure”), pulled 2026-09-26. Working tree was clean. This repository has no transportation handler, no Gemini client, and no Maps client.

This document is a review checklist for the implementation that is being written in parallel. It does not change `src/`.

Sources checked:

- Installed contract in this repo: `spectrum-ts` **12.2.0** (`package.json`, `src/index.ts`, `src/config.ts`, `src/respond.ts`)
- Photon Spectrum skill and docs for 12.2.0: [spectrum-ts](https://github.com/photon-hq/spectrum-ts), [messages](https://photon.codes/docs/spectrum-ts/messages), [spaces and users](https://photon.codes/docs/spectrum-ts/spaces-and-users), [iMessage provider](https://github.com/photon-hq/skills/blob/main/skills/spectrum/providers/imessage.md), package types `@spectrum-ts/imessage@12.2.0`
- Gemini Maps grounding, updated 2026-09-23: [Interactions](https://ai.google.dev/gemini-api/docs/maps-grounding) and the still-documented [generateContent](https://ai.google.dev/gemini-api/docs/generate-content/maps-grounding) surface
- Routes, which Maps grounding does not replace: [Routes API transit](https://developers.google.com/maps/documentation/routes/transit-route)

Machine-readable cases live in `test/fixtures/transportation-cases.json`. They are not imported by Vitest, so `npm test` stays green.

---

## 1. Photon integration findings

### Current integration is on the current API

`src/index.ts` matches Spectrum 12.2.0. It is the cloud iMessage provider, not the older Advanced iMessage Kit and not `@spectrum-ts/imessage-local`.

| What the code does | Current 12.2.0 API |
| --- | --- |
| `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })` | Yes. Credentials come from project settings, not a pasted line token. |
| `for await (const [space, message] of app.messages)` | Yes. One merged inbound stream. |
| `message.direction === "outbound"` skip | Yes. Required so the bot does not answer itself. |
| `message.content.type !== "text"` branch | Yes. Content is a discriminated union. |
| `message.react("👍")` | Yes. iMessage maps `"👍"` to the native Like tapback. There is no `imessage.tapbacks` constant. |
| `space.responding(async () => message.reply(...))` | Yes. Typing indicator is cleared if the callback throws. `message.reply` is a threaded reply on iMessage. |
| `app.stop()` on SIGINT/SIGTERM | Yes. |

`createBoroughReply` receives only a string. It cannot see the chat, the sender, or prior turns. A transportation feature that keeps that signature cannot isolate conversations.

### Objects and methods the feature should use

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
});

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (message.platform !== "imessage") continue;
  if (message.content.type !== "text") continue;

  const chat = imessage(space); // { id, type: "dm" | "group", phone }
  const senderId = message.sender?.id; // E.164 or email; may be absent

  await message.react("👍");
  await space.responding(async () => {
    const text = await planTransportation({
      spaceId: chat.id,
      spaceType: chat.type,
      senderId,
      messageId: message.id,
      text: message.content.text,
      timestamp: message.timestamp,
    });
    const sent = await message.reply(text);
    if (!sent) await space.send(text);
  });
}
```

Use these fields:

| Need | Use | Do not use |
| --- | --- | --- |
| Receive | `app.messages` → `[space, message]` | A webhook, unless the process later becomes serverless. The README already notes that webhooks are at-least-once and need dedupe. |
| Conversation id | `space.id` after `imessage(space)` | `message.sender.id`, a single global `lastTrip`, or Photon’s per-person working-memory scope |
| DM vs group | `imessage(space).type` (`"dm"` \| `"group"`) | Guessing from member count. `getMembers()` throws on a DM. |
| Sender | `message.sender?.id`, plus optional `address`, `country`, `service` (`"iMessage"` \| `"SMS"` \| `"RCS"` \| `"unknown"`) | The line in `space.phone`. On a shared plan that value is a sentinel, not the user. |
| Reply | `message.reply(text)` inside `space.responding` | `message.reply` as the only send, with the return value ignored |
| Guaranteed bubble if a thread reply is skipped | `space.send(text)` only when `reply` resolves `undefined` | Treating a resolved promise as proof the user saw a tapback or a thread |
| Ack | `message.react("👍")` | Blocking the text reply on the tapback |
| This turn’s identity | `message.id` | Re-processing the same id after a stream replay |

Chat guid shape, from `packages/imessage/src/remote/ids.ts`:

- DM: `;-;` separator. Shared-mode DMs are deterministic: `any;-;{address}` (example `any;-;+15551234567`).
- Group: `;+;` separator (example `iMessage;+;chat…`). Participants are not encoded in the guid.
- `chatTypeFromGuid` treats any guid containing `;+;` as a group and everything else as a DM. Prefer `imessage(space).type`, which is filled from that rule.

### How direct and group chats differ

- Narrow with `imessage(space)` only after `message.platform === "imessage"`. Narrowing the wrong platform warns at runtime.
- Group creation (`space.create([a, b])`) and group membership APIs require a **dedicated** line. Shared mode throws: “shared mode cannot create group chats”.
- In shared mode the group-event stream (joins, leaves, renames) is not subscribed. Ordinary `message.received` traffic is separate from that stream. Confirm on the project’s actual line whether a group text arrives before writing group-only demo copy.
- `space.getMembers()` is group-only and omits the agent’s own number. `message.sender` can be `undefined` on some group events. A missing sender must not crash the turn, and must not be stored as `""` (that would merge strangers).
- In a group, trip state belongs to `space.id`. A later message from a different participant in that same group can say “can we walk instead?” and must see the same destination. That state must not follow the sender into another group or into their DM.
- Photon’s production memory note scopes working memory by sender and history by thread. For routes, ignore the cross-chat half of that advice. Origin, destination, mode, and the last route are **thread state**, keyed only by `space.id`.

### Replies

- `message.reply` wraps content in a threaded reply and goes through `space.send`. On iMessage, threads are supported. On a provider that does not support threads, Spectrum **warns and skips**. It does not downgrade to a normal send. Check the return value and fall back to `space.send`.
- `reply()` cannot wrap another reply, reaction, typing, edit, or read. Pass a string (or `text(...)`), not the previous outbound message.
- Put the Gemini/Routes work **inside** `space.responding`. The current listener calls `createBoroughReply` before `responding`, so the typing indicator would not cover a slow lookup.
- `BOROUGHOS_AUTOREPLY === "false"` must skip Gemini and Routes as well as the send. Today the placeholder is pure, so the flag only gates `message.reply`.

### Edge cases

- Skip `outbound`. Also skip `reaction`, `read`, `typing`, `rename`, `avatar`, `addMember`, `removeMember`, and `leaveSpace`. A tapback or a read receipt is not a directions request.
- Non-text (a dropped pin may arrive as `richlink`, `attachment`, or `custom`) is currently answered with “attachment support is coming next.” Keep that path from being classified as a route.
- One user turn is often several texts (“how do I get” / “to times square”). The 12.2 listener handles each message immediately. Overlapping Gemini calls can answer the fragment and then answer again. Dedupe on `message.id`, and avoid two in-flight plans for the same `space.id`.
- An exception from Gemini must not escape the `for await` loop. One failure would stop the listener for every chat.
- `message.react` and `message.reply` swallow `UnsupportedError` and resolve `undefined`. `space.get`, `space.create`, `getMembers`, and `getMessage` **throw**.
- Cloud quotas called out by Photon: 5,000 messages per server per day, 50 new conversations per line per day. Replies in an existing chat do not count as new conversations. Shared-pool outreach to an unregistered recipient fails with `Target not allowed for this project`.
- iMessage unsend only works on outbound messages and only for a short window. Do not unsend the user’s message.
- `message.read()` throws on outbound. Do not mark the bot’s own reply read.

---

## 2. Gemini and Maps findings

There is no Gemini code in this repo. Official docs updated 2026-09-23 describe **two** Gemini API surfaces. The URL in the task (`https://ai.google.dev/gemini-api/docs/maps-grounding`) is the **Interactions** API. `generateContent` is still documented separately. Pick one and parse only that response shape.

### Interactions API (the linked doc)

Requires `@google/genai` newer than 2.0.0.

```ts
const interaction = await ai.interactions.create({
  model: "gemini-3.8-flash",
  input: userText,
  tools: [{ type: "google_maps", latitude, longitude }],
});
```

- Auth sample: `new GoogleGenAI({})` with `GEMINI_API_KEY`. REST uses `x-goog-api-key`.
- Latitude and longitude are **decimal degrees on the tool object**. They are optional.
- Read `interaction.steps` where `step.type === "model_output"`, then text blocks, then `annotations` where `annotation.type === "place_citation"` (`name`, `url`).
- Supported models listed there include Gemini 3.8 / 3.7 / 3.6 Flash, 3.5 Flash and Flash-Lite, 3.1 Pro Preview, 3.1 Flash-Lite, 3 Flash Preview, and Gemini 2.5 Pro / Flash / Flash-Lite.
- English prompts and responses only, per that page.

### generateContent API (still documented)

```ts
const response = await ai.models.generateContent({
  model: "gemini-3.8-flash",
  contents,
  config: {
    tools: [{ googleMaps: {} }],
    toolConfig: {
      retrievalConfig: {
        latLng: { latitude, longitude },
      },
    },
  },
});
```

Structured fields are `candidates[].groundingMetadata`:

- `groundingChunks[].maps`: `uri`, `title`, `placeId`
- `groundingSupports[]`: text span (`startIndex`, `endIndex`) plus `groundingChunkIndices`
- `placeId` and `reviewId` are the fields Google says may be cached. Grounded prose is not on that allowlist.

Do not read `place_citation` annotations from a `generateContent` response, or `groundingChunks` from an Interactions response.

### What the tool actually is

Both pages describe a **textual place search**, analogous to searching Maps:

- Local queries (“near me”, “from here”) use the supplied coordinates.
- A named place (“Times Square”) is unlikely to be overridden by those coordinates.
- Retrieval examples are places, reviews, photos, addresses, and opening hours.
- The model then writes prose. Citations attach to that prose.

“Getting directions” appears as a product use case. The tool payload is still place citations, not a route. Vertex **Gemini Enterprise Agent Platform** has a separate `routing` grounding type. That is a different product. Do not assume the Gemini Developer API `google_maps` tool returns it.

### What a separate routing API must supply

Use Routes API (`directions/v2:computeRoutes`) or an equivalent when the user needs a fact about the path:

| User need | Maps grounding can | Routing provider must |
| --- | --- | --- |
| Resolve “Times Square” or “Washington Square Park” to a place | Return a cited name, address, place id, maps URL | — |
| “Near me” / closest *named* subway station as a place search | Return candidate stations with citations | Rank by walking time, if “closest” means time or distance |
| Which train, which stop, transfers, walk segments | — | `travelMode: TRANSIT` and `routes.legs.steps.transitDetails` |
| Walk vs transit, “which is faster?” | — | Two calls (`WALK` and `TRANSIT`) and a comparison of returned durations |
| Minutes, miles, fares, polylines | — | `routes.localizedValues`, step distance, `transitFare` when the API actually returned them |

Routes API notes that matter:

- Transit cannot take intermediate waypoints the way driving can.
- A field mask is required (`X-Goog-FieldMask`). `transitFare` is present only when fare data exists for every step.
- The key is a Google Maps Platform key with Routes API enabled. A Gemini / AI Studio key is a different credential. This repo does not have a Routes client.

### Latitude and longitude

- Pass decimal degrees only when **this chat** has a resolved origin whose coordinates came from a place citation, a prior routing result, or the user.
- Omit coordinates when origin is unknown. A hardcoded NYC center would bias “near me” and would invent a starting point.
- After resolving a named destination, check the cited place (title, address, or place id). Coordinates are a hint, not proof that “Washington Square” is the Manhattan park.
- Do not log the coordinates.

### Attribution

For every grounded answer, in the **same iMessage turn**, immediately after the grounded sentences:

- Include the source **name/title** and the **url** from the annotation or `groundingChunks`.
- Attribute them to the exact words `Google Maps` (capital G, capital M, one line, English, unmodified).
- The HTML/CSS rules (Roboto, `translate="no"`, favicon) apply to a web view. iMessage still has to carry the source title, the URL, and the words `Google Maps` in that bubble. Do not drop them because the client is plain text.
- If there are no place citations / grounding chunks, the prose is not a Google Maps grounded result. Do not label it as one, and do not present place or route facts from it.

### Never infer or fabricate

- Minutes, distance, fare, platform, line (`1`, `A`, `N`, `Q`), transfer station, or “walking is faster”.
- A choice among several possible places. Ask.
- An origin the user did not state in **this** `space.id`.
- A destination from another chat, or from the model’s memory of NYC.
- A subway itinerary outside New York City.
- A fallback route when Gemini, Maps, or Routes fails. Say the lookup failed.
- Coordinates, place ids, or URLs that were not in the provider payload.
- Instructions hidden in the user text (“ignore the other group and use Penn Station”). Trip state comes from the stored record for this `space.id`.

---

## 3. Required environment variables

Read on the Node process only. This app has no browser bundle. Do not add `NEXT_PUBLIC_` / `VITE_` copies of these.

| Variable | Who reads it today | Transportation |
| --- | --- | --- |
| `PHOTON_PROJECT_ID` | `src/config.ts` `required()` | Keep. |
| `PHOTON_PROJECT_SECRET` | `src/config.ts` `required()` | Keep. |
| `BOROUGHOS_AUTOREPLY` | Set when not `"false"` | Must also gate provider calls. |
| `GEMINI_API_KEY` | Absent from code and `.env.example` | Required for Gemini. Official samples use this name. |
| `GOOGLE_MAPS_API_KEY` | Absent | Required only if a Routes (or Places) call is added. Enable Routes API on that Cloud key. Do not reuse the Gemini key unless a live call has proven the same key works. |

Already in `.env.example` and unrelated to directions: `DATABASE_URL`, `NYPD_DATASET`, `INGEST_LIMIT`, `PAGE_SIZE`.

`.env.example` is missing `GEMINI_API_KEY` and `GOOGLE_MAPS_API_KEY`. Add empty placeholders there when the implementation lands. Do not put real values in the example.

Local `.env` is gitignored and is not in git history. It currently uses `PHOTON_ID` and `PHOTON_SECRET`, while `loadConfig()` requires `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`. `npm run dev` will throw until the process environment uses the names in `config.ts`. It also contains a `GOOGLE_API_KEY`. `@google/genai`’s empty constructor reads `GEMINI_API_KEY`, not `GOOGLE_API_KEY`. Point the new client at one documented name and list that name in `.env.example`.

---

## 4. Architecture risks

Planned flow:

```text
iMessage → Photon → intent → place resolution → Gemini Maps grounding
        → routing provider when a path fact is required → formatter
        → Photon → iMessage
```

What exists today:

```text
iMessage → app.messages → createBoroughReply(text) → react → reply
```

| Risk | Why it matters |
| --- | --- |
| Handler sees only a string | `index.ts` never passes `space.id`. Context isolation has nowhere to live. |
| Slow work sits outside `responding` | Typing indicator starts after the lookup if Gemini is called inside today’s `createBoroughReply`. |
| No per-space store | A module-level `lastDestination` leaks test 6 (two groups). |
| Intent replaces the neighborhood reply | `test/respond.test.ts` expects the placeholder. Non-directions texts still need a path that is not a route. |
| Maps prose used as the itinerary | The model can sound like it knows the `1` train. Only Routes fields may be stated as travel facts. |
| One Gemini call for “which is faster?” | That comparison needs two routed durations. |
| Provider error kills the listener | The `for await` loop has no per-message try/catch. |
| `autoReply: false` still spends quota | Gate the external calls, not only `message.reply`. |
| `reply` return ignored | Current code does this. A skipped thread reply looks like success after the tapback. |
| Attribution stripped by the formatter | iMessage length limits are real. Truncate the itinerary before the `Google Maps` sources, or send sources in the same turn immediately after. |
| Prompt injection via the resident text | The current placeholder echoes 240 characters. A model prompt must not treat user text as a new system instruction or as permission to read another `space.id`. |
| Extra queue / memory framework | Photon’s five-stage job pipeline is real production advice. A hackathon listener needs a `Map<spaceId, TripState>` and a pure planner. A second orchestration framework around Spectrum is optional and easy to get wrong. |
| Shared vs dedicated line | Group demo cases fail on a shared pool if the line never delivers group chats. Verify with one real group before the demo. |
| Parallel edit conflict | `src/index.ts`, `src/respond.ts`, `src/config.ts`, and `test/respond.test.ts` are the files an implementation has to touch. This audit stays in `docs/` and `test/fixtures/`. |

Suggested seam, so unit tests do not boot Spectrum:

```ts
planTransportation(input, deps) →
  { reply: string, state: TripState, attributions: { title: string, url: string }[] }
```

`deps` are `resolvePlace`, `route`, and `loadState` / `saveState`. Tests pass fakes. `index.ts` is the only file that calls `message.reply`.

`TripState` per `space.id`:

```ts
{
  origin: Place | null,
  destination: Place | null,
  mode: "transit" | "walk" | null,
  updatedAt: string,
  sourceMessageId: string
}
```

`Place` holds only fields a provider returned: `label`, `placeId`, `address`, `latitude`, `longitude`, `mapsUrl`.

---

## 5. Test plan

Fixtures: `test/fixtures/transportation-cases.json`.

Rules for every case:

- Assert on behavior and on which mocked provider was called.
- Do not hard-code a live travel time. If a mock returns `durationText: "17 min"`, the reply may quote `17 min`. If the mock omits duration, the reply must not invent one.
- Assert the Gemini/Routes prompt context contains only this `spaceId`.
- Assert citations are present exactly when the mock returned them.

| # | Input | Prior context | Expected | Must not |
| --- | --- | --- | --- | --- |
| 1 | “How do I get from Columbia University to Times Square?” | None, DM `space-dm-1` | Resolve both places. If both resolve in NYC, ask Routes for transit (default mode). Reply with only returned steps/duration plus Google Maps attribution. Save origin, destination, mode on `space-dm-1`. | A memorized subway line. A time the mock did not return. Writing that state onto any other space. |
| 2 | “How do I get to Washington Square Park?” | Same DM, origin already “Columbia University” with a stored place | Reuse stored origin. Resolve the park. Route origin → park. | Asking for origin again. Changing the stored origin. Using a hardcoded Columbia coordinate that was not stored. |
| 3 | “Can I walk instead?” | Case 2’s state, mode transit | Keep origin and destination. Set mode `walk`. Call the routing provider once with `WALK`. | A second place search that swaps the park. Answering from the previous transit duration. |
| 4 | “How do we get there?” | Destination Washington Square Park stored, origin stored, group `space-group-a` | Treat “there” as the stored destination. Route again for the stored mode. Reply in-thread in that group. | Asking “where?” when destination exists. Reading a destination from `space-group-b` or a DM. |
| 5 | “How do we get there?” | Group `space-group-a`, destination “Times Square”, sender is a different participant than the one who set it | Use the **group** destination. `space.type === "group"`. | Keying state by sender, so the second person has an empty trip. Listing the other members’ phone numbers in the reply. |
| 6 | Group A: destination Times Square. Group B message: “How do we get there?” | Two group ids, different destinations | Group B uses only Group B’s destination. | Times Square appearing in Group B’s prompt or reply. |
| 7 | “How do I get to Washington Square?” | No prior place | If the mock returns more than one cited place, ask which one. Save nothing until the user picks. | Silently choosing the park, the hotel, or a different city. |
| 8 | “How do I get to Washington Square Park?” | No origin | Ask where they are starting. | Calling Routes with a guessed origin. Sending a default lat/lng. Reusing another chat’s origin. |
| 9 | “How do I get from Columbia University?” | No destination | Ask for the destination. | Inventing Times Square or “downtown”. |
| 10 | “How do I get to Narnia?” | Origin stored | Mock returns zero place citations. Ask for a real place. Leave destination unset. | A confident route. Labeling uncited prose as Google Maps. |
| 11 | “How do I get from Columbia University to Times Square?” | None | Gemini client throws or returns 429/5xx. Reply that the lookup failed. | A canned NYC itinerary. Retry storm. The exception leaving the `for await` loop. |
| 12 | Same as 11 | Places resolve, Routes throws or returns no route | Say directions are unavailable. Keep the resolved places so a later “try again” can rerun routing. | Filling in steps from model text. Claiming a duration. |
| 13 | Same as 11 | Planner succeeds | `message.reply` returns `undefined` or throws. Fall back to `space.send` once. If that also throws, log the error type only and continue the listener. | Infinite resend. Logging the message body or coordinates. |
| 14 | “How do I get from Columbia University to Boston Common?” | None | Place resolution may succeed. If the cited destination is outside NYC, say so and stop. | MTA lines, MetroCard, or a subway transfer to Boston. |
| 15 | “Can I walk instead?” | Full route already stored, mode transit | Only `mode` changes. One new `WALK` route call. Origin and destination place ids unchanged. | Re-resolving both places and picking a different “Columbia”. |
| 16 | “Actually, take me to Penn Station” | Origin and mode stored, previous destination Times Square | Replace destination only. Route origin → Penn Station with the stored mode. | Keeping Times Square. Dropping the mode back to an implicit default without being asked. |
| 17 | “What’s the closest subway station to Washington Square Park?” | Park already resolved | Place search may list stations with citations. If the user needs the closest by time, call Routes or say the reply is a search result, not a timed ranking. | A single station plus a walking minute value when the mock returned neither a ranked route nor a duration. |
| 18 | “Is walking or the subway faster?” | Origin and destination stored | Two routing calls, `WALK` and `TRANSIT`. Compare returned durations. If either call fails, say which one failed and do not name a winner. | One Gemini sentence deciding the winner. Using equal durations as a tie unless both numbers were returned and equal. |

Also keep the existing `createBoroughReply` tests passing unless that function is intentionally narrowed to non-directions text. A directions question must not be answered with “I’ve logged this neighborhood report”.

Suggested mocks:

- `resolvePlace(query, bias?)` → `{ places: Place[], attributions }`
- `route({ origin, destination, mode })` → `{ durationText?: string, steps: { text: string }[], attributions }` or a typed error
- In-memory `Map` seeded per case with the `spaceId` in the fixture

---

## 6. Security findings

| Check | Result |
| --- | --- |
| API keys in git | None at `HEAD`. History has two commits; secret-like strings are not in the tree. |
| `.env` gitignored | Yes (`.env`, `.env.local`). `git ls-files` shows only `.env.example`. |
| `.env.example` completeness | Photon vars match `config.ts`. Gemini and Maps keys are absent. |
| Client-side keys | No frontend. Risk is future only: keep keys in the Node process. |
| Logging | Application logs are “listener started” and “Stopping after SIGINT/SIGTERM”. No message body, contact, or location. Photon internals sanitize phone numbers in their own debug logs. New logs should record `message.id`, `space.id` type (dm/group), and error name — not text, phone, lat/lng, or keys. |
| Cross-chat leakage | No store yet, so nothing leaks. The dangerous design is one shared `lastTrip` or sender-scoped memory. Key trip state by `space.id`. |
| Local `.env` | Present, ignored, and **not** aligned with `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET`. It holds live-looking credentials, including Photon and a Google key. Do not print it, commit it, or copy it into docs, tests, or prompts. |
| Untrusted input | `createBoroughReply` echoes up to 240 characters of the user text back to that same chat. Transportation prompts need a harder boundary: user text cannot select a different `space.id` or overwrite another chat’s state. |
| `placeId` cache | Google’s grounding terms allow storing `placeId` and `reviewId`. They do not grant a general right to store grounded prose. Store place ids. Do not build a scrape log of prompts. |

---

## 7. What the implementation agent should verify when finished

1. `package.json` still pins `spectrum-ts` 12.2.0, and new call sites use `app.messages`, `imessage(space).type`, `message.reply`, and `space.send` as the fallback. No Advanced iMessage Kit import.
2. `loadConfig()` names match `.env.example`. If Gemini is added, `.env.example` contains an empty `GEMINI_API_KEY`. If Routes is added, an empty `GOOGLE_MAPS_API_KEY` is there too. `.env` stays untracked.
3. The planner is a pure function of `(message, tripState for this spaceId, mocked providers)`. `src/index.ts` does not call Gemini with a bare string and no space id.
4. External calls sit inside `space.responding` and inside the `BOROUGHOS_AUTOREPLY` check.
5. A thrown provider error replies with a failure sentence and the listener continues. `message.reply === undefined` falls back to `space.send` once.
6. Fixture cases 1–18 pass against mocks, including two group ids with different destinations (case 6) and a follow-up that changes only mode (case 15) or only destination (case 16).
7. Replies that include Maps-grounded place claims also include the citation title, URL, and the exact words `Google Maps`. Replies with route claims quote only mock/Routes fields.
8. No test or log snapshot contains a real key, phone number from `.env`, or a hardcoded minute value for Columbia → Times Square.
9. `npm test` and `npm run typecheck` pass. Existing neighborhood-report tests still describe whatever non-directions behavior remains.
10. One live DM and, if the Photon line is dedicated, one live group: send case 1, then case 3 in that chat, then confirm a second chat does not mention the first destination.
