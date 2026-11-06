# Combat dataset

This reference inventories the inputs, outputs, and settings in `ml/dataset.py`.
Training uses an additional bridge-compatible feature adapter; its differences
are documented in [method.md](method.md). The recording loader declares Python
3.11+ support. [ml/dataset.py:1](../ml/dataset.py#L1)

## Files and schema versions

| Input or setting | Definition | Source |
| --- | --- | --- |
| Supported schemas | Versions `1` and `2`; current `SCHEMA_VERSION = 2`. | [ml/dataset.py:18](../ml/dataset.py#L18) |
| Session directory | Contains `session.json` and `encounters/*.jsonl`; encounter filenames are sorted. | [ml/dataset.py:171](../ml/dataset.py#L171), [ml/dataset.py:192](../ml/dataset.py#L192) |
| Dataset root | Recursively discovers directories containing `session.json` or an `encounters` directory. Missing directories and roots without sessions are errors. | [ml/dataset.py:332](../ml/dataset.py#L332) |
| Encoding and JSON | UTF-8; each encounter line must be a JSON object. Nonstandard constants such as `NaN` are rejected. | [ml/dataset.py:71](../ml/dataset.py#L71), [ml/dataset.py:135](../ml/dataset.py#L135) |
| Extra fields | Required keys are checked without rejecting additional keys; row normalization copies the original dictionary. | [ml/dataset.py:81](../ml/dataset.py#L81), [ml/dataset.py:111](../ml/dataset.py#L111) |

## Session metadata inputs

| Field | Requirement or use | Source |
| --- | --- | --- |
| `schema_version` | Required integer identifying supported schema `1` or `2`. | [ml/dataset.py:27](../ml/dataset.py#L27), [ml/dataset.py:85](../ml/dataset.py#L85) |
| `session_id` | Required nonempty string; must agree with encounter rows. | [ml/dataset.py:178](../ml/dataset.py#L178), [ml/dataset.py:206](../ml/dataset.py#L206) |
| `target` | Required key; training uses it as a fallback when a row has no target `mob_type`. | [ml/dataset.py:27](../ml/dataset.py#L27), [ml/train.py:93](../ml/train.py#L93) |
| `source`, `notes`, `created_at` | Required keys; this loader adds no value/type validation for them. | [ml/dataset.py:27](../ml/dataset.py#L27), [ml/dataset.py:175](../ml/dataset.py#L175) |
| `environment_suite` | Required nonempty string. | [ml/dataset.py:178](../ml/dataset.py#L178) |
| `environment_label` | Required nonempty string; becomes the validation report's `environment`. | [ml/dataset.py:178](../ml/dataset.py#L178), [ml/dataset.py:186](../ml/dataset.py#L186) |
| `agent_name` | Required in v2; nonempty string or null. V2 rows must match it. | [ml/dataset.py:28](../ml/dataset.py#L28), [ml/dataset.py:181](../ml/dataset.py#L181), [ml/dataset.py:210](../ml/dataset.py#L210) |
| `synthetic` | Optional boolean, default `false`; controls synthetic-data eligibility. | [ml/dataset.py:183](../ml/dataset.py#L183) |
| Recognized environment names | `open_surface`, `underground`, `nether_open`, `fortress`, `end_island`, `bridge`, `other`. Used for coverage reporting; validation only requires a nonempty label. | [ml/dataset.py:20](../ml/dataset.py#L20), [ml/dataset.py:178](../ml/dataset.py#L178), [ml/train.py:264](../ml/train.py#L264) |

## Encounter-row inputs

| Field | Requirement or use | Source |
| --- | --- | --- |
| `schema_version` | Required supported integer version. | [ml/dataset.py:25](../ml/dataset.py#L25), [ml/dataset.py:94](../ml/dataset.py#L94) |
| `session_id`, `encounter_id`, `source` | Required nonempty strings. Top-level `source` does not determine teacher eligibility. | [ml/dataset.py:95](../ml/dataset.py#L95), [ml/dataset.py:234](../ml/dataset.py#L234) |
| `tick` | Required nonnegative integer row counter; strictly increases within the encounter. | [ml/dataset.py:98](../ml/dataset.py#L98), [ml/dataset.py:154](../ml/dataset.py#L154) |
| `timestamp_ms` | Required finite number; strictly increases. Used for synchronization gaps and training sampling. | [ml/dataset.py:100](../ml/dataset.py#L100), [ml/dataset.py:156](../ml/dataset.py#L156), [ml/train.py:89](../ml/train.py#L89) |
| `server_tick` | Required key; no additional value/type check in this loader. | [ml/dataset.py:25](../ml/dataset.py#L25), [ml/dataset.py:93](../ml/dataset.py#L93) |
| `recording_state` | One of `recording`, `paused`, `stopped`. It is not part of the demo-row predicate. | [ml/dataset.py:104](../ml/dataset.py#L104), [ml/dataset.py:234](../ml/dataset.py#L234) |
| `label` | One of `good`, `bad`, `excluded`, `unlabelled`. Only `good` qualifies for training. | [ml/dataset.py:102](../ml/dataset.py#L102), [ml/dataset.py:234](../ml/dataset.py#L234) |
| `observation` | Required object; nested feature inputs are listed below. | [ml/dataset.py:106](../ml/dataset.py#L106) |
| `teacher_action` | Required object; supplies training labels. Individual action keys are optional. | [ml/dataset.py:106](../ml/dataset.py#L106), [ml/dataset.py:319](../ml/dataset.py#L319) |
| `applied_action` | Required object, preserved; not used as the training target. | [ml/dataset.py:106](../ml/dataset.py#L106), [ml/train.py:98](../ml/train.py#L98) |
| `arbiter` | Required object. Eligibility requires its `source` member to equal exactly `"teacher"`. | [ml/dataset.py:106](../ml/dataset.py#L106), [ml/dataset.py:232](../ml/dataset.py#L232) |
| `server_time_ms` | Required in v2; null or nonnegative integer. Not used for gap checks or training sampling. | [ml/dataset.py:24](../ml/dataset.py#L24), [ml/dataset.py:115](../ml/dataset.py#L115), [ml/dataset.py:156](../ml/dataset.py#L156), [ml/train.py:89](../ml/train.py#L89) |
| `agent_name` | Required in v2; null or nonempty string. | [ml/dataset.py:24](../ml/dataset.py#L24), [ml/dataset.py:118](../ml/dataset.py#L118) |
| `controller_id` | Required in v2; null or nonempty string. Must be null unless `arbiter.source == "teacher"`. | [ml/dataset.py:118](../ml/dataset.py#L118), [ml/dataset.py:121](../ml/dataset.py#L121) |
| V1 normalization | `server_time_ms`, `agent_name`, and `controller_id` become `None`; the row otherwise remains copied from the input. | [ml/dataset.py:111](../ml/dataset.py#L111) |

## Loading, validation, and CLI

| Item | Definition | Source |
| --- | --- | --- |
| `load_encounter(path, *, max_gap_ms=250)` | Returns normalized row dictionaries in file order. `max_gap_ms=None` disables only the maximum-gap check. | [ml/dataset.py:126](../ml/dataset.py#L126), [ml/dataset.py:162](../ml/dataset.py#L162) |
| Empty/blank records | Empty files and blank JSONL rows are errors; one final newline is allowed. | [ml/dataset.py:138](../ml/dataset.py#L138), [ml/dataset.py:140](../ml/dataset.py#L140), [ml/dataset.py:147](../ml/dataset.py#L147) |
| Encounter invariants | `schema_version`, `session_id`, `encounter_id`, and normalized `agent_name` cannot change within a file. | [ml/dataset.py:151](../ml/dataset.py#L151) |
| Session consistency | Row schema/session ID must match metadata; v2 agent identity must match metadata; encounter ID must equal the JSONL filename stem. | [ml/dataset.py:205](../ml/dataset.py#L205), [ml/dataset.py:212](../ml/dataset.py#L212) |
| `validate_session(path, *, max_gap_ms=250)` | Returns a `Validation` object. | [ml/dataset.py:227](../ml/dataset.py#L227) |
| `Validation` fields and defaults | `valid` is required; defaults are `rows=0`, `encounters=()`, `mob_types=()`, `errors=()`, `synthetic=False`, `environment=""`. Encounter and mob names in generated reports are sorted tuples. | [ml/dataset.py:35](../ml/dataset.py#L35), [ml/dataset.py:219](../ml/dataset.py#L219) |
| Validation counts | Count parsed rows and recorded nonempty `observation.target.mob_type` values, before demo filtering. | [ml/dataset.py:215](../ml/dataset.py#L215), [ml/dataset.py:220](../ml/dataset.py#L220) |
| `Validation.eligible` | `valid and not synthetic and rows > 0`; this does not establish sufficient training encounters. | [ml/dataset.py:46](../ml/dataset.py#L46), [ml/train.py:103](../ml/train.py#L103) |
| `is_demo_row(row)` | Boolean: `arbiter` is an object, `arbiter.source == "teacher"`, and `label == "good"`. | [ml/dataset.py:232](../ml/dataset.py#L232) |
| `load_session(path, *, demos_only=False, max_gap_ms=250)` | Returns all normalized rows, or only demo rows when requested. Validates the complete session first; invalid sessions raise `DatasetError`. | [ml/dataset.py:237](../ml/dataset.py#L237), [ml/dataset.py:243](../ml/dataset.py#L243) |
| CLI inputs | Required `--check` and one or more positional `paths`; accepts sessions or dataset roots. Resolved session paths are deduplicated. | [ml/dataset.py:345](../ml/dataset.py#L345), [ml/dataset.py:356](../ml/dataset.py#L356) |
| CLI outputs | Prints `<sessions> sessions, <failures> invalid`, followed by failure explanations. Returns `1` if failures exist, otherwise `0`. Discovery failures also contribute to the failure count. | [ml/dataset.py:354](../ml/dataset.py#L354), [ml/dataset.py:363](../ml/dataset.py#L363) |

## Ordered observation features

The default output has 46 numbers. Indices below are 1-based and follow
`DEFAULT_FEATURES`. Numeric conversion accepts finite `int`/`float` values,
excluding booleans; its general fallback is `0.0`, with a separate health
default of `20.0`. [ml/dataset.py:22](../ml/dataset.py#L22),
[ml/dataset.py:50](../ml/dataset.py#L50),
[ml/dataset.py:269](../ml/dataset.py#L269),
[ml/dataset.py:280](../ml/dataset.py#L280)

| Indices / feature names | Observation input and dataset conversion | Source |
| --- | --- | --- |
| 1-3: `target_dx`, `target_dy`, `target_dz` | `target.relative_position.{x,y,z}`. | [ml/dataset.py:275](../ml/dataset.py#L275) |
| 4-6: `target_vx`, `target_vy`, `target_vz` | `target.velocity.{x,y,z}`. | [ml/dataset.py:276](../ml/dataset.py#L276) |
| 7-9: `distance`, `bearing`, `elevation` | Corresponding `target` members. | [ml/dataset.py:277](../ml/dataset.py#L277) |
| 10-11: `angular_error_yaw`, `angular_error_pitch` | `target.angular_error.{yaw,pitch}`. | [ml/dataset.py:278](../ml/dataset.py#L278) |
| 12-13: `line_of_sight`, `in_reach` | Corresponding `target` members converted through Python truthiness to `0.0`/`1.0`. | [ml/dataset.py:279](../ml/dataset.py#L279) |
| 14-15: `self_health`, `target_health` | `self.health`, `target.health`; default `20.0`. | [ml/dataset.py:280](../ml/dataset.py#L280) |
| 16: `on_ground` | `self.on_ground`, converted through truthiness. | [ml/dataset.py:281](../ml/dataset.py#L281) |
| 17: `cooldown` | `self.cooldown`. | [ml/dataset.py:281](../ml/dataset.py#L281) |
| 18-19: `is_sprinting`, `is_sneaking` | `self.sprinting`, `self.sneaking`, converted through truthiness. | [ml/dataset.py:282](../ml/dataset.py#L282) |
| 20-24: `target_zombie`, `target_skeleton`, `target_enderman`, `target_blaze`, `target_phantom` | One-hot comparison against lowercased, namespace-stripped `target.mob_type`. | [ml/dataset.py:253](../ml/dataset.py#L253), [ml/dataset.py:272](../ml/dataset.py#L272), [ml/dataset.py:284](../ml/dataset.py#L284) |
| 25: `has_sword` | Lowercased held/offhand text contains any of `"sword"`, `"netherite"`, `"diamond"`. | [ml/dataset.py:273](../ml/dataset.py#L273), [ml/dataset.py:287](../ml/dataset.py#L287) |
| 26-27: `has_axe`, `has_shield` | Held/offhand text contains `"axe"` or `"shield"`. | [ml/dataset.py:288](../ml/dataset.py#L288) |
| 28-30: `dimension_overworld`, `dimension_nether`, `dimension_end` | Lowercased `observation.dimension`, falling back to `terrain.dimension`, tested with `endswith`. | [ml/dataset.py:267](../ml/dataset.py#L267), [ml/dataset.py:290](../ml/dataset.py#L290) |
| 31-35: `support_center`, `support_forward`, `support_back`, `support_left`, `support_right` | `terrain.support_grid.<direction>`, falling back to `terrain.support_<direction>`; numeric value or truthiness conversion. | [ml/dataset.py:294](../ml/dataset.py#L294), [ml/dataset.py:298](../ml/dataset.py#L298) |
| 36-39: `drop_forward`, `drop_back`, `drop_left`, `drop_right` | Precedence: `terrain.drop_<direction>`, `terrain.drop_depth.<direction>`, `terrain.drop.<direction>`. | [ml/dataset.py:295](../ml/dataset.py#L295), [ml/dataset.py:302](../ml/dataset.py#L302) |
| 40-43: `clearance_forward`, `clearance_back`, `clearance_left`, `clearance_right` | Scalar `terrain.clearance_<direction>` or `terrain.clearance.<direction>`. Object form combines `available` (default true), `body_clear`, and `head_clear`. | [ml/dataset.py:303](../ml/dataset.py#L303) |
| 44: `hazard_near` | `terrain.hazard_near` or `terrain.hazards`; dictionary hazards are reduced using `any(values)`. | [ml/dataset.py:307](../ml/dataset.py#L307) |
| 45: `incoming_swing` | `self.incoming_attack.swing_detected`, converted through truthiness. | [ml/dataset.py:311](../ml/dataset.py#L311) |
| 46: `recent_damage` | `self.incoming_attack.damage`. | [ml/dataset.py:312](../ml/dataset.py#L312) |

## Feature, action, and hashing interfaces

| Item | Definition | Source |
| --- | --- | --- |
| `feature_vector(row, features=DEFAULT_FEATURES)` | Supports caller-supplied feature selection/order; returns values in that order. Unknown feature names raise `ValueError`. | [ml/dataset.py:257](../ml/dataset.py#L257), [ml/dataset.py:313](../ml/dataset.py#L313) |
| Missing/non-object observation groups | Treated as empty mappings by dataset feature extraction. | [ml/dataset.py:249](../ml/dataset.py#L249), [ml/dataset.py:259](../ml/dataset.py#L259) |
| Ordered action outputs | `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`, `attack`, `use`, `disengage`. | [ml/dataset.py:21](../ml/dataset.py#L21) |
| `action_vector(row)` | Reads those keys from `teacher_action`; each becomes `float(bool(value))`. Missing keys default false. | [ml/dataset.py:319](../ml/dataset.py#L319) |
| `sha256_file(path)` | Reads raw bytes in 1 MiB blocks and returns a hexadecimal SHA256 string. | [ml/dataset.py:324](../ml/dataset.py#L324) |

## Internal interfaces

| Function inputs | Return/output | Source |
| --- | --- | --- |
| `_num(value)` | Whether value is a finite integer/float, excluding bool. | [ml/dataset.py:50](../ml/dataset.py#L50) |
| `_nonempty_string(value)` | Whether value is a string containing non-whitespace characters. | [ml/dataset.py:59](../ml/dataset.py#L59) |
| `_nullable_identity(value)` | Whether value is null or a nonempty string. | [ml/dataset.py:63](../ml/dataset.py#L63) |
| `_reject_constant(value)` | Raises for nonstandard JSON constants. | [ml/dataset.py:67](../ml/dataset.py#L67) |
| `_json_object(text, location)` | Parsed dictionary, or location-qualified `DatasetError`. | [ml/dataset.py:71](../ml/dataset.py#L71) |
| `_versioned_keys(value, schemas, location)` | Validated schema version, or missing/unsupported-key error. | [ml/dataset.py:81](../ml/dataset.py#L81) |
| `_normalize_row(row, location)` | Validated, normalized row dictionary. | [ml/dataset.py:93](../ml/dataset.py#L93) |
| `_session_data(path, max_gap_ms)` | `(Validation, all_rows)`; public `load_session` rejects an invalid report. | [ml/dataset.py:165](../ml/dataset.py#L165), [ml/dataset.py:224](../ml/dataset.py#L224), [ml/dataset.py:244](../ml/dataset.py#L244) |
| `_mapping(value)` | Value if a dictionary, otherwise `{}`. | [ml/dataset.py:249](../ml/dataset.py#L249) |
| `_target_type(value)` | Lowercased string with namespace removed. | [ml/dataset.py:253](../ml/dataset.py#L253) |
| Nested `n(value, default=0.0)` | Float conversion for valid numeric values; otherwise the supplied default. | [ml/dataset.py:269](../ml/dataset.py#L269) |
| `_discover_sessions(path)` | Sorted session paths, or discovery error. | [ml/dataset.py:332](../ml/dataset.py#L332) |
| `main(argv=None)` | Parses CLI arguments, prints validation results, returns status. | [ml/dataset.py:345](../ml/dataset.py#L345) |
