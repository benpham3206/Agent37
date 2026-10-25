# Recording format and proposed fields

Status: Draft for human fact-check and lead review. The current format is schema version 1; the additions below are proposed and unimplemented.

Training and dataset loaders depend on this format. The source of truth is [`bridge/recording.js`](../bridge/recording.js), reused from [Agent-37](https://github.com/benpham3206/Agent-37/blob/main/bridge/recording.js). The current-format sections describe this repository at commit `38be968`. [`server.js`](../bridge/server.js), [`observation.js`](../bridge/observation.js), and [`arbiter.js`](../bridge/arbiter.js) define the values supplied to the recorder. Runtime payload details below refer to the core bridge; launcher wrappers can modify control behavior.

## Files and session metadata

The recorder creates this layout under its configured `dataDir`:

```text
<dataDir>/<sessionId>/
  session.json
  encounters/
    <encounterId>.jsonl
```

`session.json` is a JSON object, indented with two spaces and followed by a newline. It is written only if the file does not already exist. Reusing a session directory does not refresh its metadata.

| Field | Current value or meaning |
| --- | --- |
| `schema_version` | Integer `1`. |
| `session_id` | The supplied `sessionId`. |
| `target` | The supplied target, such as `"zombie"`. This is constructor metadata; later changes to the runtime target do not update it. |
| `source` | Constant `"human"`; this does not prove that every row used human control. |
| `environment_suite` | Supplied `environmentSuite`, default `"open_surface"`. |
| `environment_label` | Supplied `environmentLabel`, default `"open_surface"`. |
| `notes` | Supplied notes, default `""`. |
| `created_at` | Bridge host creation time as a UTC ISO 8601 string from `new Date().toISOString()`. |

The core runtime defaults to session `combat` and `path.resolve('data/combat')`, relative to the working directory. The team launcher instead uses session `devserver-test` and `A37_DATA_DIR`, or its per-bot `bridge-data/<bot-name>` directory. See the [setup guide](../README.md#quick-start-guide) and [launcher](../tools/bridge/run-agent37-bridge.mjs).

The current runtime passes `environment: cfg.environment` into `Recorder`, whose constructor accepts `environmentSuite` and `environmentLabel`. That argument does not override the metadata defaults. Row observations can therefore have a different environment label from session metadata.

Example session metadata with supplied `sessionId`, `target`, and `notes`:

```json
{
  "schema_version": 1,
  "session_id": "demo-001",
  "target": "zombie",
  "source": "human",
  "environment_suite": "open_surface",
  "environment_label": "open_surface",
  "notes": "arena demo",
  "created_at": "2026-10-24T19:00:00.000Z"
}
```

## Current encounter rows

Each encounter file contains one compact JSON object per line, with a trailing newline. There is no header or footer. `Recorder.row(observation, teacherAction, appliedAction, arbiter, timestampMs = Date.now())` writes only while the state is `recording` and a file is open; it returns `true` after writing and `false` otherwise.

| Field | Type and current meaning |
| --- | --- |
| `schema_version` | Integer `1`. |
| `session_id` | Supplied session ID; matches the directory and session metadata. |
| `encounter_id` | String generated as epoch milliseconds, a hyphen, and a random base-36 suffix using `Math.random().toString(36).slice(2, 8)`. Matches the filename stem. |
| `tick` | Integer row counter starting at `0` in each new encounter, incremented for each written row. It is not a Minecraft server tick. |
| `timestamp_ms` | Bridge host Unix epoch time in milliseconds, default `Date.now()` at the row call. A caller can supply another value; the recorder does not validate it. |
| `server_tick` | Always `null`; no server tick is captured. |
| `source` | Constant `"privileged_hitbox"`, describing observation provenance rather than who controls the bot. |
| `recording_state` | Always `"recording"` in emitted rows. |
| `label` | One of `"good"`, `"bad"`, `"excluded"`, `"unlabelled"`; new encounters start `"unlabelled"`. |
| `observation` | Supplied observation object, serialized as received. |
| `teacher_action` | Supplied teacher input, serialized as received. |
| `applied_action` | Supplied action selected by the arbiter, serialized as received. |
| `arbiter` | Supplied arbitration metadata; the runtime writes `{ "source": ..., "reason": ... }`. |

The recorder uses `JSON.stringify` without schema validation or payload normalization. Callers must supply the expected types. For example, an `undefined` object property is omitted during serialization, rather than converted to `null`.

The core runtime requests a row every 50 ms, nominally 20 Hz, after taking an observation and selecting/applying an action. This is a timer, not a guarantee of exact spacing or synchronization to Minecraft ticks. Use recorded timestamps for elapsed time. The policy contract's 10 Hz inference setting does not describe the recording rate.

### Observation payload

[`buildObservation`](../bridge/observation.js) produces these groups:

| Group | Current contents |
| --- | --- |
| `self` | Position and velocity vectors; yaw/pitch; on-ground state; health/hunger; held and offhand items; hotbar slot; sprint/sneak/use state; incoming attack summary and recent events. `armor` and `cooldown` are currently `null`; `effects` is `[]`. |
| `target` | `null` when unavailable, otherwise entity ID/type, position/velocity, width/height, bounding box, relative position, distance/bearing/elevation, angular error, line of sight, reach, aim point, health, and events. |
| `hostiles`, `projectiles` | Arrays of entity summaries; the core runtime leaves the builder's defaults as empty arrays. |
| `collision` | Currently `{}`. |
| `dimension`, `terrain` | Dimension, environment label, support grid, clearance, hazards, cover samples, and derived terrain features. When position or yaw is unavailable, the builder returns a reduced terrain object with unavailable groups set to `null`. |
| `selector` | Runtime selection metadata: `environment_label`, `target_type`, and `sparring_player`. |

Vectors use `{ "x": ..., "y": ..., "z": ... }`. Positions and distances use Minecraft blocks; orientation angles and angular errors use radians. Availability varies by field: some values are `null`, while other fields have explicit empty, zero, or Boolean defaults. Loaders must preserve those distinctions. Event `timestamp_ms` values also come from the bridge host clock.

### Actions and arbitration

The standard action shape from [`emptyAction`](../bridge/arbiter.js) has:

- Boolean fields: `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`, `attack`, `use`, `emergency_stop`, `manual_abort`.
- `hotbar`: integer slot index `0` through `8`.
- Numeric fields: `mouse_dx`, `mouse_dy`, `yaw_delta`, `pitch_delta`. Browser mouse deltas originate as mouse movement values; yaw/pitch deltas are radians.

The arbiter sanitizes its action inputs: it coerces Boolean fields, clamps an integer hotbar slot to `0..8` (otherwise `0`), and clamps each finite numeric delta to `[-1, 1]` (otherwise `0`). `teacher_action` is the runtime's stored teacher input, not necessarily this sanitized output. In particular, applying human look input resets its stored mouse and angle deltas before the row is written. Do not assume teacher and applied deltas match.

In recorded `arbiter.source`, the runtime renames the arbiter's `human` source to `teacher`. Other possible core sources include `idle`, `emergency`, `survival`, `mimic`, `skill`, and `navigation`. `reason` carries the selected decision's reason, such as `teacher`, `idle`, or `retreat_health`. This identifies a control source, not an individual controller.

`applied_action` records the selected command, not confirmation that every requested effect happened. The runtime separately gates attacks and item/slot operations. Teacher input can also remain present while another source wins, so filter human demonstrations using arbitration metadata rather than the constant `source` fields.

### Example row

This synthetic example shows the exact envelope emitted by a direct recorder call with empty payload objects and a supplied timestamp. Real runtime payloads use the groups above. It is one JSONL line:

```json
{"schema_version":1,"session_id":"demo-001","encounter_id":"1792868400000-abc123","tick":0,"timestamp_ms":1792868400000,"server_tick":null,"source":"privileged_hitbox","recording_state":"recording","label":"unlabelled","observation":{},"teacher_action":{},"applied_action":{},"arbiter":{}}
```

## Encounter lifecycle and labels

| Call | Behavior |
| --- | --- |
| Constructor | Creates the session directory and missing metadata; starts in `idle` with no encounter file open. |
| `start()` | Opens a new encounter unless already `recording`, in which case it does nothing. Despite the UI's “Start / New encounter” label, clicking Start during recording does not split the file. |
| `pause()` | From `recording`, changes to `paused` and flushes/closes the encounter. Other states are unchanged. |
| `resume()` | From `paused`, changes to `recording` and opens a new encounter. Other states are unchanged. |
| `stop()` | Changes to `stopped` and flushes/closes any open encounter. A later `start()` creates a new encounter in the same session. |
| New encounter | Resets `tick` to `0` and `label` to `unlabelled`. Opening a file does not write a row, so an encounter may be empty. |
| `setLabel(label)` | Ignores invalid labels. For a valid label, sets the current label and rewrites all parseable existing rows in the current encounter, including after pause/stop; it does not relabel other encounters. Future rows in that encounter use the new label. Malformed lines are preserved as text. |

Relabelling rewrites the file; encounter logs are not immutable. Rows are written synchronously, and explicit encounter close calls `fsyncSync` before closing. A crash can still leave incomplete data; consumers should report malformed lines instead of silently treating them as valid examples. Empty encounters need handling before indexing a first or last row. The existing replay/stats scripts assume nonempty, parseable input.

## Proposed server time and identity fields

Propose schema version **2** for newly written session metadata and rows. Preserve the existing fields and meanings, including `timestamp_ms`, `tick`, `server_tick`, and the two `source` constants. Version 1 recordings remain valid historical inputs.

| Proposed field | Location and type | Meaning and population rule |
| --- | --- | --- |
| `server_time_ms` | Row; nonnegative integer or `null` | Minecraft server-origin Unix epoch wall-clock milliseconds associated with the sample. Populate only from an authoritative server time source with a documented sampling method. Use `null` when unavailable; do not copy bridge `Date.now()` or convert world time/daytime into epoch milliseconds. |
| `agent_name` | Session and every row; nonempty string or `null` | Minecraft username of the bot being recorded. Prefer the actual connected bot username; if unavailable, use an explicitly configured username, otherwise `null`. Repeating it on rows lets loaders retain identity when processing an encounter alone. Keep it fixed within a session; use a new session if it changes. |
| `controller_id` | Row; nonempty opaque string or `null` | Session-scoped identifier of the human controller whose command won arbitration for that sample (`arbiter.source === "teacher"`). Assign it in the bridge to the browser control connection and carry it with that connection's accepted input through arbitration. Use `null` for nonhuman winners or unknown identity. Reconnection gets a new ID; concurrent connections get distinct IDs. |

This defines “server time” as server wall-clock time. `server_tick` remains the separate reserved field for a possible authoritative Minecraft tick count. Neither is the encounter row counter. The current recorder supplies neither authoritative clock value. A future implementation needs a server-side time source before `server_time_ms` can be non-null; if the team wants world age or time of day instead, agree on a separately named field and its units before implementation.

`controller_id` identifies a connection, not a verified person, Minecraft entity, bot name, or arbiter category. It must not contain passwords, login tokens, or personal contact details. It attributes the selected human action; when another source overrides human input, it does not identify the author of the remaining `teacher_action`. Any need for that additional attribution requires a separate field definition.

Proposed additional session member, using the existing example session:

```json
{
  "agent_name": "Agent37Teacher"
}
```

Proposed row example, retaining the existing envelope and showing unavailable server time and a human winner. Payloads are abbreviated with empty objects as in the direct-call example:

```json
{"schema_version":2,"session_id":"demo-001","encounter_id":"1792868400000-abc123","tick":0,"timestamp_ms":1792868400000,"server_tick":null,"source":"privileged_hitbox","recording_state":"recording","label":"unlabelled","observation":{},"teacher_action":{},"applied_action":{},"arbiter":{"source":"teacher","reason":"teacher"},"server_time_ms":null,"agent_name":"Agent37Teacher","controller_id":"controller-001"}
```

### Loader compatibility and rollout proposal

1. Update training and dataset readers to dispatch on schema version and accept both versions 1 and 2. Treat the three absent new fields in version 1 as unknown (`null`); do not infer identity from filenames or clock values. In version 2, require all three row keys, allowing `null` as defined above.
2. Keep replay timing based on `timestamp_ms`. Unknown server time does not invalidate an otherwise usable sample. Clock changes or unsynchronized bridge hosts mean host timestamps alone cannot establish exact ordering across machines.
3. Verify consumers with a version 1 fixture, a version 2 fixture with unknown values, and a version 2 human-control fixture. Check row fields survive label rewrites and controller IDs follow takeovers, reconnects, and safety overrides. Check empty/malformed encounters are handled explicitly. The in-repo replay/stats scripts read named fields without checking schema version, but compatibility with actual training/loaders still needs verification.
4. Only then change the writer to emit version 2. Use a new session directory: the constructor currently preserves existing `session.json`, so reusing a version 1 session could otherwise mix metadata and row versions. Do not rewrite old datasets to manufacture missing server time or identities.

## Review and completion

The lead should review the three field definitions, the proposed version bump, and the time source before implementation. Training and dataset-loader owners should verify the compatibility plan against their actual readers.

- [x] Describe the current session file, complete row envelope, payload sources, timestamps, labels, and encounter transitions against the repository code.
- [x] Propose server time, agent name, and controller ID with locations, types, unknown-value rules, examples, and loader compatibility.
- [ ] A person checks every factual statement against the source and setup guide.
- [ ] Post the shared document link in the team chat and ask project lead Ben Pham to review.
