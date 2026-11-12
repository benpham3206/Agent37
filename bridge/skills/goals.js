// The ordered advancement goals in goals.json and a picker for the next one.
import fs from 'node:fs';
import path from 'node:path';
import { SkillRegistry } from './registry.js';

export const GOAL_COUNT = 5;
const ID = /^minecraft:[a-z0-9_]+\/[a-z0-9_/]+$/;
const defaultFile = new URL('./goals.json', import.meta.url);

// True when the skill has at least one vN/skill.json folder that the J1 registry accepts.
function hasTemplate(registry, name) {
  let versions;
  try { versions = fs.readdirSync(path.join(registry.root, name)); }
  catch { return false; }
  return versions.some((entry) => {
    const match = /^v([1-9]\d*)$/.exec(entry);
    if (!match) return false;
    try { registry.load(name, Number(match[1])); return true; } // load also rejects bad names
    catch { return false; }
  });
}

// Checks the parsed goals.json and returns a frozen copy of its goals.
// Every skill must have a template folder in bridge/skills/, or be marked "planned": true.
export function validateGoals(data, registry = new SkillRegistry()) {
  const goals = data?.goals;
  if (!Array.isArray(goals) || goals.length !== GOAL_COUNT) throw new Error(`goals.json needs exactly ${GOAL_COUNT} goals`);
  const seen = new Set();
  return Object.freeze(goals.map((goal, index) => {
    const where = `goal ${index + 1}`;
    if (typeof goal?.id !== 'string' || !ID.test(goal.id)) throw new Error(`${where}: id must look like minecraft:story/root`);
    if (seen.has(goal.id)) throw new Error(`${where}: ${goal.id} is listed twice`);
    seen.add(goal.id);
    if (typeof goal.skill !== 'string' || !goal.skill) throw new Error(`${where}: skill name is required`);
    if (goal.planned !== undefined && typeof goal.planned !== 'boolean') throw new Error(`${where}: planned must be true or false`);
    if (goal.planned !== true && !hasTemplate(registry, goal.skill)) {
      throw new Error(`${where}: ${goal.skill} has no bridge/skills/${goal.skill}/vN/skill.json; add it or mark the goal "planned": true`);
    }
    return Object.freeze({ id: goal.id, skill: goal.skill, planned: goal.planned === true });
  }));
}

export function loadGoals({ file = defaultFile, registry = new SkillRegistry() } = {}) {
  return validateGoals(JSON.parse(fs.readFileSync(file, 'utf8')), registry);
}

let cached = null;
const defaultGoals = () => (cached ??= loadGoals());

// summary is what AdvancementTracker.get() returns: { done: [...], in_progress: [...] }.
// Returns { id, skill } for the first goal not in done, or null when all are done.
// Pure: it only reads its arguments (the default goal list is loaded once and cached).
export function pickNextGoal(summary, goals = defaultGoals()) {
  const done = new Set(Array.isArray(summary?.done) ? summary.done : []);
  const next = goals.find((goal) => !done.has(goal.id));
  return next ? { id: next.id, skill: next.skill } : null;
}
