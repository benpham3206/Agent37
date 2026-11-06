# Agent37 roadmap (Fall 2026)

Source of truth for status: [Project Agent37](https://github.com/users/benpham3206/projects/2).

## Checkpoints

| Checkpoint | Date | Meaning |
|---|---|---|
| M0 | Oct 22 | Team onboarded |
| M1 | Oct 29 | Observation/action API, eval runner, verify command |
| M2 | Nov 5 | Combat / craft / goal slices for demo |
| M3 | Nov 12 | Demo video; fixed link; backup recording |
| Dry run | Nov 14 | Full run-through |
| Showcase | Nov 16 3–5 PM PT | ≤5-slide pitch + live Q&A, Student Union Theater |

## Headline demo

Bots (target up to 4) reach the Nether from a fresh spawn. Chain: spawn facts → wood → tools → iron → obsidian → light → enter.

## Lanes

B bot control · R takeover UI · J skills & testing · V ML · H infra & docs

## Recent landings (as of Nov 5, 2026)

- Nether-chain scorer and multi-log wood sensing (PR #51).
- ML V2–V5: dataset loader for combat demos, training + ONNX export, V4 learned combat benchmark, dataset/method docs (PRs #52–#55).

## Planned (board cards; not claiming code yet)

- Speed fixes on the bot control lane: instant-action apply, `bridge/server.js` split (no behavior change), live latency bench.
- Jev integration: fast perception layer (~500 ms refresh) feeding observation for the slower planner (ML lane; unassigned until ownership is clear).
- Showcase logistics: presentation slot sign-up (due Mon Nov 9), ≤5-slide pitch draft, Nov 12 demo video record.
