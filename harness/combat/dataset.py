"""Versioned combat trajectory storage and deterministic feature extraction.

Reused from benpham3206/Agent-37, harness/combat/dataset.py (commit 4b56adf).
"""
from __future__ import annotations
import hashlib, json, math
from pathlib import Path
from dataclasses import dataclass
from typing import Any

SCHEMA_VERSION = 1
ENVIRONMENTS = ("open_surface", "underground", "nether_open", "fortress", "end_island", "bridge", "other")
OUTPUTS = ["forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use", "disengage"]
DEFAULT_FEATURES = ["target_dx","target_dy","target_dz","target_vx","target_vy","target_vz","distance","bearing","elevation","angular_error_yaw","angular_error_pitch","line_of_sight","in_reach","self_health","target_health","on_ground","cooldown","is_sprinting","is_sneaking","target_zombie","target_skeleton","target_enderman","target_blaze","target_phantom","has_sword","has_axe","has_shield","dimension_overworld","dimension_nether","dimension_end","support_center","support_forward","support_back","support_left","support_right","drop_forward","drop_back","drop_left","drop_right","clearance_forward","clearance_back","clearance_left","clearance_right","hazard_near","incoming_swing","recent_damage"]

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
    def eligible(self): return self.valid and not self.synthetic and self.rows > 0

def _num(x): return isinstance(x, (int,float)) and math.isfinite(x)
def _bool(x): return isinstance(x, bool)
def _point(p): return isinstance(p, dict) and all(_num(p.get(k)) for k in ("x","y","z"))

def _iter_rows(path: Path):
    for f in sorted(path.glob("encounters/*.jsonl")):
        with f.open(encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                if line.strip():
                    try: yield f, line_no, json.loads(line)
                    except json.JSONDecodeError as e: yield f, line_no, {"__error__": str(e)}

def iter_encounters(path: str|Path):
    """Yield (session directory, rows) for a session or a per-agent data root.

    Keep each encounter separate even when agents reuse session/encounter IDs.
    Rows retain their labels, arbitration, identity, and clock metadata unchanged.
    """
    root = Path(path)
    sessions = [root] if (root / "session.json").is_file() else sorted(file.parent for file in root.rglob("session.json"))
    if not sessions:
        raise ValueError(f"{root}: no session.json found")
    for session in sessions:
        validation = validate_session(session)
        if not validation.valid:
            raise ValueError(f"{session}: " + "; ".join(validation.errors or ("empty session",)))
        current = None
        rows = []
        for file, _, row in _iter_rows(session):
            if file != current and rows:
                yield session, rows
                rows = []
            current = file
            rows.append(row)
        if rows:
            yield session, rows


def validate_session(path: str|Path, *, max_gap_ms=250) -> Validation:
    root=Path(path); errors=[]; rows=0; encounters=set(); mobs=set(); previous={}; previous_tick={}; synthetic=False; environment=""; expected_session=""
    session_file=root/"session.json"
    if not session_file.exists(): errors.append("missing session.json")
    else:
        try:
            session=json.loads(session_file.read_text(encoding="utf-8")); synthetic=bool(session.get("synthetic",False)); expected_session=str(session.get("session_id", ""))
            if not expected_session: errors.append("session.json missing session_id")
            if session.get("schema_version") != SCHEMA_VERSION: errors.append("unsupported session schema_version")
            environment=session.get("environment_suite",session.get("environment",""))
            if environment not in ENVIRONMENTS: errors.append("session environment must be one of the documented environment tags")
        except Exception as e: synthetic=False; environment=""; errors.append(f"invalid session.json: {e}")
    if not (root/"encounters").is_dir(): errors.append("missing encounters/")
    for f,n,r in _iter_rows(root):
        if "__error__" in r: errors.append(f"{f.name}:{n}: invalid JSON"); continue
        rows += 1; sid=r.get("session_id"); eid=r.get("encounter_id"); encounters.add(str(eid))
        if expected_session and sid != expected_session: errors.append(f"{f.name}:{n}: session_id mismatch")
        if str(eid) != f.stem: errors.append(f"{f.name}:{n}: encounter_id does not match encounter filename")
        if r.get("schema_version") != SCHEMA_VERSION: errors.append(f"{f.name}:{n}: schema mismatch")
        for field in ("agent_name", "controller_id"):
            value = r.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()): errors.append(f"{f.name}:{n}: {field} must be a nonempty string or null")
        server_time = r.get("server_time_ms")
        if server_time is not None and (type(server_time) is not int or server_time < 0): errors.append(f"{f.name}:{n}: server_time_ms must be a nonnegative integer or null")
        if not sid or not eid: errors.append(f"{f.name}:{n}: missing session/encounter id")
        if not isinstance(r.get("tick"),int) or not _num(r.get("timestamp_ms")): errors.append(f"{f.name}:{n}: invalid clock")
        key=str(eid)
        if key in previous_tick and r.get("tick") <= previous_tick[key]: errors.append(f"{f.name}:{n}: non-monotone tick")
        previous_tick[key]=r.get("tick",-1)
        if r.get("recording_state") not in ("recording","paused","stopped"): errors.append(f"{f.name}:{n}: invalid recording state")
        if r.get("label") not in ("good","bad","excluded","unlabelled"): errors.append(f"{f.name}:{n}: invalid label")
        obs=r.get("observation",{}); self_=obs.get("self",{}); target=obs.get("target")
        if not _point(self_.get("position")) or not _point(self_.get("velocity")): errors.append(f"{f.name}:{n}: missing self kinematics")
        if not all(_num(self_.get(k)) for k in ("yaw","pitch")): errors.append(f"{f.name}:{n}: missing self angles")
        if not _bool(self_.get("on_ground")): errors.append(f"{f.name}:{n}: on_ground must be boolean")
        action=r.get("teacher_action"); applied=r.get("applied_action")
        if not isinstance(action,dict) or not isinstance(applied,dict): errors.append(f"{f.name}:{n}: missing teacher/applied action")
        action=action if isinstance(action,dict) else {}; applied=applied if isinstance(applied,dict) else {}
        for a in OUTPUTS + ["emergency_stop","manual_abort"]:
            default = False if a == "disengage" else None
            if not _bool(action.get(a, default)): errors.append(f"{f.name}:{n}: action {a} must be boolean")
            if not _bool(applied.get(a, default)): errors.append(f"{f.name}:{n}: applied action {a} must be boolean")
        for k in ("mouse_dx","mouse_dy","yaw_delta","pitch_delta"):
            if k in action and not _num(action[k]): errors.append(f"{f.name}:{n}: action {k} must be finite")
            if k not in applied or not _num(applied[k]): errors.append(f"{f.name}:{n}: applied action {k} must be finite")
        if target is not None:
            mt=target.get("mob_type");
            if mt: mobs.add(mt)
            if not _point(target.get("position")) or not _point(target.get("velocity")): errors.append(f"{f.name}:{n}: target kinematics")
            if not all(_num(target.get(k)) for k in ("width","height","distance")): errors.append(f"{f.name}:{n}: target geometry")
            if not isinstance(target.get("aabb"),dict) or not _point(target["aabb"].get("min")) or not _point(target["aabb"].get("max")): errors.append(f"{f.name}:{n}: target aabb")
        ts=r.get("timestamp_ms")
        if not _num(ts): errors.append(f"{f.name}:{n}: timestamp must be finite")
        elif key in previous and ts <= previous[key]: errors.append(f"{f.name}:{n}: non-monotone timestamp")
        elif key in previous and ts-previous[key] > max_gap_ms: errors.append(f"{f.name}:{n}: synchronization gap > {max_gap_ms}ms")
        if _num(ts): previous[key]=ts
    return Validation(not errors and rows>0, rows, tuple(sorted(encounters)), tuple(sorted(mobs)), tuple(errors), synthetic, environment)

def _target_type(t): return (t or "").lower().split(":")[-1]
def feature_vector(row: dict[str,Any], features=DEFAULT_FEATURES) -> list[float]:
    o=row.get("observation",{}); s=o.get("self",{}); t=o.get("target") or {}; p=t.get("relative_position") or {}; terrain=o.get("terrain") or {}; incoming=s.get("incoming_attack") or {}; dimension=str(o.get("dimension") or terrain.get("dimension") or "").lower()
    def n(v, default=0.): return float(v) if _num(v) else default
    mt=_target_type(t.get("mob_type")); caps=f"{s.get('held_item') or ''} {s.get('offhand_item') or ''}".lower()
    vals={"target_dx":n(p.get("x")),"target_dy":n(p.get("y")),"target_dz":n(p.get("z")),"target_vx":n((t.get("velocity") or {}).get("x")),"target_vy":n((t.get("velocity") or {}).get("y")),"target_vz":n((t.get("velocity") or {}).get("z")),"distance":n(t.get("distance")),"bearing":n(t.get("bearing")),"elevation":n(t.get("elevation")),"angular_error_yaw":n(t.get("angular_error",{}).get("yaw") if isinstance(t.get("angular_error"),dict) else 0),"angular_error_pitch":n(t.get("angular_error",{}).get("pitch") if isinstance(t.get("angular_error"),dict) else 0),"line_of_sight":float(bool(t.get("line_of_sight"))),"in_reach":float(bool(t.get("in_reach"))),"self_health":n(s.get("health"),20),"target_health":n(t.get("health"),20),"on_ground":float(bool(s.get("on_ground"))),"cooldown":n(s.get("cooldown")),"is_sprinting":float(bool(s.get("sprinting"))),"is_sneaking":float(bool(s.get("sneaking")))}
    for name in ("zombie","skeleton","enderman","blaze","phantom"): vals["target_"+name]=float(mt==name)
    vals.update(has_sword=float(any(x in caps for x in ("sword","netherite","diamond"))),has_axe=float("axe" in caps),has_shield=float("shield" in caps))
    for name in ("overworld","nether","end"): vals["dimension_"+name]=float(dimension.endswith(name))
    # Features use bridge terrain data, never the session's environment tag.
    support_grid=terrain.get("support_grid") if isinstance(terrain.get("support_grid"),dict) else {}
    drop_depth=terrain.get("drop_depth") if isinstance(terrain.get("drop_depth"),dict) else {}
    drop=terrain.get("drop") if isinstance(terrain.get("drop"),dict) else {}
    clearance=terrain.get("clearance") if isinstance(terrain.get("clearance"),dict) else {}
    for name in ("center","forward","back","left","right"):
        value=terrain.get("support_"+name, support_grid.get(name))
        vals["support_"+name]=n(value) if _num(value) else float(bool(value))
    for name in ("forward","back","left","right"):
        vals["drop_"+name]=n(terrain.get("drop_"+name, drop_depth.get(name, drop.get(name))))
        value=terrain.get("clearance_"+name, clearance.get(name))
        if isinstance(value, dict): value=bool(value.get("available") and value.get("body_clear") and value.get("head_clear"))
        vals["clearance_"+name]=n(value) if _num(value) else float(bool(value))
    hazards=terrain.get("hazard_near", terrain.get("hazards", False))
    if isinstance(hazards, dict): hazards=any(hazards.values())
    vals["hazard_near"]=float(bool(hazards)) if not _num(hazards) else n(hazards)
    vals["incoming_swing"]=float(bool(incoming.get("swing_detected"))); vals["recent_damage"]=n(incoming.get("damage"))
    unknown=[f for f in features if f not in vals]
    if unknown: raise ValueError("unknown policy feature(s): "+", ".join(unknown))
    return [vals[f] for f in features]

def action_vector(row): return [float(bool(row.get("teacher_action",{}).get(k,False))) for k in OUTPUTS]
def sha256_file(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
    return h.hexdigest()
