"""Versioned combat recordings and deterministic policy features (Python 3.11+).

Ported from Agent-37's harness/combat/dataset.py. The recording contract is
docs/recording-format.md; feature/output order follows contracts/policy.json.
Loading preserves payloads, normalizes v1's undefined identity/time to None,
and refuses partial data from invalid sessions or encounters.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2
SUPPORTED_SCHEMA_VERSIONS = (1, 2)
ENVIRONMENTS = ("open_surface", "underground", "nether_open", "fortress", "end_island", "bridge", "other")
OUTPUTS = ["forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use", "disengage"]
DEFAULT_FEATURES = ["target_dx", "target_dy", "target_dz", "target_vx", "target_vy", "target_vz", "distance", "bearing", "elevation", "angular_error_yaw", "angular_error_pitch", "line_of_sight", "in_reach", "self_health", "target_health", "on_ground", "cooldown", "is_sprinting", "is_sneaking", "target_zombie", "target_skeleton", "target_enderman", "target_blaze", "target_phantom", "has_sword", "has_axe", "has_shield", "dimension_overworld", "dimension_nether", "dimension_end", "support_center", "support_forward", "support_back", "support_left", "support_right", "drop_forward", "drop_back", "drop_left", "drop_right", "clearance_forward", "clearance_back", "clearance_left", "clearance_right", "hazard_near", "incoming_swing", "recent_damage"]

NEW_FIELDS = ("server_time_ms", "agent_name", "controller_id")
V1_ROW_KEYS = ("schema_version", "session_id", "encounter_id", "tick", "timestamp_ms", "server_tick", "source", "recording_state", "label", "observation", "teacher_action", "applied_action", "arbiter")
ROW_KEYS = {1: V1_ROW_KEYS, 2: V1_ROW_KEYS + NEW_FIELDS}
V1_SESSION_KEYS = ("schema_version", "session_id", "target", "source", "environment_suite", "environment_label", "notes", "created_at")
SESSION_KEYS = {1: V1_SESSION_KEYS, 2: V1_SESSION_KEYS + ("agent_name",)}


class DatasetError(ValueError):
    """A recording cannot be consumed safely; the message identifies its location."""


@dataclass
class Validation:
    valid: bool
    rows: int = 0
    encounters: tuple[str, ...] = ()
    mob_types: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()
    synthetic: bool = False
    environment: str = ""

    @property
    def eligible(self):
        return self.valid and not self.synthetic and self.rows > 0


def _num(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def _nullable_identity(value):
    return value is None or _nonempty_string(value)


def _reject_constant(value):
    raise ValueError(f"nonstandard JSON constant {value}")


def _json_object(text, location):
    try:
        value = json.loads(text, parse_constant=_reject_constant)
    except ValueError as error:
        raise DatasetError(f"{location}: malformed JSON: {error}") from error
    if not isinstance(value, dict):
        raise DatasetError(f"{location}: expected a JSON object")
    return value


def _versioned_keys(value, schemas, location):
    version = value.get("schema_version")
    if "schema_version" not in value:
        raise DatasetError(f"{location}: missing required key schema_version")
    if type(version) is not int or version not in schemas:
        raise DatasetError(f"{location}: unsupported schema_version {version!r}")
    for key in schemas[version]:
        if key not in value:
            raise DatasetError(f"{location}: missing required key {key}")
    return version


def _normalize_row(row, location):
    version = _versioned_keys(row, ROW_KEYS, location)
    for key in ("session_id", "encounter_id", "source"):
        if not _nonempty_string(row[key]):
            raise DatasetError(f"{location}: {key} must be a nonempty string")
    if type(row["tick"]) is not int or row["tick"] < 0:
        raise DatasetError(f"{location}: tick must be a nonnegative integer row counter")
    if not _num(row["timestamp_ms"]):
        raise DatasetError(f"{location}: timestamp_ms must be finite")
    if row["label"] not in ("good", "bad", "excluded", "unlabelled"):
        raise DatasetError(f"{location}: invalid label")
    if row["recording_state"] not in ("recording", "paused", "stopped"):
        raise DatasetError(f"{location}: invalid recording_state")
    for key in ("observation", "teacher_action", "applied_action", "arbiter"):
        if not isinstance(row[key], dict):
            raise DatasetError(f"{location}: {key} must be an object")
    # Payload availability varies: retain None, empty objects/arrays, zero, and
    # False exactly as recorded. Do not require upstream-only action members.
    normalized = dict(row)
    if version == 1:
        normalized.update(dict.fromkeys(NEW_FIELDS))
    else:
        server_time = row["server_time_ms"]
        if server_time is not None and (type(server_time) is not int or server_time < 0):
            raise DatasetError(f"{location}: server_time_ms must be a nonnegative integer or null")
        for key in ("agent_name", "controller_id"):
            if not _nullable_identity(row[key]):
                raise DatasetError(f"{location}: {key} must be a nonempty string or null")
        if row["arbiter"].get("source") != "teacher" and row["controller_id"] is not None:
            raise DatasetError(f"{location}: controller_id must be null unless arbiter.source is teacher")
    return normalized


def load_encounter(path: str | Path, *, max_gap_ms=250) -> list[dict[str, Any]]:
    """Read one encounter independently; reject the first bad row, never skip it.

    max_gap_ms preserves the upstream synchronization check; pass None to
    disable the gap limit. Both gaps and monotonicity use timestamp_ms alone.
    File order is retained, with no ordering claims across bridge hosts.
    """
    file = Path(path)
    try:
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise DatasetError(f"{file.name}:1: cannot read encounter: {error}") from error
    if not text:
        raise DatasetError(f"{file.name}:1: empty encounter")
    # split('\n') preserves blank records. Remove only the final terminator.
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    rows = []
    for line_no, line in enumerate(lines, 1):
        location = f"{file.name}:{line_no}"
        if not line.strip():
            raise DatasetError(f"{location}: blank row")
        row = _normalize_row(_json_object(line, location), location)
        if rows:
            for key in ("schema_version", "session_id", "encounter_id", "agent_name"):
                if row[key] != rows[0][key]:
                    raise DatasetError(f"{location}: {key} changed within encounter")
            if row["tick"] <= rows[-1]["tick"]:
                raise DatasetError(f"{location}: non-monotone tick")
            elapsed = row["timestamp_ms"] - rows[-1]["timestamp_ms"]
            if elapsed <= 0:
                raise DatasetError(f"{location}: non-monotone timestamp_ms")
            if max_gap_ms is not None and elapsed > max_gap_ms:
                raise DatasetError(f"{location}: timestamp_ms synchronization gap > {max_gap_ms}ms")
        rows.append(row)
    return rows


def _session_data(path, max_gap_ms):
    root = Path(path)
    errors = []
    session = {}
    synthetic = False
    environment = ""
    metadata = root / "session.json"
    if not metadata.exists():
        errors.append("missing session.json")
    else:
        try:
            session = _json_object(metadata.read_text(encoding="utf-8"), "session.json")
            version = _versioned_keys(session, SESSION_KEYS, "session.json")
            for key in ("session_id", "environment_suite", "environment_label"):
                if not _nonempty_string(session[key]):
                    raise DatasetError(f"session.json: {key} must be a nonempty string")
            if version == 2 and not _nullable_identity(session["agent_name"]):
                raise DatasetError("session.json: agent_name must be a nonempty string or null")
            if type(session.get("synthetic", False)) is not bool:
                raise DatasetError("session.json: synthetic must be boolean")
            synthetic = session.get("synthetic", False)
            environment = session["environment_label"]
        except (DatasetError, OSError, UnicodeError) as error:
            errors.append(str(error))
    all_rows = []
    encounters = set()
    mobs = set()
    files = sorted((root / "encounters").glob("*.jsonl"))
    if not (root / "encounters").is_dir():
        errors.append("missing encounters/")
    elif not files:
        errors.append("no encounter files in encounters/")
    for file in files:
        try:
            rows = load_encounter(file, max_gap_ms=max_gap_ms)
        except DatasetError as error:
            errors.append(str(error))
            continue
        for line_no, row in enumerate(rows, 1):
            location = f"{file.name}:{line_no}"
            if session:
                for key in ("schema_version", "session_id"):
                    if row[key] != session.get(key):
                        errors.append(f"{location}: {key} mismatch with session.json")
                # V1 identity is always unknown, regardless of stray metadata.
                if row["schema_version"] == 2 and row["agent_name"] != session.get("agent_name"):
                    errors.append(f"{location}: agent_name mismatch with session.json")
            if row["encounter_id"] != file.stem:
                errors.append(f"{location}: encounter_id does not match encounter filename")
            encounters.add(row["encounter_id"])
            target = row["observation"].get("target")
            if isinstance(target, dict) and _nonempty_string(target.get("mob_type")):
                mobs.add(target["mob_type"])
        all_rows.extend(rows)
    report = Validation(
        valid=not errors and bool(all_rows), rows=len(all_rows),
        encounters=tuple(sorted(encounters)), mob_types=tuple(sorted(mobs)),
        errors=tuple(errors), synthetic=synthetic, environment=environment,
    )
    return report, all_rows


def validate_session(path: str | Path, *, max_gap_ms=250) -> Validation:
    """Report metadata and encounter errors, including empty/malformed files."""
    return _session_data(path, max_gap_ms)[0]


def is_demo_row(row: dict[str, Any]) -> bool:
    arbiter = row.get("arbiter")
    return isinstance(arbiter, dict) and arbiter.get("source") == "teacher" and row.get("label") == "good"


def load_session(path: str | Path, *, demos_only=False, max_gap_ms=250) -> list[dict[str, Any]]:
    """Load all valid rows, optionally selecting only good teacher winners.

    Validation precedes filtering, so malformed non-demo rows are reported too.
    Rows remain in encounter/file order; histories must not cross encounters.
    """
    report, rows = _session_data(path, max_gap_ms)
    if not report.valid:
        raise DatasetError(f"invalid session {path}: " + "; ".join(report.errors))
    return [row for row in rows if is_demo_row(row)] if demos_only else rows


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _target_type(value):
    return str(value or "").lower().split(":")[-1]


def feature_vector(row: dict[str, Any], features=DEFAULT_FEATURES) -> list[float]:
    """Upstream deterministic policy features; raw recordings stay unmodified."""
    observation = _mapping(row.get("observation"))
    self_ = _mapping(observation.get("self"))
    target = _mapping(observation.get("target"))
    position = _mapping(target.get("relative_position"))
    velocity = _mapping(target.get("velocity"))
    terrain = _mapping(observation.get("terrain"))
    incoming = _mapping(self_.get("incoming_attack"))
    angles = _mapping(target.get("angular_error"))
    dimension = str(observation.get("dimension") or terrain.get("dimension") or "").lower()

    def n(value, default=0.0):
        return float(value) if _num(value) else default

    mob_type = _target_type(target.get("mob_type"))
    equipment = f"{self_.get('held_item') or ''} {self_.get('offhand_item') or ''}".lower()
    values = {
        "target_dx": n(position.get("x")), "target_dy": n(position.get("y")), "target_dz": n(position.get("z")),
        "target_vx": n(velocity.get("x")), "target_vy": n(velocity.get("y")), "target_vz": n(velocity.get("z")),
        "distance": n(target.get("distance")), "bearing": n(target.get("bearing")), "elevation": n(target.get("elevation")),
        "angular_error_yaw": n(angles.get("yaw")), "angular_error_pitch": n(angles.get("pitch")),
        "line_of_sight": float(bool(target.get("line_of_sight"))), "in_reach": float(bool(target.get("in_reach"))),
        "self_health": n(self_.get("health"), 20.0), "target_health": n(target.get("health"), 20.0),
        "on_ground": float(bool(self_.get("on_ground"))), "cooldown": n(self_.get("cooldown")),
        "is_sprinting": float(bool(self_.get("sprinting"))), "is_sneaking": float(bool(self_.get("sneaking"))),
    }
    for name in ("zombie", "skeleton", "enderman", "blaze", "phantom"):
        values["target_" + name] = float(mob_type == name)
    values.update(
        has_sword=float(any(item in equipment for item in ("sword", "netherite", "diamond"))),
        has_axe=float("axe" in equipment), has_shield=float("shield" in equipment),
    )
    for name in ("overworld", "nether", "end"):
        values["dimension_" + name] = float(dimension.endswith(name))
    # Preserve upstream map support and use this bridge's derived scalar fields
    # for its 3x3 support grid and object-valued clearance directions.
    support_grid = _mapping(terrain.get("support_grid"))
    drop_depth = _mapping(terrain.get("drop_depth"))
    drop = _mapping(terrain.get("drop"))
    clearance = _mapping(terrain.get("clearance"))
    for name in ("center", "forward", "back", "left", "right"):
        value = support_grid.get(name, terrain.get("support_" + name))
        values["support_" + name] = n(value) if _num(value) else float(bool(value))
    for name in ("forward", "back", "left", "right"):
        values["drop_" + name] = n(terrain.get("drop_" + name, drop_depth.get(name, drop.get(name))))
        value = terrain.get("clearance_" + name, clearance.get(name))
        if isinstance(value, dict):
            value = value.get("available", True) and value.get("body_clear") and value.get("head_clear")
        values["clearance_" + name] = n(value) if _num(value) else float(bool(value))
    hazards = terrain.get("hazard_near", terrain.get("hazards", False))
    if isinstance(hazards, dict):
        hazards = any(hazards.values())
    values["hazard_near"] = n(hazards) if _num(hazards) else float(bool(hazards))
    values["incoming_swing"] = float(bool(incoming.get("swing_detected")))
    values["recent_damage"] = n(incoming.get("damage"))
    unknown = [name for name in features if name not in values]
    if unknown:
        raise ValueError("unknown policy feature(s): " + ", ".join(unknown))
    return [values[name] for name in features]


def action_vector(row):
    # OUTPUTS is the policy contract, not a list of required recorder fields.
    return [float(bool(_mapping(row.get("teacher_action")).get(key, False))) for key in OUTPUTS]


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _discover_sessions(path):
    if not path.is_dir():
        raise DatasetError(f"{path}: dataset directory does not exist or is not a directory")
    if (path / "session.json").exists() or (path / "encounters").is_dir():
        return [path]
    # Encounter directories also identify broken sessions with missing metadata.
    roots = {file.parent for file in path.rglob("session.json")}
    roots.update(directory.parent for directory in path.rglob("encounters") if directory.is_dir())
    if not roots:
        raise DatasetError(f"{path}: no sessions found")
    return sorted(roots)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate sessions and explain failures")
    parser.add_argument("paths", nargs="+", type=Path, help="session folders or dataset roots")
    args = parser.parse_args(argv)
    if not args.check:
        parser.error("use --check to validate recordings")
    sessions = set()
    failures = []
    for path in args.paths:
        try:
            sessions.update(root.resolve() for root in _discover_sessions(path))
        except (DatasetError, OSError) as error:
            failures.append(str(error))
    for root in sorted(sessions):
        report = validate_session(root)
        if not report.valid:
            failures.append(f"{root}: " + "; ".join(report.errors))
    print(f"{len(sessions)} sessions, {len(failures)} invalid")
    for reason in failures:
        print(reason)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
