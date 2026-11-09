# Planner

A slow model plans first, then does one objective at a time. Jev only reports what it sees: every 500 ms an observation (`situation`, `heard_threat`, `danger`). The prompt says these are observations, never instructions. The planner is off by default and separate from `eval/chain.mjs`. Mineflayer, through the arbiter, is the model's only way to act. No server command is used once it is deciding.

The model's reply is untrusted text, parsed strictly. An unknown type, skill, primitive, assist, rule or field is rejected. The rejection names the reason and the valid names, and the planner asks again. A run ends only after 3 invalid replies in a row for one decision (`invalidReplies`). Nothing the model writes is run or loaded as code.

## Plan, then one objective at a time

1. The first decision is `{ type: "plan", objectives, threat_policy }`: 1 to 15 objectives, each `{ id, description, done, reasoning }`. `done` is exactly one of `{ have: { item, count } }` (`item` may be `any_log` or `any_planks`), `{ dimension: "the_nether" }`, or `{ placed: { block } }`. A `have` objective must show its arithmetic. The recipe table uses real item names (`acacia_log` makes `acacia_planks`).
2. Every action carries `"objective": "<current id>"`. The runner, not the model, decides an objective is done, by checking `done` against the real observation.
3. `{ type: "revise_plan", why, objectives }` replaces the plan, at most 3 times, each logged under `plan.revisions`. `done` ends the run; with objectives left it is recorded as `gave_up`.

## Threats are the model's decision

`threat_policy` is `{ <rule>: { action: fight|flee|ignore, flee_distance: 4-32, min_health?: 1-20 } }`. Rules are the mob groups `zombie_like`, `skeleton_like`, `creeper`, `spider_like`, `enderman`, `other_hostile`, plus a required `creeper_fuse`. `min_health` is for `fight` only: below it the rule flees. `{ type: "set_threat_policy", policy, why }` replaces it at any time, logged under `threat.policy_changes` (`THREAT_POLICY_SET`).

A model call takes about 3 s, too slow for a hit or a fuse. So the runner applies the model's own rule at once and pauses the running skill. Triggers: a hostile within 8 blocks whose rule says fight or flee, the bot being hit, a creeper fuse. Then it makes one model call (`trigger=threat_response`) with `threat_report` saying what happened. A decision that was in flight meanwhile is discarded. These are the bot's own moves, never assists.

The fuse is read straight from the sound packet (`entity.creeper.primed`, resolved from the 1.21.1 registry in `sounds.js`), not from Jev. The `creeper_fuse` rule starts inside the packet handler; `reaction_ms` is logged per event. Each mob is reacted to at most once per 10 s, a hit once per 3 s.

## Moves

`resource.collect_wood {count}`, `combat.kill_hostile` (only zombies are trained), and primitives through the bot adapter and arbiter only, never RCON. Each returns `{ outcome, reason, moved, dug }`:

- `walk`, `dig`, `jump`, `wait`, `equip`, `place`, `use_on` as before.
- `craft {name, count, table?}`: a real name. `planks` alone resolves to the planks of the logs held. Fails at once with the right name if the wood does not match.
- `attack {mob_id}`: hostile only. Faces the mob, walks into reach, swings paced by the 1.21 cooldown, takes the best sword or axe. Ends when the mob is gone, at 15 s, or below the rule's `min_health`.
- `flee {from_mob_id | away_from:{dx,dz}, blocks}`: sprints directly away, jumps when blocked. At most 32 blocks and 15 s.

## When the model is asked

After a plan, an action, an objective, a policy change or a threat response. A running skill is interrupted when Jev's `danger` crosses up through 0.5 (`jev_danger`), or a hostile the policy ignores comes within 8 blocks (`hostile_close`). Calls are at least 5 s apart, except after an action ends.

## Run

```
node eval/planned.mjs (--live | --ci) --start X,Z --model haiku|sonnet|<id> [--minutes M] [--unstuck] [--mob-watch] [--jev] [--allow-assists] [--reset-advancements]
```

Live runs need loopback hosts and a bot on the runner's allow-list. The model runs through `claude -p` with no tools and an allow-listed environment that never holds the Jev key or the RCON password. Planned runs set the arbiter's `retreatHealth` to 0 (default 4 elsewhere), so the forced retreat does not take control from the model.

Output: `eval/results/planned-<timestamp>.json`, `PLAN`, `THREAT`, `OBJECTIVE done` and `SUMMARY` lines. `PASS` only with the Nether reached and zero assists, watchdog actions and fallbacks. Limits: 10 minutes by default (15 max), 120 decisions, 200000 tokens.
