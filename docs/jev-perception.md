# Jev perception (optional)

Jev is TypeSafe's fast System One model. It answers typed questions instead of writing text. The bridge can ask Jev two questions about the current facts every 500 ms:

- `next_goal`: which Nether step to work on next (wood, iron, obsidian, lava_water, portal, none).
- `danger`: the chance, from 0 to 1, that a hostile mob or lava is a threat right now.

The answers show up as `jev` in `GET /api/observation`, next to `facts`. `jev.hints.where` points the chosen goal at the nearest matching block. The hints are only suggestions. When `jev.stale` is true, the planner should use `facts` alone.

## Turn it on

Set `AGENT37_JEV=1` and `JEV_API_KEY` in the bridge's environment, then start the bridge. Without both, Jev stays off and nothing changes. `JEV_MODEL` defaults to `jev-latest`.

## Limits

- The loop runs on its own timer with one request in flight, so it never holds up the 50 ms control tick.
- Each request times out after 400 ms. A failure keeps the last hints and counts in `jev.errors`.
- Jev bills per input token, so the state sent is a trimmed copy of `facts`.

API docs: https://docs.typesafe.ai
