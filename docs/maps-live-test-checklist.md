# Maps live iMessage checklist

Use a phone on the Photon iMessage line. Run the listener with `GEMINI_API_KEY` set. Set `GOOGLE_MAPS_API_KEY` too if you want structured Routes durations. Do not paste keys into the chat.

In a group, mention the agent (`@Agent`). In a 1:1 chat, send the text as written.

After each reply, check:

- The reply is a short text, not JSON, a stack trace, or an API key.
- Travel times, subway lines, stops, fares, and walking distances appear only if they came from Maps. If the reply says it could not get route data, that is a failure of the happy path, not a license to invent.
- Origin and destination were not swapped.
- A second chat does not inherit this chat’s places.

## 1. Direct trip

Send:

`How should I get from Columbia University to Times Square?`

Inspect:

- Origin is Columbia University, not Times Square.
- Destination is Times Square.
- The reply includes a way to travel and a duration.
- It does not name a subway line or stop unless that detail is actually on the route.

## 2. Change mode

Send:

`Can I walk instead?`

Inspect:

- Origin is still Columbia University.
- Destination is still Times Square.
- The reply is about walking.
- The previous subway answer was not reused unchanged if a new lookup was required.

## 3. Change destination

Send:

`What about Washington Square Park?`

Inspect:

- Origin is still Columbia University.
- Destination is now Washington Square Park, not Times Square.
- A new route is described.

## 4. Compare the options already in the chat

Send:

`Which option is faster?`

Inspect:

- The comparison uses the Columbia → Washington Square Park trip from this chat.
- Times are the ones just returned, not a new invented pair.
- It does not switch the destination back to Times Square.

## 5. Context in a fresh chat

Start a new 1:1 thread so the previous trip is gone. Send these one at a time:

`I’m at Washington Square Park.`

Inspect: no route yet. It should not invent a destination.

`Let’s go to Katz’s.`

Inspect: Katz’s Delicatessen is remembered. It should not route yet unless you asked how to get there.

`How should I get there?`

Inspect:

- Origin is Washington Square Park.
- Destination is Katz’s Delicatessen.
- The reply does not use Columbia or Times Square from the earlier thread.

## 6. Group chats do not share a trip

Use two group chats.

Group A:

`We’re at Columbia.`

`Let’s go to Times Square.`

`@Agent how should we get there?`

Inspect: Columbia University → Times Square.

Group B:

`We’re at Washington Square Park.`

`Let’s go to Brooklyn Bridge.`

`@Agent how should we get there?`

Inspect:

- Washington Square Park → Brooklyn Bridge.
- The reply does not mention Times Square or Columbia.
- Group A does not mention Brooklyn Bridge if you ask it again.

## 7. Do not guess

In a third empty chat, send:

`How do I get to Central Park?`

Inspect: it asks where you are starting, or uses a location pin you actually shared. It does not pick a neighborhood for you.

Then send:

`How should I get there?`

in a brand-new chat with no destination.

Inspect: it asks where you want to go. It does not choose a famous place.
