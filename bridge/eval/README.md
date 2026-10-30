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
