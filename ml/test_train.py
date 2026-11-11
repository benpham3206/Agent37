"""Fabricated recordings only: data selection, runtime parity, and bundle tests."""
from __future__ import annotations

import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

import numpy as np
import onnx
import onnxruntime as ort
import pytest
import torch

from ml.dataset import DEFAULT_FEATURES, OUTPUTS, DatasetError, sha256_file
from ml.export_onnx import Policy, export_onnx
from ml.features import policy_features
from ml.train import SEED, _hash_sessions, build_examples, load_policy_contract, train

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "ml/fixtures"
NAMES = ("synthetic-v1", "synthetic-v2-unknown", "synthetic-v2-human")


def write_rows(root, rows):
    (root / "encounters/demo.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8",
    )


def fabricated_sessions(tmp_path, count=10):
    roots = []
    for number, name in enumerate(NAMES):
        root = Path(shutil.copytree(FIXTURES / name, tmp_path / name))
        base = json.loads((root / "encounters/demo.jsonl").read_text().splitlines()[0])
        rows = []
        for tick in range(count):
            row = copy.deepcopy(base)
            row.update(tick=tick, timestamp_ms=1000 + 50 * tick)
            row["observation"] = {"target": {"relative_position": {"x": number * 100 + tick}, "mob_type": "zombie"}}
            row["teacher_action"] = {"attack": True, "forward": bool(tick % 2)}
            row["applied_action"] = {"attack": False}
            rows.append(row)
        write_rows(root, rows)
        roots.append(root)
    return roots


def test_feature_match_with_actual_node_bridge():
    observations = [
        {}, {"self": {}, "target": None},
        {"self": {"held_item": "diamond_axe", "offhand_item": "shield"}, "dimension": "minecraft:the_nether"},
        {"target": {"relative_position": {"x": 2, "y": -3, "z": 4}, "velocity": {"x": .2},
                    "angular_error": {"yaw": .3, "pitch": -.4}, "distance": 5,
                    "bearing": .9, "elevation": .1, "line_of_sight": True, "in_reach": False, "health": 8},
         "self": {"health": 14, "held_item": "iron_sword", "on_ground": True,
                  "cooldown": .5, "sprinting": True, "sneaking": False,
                  "incoming_attack": {"swing_detected": True, "damage": 3}},
         "terrain": {name: index / 2 for index, name in enumerate(DEFAULT_FEATURES[30:44])}},
        {"terrain": {"support_center": True, "support_forward": False,
                     "clearance_forward": 0, "drop_back": 4, "hazard_near": True}},
        {"terrain": {"support_grid": {"center": True}, "drop_depth": {"forward": 4},
                     "clearance": {"forward": True}, "hazards": {"lava": True}}},
        {"dimension": "", "terrain": {"dimension": "nether", "target_dx": 7, "is_sprinting": False}},
        {"self": {"health": True, "on_ground": {}, "incoming_attack": {"swing_detected": []}},
         "target": {"relative_position": {"x": True}, "health": None}},
    ]
    inputs = [{"observation": observation, "target_type": mob}
              for observation in observations for mob in ("zombie", "skeleton", "enderman", "blaze", "phantom", "")]
    code = f"""
        import {{DEFAULT, policyFeatures}} from {json.dumps((REPO / 'bridge/policy.js').as_uri())};
        let input=''; for await (const chunk of process.stdin) input+=chunk;
        console.log(JSON.stringify({{features:DEFAULT, vectors:JSON.parse(input).map(
            x => policyFeatures(x.observation, x.target_type))}}));
    """
    result = subprocess.run(["node", "--input-type=module", "-e", code],
                            input=json.dumps(inputs), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    actual = json.loads(result.stdout)
    contract = load_policy_contract()
    assert actual["features"] == contract["features"] == DEFAULT_FEATURES
    bridge = (REPO / "bridge/policy.js").read_text()
    assert ast.literal_eval(re.search(r"const keys=(\[[^;]+\]);", bridge).group(1)) == contract["outputs"] == OUTPUTS
    for record, expected in zip(inputs, actual["vectors"]):
        assert policy_features({"observation": record["observation"]}, record["target_type"]) == expected


def test_contract_drift_is_rejected(monkeypatch):
    monkeypatch.setattr("ml.train.DEFAULT_FEATURES", ["invented"])
    with pytest.raises(ValueError, match="feature/output"):
        load_policy_contract()


def test_strict_teacher_selection_and_history_reset(tmp_path):
    roots = fabricated_sessions(tmp_path, 12)
    for root in roots:
        rows = [json.loads(line) for line in (root / "encounters/demo.jsonl").read_text().splitlines()]
        # Every rejected row lies between otherwise sampled 10 Hz frames.
        for index, source, label in (
            (1, "teacher", "bad"), (3, "human", "good"), (5, "", "good"),
            (7, "survival", "good"), (9, "emergency", "good"), (11, "teacher", "unlabelled"),
        ):
            rows[index]["label"] = label
            rows[index]["arbiter"]["source"] = source
            if source != "teacher" and "controller_id" in rows[index]:
                rows[index]["controller_id"] = None
            rows[index]["observation"]["target"]["relative_position"]["x"] = 999999
        write_rows(root, rows)
    examples, splits = build_examples(roots, allow_synthetic=True)
    assert all(len(group) == 1 for group in splits.values())
    for xs, ys, _, _ in examples.values():
        assert len(xs) == 6
        for window, label in zip(xs, ys):
            frame_values = window[::len(DEFAULT_FEATURES)]
            assert len(set(frame_values)) == 1  # Every rejected row resets padding.
            assert 999999 not in window
            assert label[OUTPUTS.index("attack")] == 1  # Requested, not applied action.


def test_sampling_padding_encounters_and_sessions_never_mix(tmp_path):
    roots = fabricated_sessions(tmp_path)
    examples, memberships = build_examples(roots, allow_synthetic=True)
    keys = [(m["session"], m["encounter"]) for group in memberships.values() for m in group]
    assert len(keys) == len(set(keys)) == 3  # Reused 'demo' IDs in different sessions are valid.
    for split, (xs, _, _, _) in examples.items():
        assert len(xs) == 5
        number = NAMES.index(Path(memberships[split][0]["session"]).name)
        assert xs[0][::46] == [number * 100] * 4
        assert xs[-1][::46] == [number * 100 + i for i in (2, 4, 6, 8)]
    # Add another encounter to a single session with a distinct feature sentinel.
    root = roots[0]
    rows = [json.loads(line) for line in (root / "encounters/demo.jsonl").read_text().splitlines()]
    for row in rows:
        row["encounter_id"] = "second"
        row["observation"]["target"]["relative_position"]["x"] += 1000
    (root / "encounters/second.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    examples, memberships = build_examples(roots, allow_synthetic=True)
    assert sum(map(len, memberships.values())) == 4
    for xs, _, _, _ in examples.values():
        for window in xs:
            values = window[::46]
            assert max(values) - min(values) <= 6
    assert build_examples(list(reversed(roots)), allow_synthetic=True) == (examples, memberships)


def test_validation_precedes_filtering_and_rejects_insufficient_data(tmp_path):
    roots = fabricated_sessions(tmp_path)
    file = roots[0] / "encounters/demo.jsonl"
    rows = [json.loads(line) for line in file.read_text().splitlines()]
    rows[1]["label"] = "bad"
    rows[1]["tick"] = -1
    write_rows(roots[0], rows)
    with pytest.raises(DatasetError, match="tick"):
        build_examples(roots, allow_synthetic=True)
    with pytest.raises(ValueError, match="three usable"):
        build_examples([roots[1]], allow_synthetic=True)
    for row in rows:
        row["tick"] = rows.index(row)
        row["label"] = "bad"
    write_rows(roots[0], rows)
    with pytest.raises(ValueError, match="three usable"):
        build_examples(roots, allow_synthetic=True)


def test_synthetic_requires_opt_in_and_fixed_seed(tmp_path):
    with pytest.raises(ValueError, match="allow-synthetic"):
        train([FIXTURES], tmp_path / "refused")
    with pytest.raises(ValueError, match="fixed at 37001"):
        train([FIXTURES], tmp_path / "refused", seed=1, allow_synthetic=True)
    with pytest.raises(ValueError, match="positive integer"):
        train([FIXTURES], tmp_path / "refused", epochs=0, allow_synthetic=True)
    assert not (tmp_path / "refused").exists()


def test_hash_covers_metadata_rejected_rows_and_is_location_independent(tmp_path):
    roots = fabricated_sessions(tmp_path / "original")
    before = _hash_sessions(roots)
    moved = [Path(shutil.copytree(root, tmp_path / "moved" / root.name)) for root in roots]
    assert _hash_sessions(moved[::-1] + [moved[0]]) == before
    session = moved[0] / "session.json"
    original = session.read_bytes()
    data = json.loads(original)
    data["synthetic"] = False
    session.write_text(json.dumps(data))
    assert _hash_sessions(moved) != before
    session.write_bytes(original)
    rows = [json.loads(line) for line in (moved[0] / "encounters/demo.jsonl").read_text().splitlines()]
    rows[1]["label"] = "excluded"
    write_rows(moved[0], rows)
    assert _hash_sessions(moved) != before
    # Independent implementation of the documented framing.
    digests = []
    for root in roots:
        framed = b""
        for file in [root / "session.json", *sorted((root / "encounters").glob("*.jsonl"))]:
            for block in (file.relative_to(root).as_posix().encode(), file.read_bytes()):
                framed += len(block).to_bytes(8, "big") + block
        digests.append(hashlib.sha256(framed).digest())
    assert before == hashlib.sha256(b"combat.dataset.v1\0" + b"".join(sorted(digests))).hexdigest()


def runtime(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def test_export_matches_torch_raw_logits_and_dynamic_batch(tmp_path):
    torch.manual_seed(SEED)
    model = Policy(184, 10).cpu().eval()
    path = export_onnx(model, tmp_path / "model.onnx", 184, 10)
    onnx.checker.check_model(onnx.load(str(path)))
    session = runtime(path)
    assert session.get_inputs()[0].name == "observations"
    assert session.get_inputs()[0].shape == ["batch", 184]
    assert session.get_outputs()[0].name == "logits"
    assert session.get_outputs()[0].shape == ["batch", 10]
    for batch in (1, 3):
        probes = torch.linspace(-3, 3, batch * 184).reshape(batch, 184)
        with torch.no_grad():
            expected = model(probes).numpy()
        actual = session.run(["logits"], {"observations": probes.numpy()})[0]
        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-6)
        assert np.array_equal(actual >= 0, 1 / (1 + np.exp(-actual)) >= .5)


def test_fixture_cli_bundle_under_sixty_seconds(tmp_path):
    env = dict(os.environ, PYTHONPATH=str(REPO))
    started = time.perf_counter()
    result = subprocess.run(
        [sys.executable, "-m", "ml.train", str(FIXTURES), "--allow-synthetic"],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60,
    )
    elapsed = time.perf_counter() - started
    assert result.returncode == 0, result.stderr
    assert elapsed < 60
    metadata = json.loads(result.stdout)
    bundle = tmp_path / "skills_store/candidates" / f"candidate-{metadata['dataset_sha256'][:12]}"
    assert {p.name for p in bundle.iterdir()} == {"model.onnx", "metadata.json", "skill.json"}
    assert metadata == json.loads((bundle / "metadata.json").read_text())
    assert metadata["seed"] == SEED
    assert metadata["epochs"] == 30
    assert metadata["synthetic"] is True and metadata["promotion_eligible"] is False
    assert metadata["qualified_environments"] == []
    assert metadata["model_sha256"] == sha256_file(bundle / "model.onnx")
    assert metadata["dataset_sha256"] == _hash_sessions([FIXTURES])
    assert metadata["features"] == DEFAULT_FEATURES and metadata["outputs"] == OUTPUTS
    assert metadata["history"] == 4 and metadata["rate_hz"] == 10
    examples, memberships = build_examples([FIXTURES], allow_synthetic=True)
    assert metadata["splits"] == memberships and metadata["encounter_count"] == 3
    x = torch.tensor(examples["train"][0], dtype=torch.float32)
    expected_std = x.std(0, correction=0)
    expected_std[expected_std < 1e-6] = 1
    np.testing.assert_array_equal(metadata["normalization"]["mean"], x.mean(0).numpy())
    np.testing.assert_array_equal(metadata["normalization"]["std"], expected_std.numpy())
    assert len(metadata["normalization"]["mean"]) == len(metadata["normalization"]["std"]) == 184
    assert all(np.isfinite(metadata["normalization"]["mean"]))
    assert all(np.array(metadata["normalization"]["std"]) > 0)
    for scores in metadata["metrics"].values():
        for output in OUTPUTS:
            assert set(scores[output]) == {"accuracy", "precision", "recall", "f1"}
        assert scores["by_mob"] and scores["by_environment"]
    skill = json.loads((bundle / "skill.json").read_text())
    assert set(skill) == {"name", "version", "implementation", "requirements", "success_check", "reset_steps", "evaluation"}
    assert skill["name"] == "combat.engage"
    for key, filename in (("model_path", "model.onnx"), ("metadata_path", "metadata.json")):
        assert (tmp_path / skill["implementation"][key]).resolve() == (bundle / filename).resolve()
    assert skill["implementation"]["model_sha256"] == metadata["model_sha256"]
    assert skill["evaluation"]["status"] == "untested" and skill["evaluation"]["trial_count"] == 0
    assert skill["requirements"]["synthetic"] is True
    assert skill["requirements"]["promotion_eligible"] is False
    assert not list(tmp_path.rglob("active*.json"))
    # Bridge-style external normalization and actual CPU inference.
    mean, std = (np.asarray(metadata["normalization"][k], dtype=np.float32) for k in ("mean", "std"))
    inputs = (np.asarray(examples["test"][0], dtype=np.float32) - mean) / std
    logits = runtime(bundle / "model.onnx").run(["logits"], {"observations": inputs})[0]
    assert logits.shape == (1, 10) and np.isfinite(logits).all()
    # Deterministic model bytes despite a fresh training call and different output location.
    second = train([FIXTURES], tmp_path / "second", allow_synthetic=True)
    assert second["model_sha256"] == metadata["model_sha256"]
    assert second["metrics"] == metadata["metrics"]
    with pytest.raises(FileExistsError):
        train([FIXTURES], bundle, epochs=1, allow_synthetic=True)
    assert sha256_file(bundle / "model.onnx") == metadata["model_sha256"]
    print(f"fixture training/export: {elapsed:.2f}s; candidate: {bundle}")


def test_normalization_uses_only_training_split(tmp_path):
    roots = fabricated_sessions(tmp_path / "data", count=20)
    examples, _ = build_examples(roots, allow_synthetic=True)
    expected = torch.tensor(examples["train"][0], dtype=torch.float32)
    metadata = train(roots, tmp_path / "candidate", epochs=1, allow_synthetic=True)
    np.testing.assert_allclose(metadata["normalization"]["mean"], expected.mean(0).numpy())
    std = expected.std(0, correction=0)
    std[std < 1e-6] = 1
    np.testing.assert_allclose(metadata["normalization"]["std"], std.numpy())


def test_export_failure_does_not_publish_partial_candidate(tmp_path, monkeypatch):
    def fail(*args):
        raise RuntimeError("injected export failure")
    monkeypatch.setattr("ml.export_onnx.export_onnx", fail)
    with pytest.raises(RuntimeError, match="injected export failure"):
        train([FIXTURES], tmp_path / "candidate", epochs=1, allow_synthetic=True)
    assert not (tmp_path / "candidate").exists()
    assert not list(tmp_path.glob(".candidate-*"))
