// Threat policy: the model's own rules for hostile mobs. The runner applies them at once when a
// threat appears (a model call is too slow for a hit or a creeper fuse), then tells the model.
// Pure logic. Nothing here acts; the runner turns a verdict into an attack or flee primitive.
import { HOSTILE_MOBS } from '../observation.js';

export const GROUPS = Object.freeze({
  zombie_like: ['zombie', 'husk', 'drowned'],
  skeleton_like: ['skeleton', 'stray', 'bogged', 'wither_skeleton'],
  creeper: ['creeper'],
  spider_like: ['spider', 'cave_spider'],
  enderman: ['enderman'],
});
export const RULE_NAMES = Object.freeze([...Object.keys(GROUPS), 'other_hostile', 'creeper_fuse']);
export const ACTIONS = Object.freeze(['fight', 'flee', 'ignore']);
export const HOSTILE_RANGE = 8;
export const FLEE_RANGE = Object.freeze({ min: 4, max: 32 });
export const FUSE_RANGE = 12;
export const COOLDOWN_MS = Object.freeze({ mob: 10000, hit: 3000, fuse: 1000 });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const list = RULE_NAMES.join(', ');

export const groupOf = (type) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(type)) ?? 'other_hostile';

// { <rule name>: { action: fight|flee|ignore, flee_distance: 4-32, min_health?: 1-20 (fight only) } }.
// creeper_fuse is required. Every other name is a mob group.
export function validateThreatPolicy(policy) {
  if (!isPlain(policy)) throw new Error('threat_policy_not_an_object');
  const out = {};
  for (const [name, rule] of Object.entries(policy)) {
    if (!RULE_NAMES.includes(name)) throw new Error(`threat_policy_unknown_rule:${name.slice(0, 40)}. Valid rule names: ${list}`);
    if (!isPlain(rule)) throw new Error(`threat_rule_${name}_not_an_object`);
    for (const key of Object.keys(rule)) {
      if (!['action', 'flee_distance', 'min_health'].includes(key)) throw new Error(`threat_rule_${name}_unknown_field:${key}`);
    }
    if (!ACTIONS.includes(rule.action)) throw new Error(`threat_rule_${name}_action_must_be_fight_flee_or_ignore`);
    if (!isInt(rule.flee_distance) || rule.flee_distance < FLEE_RANGE.min || rule.flee_distance > FLEE_RANGE.max) {
      throw new Error(`threat_rule_${name}_flee_distance_must_be_an_integer_${FLEE_RANGE.min}_to_${FLEE_RANGE.max}`);
    }
    const copy = { action: rule.action, flee_distance: rule.flee_distance };
    if ('min_health' in rule) {
      if (rule.action !== 'fight') throw new Error(`threat_rule_${name}_min_health_only_with_fight`);
      if (!isInt(rule.min_health) || rule.min_health < 1 || rule.min_health > 20) throw new Error(`threat_rule_${name}_min_health_must_be_an_integer_1_to_20`);
      copy.min_health = rule.min_health;
    }
    out[name] = copy;
  }
  if (!out.creeper_fuse) throw new Error(`threat_policy_needs_creeper_fuse. Valid rule names: ${list}`);
  return out;
}

export const ruleNameFor = (policy, type) => {
  const group = groupOf(type);
  return policy?.[group] ? group : policy?.other_hostile ? 'other_hostile' : null;
};

// A fight rule below its min_health becomes a flee. Health is in half hearts, 20 is full.
export function effectiveAction(rule, health) {
  if (!rule) return { action: 'ignore', why: 'no_rule' };
  if (rule.action === 'fight' && rule.min_health != null && Number.isFinite(health) && health < rule.min_health) {
    return { action: 'flee', why: 'health_below_min_health' };
  }
  return { action: rule.action, why: 'rule' };
}

export const minHealthFor = (policy, type) => policy?.[ruleNameFor(policy, type)]?.min_health ?? null;

const hostileMobs = (o) => (o?.facts?.nearby_mobs ?? []).filter((m) => m?.id != null && (m.hostile ?? HOSTILE_MOBS.has(m.type)));

// What should the policy react to right now? Returns null or
// { kind: 'hit' | 'hostile_close', mob, rule, action, why }. `cooling(key)` says a reaction is too recent.
// A hit with no mob the policy covers still returns { action: 'ignore' }: the model is told, nothing is forced.
export function findThreat({ policy, observation, prevHealth = null, cooling = () => false }) {
  if (!policy) return null;
  const health = observation?.health ?? observation?.self?.health ?? null;
  const near = hostileMobs(observation).filter((m) => m.distance <= HOSTILE_RANGE);
  const verdict = (kind, mob) => {
    const rule = ruleNameFor(policy, mob.type);
    return { kind, mob, rule, ...effectiveAction(rule && policy[rule], health), flee_distance: rule ? policy[rule].flee_distance : null };
  };
  if (Number.isFinite(prevHealth) && Number.isFinite(health) && health < prevHealth && !cooling('hit')) {
    const hurt = [...(observation?.recent_events ?? [])].reverse().find((e) => e?.type === 'self_hurt' || e?.type === 'self_damage');
    const source = near.find((m) => m.id === hurt?.source_id) ?? near[0] ?? null;
    return source ? verdict('hit', source) : { kind: 'hit', mob: null, rule: null, action: 'ignore', why: 'unknown_source', flee_distance: null };
  }
  for (const mob of near) {
    if (cooling(`mob:${mob.id}`)) continue;
    const v = verdict('hostile_close', mob);
    if (v.action !== 'ignore') return v;
  }
  return null;
}

// A hostile inside the range that no fight or flee rule covers: the model is asked, nothing is forced.
export function ignoredHostileClose(policy, observation) {
  return hostileMobs(observation).some((m) => m.distance <= HOSTILE_RANGE
    && effectiveAction(policy?.[ruleNameFor(policy, m.type)], observation?.health).action === 'ignore');
}

// The attack or flee primitive for a verdict. Callers still pass it through validatePrimitive.
export function primitiveFor(v) {
  if (v.action === 'fight' && v.mob) return { type: 'primitive', name: 'attack', args: { mob_id: v.mob.id } };
  if (v.action === 'flee' && v.flee_distance != null) {
    return { type: 'primitive', name: 'flee', args: v.mob ? { from_mob_id: v.mob.id, blocks: v.flee_distance }
      : { away_from: v.away_from, blocks: v.flee_distance } };
  }
  return null;
}
