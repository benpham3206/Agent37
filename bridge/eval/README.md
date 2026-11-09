# Skill registry and evaluation runner

This adds the first registry and repeatable test runner for Skills & Testing.
It follows the seven fields in `docs/skill-format.md`; that document is unchanged.
The JSON details below are this runner's first implementation, not a change to the team template.

## Run the test-only example

From the repository root:

```bash
cd bridge
npm ci
npm test
node eval/run.mjs --skill test.noop --trials 3 --ci
```

The shorter form is `npm run eval -- --skill test.noop --trials 3 --ci`.
The output is `bridge/eval/results/test.noop--v1.json`, with three trial rows and an
`evaluation` summary. `synthetic: true` means no Minecraft behavior was measured.
Results and live session files are ignored by Git. A later run of the same version
replaces that results file; save a separate copy before repeating a run you need to keep.

`npm test` includes a CLI integration test, so the existing CI workflow also runs
the three-trial check. No workflow change or new package is needed. A CLI run exits
with a nonzero status if a trial fails, times out, or the setup is invalid.

## Where a skill goes

Each version has its own folder:

```text
bridge/skills/test.noop/v1/skill.json
bridge/skills/test.noop/v1/index.js
```

`skill.json` must have exactly `name`, `version`, `implementation`, `requirements`,
`success_check`, `reset_steps`, and `evaluation`. Unknown details stay `null`.
A skill can be stored with unknown details, but it cannot run until the required
implementation, reset steps, and success check are supplied.

This runner supports JavaScript adapters: `implementation` is
`{"type":"code","artifact":"index.js","entry_point":"run"}`. A model needs a
code adapter that loads it using the existing model and policy contracts. The
runner does not load ONNX files by itself or replace the combat evaluation path.

The exported function is:

```javascript
export async function run(bot, input, { signal }) {
  signal.throwIfAborted();
  const started = performance.now();
  const before = bot.observe();
  // Request actions through bot.requestAction(action), not raw Mineflayer calls.
  return {
    outcome: 'success', reason: 'goal_reached',
    elapsed_ms: performance.now() - started,
    before, after: bot.observe(),
  };
}
```

The bot argument is a small adapter, not the raw Mineflayer bot. It exposes
`observe()`, `requestAction(action)`, and `releaseControls()`. Requests go through
the existing arbiter. Available live actions are limited to the existing bridge;
this work does not add digging or inventory-control actions. Skills must check
`signal` and stop when canceled. The runner blocks later action requests after
cancellation, but cannot interrupt synchronous JavaScript that blocks Node itself.

## Conditions and resets

`success_check.time_limit_ms` is a positive integer in milliseconds.
`success_check.condition` uses an observation path and either `equals` or
`increase_by`. For example, `{"path":"inventory.oak_log","increase_by":1}`
checks that the item count increased since the trial began. Missing or null
observations do not count as success. The runner checks the outcome against
observations instead of trusting the returned success label alone.
When a complete inventory was observed, an absent item has count zero. If the
inventory itself is unavailable, the count stays unknown.

`reset_steps` is an ordered array. A live step has one `command` and a `verify`
condition, such as:

```json
{
  "command": "tp {username} 0 64 0",
  "verify": { "path": "self.position", "equals": { "x": 0, "y": 64, "z": 0 } }
}
```

Use only team-approved commands and positions in an approved test world. The
runner checks each step before moving on. Failed resets are failure rows and do
not launch the skill. Reset has a 30-second bound; each verification has a
5-second bound. CI does not run commands; it restores the same small fake state.

Death, execution errors, disconnection, emergency stop, and human takeover are
failures. A skill exceeding its time limit is a timeout. Cleanup releases controls
on every path. Human interventions count interrupted trials, not keyboard packets.

## Candidates and the active version

`active.json` maps each skill name to its active version. It starts empty.
`load(name, version)` reads a candidate or old version. `get(name)` reads only
the version named in `active.json`; it does not pick the newest folder.

Use `--version N` to evaluate a candidate. Without it, the runner uses the active
version. The only exception is `test.noop` in CI, which loads its bundled v1
fixture without putting synthetic work in the active registry.

`activate(name, version)` requires matching evaluated-version metadata, at least
20 trials, at least 16 successes, consistent result counts, zero human
interventions, and `synthetic: false`. Unknown synthetic status is refused too.
Combat skills are refused here: they still need the separate combat approval path.
Older folders are kept so results can be traced and an evaluated version restored.

The runner writes results but does not edit `skill.json` or activate anything.
The team must review real results and add the matching `evaluation` record to
the candidate before activation. Metadata is a team-reviewed record, not proof
against someone manually inventing results. Baseline stays `null` if none was supplied;
this runner does not run a second baseline automatically.

## Live testing

Do not use the shared world without the lead's approval. This command is intended
for an approved test world with seed `37001`; the runner checks the server's seed.
It needs a non-test skill with reviewed reset commands and observable checks.

Set these locally, never in committed files:

- `A37_MC_HOST`, `A37_MC_PORT`, `A37_MC_VERSION`
- `A37_EVAL_USERNAME` (a unique, whitelisted bot name)
- `A37_RCON_HOST`, `A37_RCON_PORT`, `A37_RCON_PASSWORD`
- `A37_EVAL_APPROVED_RESET=1` only after approval
- Optional: `A37_EVAL_WEB_PORT` for the local control page

Then use `node eval/run.mjs --skill NAME --version N --trials 20 --live`.
The control page binds to localhost. Live mode reuses the existing bridge runtime
and listens for its human-control messages. No live run is required for the CI
fixture, and a passing CI run is not evidence that a real skill has learned anything.

## Run the continuous Nether chain

Run `node eval/chain.mjs --ci --runs 3` for synthetic reporting checks.
For the approved local team world, use `node eval/chain.mjs --live --runs 3 --hold-minutes 60`
with the live environment settings above. `A37_EVAL_USERNAME` selects the bot and accepts
only `Vikram_bot` or `Ben_bot`. Add `--start=X,Z` with finite coordinates to center the run
on a chosen spot, for example `--start=-8048,-7984` at the ruined portal site. Without
`--start` the runner keeps the default region around x=11000, z=5000.
Live runs also need `A37_RCON_PASSWORD`, `A37_EVAL_SEED` (the approved world's seed, kept out of
this repo), and optionally `A37_E2E_RESULTS` for the copy of each live report (default `e2e-results/`).
The same settings drive `e2e/portal.e2e.mjs`, `e2e/iron.e2e.mjs` and `e2e/wood.e2e.mjs`.
A local launcher script sets them and passes `-Start 'X,Z'`, `-Bot`, `-Unstuck` and `-MobWatch` through.
Live mode requires loopback Minecraft and RCON hosts, checks that the server reports `A37_EVAL_SEED`,
and serves the viewer at `http://127.0.0.1:3744/`. Keep the bridge control page closed during trials.

The ordered legs are spawn, wood, tools, iron, obsidian, light, and enter.
One bot retains its inventory and world between legs; skill `reset_steps` never run.
Failed natural attempts get a logged stage and retry, then a grant where specified.
Missing v1 skills produce `no_skill`; the unowned obsidian leg produces `no_owner`.
Neither staging nor grants count toward consecutive natural passes. `--no-assist` stops at the first natural failure.
`--unstuck` and `--mob-watch` are off by default. `--unstuck` arms a stuck watchdog during the
wood and iron legs; it teleports the bot to a verified safe spot after stillness, wandering, or a
hazard underfoot. `--mob-watch` arms a mob watchdog during the wood, iron, and light legs; it
kills a threatening hostile with `kill <uuid>`. Both tick about every 250 ms, act only inside the
approved region, and record every sent command in the row's `assistance` as `stuck_reset` or
`mob_removed`. Any watchdog command sets `watchdog_assisted` on the row and `assisted` on the
run, counts in `summary.watchdog` (`stuck_resets`, `mob_removals`, printed on the `E2E run`
line), and bars that leg from `unassisted_depth`; the first assisted leg sets `first_blocker` to
`watchdog_assist`. The launcher accepts `-Unstuck` and `-MobWatch`. Watchdog help is test-rig
assistance and never counts as a natural pass.
Each cooperative run is bounded to ten minutes. The launcher terminates a stuck process after
`runs * 10 + hold_minutes + 1` minutes; for the filmed command that bound is 11 minutes 30 seconds.
A five-minute video is the target, not a guarantee; a run can finish sooner or reach the bound.
Runs start in survival with an empty inventory. Without `--start`, retained live reports reserve
previous starts and at most 25 plots fit the default region. With `--start`, the approved area is a
radius of 400 blocks around the chosen point holding nine plots on a -240/0/240 offset grid,
center first. Stage blocks, the flattened obsidian pad, and the portal frame stay inside that
radius and at least 20 blocks from the chosen start point, leaving the ruined portal's natural
obsidian untouched; every placement is a logged command. A stage or frame that would cross either
limit is moved to a pad 40 blocks east of the chosen point first, with the move logged.

Reports go to `eval/results/chain-<timestamp>.json` and, for live runs, `A37_E2E_RESULTS/chain/`. Rows include observations, commands, assistance,
and scorer mismatches. Tick samples every 30 seconds help distinguish server lag from skill failure.
Each run prints PASS or FAIL. PASS requires all seven natural legs and a confirmed Nether dimension.
The final summary and process exit code reflect that result; missing work exits with code 1.
Attempt snapshots precede grants; each grant has its own before and after snapshots and scorer view.
Setup no longer teleports into the sky. The runner picks a plot at least 200 blocks from earlier
starts, sends `gamemode survival`, `clear`, and `execute in minecraft:overworld run spreadplayers`
naming only the selected bot, checks the reply, and retries when the server rejects a spread.
It still verifies the observed outcome: a grounded overworld position inside the plot, an empty
inventory, survival mode, loaded chunks, and settled facts. When every candidate is rejected or
never relocates the bot, setup fails with `no_safe_approved_plot`.
Wood and iron stages require a loaded target chunk, an accepted command reply, the expected block,
and facts selecting that target before the skill starts. Verification waits at most five seconds.
Failed setup produces `stage_failed:*`, `failure_type=stage_setup`, and `skill_started=false`.
Stage evidence includes command acceptance, target block probes, chunk state, facts, and terrain snapshots.
The natural wood leg requests five logs. Staging places a single oak_log and requests one
additional log beyond the current inventory, so prior partial collection cannot satisfy it.
The iron leg is invoked
without a descent input. The tools leg stays a logged grant until `crafting.craft_wooden_pickaxe` v1 exists.
The scorer reports resource readiness and can overstate obsidian and light; its view is not proof of completion.
Natural attempts after earlier assistance carry `upstream_assisted=true` and do not prove an unassisted chain.
`--hold-minutes` accepts fractions and keeps the bot connected and idle in its final observed
dimension, including the Nether for a run that arrived there.
Synthetic runs prove reporting behavior only. A missing entry skill cannot demonstrate a Nether crossing.
The CLI's synthetic mode records missing fixtures instead of running installed live skills.
