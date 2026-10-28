# Bringing Agent-37 into this repo

`tools/bridge` runs Agent-37's combat bridge. The bridge now lives in this repo at `bridge/`, so one clone has everything. The launcher (`tools/bridge/run-agent37-bridge.mjs`) and `status.mjs` use the in-repo `bridge/server.js` by default.

## Pick: vendored copy

The lead picked a vendored copy over a git submodule or an npm dependency. These files came from the Agent-37 build that runs the current demo:

- `bridge/`: `server.js`, `arbiter.js`, `geometry.js`, `imitation.js`, `observation.js`, `policy.js`, `recording.js`, their tests, the `public/` control page, and `package.json` with its lock file.
- `contracts/policy.json`: the shared policy feature contract that `policy.test.js` reads.

Fixes made in Agent-37 have to be copied over by hand. To run a different bridge, set `A37_BRIDGE_SERVER` to its `server.js` (see `tools/bridge/bridge.env.example`).

Not brought in yet: the teacher page and the training scripts. They're still only in Agent-37.

## Proposed fix in Agent-37

In `bridge/arbiter.js`, the terrain guard clears forward/back/left/right whenever the next support cell looks like a drop. When a person drives, the bot crawls at block edges.

Fix: only run the guard when the winning source isn't `human`. In `tick()`, pass `terrain: null` for human control. For now, `tools/bridge/run-agent37-bridge.mjs` does this from outside.

The same file also ends any control after 2 minutes (`maxDurationMs`). That should not apply to a human driver either.
