# Jev perception (optional)

Jev is TypeSafe's fast System One model. It answers typed questions instead of writing text. The bridge asks Jev three questions about the current facts every 500 ms. Jev only observes. It is never told a goal and never picks a step; deciding is the planner model's job.

- `situation`: where the bot is, one of `on_flat_ground`, `on_tree`, `on_steep_ground`, `in_water`, `in_cave`, `boxed_in`, `other`. It is judged from `facts.surroundings` (what the bot stands on, and per compass side the block below, whether it is open below, and the body and head blocks) plus `y` and `nearest_blocks`.
- `heard_threat`: what the bot just heard, one of `none`, `creeper_fuse`, `explosion`, `hostile_nearby`, `other`. It is judged from `facts.sounds` (the last 3 s). Like the others it is an observation only; the planner model's `threat_policy` decides what to do about it.
- `danger`: the chance, from 0 to 1, that a hostile mob or lava is a threat right now.

The answers show up as `jev` in `GET /api/observation`, next to `facts`. `jev.hints` holds `situation`, `situation_confidence`, `heard_threat`, `danger` and `nearest_hostile`. They are observations only. When `jev.stale` is true, the planner should use `facts` alone.

## Turn it on

Set `AGENT37_JEV=1` and the Jev key in the bridge's environment, then start the bridge. Without both, Jev stays off and nothing changes. `JEV_MODEL` defaults to `jev-latest`.

## Limits

- The loop runs on its own timer with one request in flight, so it never holds up the 50 ms control tick.
- Each request times out after 400 ms. A failure keeps the last hints and counts in `jev.errors`.
- Jev bills per input token, so the state sent is a trimmed copy of `facts`.

API docs: https://docs.typesafe.ai

## Sounds

`facts.sounds` lists what the bot heard in the last 3 s, newest first, up to 8, like Minecraft's subtitles. Each entry has `name`, `category` (hostile, block, weather...), `source` (the mob standing where the sound played, if any), `direction` relative to where the bot faces (front, behind, left, right, plus above or below) and `distance`. Jev sees the list too, so a groan behind a wall can raise `danger`.

`name` is the real Minecraft sound when the packet carries a registry id (for example `entity.creeper.primed`), resolved from the 1.21.1 data with the packet's 0-based index. Mineflayer's own lookup is one entry early. A sound that cannot be resolved falls back to `<category>:<mob standing there>`.

Jev is too slow for a creeper fuse (about 1.5 s). The planned runner reads `entity.creeper.primed` straight from the sound packet through `createSoundTracker().subscribe` and starts the model's `creeper_fuse` rule at once, without waiting for Jev or the model. `heard_threat` is for the model's picture of the situation, not the reflex.
