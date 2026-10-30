"""Adapt dataset features to this checkout's bridge/policy.js:3-8 exactly.

The dataset keeps upstream compatibility (legacy terrain maps and broader sword
capabilities). The deployed bridge consumes numeric terrain scalars and detects
only item names containing 'sword'. Keep those runtime differences here.
"""
from __future__ import annotations

import math

from .dataset import DEFAULT_FEATURES, feature_vector


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _finite(value):
    # JS Number.isFinite excludes booleans, strings, null, and objects.
    return type(value) in (int, float) and math.isfinite(value)


def _truthy(value):
    # Unlike Python, JavaScript considers even empty arrays/objects truthy.
    if isinstance(value, (dict, list)):
        return True
    return bool(value)


def _nullish(value, fallback):
    return fallback if value is None else value


def policy_features(row, target_type=None):
    """Use dataset extraction, adjusted to the bridge's deployed definitions.

    target_type is the invocation's configured mob, just as TacticalPolicy's
    targetType argument. If omitted, use the row's recorded mob_type.
    """
    observation = _mapping(row.get("observation"))
    target, self_ = (_mapping(observation.get(k)) for k in ("target", "self"))
    terrain = _mapping(observation.get("terrain"))
    position = _mapping(target.get("relative_position"))
    velocity = _mapping(target.get("velocity"))
    angles = _mapping(target.get("angular_error"))
    incoming = _mapping(self_.get("incoming_attack"))
    values = dict(zip(DEFAULT_FEATURES, feature_vector(row)))
    for prefix, source in (("target_d", position), ("target_v", velocity)):
        for axis in "xyz":
            values[prefix + axis] = _nullish(source.get(axis), 0)
    for key in ("distance", "bearing", "elevation"):
        values[key] = _nullish(target.get(key), 0)
    for axis in ("yaw", "pitch"):
        values["angular_error_" + axis] = _nullish(angles.get(axis), 0)
    for key, source, field, default in (
        ("self_health", self_, "health", 20),
        ("target_health", target, "health", 20),
        ("cooldown", self_, "cooldown", 0),
        ("recent_damage", incoming, "damage", 0),
    ):
        values[key] = _nullish(source.get(field), default)
    for key, source, field in (
        ("line_of_sight", target, "line_of_sight"),
        ("in_reach", target, "in_reach"),
        ("on_ground", self_, "on_ground"),
        ("is_sprinting", self_, "sprinting"),
        ("is_sneaking", self_, "sneaking"),
        ("incoming_swing", incoming, "swing_detected"),
    ):
        values[key] = int(_truthy(source.get(field)))
    mob = target.get("mob_type") if target_type is None else target_type
    mob = str(mob or "").lower().split(":")[-1]
    for name in ("zombie", "skeleton", "enderman", "blaze", "phantom"):
        values["target_" + name] = int(mob == name)
    equipment = " ".join(str(_nullish(self_.get(k), "")) for k in ("held_item", "offhand_item")).lower()
    for name in ("sword", "axe", "shield"):
        values["has_" + name] = int(name in equipment)
    dimension = str(_nullish(observation.get("dimension"), _nullish(terrain.get("dimension"), ""))).lower()
    for name in ("overworld", "nether", "end"):
        values["dimension_" + name] = int(dimension.endswith(name))
    # The bridge spreads terrain last and has no fallback to legacy maps.
    for key in DEFAULT_FEATURES[30:44]:
        values[key] = 0
    values.update(terrain)
    return [float(values[key]) if _finite(values[key]) else 0.0 for key in DEFAULT_FEATURES]
