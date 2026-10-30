# Combat training method

This reference inventories training inputs, outputs, and settings in
`ml/train.py`, including the imported feature adapter and model/export settings.
See [dataset.md](dataset.md) for the complete recording schema and ordered
feature/action lists. The trainer creates candidates; frozen arena evaluation
and registry activation are separate work.
[ml/train.py:1](../ml/train.py#L1)

## Training inputs and example preparation

| Input or setting | Definition | Source |
| --- | --- | --- |
| `train(sessions, out_dir=None, *, seed=37001, epochs=30, allow_synthetic=False)` | Main Python training interface; returns metadata. | [ml/train.py:211](../ml/train.py#L211), [ml/train.py:280](../ml/train.py#L280) |
| `sessions` | One path or iterable of paths; accepts sessions/dataset roots, resolves and deduplicates session paths, then sorts them. | [ml/train.py:37](../ml/train.py#L37) |
| Policy contract | Reads repository-relative `contracts/policy.json`. Feature/output order must equal the dataset constants. | [ml/train.py:25](../ml/train.py#L25), [ml/train.py:28](../ml/train.py#L28) |
| History and rate | Training requires `history == 4` and `rate_hz == 10`. | [ml/train.py:32](../ml/train.py#L32) |
| Whole-session validation | Calls `load_session()` before filtering; its default 250 ms gap validation applies. | [ml/train.py:69](../ml/train.py#L69), [ml/dataset.py:237](../ml/dataset.py#L237) |
| Synthetic opt-in | Synthetic sessions fail unless `allow_synthetic=True`; any synthetic input makes the complete candidate synthetic. | [ml/train.py:73](../ml/train.py#L73) |
| Eligible rows | Exactly `arbiter.source == "teacher"` and `label == "good"`. A rejected row resets frame history and the sampling timestamp. | [ml/train.py:84](../ml/train.py#L84), [ml/dataset.py:234](../ml/dataset.py#L234) |
| Sampling | Selects the first eligible frame, then frames at least `1000 / rate_hz` milliseconds after the last selected frame (100 ms in training). Uses `timestamp_ms`. | [ml/train.py:89](../ml/train.py#L89) |
| Encounter boundaries | Groups rows per encounter within each session; initializes frames separately for each encounter. Membership retains session path and encounter ID. | [ml/train.py:77](../ml/train.py#L77), [ml/train.py:102](../ml/train.py#L102), [ml/train.py:119](../ml/train.py#L119) |
| Window order and padding | Keeps the latest `history` frames, repeats the first eligible frame on the left when short, then flattens oldest to newest. | [ml/train.py:94](../ml/train.py#L94) |
| Target labels | Current selected row's `action_vector(row)`, not an earlier frame or `applied_action`. | [ml/train.py:98](../ml/train.py#L98), [ml/dataset.py:319](../ml/dataset.py#L319) |
| Mob type and metric label | Row target's `mob_type`, then session `target`, then empty string; lowercased and namespace-stripped. Empty metric labels become `"unknown"`. | [ml/train.py:92](../ml/train.py#L92), [ml/train.py:99](../ml/train.py#L99) |
| Minimum dataset size | At least three encounters containing usable examples. | [ml/train.py:101](../ml/train.py#L101) |
| Encounter shuffle | `random.Random(37001).shuffle(encounters)`. | [ml/train.py:24](../ml/train.py#L24), [ml/train.py:105](../ml/train.py#L105) |
| Split sizes | `a = min(max(1, round(n*.7)), n-2)`; `b = min(max(a+1, round(n*.85)), n-1)`. Train=`[:a]`, validation=`[a:b]`, test=`[b:]`; each has at least one encounter. | [ml/train.py:106](../ml/train.py#L106) |
| Example output | Per split: `(xs, ys, envs, mobs)`, with one environment/mob label per example. | [ml/train.py:110](../ml/train.py#L110) |
| Membership output | Per split: dictionaries containing `session`, `encounter`, `environment`. | [ml/train.py:119](../ml/train.py#L119) |
| `build_examples(sessions, history=4, *, allow_synthetic=False)` | Returns `(examples, memberships)`; its standalone history argument can be any positive integer, and its sampling rate is fixed at 10 Hz. | [ml/train.py:65](../ml/train.py#L65), [ml/train.py:124](../ml/train.py#L124) |

## Features used by training

Training calls `policy_features(row, mob)` rather than using the dataset feature
vector directly. The adapter starts with dataset extraction, then adjusts values
to match the bridge. [ml/train.py:94](../ml/train.py#L94),
[ml/features.py:47](../ml/features.py#L47)

| Actual training feature behavior | Source |
| --- | --- |
| Same ordered 46 feature names as the dataset. | [ml/features.py:11](../ml/features.py#L11), [ml/features.py:85](../ml/features.py#L85), [ml/dataset.py:22](../ml/dataset.py#L22) |
| `policy_features(row, target_type=None)` accepts an explicit configured mob; without it, uses the row's recorded `mob_type`. | [ml/features.py:34](../ml/features.py#L34), [ml/features.py:71](../ml/features.py#L71) |
| `has_sword` requires substring `"sword"`; `"diamond"`/`"netherite"` alone do not qualify. Axe/shield use their respective substrings in held/offhand text. | [ml/features.py:75](../ml/features.py#L75) |
| Terrain features default to zero and use scalar terrain members. Legacy terrain maps are not fallbacks. Terrain members are applied last and can override other named features. | [ml/features.py:81](../ml/features.py#L81) |
| Final numeric filtering excludes booleans, strings, nulls, objects, and nonfinite values, producing zero for them. | [ml/features.py:18](../ml/features.py#L18), [ml/features.py:85](../ml/features.py#L85) |
| Boolean features use JavaScript-style truthiness, including truthy empty arrays/objects. | [ml/features.py:23](../ml/features.py#L23), [ml/features.py:62](../ml/features.py#L62) |
| Numeric null/missing defaults are zero, except health defaults to 20. A non-null invalid numeric value reaches the final numeric filter. | [ml/features.py:48](../ml/features.py#L48), [ml/features.py:55](../ml/features.py#L55), [ml/features.py:85](../ml/features.py#L85) |
| Dimension fallback is null-based rather than Python's `or` fallback; dimension indicators use suffix comparisons. | [ml/features.py:78](../ml/features.py#L78) |

## Model and optimization

| Setting or output | Definition | Source |
| --- | --- | --- |
| Seed | Fixed `37001`; another seed value is rejected. Both Python and Torch RNGs are seeded. | [ml/train.py:213](../ml/train.py#L213), [ml/train.py:225](../ml/train.py#L225) |
| Execution | CPU, one Torch thread, deterministic algorithms enabled. | [ml/train.py:227](../ml/train.py#L227), [ml/train.py:229](../ml/train.py#L229) |
| Tensor dtype | Training inputs and labels are `torch.float32` on CPU. | [ml/train.py:229](../ml/train.py#L229) |
| Input/output width | Four frames times 46 features = 184 inputs; ten action outputs. Dimensions derive from `x.shape[1]` and output count. | [ml/train.py:32](../ml/train.py#L32), [ml/dataset.py:21](../ml/dataset.py#L21), [ml/dataset.py:22](../ml/dataset.py#L22), [ml/train.py:237](../ml/train.py#L237) |
| Architecture | Imported `Policy`: linear input to 64, ReLU, linear 64 to 64, ReLU, linear 64 to output count. | [ml/train.py:223](../ml/train.py#L223), [ml/export_onnx.py:15](../ml/export_onnx.py#L15) |
| Normalization | Per flattened input position, using training examples only: population mean/std (`correction=0`); std below `1e-6` becomes `1`; model input is `(x-mean)/std`. | [ml/train.py:229](../ml/train.py#L229), [ml/train.py:233](../ml/train.py#L233), [ml/train.py:241](../ml/train.py#L241) |
| Numerical checks | Rejects nonfinite training features, normalization values, and training loss. | [ml/train.py:231](../ml/train.py#L231), [ml/train.py:235](../ml/train.py#L235), [ml/train.py:245](../ml/train.py#L245) |
| Loss | `BCEWithLogitsLoss`; per-output positive weight `(N - positives + 1) / (positives + 1)`. | [ml/train.py:238](../ml/train.py#L238) |
| Optimizer | Adam, learning rate `0.001`; other Adam arguments are not explicitly set here. | [ml/train.py:240](../ml/train.py#L240) |
| Epochs/batching | Default 30 positive-integer epochs; one full-training-batch optimizer update per epoch. | [ml/train.py:211](../ml/train.py#L211), [ml/train.py:215](../ml/train.py#L215), [ml/train.py:242](../ml/train.py#L242) |

## Offline metrics

| Setting or output | Definition | Source |
| --- | --- | --- |
| Evaluation execution | `model.eval()` followed by metrics under `torch.no_grad()`. | [ml/train.py:249](../ml/train.py#L249), [ml/train.py:138](../ml/train.py#L138) |
| Prediction threshold | Raw logit `>= 0`, equivalent to sigmoid probability `>= 0.5`. | [ml/train.py:141](../ml/train.py#L141) |
| Per-output metrics | Accuracy, precision, recall, F1 for each output. Precision/recall/F1 use zero when their denominator is zero. | [ml/train.py:143](../ml/train.py#L143) |
| Overall metric | Mean correctness across all example/output cells. | [ml/train.py:154](../ml/train.py#L154) |
| Grouped metrics | `by_environment` and `by_mob`, each containing `rows` and `overall`. Metrics are produced for train, validation, and test splits. | [ml/train.py:139](../ml/train.py#L139), [ml/train.py:155](../ml/train.py#L155) |

## Hashing, export, and bundle output

| Item | Definition | Source |
| --- | --- | --- |
| Dataset hash contents | Raw `session.json` and all sorted encounter JSONLs, including rejected rows and synthetic metadata. | [ml/train.py:46](../ml/train.py#L46), [ml/train.py:56](../ml/train.py#L56) |
| Dataset hash framing | For each file, frame its relative POSIX UTF-8 filename and raw contents separately with unsigned 8-byte big-endian lengths; SHA256 each session. Sort raw session digests and SHA256 `b"combat.dataset.v1\0" + concatenated_digests`; `\0` denotes one null byte. | [ml/train.py:57](../ml/train.py#L57), [ml/train.py:61](../ml/train.py#L61) |
| Dataset mutation check | Recomputes the dataset hash after training and rejects changed data. | [ml/train.py:219](../ml/train.py#L219), [ml/train.py:251](../ml/train.py#L251) |
| Default destination | Relative to invocation working directory: `skills_store/candidates/candidate-<first 12 dataset-hash characters>`. `out_dir` overrides it. | [ml/train.py:253](../ml/train.py#L253) |
| Existing destination | Rejected with `FileExistsError`. | [ml/train.py:254](../ml/train.py#L254) |
| Staging | Creates a sibling temporary directory with prefix `.candidate-`, writes the bundle there, then renames it to the destination. | [ml/train.py:270](../ml/train.py#L270) |
| Bundle files | `model.onnx`, `metadata.json`, `skill.json`. | [ml/train.py:274](../ml/train.py#L274) |
| JSON serialization | UTF-8, indentation 2, disallow NaN, final newline. | [ml/train.py:276](../ml/train.py#L276) |
| Model hash | SHA256 of the exported ONNX bytes. | [ml/train.py:275](../ml/train.py#L275), [ml/dataset.py:324](../ml/dataset.py#L324) |
| ONNX interface | Input `observations`, float32 `[batch,184]`; output `logits`, float32 `[batch,10]`; dynamic batch dimension. | [ml/train.py:274](../ml/train.py#L274), [ml/export_onnx.py:32](../ml/export_onnx.py#L32) |
| ONNX settings | Opset 17, `dynamo=False`, `external_data=False`; model moved to CPU/eval mode. | [ml/export_onnx.py:30](../ml/export_onnx.py#L30) |
| ONNX verification | Runs ONNX checker and verifies names, float dtype, rank 2, and fixed feature/output widths. | [ml/export_onnx.py:37](../ml/export_onnx.py#L37) |
| External processing | Normalization and sigmoid remain outside the ONNX graph. | [ml/export_onnx.py:1](../ml/export_onnx.py#L1) |

## Metadata fields

| Field(s) | Value/content | Source |
| --- | --- | --- |
| `schema_version`, `artifact_type` | `1`, `"combat.tactical_policy"`. | [ml/train.py:258](../ml/train.py#L258) |
| `history`, `rate_hz` | Contract values: 4 and 10. | [ml/train.py:259](../ml/train.py#L259), [ml/train.py:32](../ml/train.py#L32) |
| `features`, `outputs` | Ordered contract lists. | [ml/train.py:260](../ml/train.py#L260) |
| `normalization.mean`, `normalization.std` | Flattened-position training statistics, serialized as lists. | [ml/train.py:261](../ml/train.py#L261) |
| `history_padding`, `history_reset` | `"repeat_first_eligible_frame"`, `"encounter_or_rejected_row"`. | [ml/train.py:262](../ml/train.py#L262) |
| `splits`, `encounter_count` | Membership dictionaries and total included encounter count. | [ml/train.py:263](../ml/train.py#L263) |
| `data_coverage.environments` | Sorted environments represented by split encounters. | [ml/train.py:256](../ml/train.py#L256), [ml/train.py:264](../ml/train.py#L264) |
| `data_coverage.absent_environments` | Recognized environment names absent from that coverage. | [ml/train.py:264](../ml/train.py#L264), [ml/dataset.py:20](../ml/dataset.py#L20) |
| `qualified_environments` | Empty list. | [ml/train.py:265](../ml/train.py#L265) |
| `metrics` | Split/output/environment/mob metrics described above. | [ml/train.py:265](../ml/train.py#L265) |
| `dataset_sha256`, `dataset_hash_algorithm` | Dataset digest and `"combat.dataset.v1"`. | [ml/train.py:266](../ml/train.py#L266) |
| `seed`, `epochs`, `created_at` | Fixed seed, requested epoch count, and `time.time()` timestamp. | [ml/train.py:267](../ml/train.py#L267) |
| `synthetic`, `promotion_eligible` | Any-input synthetic flag and its negation. These flags do not perform activation. | [ml/train.py:268](../ml/train.py#L268), [ml/train.py:212](../ml/train.py#L212) |
| `model_sha256` | Final ONNX digest, added after export. | [ml/train.py:275](../ml/train.py#L275) |

## Skill descriptor fields

| Field(s) | Value/content | Source |
| --- | --- | --- |
| `name`, `version` | `"combat.engage"`; destination directory basename. | [ml/train.py:169](../ml/train.py#L169) |
| `implementation.type`, `model_path`, `metadata_path` | `"model"` and POSIX-form artifact paths beneath the destination. | [ml/train.py:171](../ml/train.py#L171) |
| `implementation.model_sha256`, `loader`, `description` | Model digest; `"bridge/policy.js:TacticalPolicy"`; bounded arbiter-controlled combat description. | [ml/train.py:174](../ml/train.py#L174) |
| `requirements.starting_conditions` | Alive, one selected hostile target, approved fixed arena setup. | [ml/train.py:179](../ml/train.py#L179) |
| `requirements.equipment` | Record and hold agreed weapon/shield setup fixed across trials. | [ml/train.py:180](../ml/train.py#L180) |
| `requirements.allowed_environment` | Approved frozen-evaluation arenas; none qualified yet. | [ml/train.py:181](../ml/train.py#L181) |
| `requirements.observations`, `input_contract` | Ordered policy features with contract defaults; `"contracts/policy.json"`. | [ml/train.py:182](../ml/train.py#L182) |
| `requirements.inputs` | `observations: [1, history*feature_count]`, `dtype: "float32"`. | [ml/train.py:184](../ml/train.py#L184) |
| `requirements.outputs` | Ordered action-output list. | [ml/train.py:185](../ml/train.py#L185) |
| `requirements.units` | Distance: blocks; velocity: blocks/tick; angles: radians. | [ml/train.py:186](../ml/train.py#L186) |
| `requirements.synthetic`, `promotion_eligible` | Copies candidate metadata flags. | [ml/train.py:187](../ml/train.py#L187) |
| `success_check.success` | Selected target death, bot alive, no human intervention or safety violation. | [ml/train.py:191](../ml/train.py#L191) |
| `success_check.failure` | Bot death, target lost, pursuit limit, inference error, human intervention. | [ml/train.py:192](../ml/train.py#L192) |
| `success_check.time_limit_s`, `max_pursuit_distance_blocks`, `retreat_health` | `120`, `32`, `4`. | [ml/train.py:193](../ml/train.py#L193) |
| `success_check.controls` | Arbiter owns writes; release on completion, cancellation, error, or timeout. | [ml/train.py:194](../ml/train.py#L194) |
| `reset_steps[0]` | Cancel invocation and release controls. | [ml/train.py:197](../ml/train.py#L197) |
| `reset_steps[1]` | Restore terrain; remove leftover mobs, projectiles, drops. | [ml/train.py:198](../ml/train.py#L198) |
| `reset_steps[2]` | Restore bot position, health, food, equipment, inventory. | [ml/train.py:199](../ml/train.py#L199) |
| `reset_steps[3]` | Restore target and verify setup before the next trial. | [ml/train.py:200](../ml/train.py#L200) |
| `evaluation.status`, `tested_version`, `test_settings` | `"untested"`, null, null. | [ml/train.py:203](../ml/train.py#L203) |
| `evaluation.baseline`, `trial_count`, `successes`, `failures` | Null, `0`, null, null. | [ml/train.py:204](../ml/train.py#L204) |
| `evaluation.timeouts`, `human_interventions`, `results` | All null. | [ml/train.py:205](../ml/train.py#L205) |
| `evaluation.note` | Offline cloning metrics are not arena evaluation; synthetic data never qualifies for activation. | [ml/train.py:206](../ml/train.py#L206) |

## Training CLI

| Item | Definition | Source |
| --- | --- | --- |
| Positional `sessions` | One or more paths. | [ml/train.py:285](../ml/train.py#L285) |
| `--out` | Optional destination path. | [ml/train.py:286](../ml/train.py#L286) |
| `--epochs` | Integer, default 30. | [ml/train.py:287](../ml/train.py#L287) |
| `--allow-synthetic` | Boolean opt-in, default false. No CLI seed override is defined. | [ml/train.py:285](../ml/train.py#L285), [ml/train.py:288](../ml/train.py#L288) |
| Success output | Prints returned metadata as indented JSON and returns `0`. | [ml/train.py:294](../ml/train.py#L294) |
| Failure output | Catches `OSError`, `ValueError`, `RuntimeError`, and `ImportError`; exits `1` with `training failed: <error>`. | [ml/train.py:292](../ml/train.py#L292) |

## Internal interfaces

| Function inputs | Return/output | Source |
| --- | --- | --- |
| `load_policy_contract()` | Validated contract dictionary. | [ml/train.py:28](../ml/train.py#L28) |
| `_session_paths(paths)` | Sorted, resolved, deduplicated session paths. | [ml/train.py:37](../ml/train.py#L37) |
| `_hash_sessions(paths)` | Aggregate dataset SHA256 hex string. | [ml/train.py:46](../ml/train.py#L46) |
| `_prepare(sessions, history, allow_synthetic, rate_hz)` | `(examples, memberships, synthetic)`. | [ml/train.py:64](../ml/train.py#L64), [ml/train.py:121](../ml/train.py#L121) |
| `_metrics(model, examples, mean, std)` | Nested metrics dictionary. | [ml/train.py:134](../ml/train.py#L134), [ml/train.py:164](../ml/train.py#L164) |
| `_skill(out, metadata)` | Seven-field skill descriptor dictionary. | [ml/train.py:167](../ml/train.py#L167) |
| `main(argv=None)` | Parses CLI arguments, invokes training, prints metadata, returns status. | [ml/train.py:283](../ml/train.py#L283) |
