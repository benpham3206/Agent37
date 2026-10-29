"""Only fabricated recordings are used; no real gameplay data is checked in."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from ml.dataset import (
    DEFAULT_FEATURES, OUTPUTS, DatasetError, action_vector, feature_vector,
    is_demo_row, load_encounter, load_session, sha256_file, validate_session,
)

FIXTURES = Path(__file__).parent / "fixtures"
NAMES = ("synthetic-v1", "synthetic-v2-unknown", "synthetic-v2-human")
NEW_FIELDS = ("server_time_ms", "agent_name", "controller_id")


def raw_rows(name="synthetic-v2-human"):
    return [json.loads(line) for line in (FIXTURES / name / "encounters/demo.jsonl").read_text(encoding="utf-8").splitlines()]


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def encounter(tmp_path, rows, name="demo.jsonl"):
    path = tmp_path / name
    write_rows(path, rows)
    return path


def session_copy(tmp_path, name="synthetic-v2-human"):
    return Path(shutil.copytree(FIXTURES / name, tmp_path / name))


def cli(*paths):
    return subprocess.run(
        [sys.executable, str(Path(__file__).with_name("dataset.py")), "--check", *map(str, paths)],
        capture_output=True, text=True, check=False,
    )


@pytest.mark.parametrize("name,count,demos", [(NAMES[0], 2, 1), (NAMES[1], 2, 1), (NAMES[2], 3, 2)])
def test_three_synthetic_formats(name, count, demos):
    path = FIXTURES / name
    report = validate_session(path)
    assert report.valid, report.errors
    assert report.rows == count
    assert report.encounters == ("demo",)
    assert report.synthetic and not report.eligible
    assert report.environment == "open_surface"
    assert "SYNTHETIC" in json.loads((path / "session.json").read_text())["notes"]
    rows = load_session(path)
    assert len(rows) == count
    assert len(load_session(path, demos_only=True)) == demos
    assert [row["timestamp_ms"] for row in rows] == [1000 + 50 * i for i in range(count)]


def test_v1_fields_are_unknown_without_inference_or_payload_changes(tmp_path):
    original = raw_rows(NAMES[0])
    # V1 has no defined identity/time values, even if stray future keys are present.
    for row in original:
        row.update(server_time_ms=123456, agent_name="NotAnIdentity", controller_id="NotAController")
    loaded = load_encounter(encounter(tmp_path, original, "SyntheticBot-1792868400000.jsonl"))
    for raw, normalized in zip(original, loaded):
        assert {key: normalized[key] for key in NEW_FIELDS} == dict.fromkeys(NEW_FIELDS)
        assert {key: value for key, value in normalized.items() if key not in NEW_FIELDS} == {key: value for key, value in raw.items() if key not in NEW_FIELDS}
        assert raw["agent_name"] == "NotAnIdentity"  # No mutation.
    assert loaded[0]["observation"]["self"]["armor"] is None
    assert loaded[0]["observation"]["self"]["effects"] == []
    assert loaded[0]["observation"]["self"]["yaw"] == 0
    assert loaded[0]["observation"]["target"] is None


def test_v2_unknowns_and_connection_ids_are_preserved():
    unknown = load_session(FIXTURES / NAMES[1])
    assert all(all(row[key] is None for key in NEW_FIELDS) for row in unknown)
    human = load_session(FIXTURES / NAMES[2])
    assert [row["controller_id"] for row in human] == ["synthetic-connection-a", "synthetic-connection-b", None]
    assert all(row["agent_name"] == "SyntheticBot" for row in human)
    assert human == raw_rows()


@pytest.mark.parametrize("key", NEW_FIELDS)
def test_v2_requires_each_new_key_even_on_non_demo_rows(tmp_path, key):
    rows = raw_rows()
    del rows[2][key]
    with pytest.raises(DatasetError, match=rf"demo.jsonl:3:.*{key}"):
        load_encounter(encounter(tmp_path, rows))


@pytest.mark.parametrize("version", [0, 3, "2", True, None])
def test_unknown_or_non_integer_versions_are_rejected(tmp_path, version):
    row = raw_rows()[0]
    row["schema_version"] = version
    with pytest.raises(DatasetError, match="schema_version"):
        load_encounter(encounter(tmp_path, [row]))


def test_all_documented_v1_envelope_keys_are_required(tmp_path):
    for key in raw_rows(NAMES[0])[0]:
        row = raw_rows(NAMES[0])[0]
        del row[key]
        with pytest.raises(DatasetError, match=key):
            load_encounter(encounter(tmp_path, [row]))


@pytest.mark.parametrize("source", ["teacher", "human", "skill", "survival", "emergency", "idle", "", None])
@pytest.mark.parametrize("label", ["good", "bad", "excluded", "unlabelled"])
def test_demo_selection_uses_exact_arbiter_winner_and_label(source, label):
    row = raw_rows()[0]
    row["arbiter"] = {"source": source}
    row["label"] = label
    for provenance in ["privileged_hitbox", "human", "teacher"]:
        row["source"] = provenance
        assert is_demo_row(row) == (source == "teacher" and label == "good")
    assert not is_demo_row({"label": "good", "source": "human"})


def test_timing_uses_host_timestamps_and_resets_between_encounters(tmp_path):
    root = session_copy(tmp_path)
    rows = raw_rows()
    for i, row in enumerate(rows):
        row["server_time_ms"] = 999999 - i  # Intentionally decreasing.
        row["server_tick"] = 100000 - i
        row["tick"] = i * 100  # A row counter, not an elapsed-time clock.
    write_rows(root / "encounters/demo.jsonl", rows)
    other = copy.deepcopy(rows)
    for row in other:
        row["encounter_id"] = "other"
    write_rows(root / "encounters/other.jsonl", other)
    assert validate_session(root).valid
    assert len(load_session(root)) == 6
    rows[1]["timestamp_ms"] = 1400
    write_rows(root / "encounters/demo.jsonl", rows)
    report = validate_session(root)
    assert not report.valid
    assert any("timestamp_ms" in error and "gap" in error for error in report.errors)
    assert validate_session(root, max_gap_ms=500).errors == ("demo.jsonl:3: non-monotone timestamp_ms",)


@pytest.mark.parametrize("text,reason", [("", "empty encounter"), ("\n", "blank row"), (" \n", "blank row"), ("{oops}\n", "malformed JSON"), ("null\n", "JSON object"), ("[]\n", "JSON object"), ("NaN\n", "malformed JSON")])
def test_empty_and_malformed_encounters_report_location(tmp_path, text, reason):
    path = tmp_path / "broken.jsonl"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(DatasetError, match=rf"broken.jsonl:1:.*{reason}"):
        load_encounter(path)


def test_malformed_middle_and_blank_lines_are_never_skipped(tmp_path):
    valid = json.dumps(raw_rows()[0]) + "\n"
    path = tmp_path / "broken.jsonl"
    for bad in ["{oops}\n", "\n"]:
        path.write_text(valid + bad + valid, encoding="utf-8")
        with pytest.raises(DatasetError, match="broken.jsonl:2:"):
            load_encounter(path)


def test_validation_reports_all_bad_encounters_and_loading_refuses_partial_data(tmp_path):
    root = session_copy(tmp_path)
    (root / "encounters/empty.jsonl").touch()
    (root / "encounters/broken.jsonl").write_text("{oops}\n", encoding="utf-8")
    report = validate_session(root)
    assert not report.valid and report.errors
    assert any("empty.jsonl:1: empty encounter" in error for error in report.errors)
    assert any("broken.jsonl:1: malformed JSON" in error for error in report.errors)
    with pytest.raises(DatasetError, match="invalid session"):
        load_session(root, demos_only=True)


@pytest.mark.parametrize("contents,reason", [("null", "JSON object"), ("{bad}", "malformed JSON"), ("", "malformed JSON")])
def test_bad_metadata_is_reported_not_a_traceback(tmp_path, contents, reason):
    root = session_copy(tmp_path)
    (root / "session.json").write_text(contents, encoding="utf-8")
    report = validate_session(root)
    assert not report.valid
    assert any("session.json" in error and reason in error for error in report.errors)


def test_session_version_identity_and_filename_consistency(tmp_path):
    root = session_copy(tmp_path)
    file = root / "encounters/demo.jsonl"
    for key, value, reason in [("schema_version", 1, "schema_version"), ("session_id", "other", "session_id"), ("encounter_id", "other", "encounter_id"), ("agent_name", None, "agent_name")]:
        rows = raw_rows()
        rows[1][key] = value
        write_rows(file, rows)
        report = validate_session(root)
        assert not report.valid
        assert any(reason in error for error in report.errors)


@pytest.mark.parametrize("key,value", [("server_time_ms", -1), ("server_time_ms", 1.5), ("server_time_ms", True), ("agent_name", ""), ("agent_name", 5), ("controller_id", " "), ("controller_id", {})])
def test_invalid_v2_values_are_reported(tmp_path, key, value):
    row = raw_rows()[0]
    row[key] = value
    with pytest.raises(DatasetError, match=key):
        load_encounter(encounter(tmp_path, [row]))


def test_non_teacher_cannot_claim_a_controller(tmp_path):
    row = raw_rows()[0]
    row["arbiter"]["source"] = "survival"
    with pytest.raises(DatasetError, match="controller_id"):
        load_encounter(encounter(tmp_path, [row]))


@pytest.mark.parametrize("key,value", [("timestamp_ms", True), ("timestamp_ms", "1000"), ("tick", True), ("tick", "0"), ("observation", None), ("teacher_action", []), ("arbiter", None)])
def test_bad_clocks_and_payload_shapes_report_errors(tmp_path, key, value):
    row = raw_rows()[0]
    row[key] = value
    with pytest.raises(DatasetError, match=key):
        load_encounter(encounter(tmp_path, [row]))


def test_missing_metadata_or_encounters_have_explicit_reasons(tmp_path):
    root = tmp_path / "missing"
    report = validate_session(root)
    assert not report.valid and any("missing session.json" in error for error in report.errors)
    root = session_copy(tmp_path)
    (root / "encounters/demo.jsonl").unlink()
    report = validate_session(root)
    assert not report.valid and any("no encounter files" in error for error in report.errors)
    (root / "encounters").rmdir()
    report = validate_session(root)
    assert not report.valid and any("missing encounters/" in error for error in report.errors)


def test_v2_session_requires_agent_name(tmp_path):
    root = session_copy(tmp_path)
    file = root / "session.json"
    metadata = json.loads(file.read_text())
    del metadata["agent_name"]
    file.write_text(json.dumps(metadata), encoding="utf-8")
    assert any("agent_name" in error for error in validate_session(root).errors)


def test_feature_output_contract_and_deterministic_extraction():
    contract = json.loads((Path(__file__).parents[1] / "contracts/policy.json").read_text())
    assert DEFAULT_FEATURES == contract["features"]
    assert OUTPUTS == contract["outputs"]
    row = raw_rows(NAMES[0])[0]
    assert action_vector(row) == [1.0] + [0.0] * 9
    features = feature_vector(row)
    assert len(features) == len(DEFAULT_FEATURES)
    assert all(isinstance(value, float) for value in features)
    assert feature_vector(row, ["self_health", "on_ground", "cooldown", "dimension_overworld"]) == [20.0, 1.0, 0.0, 1.0]
    row["observation"]["target"] = {"mob_type": "minecraft:zombie", "relative_position": {"x": 2, "y": 1, "z": 3}, "health": None}
    assert feature_vector(row, ["target_zombie", "target_dx", "target_health"]) == [1.0, 2.0, 20.0]
    with pytest.raises(ValueError, match="unknown policy feature"):
        feature_vector(row, ["invented_feature"])


def test_feature_vectors_handle_actual_bridge_terrain_and_unknowns():
    row = raw_rows(NAMES[0])[0]
    row["observation"]["terrain"] = {
        "support_grid": [[{"solid": False}] * 3] * 3,
        "support_forward": False, "support_center": 1,
        "drop_forward": 3,
        "clearance": {"forward": {"body_clear": False, "head_clear": True, "available": True}},
        "clearance_forward": 0,
        "hazards": {"lava": False, "deep_drop": False}, "hazard_near": 0,
    }
    assert feature_vector(row, ["support_center", "support_forward", "drop_forward", "clearance_forward", "hazard_near"]) == [1.0, 0.0, 3.0, 0.0, 0.0]
    row["observation"]["terrain"] = None
    assert feature_vector(row, ["support_center", "drop_forward", "clearance_forward", "hazard_near"]) == [0.0] * 4


def test_hashing_retains_upstream_behavior():
    file = FIXTURES / NAMES[0] / "session.json"
    assert sha256_file(file) == hashlib.sha256(file.read_bytes()).hexdigest()


def test_check_mode_counts_sessions_and_explains_each_invalid_session(tmp_path):
    good = cli(FIXTURES)
    assert good.returncode == 0, good.stderr
    assert good.stdout.strip() == "3 sessions, 0 invalid"
    root = session_copy(tmp_path)
    (root / "encounters/empty.jsonl").touch()
    (root / "encounters/broken.jsonl").write_text("{oops}\n", encoding="utf-8")
    bad = cli(tmp_path)
    assert bad.returncode == 1
    assert "1 sessions, 1 invalid" in bad.stdout
    assert "empty.jsonl:1: empty encounter" in bad.stdout
    assert "broken.jsonl:1: malformed JSON" in bad.stdout
    assert "Traceback" not in bad.stderr
    direct = cli(FIXTURES / NAMES[0])
    assert direct.returncode == 0 and direct.stdout.strip() == "1 sessions, 0 invalid"


def test_check_mode_does_not_hide_a_session_with_missing_metadata(tmp_path):
    root = session_copy(tmp_path)
    (root / "session.json").unlink()
    result = cli(tmp_path)
    assert result.returncode == 1
    assert "1 sessions, 1 invalid" in result.stdout and "missing session.json" in result.stdout


def test_check_mode_reports_empty_or_missing_dataset(tmp_path):
    for path in [tmp_path, tmp_path / "missing"]:
        result = cli(path)
        assert result.returncode == 1
        assert "0 sessions, 1 invalid" in result.stdout
        assert "no sessions" in result.stdout.lower() or "does not exist" in result.stdout.lower()
        assert "Traceback" not in result.stderr
