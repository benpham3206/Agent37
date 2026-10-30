"""CPU behavior cloning ported from Agent-37/harness/combat/train.py.

Run python -m ml.train SESSION_OR_DATASET ... [--allow-synthetic] [--out PATH].
Training creates candidates only; frozen arena evaluation and registry activation
are separate work. Synthetic candidates are permanently ineligible for promotion.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import random
import tempfile
import time

from .dataset import (
    DEFAULT_FEATURES, OUTPUTS, ENVIRONMENTS, DatasetError, _discover_sessions,
    action_vector, is_demo_row, load_session, sha256_file, validate_session,
)
from .features import policy_features

SEED = 37001
REPO = Path(__file__).resolve().parents[1]


def load_policy_contract():
    contract = json.loads((REPO / "contracts/policy.json").read_text(encoding="utf-8"))
    if contract["features"] != DEFAULT_FEATURES or contract["outputs"] != OUTPUTS:
        raise ValueError("contracts/policy.json does not match Python feature/output definitions")
    if contract["history"] != 4 or contract["rate_hz"] != 10:
        raise ValueError("this bridge requires history=4 and rate_hz=10")
    return contract


def _session_paths(paths):
    if isinstance(paths, (str, Path)):
        paths = [paths]
    sessions = {root.resolve() for path in paths for root in _discover_sessions(Path(path))}
    if not sessions:
        raise DatasetError("no sessions supplied")
    return sorted(sessions)


def _hash_sessions(paths):
    """Hash framed session.json + encounter names/bytes, independent of location.

    Each session digest frames relative UTF-8 filenames and raw contents with
    unsigned 8-byte big-endian lengths. Sort session digests before aggregation.
    Include rejected rows and synthetic metadata so the hash covers provenance.
    """
    digests = []
    for root in _session_paths(paths):
        digest = hashlib.sha256()
        for file in [root / "session.json", *sorted((root / "encounters").glob("*.jsonl"))]:
            for block in (file.relative_to(root).as_posix().encode("utf-8"), file.read_bytes()):
                digest.update(len(block).to_bytes(8, "big"))
                digest.update(block)
        digests.append(digest.digest())
    return hashlib.sha256(b"combat.dataset.v1\0" + b"".join(sorted(digests))).hexdigest()


def _prepare(sessions, history, allow_synthetic, rate_hz):
    if type(history) is not int or history < 1:
        raise ValueError("history must be a positive integer")
    encounters, synthetic = [], False
    for root in sessions:
        rows = load_session(root)  # Validate all rows BEFORE filtering.
        report = validate_session(root)
        if not report.valid:
            raise DatasetError(f"invalid session {root}: {report.errors}")
        if report.synthetic and not allow_synthetic:
            raise ValueError(f"{root}: synthetic sessions require --allow-synthetic; never promotable")
        synthetic = synthetic or report.synthetic
        session = json.loads((root / "session.json").read_text(encoding="utf-8"))
        groups = defaultdict(list)
        for row in rows:
            groups[row["encounter_id"]].append(row)
        for eid, part in groups.items():
            xs, ys, mobs, frames = [], [], [], []
            last_time = None
            for row in part:
                if not is_demo_row(row):
                    frames, last_time = [], None
                    continue
                # Sample at the contract's 10 Hz; rejected rows reset even when
                # they lie between samples. Timing uses recording timestamps.
                timestamp = row["timestamp_ms"]
                if last_time is not None and timestamp - last_time < 1000 / rate_hz:
                    continue
                target = row["observation"].get("target") or {}
                mob = str(target.get("mob_type") or session.get("target") or "").lower().split(":")[-1]
                frames.append(policy_features(row, mob))
                frames = frames[-history:]
                padded = [frames[0]] * (history - len(frames)) + frames
                xs.append([number for frame in padded for number in frame])
                ys.append(action_vector(row))
                mobs.append(mob or "unknown")
                last_time = timestamp
            if xs:
                encounters.append((str(root), eid, report.environment, xs, ys, mobs))
    if len(encounters) < 3:
        raise ValueError("need at least three usable good teacher encounters for train/validation/test split")
    random.Random(SEED).shuffle(encounters)
    n = len(encounters)
    a = min(max(1, round(n * .7)), n - 2)
    b = min(max(a + 1, round(n * .85)), n - 1)
    assignments = {"train": encounters[:a], "validation": encounters[a:b], "test": encounters[b:]}
    examples, memberships = {}, {}
    for name, group in assignments.items():
        xs, ys, envs, mobs = [], [], [], []
        memberships[name] = []
        for root, eid, env, features, actions, targets in group:
            xs.extend(features)
            ys.extend(actions)
            envs.extend([env] * len(features))
            mobs.extend(targets)
            memberships[name].append({"session": root, "encounter": eid, "environment": env})
        examples[name] = (xs, ys, envs, mobs)
    return examples, memberships, synthetic


def build_examples(sessions, history=4, *, allow_synthetic=False):
    """Return upstream-shaped examples/memberships with encounter-safe histories.

    Short runs repeat their FIRST eligible frame on the left, including after a
    rejected row. No excluded/nonteacher observation can enter any window.
    """
    examples, memberships, _ = _prepare(_session_paths(sessions), history, allow_synthetic, 10)
    return examples, memberships


def _metrics(model, examples, mean, std):
    import torch

    metrics = {}
    with torch.no_grad():
        for split, (xs, ys, envs, mobs) in examples.items():
            truth = torch.tensor(ys, dtype=torch.float32).bool()
            pred = model((torch.tensor(xs, dtype=torch.float32) - mean) / std) >= 0
            scores = {}
            for j, name in enumerate(OUTPUTS):
                tp = (pred[:, j] & truth[:, j]).sum().item()
                fp = (pred[:, j] & ~truth[:, j]).sum().item()
                fn = (~pred[:, j] & truth[:, j]).sum().item()
                precision = tp / (tp + fp) if tp + fp else 0.0
                recall = tp / (tp + fn) if tp + fn else 0.0
                scores[name] = {
                    "accuracy": (pred[:, j] == truth[:, j]).float().mean().item(),
                    "precision": precision, "recall": recall,
                    "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
                }
            scores["overall"] = (pred == truth).float().mean().item()
            for key, labels in (("by_environment", envs), ("by_mob", mobs)):
                scores[key] = {}
                for label in sorted(set(labels)):
                    indexes = [i for i, value in enumerate(labels) if value == label]
                    scores[key][label] = {
                        "rows": len(indexes),
                        "overall": (pred[indexes] == truth[indexes]).float().mean().item(),
                    }
            metrics[split] = scores
    return metrics


def _skill(out, metadata):
    return {
        "name": "combat.engage",
        "version": out.name,
        "implementation": {
            "type": "model", "model_path": (out / "model.onnx").as_posix(),
            "metadata_path": (out / "metadata.json").as_posix(),
            "model_sha256": metadata["model_sha256"],
            "loader": "bridge/policy.js:TacticalPolicy",
            "description": "Bounded tactical combat requests through the control arbiter.",
        },
        "requirements": {
            "starting_conditions": "Alive, one selected hostile target, approved fixed arena setup.",
            "equipment": "Record and hold the agreed weapon and shield setup fixed across trials.",
            "allowed_environment": "Only arenas approved for frozen evaluation; none qualified yet.",
            "observations": "Ordered policy features; unknown observations retain contract defaults.",
            "input_contract": "contracts/policy.json",
            "inputs": {"observations": [1, metadata["history"] * len(metadata["features"])], "dtype": "float32"},
            "outputs": metadata["outputs"],
            "units": {"distance": "blocks", "velocity": "blocks/tick", "angles": "radians"},
            "synthetic": metadata["synthetic"],
            "promotion_eligible": metadata["promotion_eligible"],
        },
        "success_check": {
            "success": "Selected target death, bot alive, no human intervention or safety violation.",
            "failure": ["bot death", "target lost", "pursuit limit", "inference error", "human intervention"],
            "time_limit_s": 120, "max_pursuit_distance_blocks": 32, "retreat_health": 4,
            "controls": "Arbiter owns writes; release controls on completion, cancellation, errors, or timeout.",
        },
        "reset_steps": [
            "Cancel invocation and release all controls.",
            "Restore the approved arena terrain and remove leftover mobs, projectiles, and drops.",
            "Restore fixed bot position, health, food, equipment, and inventory.",
            "Restore the selected target and verify all setup before the next trial.",
        ],
        "evaluation": {
            "status": "untested", "tested_version": None, "test_settings": None,
            "baseline": None, "trial_count": 0, "successes": None, "failures": None,
            "timeouts": None, "human_interventions": None, "results": None,
            "note": "Offline cloning metrics are not arena evaluation. Synthetic data never qualifies for activation.",
        },
    }


def train(sessions, out_dir=None, *, seed=SEED, epochs=30, allow_synthetic=False):
    """Write an immutable candidate bundle; never create an active pointer."""
    if seed != SEED:
        raise ValueError(f"seed is fixed at {SEED}")
    if type(epochs) is not int or epochs < 1:
        raise ValueError("epochs must be a positive integer")
    policy = load_policy_contract()
    sessions = _session_paths(sessions)
    dataset_hash = _hash_sessions(sessions)
    examples, splits, synthetic = _prepare(sessions, policy["history"], allow_synthetic, policy["rate_hz"])

    import torch
    from .export_onnx import Policy, export_onnx

    random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    x = torch.tensor(examples["train"][0], dtype=torch.float32, device="cpu")
    y = torch.tensor(examples["train"][1], dtype=torch.float32, device="cpu")
    if not torch.isfinite(x).all():
        raise ValueError("features overflow float32")
    mean, std = x.mean(0), x.std(0, correction=0)
    std[std < 1e-6] = 1
    if not torch.isfinite(mean).all() or not torch.isfinite(std).all():
        raise ValueError("nonfinite normalization")
    model = Policy(x.shape[1], len(OUTPUTS)).cpu()
    positives = y.sum(0)
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=(len(y) - positives + 1) / (positives + 1))
    optimizer = torch.optim.Adam(model.parameters(), lr=.001)
    normalized = (x - mean) / std
    for _ in range(epochs):
        optimizer.zero_grad()
        loss = loss_fn(model(normalized), y)
        if not torch.isfinite(loss):
            raise ValueError("nonfinite training loss")
        loss.backward()
        optimizer.step()
    model.eval()
    metrics = _metrics(model, examples, mean, std)
    if dataset_hash != _hash_sessions(sessions):
        raise ValueError("dataset changed during training")
    out = Path(out_dir) if out_dir is not None else Path("skills_store/candidates") / f"candidate-{dataset_hash[:12]}"
    if out.exists():
        raise FileExistsError(f"candidate already exists: {out}")
    covered = sorted({m["environment"] for group in splits.values() for m in group})
    metadata = {
        "schema_version": 1, "artifact_type": "combat.tactical_policy",
        "history": policy["history"], "rate_hz": policy["rate_hz"],
        "features": policy["features"], "outputs": policy["outputs"],
        "normalization": {"mean": mean.tolist(), "std": std.tolist()},
        "history_padding": "repeat_first_eligible_frame", "history_reset": "encounter_or_rejected_row",
        "splits": splits, "encounter_count": sum(map(len, splits.values())),
        "data_coverage": {"environments": covered, "absent_environments": [e for e in ENVIRONMENTS if e not in covered]},
        "qualified_environments": [], "metrics": metrics,
        "dataset_sha256": dataset_hash, "dataset_hash_algorithm": "combat.dataset.v1",
        "seed": SEED, "epochs": epochs, "created_at": time.time(),
        "synthetic": synthetic, "promotion_eligible": not synthetic,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    # Stage the complete bundle beside its destination, publish only on success.
    with tempfile.TemporaryDirectory(prefix=".candidate-", dir=out.parent) as staging:
        stage = Path(staging)
        export_onnx(model, stage / "model.onnx", x.shape[1], len(OUTPUTS))
        metadata["model_sha256"] = sha256_file(stage / "model.onnx")
        (stage / "metadata.json").write_text(json.dumps(metadata, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        (stage / "skill.json").write_text(json.dumps(_skill(out, metadata), indent=2, allow_nan=False) + "\n", encoding="utf-8")
        # rename refuses to replace an existing nonempty bundle.
        stage.rename(out)
    return metadata


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sessions", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, help="new candidate directory; default skills_store/candidates/<dataset-id>")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--allow-synthetic", action="store_true", help="fixture verification only; permanently ineligible for promotion")
    args = parser.parse_args(argv)
    try:
        metadata = train(args.sessions, args.out, epochs=args.epochs, allow_synthetic=args.allow_synthetic)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        parser.exit(1, f"training failed: {error}\n")
    print(json.dumps(metadata, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
