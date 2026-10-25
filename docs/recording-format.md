# Recording format

Status: Schema version 1, with additive server time and identity fields. Human fact-check and lead review remain pending.

Training and dataset loaders depend on this format. The source of truth is [`bridge/recording.js`](../bridge/recording.js), originally reused from [Agent-37](https://github.com/benpham3206/Agent-37/blob/main/bridge/recording.js). These sections describe the code in this repository. [`server.js`](../bridge/server.js), [`observation.js`](../bridge/observation.js), and [`arbiter.js`](../bridge/arbiter.js) define the values supplied to the recorder. Runtime payload details below refer to the core bridge; launcher wrappers can modify control behavior.

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

Each encounter file contains one compact JSON object per line, with a trailing newline. There is no header or footer. `Recorder.row(observation, teacherAction, appliedAction, arbiter, timestampMs = Date.now(), { agentName = this.agentName, controllerId = null } = {})` writes only while the state is `recording` and a file is open; it returns `true` after writing and `false` otherwise. The constructor accepts an optional `agentName`, defaulting to `null`.

| Field | Type and current meaning |
| --- | --- |
| `schema_version` | Integer `1`. |
| `session_id` | Supplied session ID; matches the directory and session metadata. |
| `encounter_id` | String generated as epoch milliseconds, a hyphen, and a random base-36 suffix using `Math.random().toString(36).slice(2, 8)`. Matches the filename stem. |
| `tick` | Integer row counter starting at `0` in each new encounter, incremented for each written row. It is not a Minecraft server tick. |
| `timestamp_ms` | Bridge host Unix epoch time in milliseconds, default `Date.now()` at the row call. A caller can supply another value; the recorder does not validate it. |
| `server_time_ms` | Bridge server UTC Unix epoch milliseconds from `Date.now()` at write time, independently of a supplied `timestamp_ms`. |
| `server_tick` | Always `null`; no server tick is captured. |
| `agent_name` | Recorded bot's username, or `null` when unknown. |
| `controller_id` | Opaque ID of the browser connection whose human command won arbitration, or `null` for nonhuman winners or unknown identity. |
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
{"schema_version":1,"session_id":"demo-001","encounter_id":"1792868400000-abc123","tick":0,"timestamp_ms":1792868400000,"server_time_ms":1792868400000,"server_tick":null,"agent_name":null,"controller_id":null,"source":"privileged_hitbox","recording_state":"recording","label":"unlabelled","observation":{},"teacher_action":{},"applied_action":{},"arbiter":{}}
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

## Server time and identity

Every new row includes these fields. Session metadata is unchanged.

| Field | Location and type | Meaning and population rule |
| --- | --- | --- |
| `server_time_ms` | Row; integer | Bridge server UTC wall clock at write time. It does not use the Minecraft server's clock, world age, or time of day. |
| `agent_name` | Row; string or `null` | Runtime uses the connected bot's `username`, falling back to configured `username`, then `null`. Direct recorder calls can supply a constructor default or per-row override. |
| `controller_id` | Row; string or `null` | Runtime generates a UUID per browser control connection and remembers it alongside that connection's latest accepted teacher input. It writes the ID only when `arbiter.source === "teacher"`. Reconnection gets a new ID; concurrent connections get distinct IDs. Direct recorder calls must supply the ID in the sixth argument; the default is `null`. |

`server_tick` remains reserved for a possible authoritative Minecraft tick count. Neither clock field is the encounter row counter. Wall-clock adjustments can affect both host timestamps; they do not establish exact ordering across unsynchronized machines.

`controller_id` identifies a connection, not a verified person, Minecraft entity, bot name, or arbiter category. It contains a server-generated UUID, not a password or login token. It attributes the selected human action; when another source overrides human input, it does not identify the author of the remaining `teacher_action`.

Example with a known agent and human winner. Payloads are abbreviated with empty objects as in the direct-call example:

```json
{"schema_version":1,"session_id":"demo-001","encounter_id":"1792868400000-abc123","tick":0,"timestamp_ms":1792868400000,"server_time_ms":1792868400000,"server_tick":null,"agent_name":"Agent37Teacher","controller_id":"b8d59168-13cc-4a64-92f2-601230b8a012","source":"privileged_hitbox","recording_state":"recording","label":"unlabelled","observation":{},"teacher_action":{},"applied_action":{},"arbiter":{"source":"teacher","reason":"teacher"}}
```

### Loader compatibility

Schema version remains **1**: the new row fields are additive, and the existing keys and meanings are preserved. Historical rows may lack them. Readers should treat absent values as unknown (`null`) and tolerate additional keys; strict field lists need to be updated. Do not rewrite old datasets to manufacture missing clock values or identities.

Keep replay timing based on `timestamp_ms`. The in-repo replay/stats scripts read named fields without checking schema version. Compatibility with external training/loaders still needs verification by their owners.

Run `node --test bridge/recording.test.js bridge/server.recording.test.js` from the repository root to check metadata, UTC clock capture, label rewrites, takeovers, reconnects, and safety overrides without a Minecraft server.

## Review and completion

The lead should review the field definitions and bridge UTC time semantics. Training and dataset-loader owners should verify compatibility against their actual readers.

- [x] Describe the current session file, complete row envelope, payload sources, timestamps, labels, and encounter transitions against the repository code.
- [x] Record server time, agent name, controller ID, and source on each new row, with regression coverage and documented loader compatibility.
- [ ] A person checks every factual statement against the source and setup guide.
- [ ] Post the shared document link in the team chat and ask project lead Ben Pham to review.
