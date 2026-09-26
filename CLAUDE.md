# Four-Person “Around Me” Agent Build Plan

## Summary

Build one iMessage agent with Gemini acting as the router between four independent skills:

| Owner | Skill | Responsibility |
|---|---|---|
| Alan | `get_safety` | Tiger Data + NYPD history around a location and time |
| You | `find_events` | Nearby activities and public events |
| Keith | `find_food` + orchestration | Restaurants, user-intent parsing, final Gemini response |
| Rohan | `get_route` | Google Places/Routes results and Google Maps links |

The user can ask one focused question or a combined request:

- “Is it safe around me?” → safety only.
- “Where should we get dinner?” → food.
- “What fun stuff is nearby tonight?” → events.
- “How do I get to this place?” → route.
- “Plan a fun and safe night near Columbia” → events + food + safety + route.

## Shared Pipeline

```text
iMessage
   ↓
Photon Spectrum listener
   ↓
Message + shared-location extraction
   ↓
Gemini structured intent parser
   ↓
Skill dispatcher
   ├── Alan: safety → Tiger/NYPD
   ├── You: events → Tiger/NYC Open Data + Tavily
   ├── Keith: food → Google Places + Gemini ranking
   └── Rohan: route → Google Routes API
   ↓
Gemini grounded response composer
   ↓
Short iMessage reply + Google Maps links
```

### Request processing

1. Photon receives the message and records the chat’s last shared location.
2. Gemini converts the message into a strict `UserIntent` object.
3. The dispatcher calls only the requested skills.
4. Independent skills run in parallel when possible.
5. If food or events produce destinations, Rohan’s route skill runs afterward for the selected or highest-ranked destination.
6. Gemini composes the final answer using only returned tool data.
7. Photon sends one concise response; individual skills never send messages themselves.

### Structured intent

```ts
type UserIntent = {
  needs: Array<"safety" | "food" | "events" | "route">;
  origin?: Location;
  destination?: Location;
  when: string;
  budget?: "free" | "low" | "medium" | "high";
  categories: string[];
  cuisine?: string[];
  travelMode: "WALK" | "TRANSIT" | "DRIVE" | "BICYCLE";
  maxTravelMinutes?: number;
  needsClarification: boolean;
  clarificationQuestion?: string;
};
```

If location is unavailable, the agent asks one question and does not call the tools.

## Skill Contracts and Ownership

### Common contracts

```ts
type Location = {
  label: string;
  latitude: number;
  longitude: number;
};

type Source = {
  name: string;
  url?: string;
  updatedAt?: string;
};

type SkillResult<T> = {
  status: "ok" | "partial" | "unavailable";
  data: T;
  sources: Source[];
  warnings: string[];
};
```

All skills receive structured input and return structured results. They must not call Photon, format the final response, or inspect unrelated environment variables.

### Alan: safety

- Keep the existing Tiger/NYPD implementation.
- Accept coordinates and requested hour.
- Return complaint counts, time-of-day comparison, common report categories, and source timestamp.
- Do not return a “safe/unsafe” score or predict individual danger.
- Preserve the distinction between historical reports and live conditions.

### You: events and activities

- Ingest NYC Parks’ daily upcoming-events dataset `w3wp-dpdi`, which includes event times, categories, links, park names, and coordinates. [Official dataset](https://data.cityofnewyork.us/City-Government/NYC-Parks-Public-Events-Upcoming-14-Days/w3wp-dpdi)
- Add NYC permitted events `tvpp-9vvx` for fairs, festivals, parades, and public gatherings.
- Normalize them into a `city_events` Tiger table.
- Use Tavily only to enrich or supplement current results; official datasets remain authoritative.
- Implement:

```ts
findEvents({
  origin,
  from,
  to,
  radiusMeters,
  categories,
  budget
}): Promise<SkillResult<EventRecommendation[]>>
```

- Return a maximum of five events ordered by time fit, distance, freshness, and category match.

### Keith: food and Gemini router

- Own the central intent parser, dispatcher, and final response composer.
- Use Google Places Text Search for factual restaurant candidates.
- Use Gemini to rank candidates based on cuisine, budget, group preferences, time, and recent conversation.
- Return place IDs and coordinates so Rohan can route reliably.
- Never let Gemini invent a restaurant, event, operating hour, route, or safety statistic.
- The shared Gemini key belongs only in each developer’s local `.env`; sharing a key does not require multiple Gemini clients or multiple orchestration systems.

### Rohan: routing

- Use Google Routes API with the origin and destination coordinates/place ID.
- Return travel mode, duration, distance, short route summary, and Google Maps directions URL.
- Support walking and transit first; driving and cycling are secondary.
- If Routes fails, return a Google Maps directions URL without claiming an exact duration.

```ts
getRoute({
  origin,
  destination,
  travelMode,
  departureTime
}): Promise<SkillResult<RouteResult>>
```

## Repository and Team Workflow

Keith is the integration owner because the router belongs with the Gemini orchestration layer.

1. Everyone updates from the latest `origin/main`; the current local checkout is behind the team branch.
2. Keith first merges the common types, tool interfaces, dispatcher skeleton, and all required environment-variable names.
3. Each teammate branches from that contract commit:
   - `alan/safety-tool`
   - `events/events-tool`
   - `keith/router-food`
   - `rohan/routes-tool`
4. Alan, you, and Rohan add isolated tool modules and tests. Do not modify `src/index.ts` or the final prompt.
5. Keith integrates the tools into the existing Photon listener.
6. Merge tools individually only after their contract tests pass.
7. Run the full prompt-routing suite after every merge.

Use one Photon listener and one Gemini router. Avoid four bots, four competing prompts, or four modules editing the chat loop.

## Response Policy

- Focused questions return only the requested information.
- Broad planning questions may invoke all relevant skills.
- “What should we do?” invokes food and events; after ranking, add safety context and a route for the top choice.
- Replies contain at most three recommendations.
- Each recommendation includes why it fits now and a source or Maps link.
- Safety appears as a short contextual note, not the headline unless explicitly requested.
- If a tool fails, return available results and disclose the missing component instead of failing the whole request.

Example:

```text
Tonight near Columbia:

1. Outdoor movie at Riverside Park — 12 min walk, free, starts 7:30.
2. Dinner at Jin Ramen — open now, about $20/person.
3. Then walk south along Riverside Park.

Historical reports near the event are lower at 7 PM than the area’s nightly peak.
Route: 18 min total → maps.google.com/...
```

## Sponsor Story

- **Photon:** the real multi-user iMessage interface.
- **Tiger Data:** NYPD time-series safety data plus the searchable event index.
- **Gemini:** intent parsing, skill routing, preference-aware ranking, and grounded response composition.
- **Google Maps Platform:** factual places and real routes.
- **Tavily:** fresh web enrichment for events, if its prize is confirmed.
- **DigitalOcean:** deploy the long-running Photon worker and scheduled ingestion jobs.
- **Main track:** Hack the City.

Do not add unrelated financial, blockchain, memory, voice, or secondary-database sponsors before this end-to-end flow works.

## Tests and Acceptance Criteria

- Routing tests cover safety-only, food-only, events-only, route-only, combined-night-plan, and missing-location prompts.
- Every tool has mocked success, empty-result, timeout, and partial-result tests.
- Gemini output may reference only IDs returned by skills.
- Events are deduplicated across official data and Tavily.
- Restaurant results contain a Google place ID or coordinates before routing.
- Exact user coordinates and phone numbers are not written to Tiger analytics.
- End-to-end demo passes when one iMessage location and prompt produce:
  1. a real activity or restaurant,
  2. sourced safety context,
  3. a real travel duration,
  4. a working Google Maps link,
  5. one concise Photon response.

## Assumptions

- The judging experience is iMessage-first; no custom web dashboard is required.
- Google Routes and Places APIs are enabled on the team’s billed Google Cloud project.
- Keith owns final integration, while all teammates may use the shared local Gemini credential.
- Photon remains the only component allowed to send user-visible replies.
- The existing remote `main` implementation is the starting point, not the older local checkout.