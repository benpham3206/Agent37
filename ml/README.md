Combat dataset loader, ported from
[`Agent-37/harness/combat/dataset.py`](https://github.com/benpham3206/Agent-37/blob/main/harness/combat/dataset.py).
The recording contract is [`docs/recording-format.md`](../docs/recording-format.md).
Runtime requirements: Python 3.11 or newer, standard library only.

```python
from ml.dataset import load_session, load_encounter, feature_vector, action_vector

rows = load_session("data/session-id", demos_only=True)
# Only label == "good" and arbiter.source == "teacher" qualify.
features = [feature_vector(row) for row in rows]
actions = [action_vector(row) for row in rows]
```

`load_encounter(path)` reads a standalone JSONL file. `load_session(path)` also
checks session metadata, session/encounter IDs, schema agreement, and fixed bot
identity. Both return normalized row dictionaries, preserve all payload values,
and raise `DatasetError` for invalid input. `validate_session(path)` returns the
upstream `Validation` report instead of raising for recording errors.

Version 1's `server_time_ms`, `agent_name`, and `controller_id` are always `None`.
Version 2 requires those keys, accepts nulls, and checks their documented types.
No identity or server time is inferred from paths, metadata, or host clocks.

Rows stay in file order. Timing checks use `timestamp_ms`, with the upstream
250 ms maximum gap by default; pass `max_gap_ms=None` to disable that limit.
Host clock changes are reported as non-monotone timestamps. No timing checks use
`server_time_ms`, `server_tick`, or tick-to-time conversion. Consumers must keep
histories within encounter boundaries, including after selecting demo rows.

The upstream feature/output order, action extraction, SHA-256 helper, and
synthetic-data eligibility rule are retained. Feature extraction recognizes the
current bridge's terrain scalars as well as upstream map-shaped terrain. Missing
`disengage` defaults to false for the policy vector; it is not required in a
recorded action. Session environment comes from `environment_label`.

Validate a session folder or a dataset root (also accepts multiple paths):

```console
python ml/dataset.py --check ml/fixtures
3 sessions, 0 invalid
```

The command prints the session count and invalid count, followed by the path and
reason for each failure, and exits 1 for invalid input. Empty encounters, blank
records, malformed JSON, missing metadata, and empty dataset roots are explicit
errors. Invalid sessions are never partially returned or silently filtered out.
The invalid count also includes input roots that cannot be scanned or contain no
sessions. Fixture data is entirely synthetic; see [fixtures/README.md](fixtures/README.md).

Run the tests with `python -m pytest ml` (pytest is a test-only requirement).
