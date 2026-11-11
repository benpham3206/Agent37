import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIELDS = Object.freeze([
  'name', 'version', 'implementation', 'requirements',
  'success_check', 'reset_steps', 'evaluation',
]);
const defaultRoot = fileURLToPath(new URL('./', import.meta.url));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function versionNumber(value) {
  if (!['string', 'number'].includes(typeof value) ||
      !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('version must be a positive integer');
  }
  return Number(value);
}

function checkName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(name)) {
    throw new Error('invalid skill name');
  }
}

export class SkillRegistry {
  constructor(root = defaultRoot) { this.root = path.resolve(root); }

  directory(name, version) {
    checkName(name);
    const directory = path.join(this.root, name, `v${versionNumber(version)}`);
    this.contained(directory);
    return directory;
  }

  // Refuse links that point outside the registry, including artifact links.
  contained(filename) {
    const relative = path.relative(fs.realpathSync(this.root), fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path leaves skill registry');
    return filename;
  }

  load(name, version) {
    const filename = this.contained(path.join(this.directory(name, version), 'skill.json'));
    const skill = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!object(skill) || Object.keys(skill).length !== FIELDS.length ||
        FIELDS.some((field) => !Object.hasOwn(skill, field))) {
      throw new Error(`skill.json must contain exactly these fields: ${FIELDS.join(', ')}`);
    }
    if (skill.name !== name || versionNumber(skill.version) !== versionNumber(version)) {
      throw new Error('skill name or version does not match its directory');
    }
    for (const field of ['implementation', 'requirements', 'success_check', 'evaluation']) {
      if (skill[field] !== null && !object(skill[field])) throw new Error(`${field} must be an object or null`);
    }
    if (skill.reset_steps !== null && !Array.isArray(skill.reset_steps)) {
      throw new Error('reset_steps must be an array or null');
    }
    return skill;
  }

  pointers() {
    const pointers = JSON.parse(fs.readFileSync(this.contained(path.join(this.root, 'active.json')), 'utf8'));
    if (!object(pointers)) throw new Error('active.json must map names to versions');
    return pointers;
  }

  get(name) {
    checkName(name);
    const pointers = this.pointers();
    if (!Object.hasOwn(pointers, name)) throw new Error(`no active version for ${name}; use --version for a candidate`);
    return this.load(name, pointers[name]);
  }

  activate(name, version) {
    const skill = this.load(name, version);
    const evaluation = skill.evaluation;
    if (!evaluation || evaluation.tested_version == null ||
        versionNumber(evaluation.tested_version) !== versionNumber(version) ||
        !['trial_count', 'successes', 'failures', 'timeouts', 'human_interventions'].every((key) => count(evaluation[key])) ||
        evaluation.trial_count < 20 || evaluation.successes < 16 ||
        evaluation.successes + evaluation.failures + evaluation.timeouts !== evaluation.trial_count ||
        evaluation.human_interventions !== 0 || evaluation.synthetic !== false) {
      throw new Error('activation requires matching real results: >=20 trials, >=16 successes, no human intervention');
    }
    // This is the general gate. It cannot replace the combat contract's separate
    // frozen zombie/skeleton evaluation and safety approval.
    if (skill.requirements?.combat === true || skill.name.startsWith('combat.')) {
      throw new Error('combat promotion requires the existing combat approval path');
    }
    const pointers = this.pointers();
    pointers[name] = versionNumber(version);
    const filename = path.join(this.root, 'active.json');
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(pointers, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(temporary, filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return skill;
  }
}

const registry = new SkillRegistry();
export const load = (name, version) => registry.load(name, version);
export const get = (name) => registry.get(name);
export const activate = (name, version) => registry.activate(name, version);
