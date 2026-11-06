# Combat cloning and ONNX candidates

This ports `C:/Github/Agent-37/harness/combat/train.py` and its combat contract.
Use Python 3.11+ on Windows or Linux. Install the pinned CPU dependencies into
a virtual environment; run commands from the repository root:

```console
python -m pip install -r ml/requirements.txt
python -m ml.train path/to/session-a path/to/session-b path/to/session-c
python -m pytest ml
```

Inputs may be individual sessions or dataset directories. At least three
encounters containing eligible rows are required for nonempty encounter-level
train/validation/test partitions. The seed is fixed at 37001. Training is a
30-epoch full-batch CPU MLP (64/64 ReLU, weighted BCE, Adam at 0.001), with one
Torch thread and deterministic algorithms. `--epochs` changes the epoch count.

Only `label == "good"` AND `arbiter.source == "teacher"` qualify. Validation
precedes filtering; malformed excluded rows still fail the session. Requested
`teacher_action`, not `applied_action`, supplies labels. Every rejected row and
every encounter resets history. Encounters are identified by session path and
encounter ID; equal IDs from different sessions are independent. The stable
split is approximately 70/15/15, with at least one encounter in every partition.

Eligible observations are sampled at most every 100 ms using `timestamp_ms`,
starting over after a rejection. Four frames are flattened oldest to newest;
short runs repeat their first eligible frame on the left. No observation from
an excluded row enters a history. This allows the existing tiny fixtures to
exercise export. Padding is a training convention; the current bridge must
have accumulated four observations before its fixed-width model can infer.

`ml/features.py` uses `ml/dataset.py` and adapts its upstream equipment and
legacy terrain behavior to this checkout's runtime. The feature-match test
executes the actual Node feature function, checks order and representative
values (including nulls, terrain and equipment), and checks output order.

## Runtime contract

- `bridge/policy.js:3` defines the ordered 46 features.
- `bridge/policy.js:12` reads `normalization.mean` / `normalization.std`.
- `bridge/policy.js:13` flattens history and normalizes it externally, feeds
  float32 `observations` `[1,184]`, reads raw `logits` `[1,10]`, and applies
  sigmoid threshold 0.5 in its hard-coded output order.

The export supports dynamic batch size and opset 17. It contains no
normalization or sigmoid. `ml/export_onnx.py` exposes the shared `Policy` MLP
and `export_onnx(model, path, input_size, output_size)` helper. Torch/ONNX Runtime
parity and dynamic batches are verified in pytest. Normalization is learned
from the training partition only; population standard deviations below 1e-6
are replaced by one, including the single-example case.

Default output is `skills_store/candidates/candidate-<dataset-sha256-prefix>/`
containing `model.onnx`, `metadata.json`, and `skill.json`. `--out PATH` selects
a new candidate directory. Existing candidates are never overwritten. Bundles
are staged beside their destination and published only after successful export.
No Torch checkpoints, recordings, registry, or active pointer are written.

Metadata includes feature/output order, history/rate, normalization, split
memberships, per-output/per-mob/per-environment offline metrics, seed, epochs,
coverage, SHA256 hashes, and synthetic eligibility. The dataset hash covers raw
`session.json` and all encounter bytes, including rejected rows. For each
session, relative UTF-8 filenames and contents are each prefixed by their
8-byte unsigned big-endian lengths and SHA256-hashed. Sort the raw session
digests and hash `b"combat.dataset.v1\0" + concatenated_digests`. Paths outside
the session are excluded, so relocating an unchanged dataset preserves its hash.
`model_sha256` hashes the final ONNX bytes. Metadata timestamps are not part of
the model hash; repeat runs in the pinned environment produce identical models.

`skill.json` contains exactly the seven top-level fields in
`docs/skill-format.md`. Implementation paths resolve from the directory where
training was invoked (absolute `--out` produces absolute paths). Evaluation is
explicitly **untested**, with unavailable measurements null. Offline prediction
metrics make no claim about combat success. Real-data candidates still require
frozen repeated zombie/skeleton arena trials without interventions or safety
violations before any registry may activate them.

## Synthetic verification only

```console
python -m ml.train ml/fixtures --allow-synthetic --out ml/.test-artifacts/skills_store/candidates/fixture
```

Fixture input requires `--allow-synthetic`. If ANY input session is synthetic,
the whole candidate is marked `synthetic: true`, `promotion_eligible: false`,
with no qualified environments. The skill descriptor repeats those restrictions.
This flag never authorizes activation. The upstream Python registry's promotion
guard rejects these fields. This checkout's bridge loader does not enforce
promotion eligibility itself; do not treat a direct `/combat/engage` request as
registry activation. No activation command is provided by this training port.

Fixtures are fabricated and must never be presented as real recordings or
combat evidence. Keep all generated models and recordings untracked. The
verification directory above is ignored; choose an ignored external artifact
store for real training. Do not commit generated candidates or real data.

For a workspace-limited test run, set `PYTEST_ADDOPTS` to
`--basetemp=ml/.test-artifacts/pytest -o cache_dir=.test-artifacts/cache`
before running `python -m pytest ml`. All test candidates are synthetic.
