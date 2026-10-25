# Skill Format

Status: Proposed for team review

A skill is a reusable behavior, such as fighting a zombie, reaching a location, or collecting an item. This format extends the existing [combat contract](https://github.com/benpham3206/Agent-37/blob/main/docs/combat-contract.md) so other workstreams can describe skills the same way. It proposes documentation and metadata; it does not add runtime support.

## Required information

Use snake_case for metadata fields. Record unavailable observations as `null`, rather than guessing a value.

| Field | What to include |
| --- | --- |
| `name` | A stable skill name and a short description of its behavior. |
| `version` | The skill revision. Keep previous versions so results can be traced and changes reversed. |
| `implementation` | Whether it uses code or a model; the exact artifact path and entry point or loader. For models, include the metadata path and artifact hash. |
| `requirements` | Starting conditions, equipment, allowed environment, and required observations. Define the inputs and outputs, including units or a link to their shared contract. |
| `success_check` | An observable condition that proves the goal was reached. Define failure conditions and a time limit too. |
| `reset_steps` | Ordered steps to restore the test area, bot state, inventory, and targets. Check that setup succeeded before starting another trial. |
| `evaluation` | Tested version, test settings, baseline, trial count, successes, failures, timeouts, human interventions, and a link to the results. Mark untested skills clearly. |

## Example: collect one oak log

This is an illustrative, unimplemented skill. Its requirements and 30-second limit are proposed test settings, not measured results.

- **Name:** `resource.collect_oak_log`: collect one additional oak log.
- **Version:** `1`.
- **Implementation:** Code; artifact path and entry point are pending implementation. It cannot run until these are supplied.
- **Requirements:** An approved test plot with one reachable oak log, a fixed starting position and equipment, and one free inventory slot. Input: requested increase of one log. Output: outcome, reason, elapsed milliseconds, and inventory counts before/after.
- **Success check:** Within 30 seconds, the bot remains alive and its oak-log count increases by at least one without human help. Failure: death, execution error, or human takeover. Timeout: the goal is not reached within 30 seconds. A broken block alone is not success; the item must be collected.
- **Reset steps:** Stop the skill and release controls. In the approved test plot, remove leftover drops and restore the log and terrain. Restore the bot's position, health, food, and equipment. Restore starting inventory and verify the plot. Record the initial log count, then begin the next trial.
- **Evaluation:** Untested; no result or improvement claimed. Compare against an agreed baseline using the same setup.

## Rules shared with the combat contract

All movement and action requests must go through the existing control arbiter, which decides which source controls the bot. Completion, cancellation, errors, and timeouts must release the skill's controls. For combat models, keep `contracts/policy.json` and the existing model metadata requirements; this general format does not replace them.

Keep candidates separate from the active version. Activation requires repeated evaluation under fixed conditions, no human intervention, and agreed success and safety thresholds. Preserve the combat contract's zombie/skeleton checks for combat promotion. For other skills, agree on equivalent tests before activation. Record synthetic data explicitly; it does not qualify a skill for promotion.
