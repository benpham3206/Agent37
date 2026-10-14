# Bringing Agent-37 into this repo

`tools/bridge` needs Agent-37's combat bridge (`bridge/`). This repo doesn't have it yet. Today it lives on the dev PC and in benpham3206/Agent-37.

## Options

- **Vendor it.** Copy `bridge/` into `vendor/agent-37-bridge/` and record which Agent-37 commit it came from. One clone has everything, but fixes have to be copied by hand.
- **Git submodule.** Add `benpham3206/Agent-37` at `vendor/Agent-37`. It's pinned to a commit and easy to update, but everyone has to run `git submodule update --init`.
- **npm dependency.** Point at `github:benpham3206/Agent-37`. That doesn't work well, because the bridge is a subfolder and isn't packaged.

Suggestion: use a submodule pinned to a known-good commit. Then set `A37_BRIDGE_SERVER=vendor/Agent-37/bridge/server.js`.

## Proposed fix in Agent-37

In `bridge/arbiter.js`, the terrain guard clears forward/back/left/right whenever the next support cell looks like a drop. When a person drives, the bot crawls at block edges.

Fix: only run the guard when the winning source isn't `human`. In `tick()`, pass `terrain: null` for human control. For now, `tools/bridge/run-agent37-bridge.mjs` does this from outside.

The same file also ends any control after 2 minutes (`maxDurationMs`). That should not apply to a human driver either.
