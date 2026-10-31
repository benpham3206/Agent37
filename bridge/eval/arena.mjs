import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionArbiter } from '../arbiter.js';

export const SEED = 37001;

function at(object, key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(key)) {
    throw new Error('condition needs a dot-separated observation path');
  }
  const parts = key.split('.');
  const found = parts.reduce((value, part) =>
    value != null && Object.hasOwn(value, part) ? value[part] : undefined, object);
  // A complete inventory count map has known zero counts for absent items.
  // A missing inventory observation is still unknown, not zero.
  if (found === undefined && parts.length === 2 && parts[0] === 'inventory' &&
      object?.inventory !== null && typeof object?.inventory === 'object') return 0;
  return found;
}

export function checkCondition(condition, before, after) {
  if (!condition || typeof condition.path !== 'string') throw new Error('missing observable condition');
  const equals = Object.hasOwn(condition, 'equals');
  const increase = Number.isFinite(condition.increase_by) && condition.increase_by > 0;
  if (equals === increase) throw new Error('condition needs either equals or a positive increase_by');
  const value = at(after, condition.path);
  if (value === undefined || value === null) return false;
  if (equals) return isDeepStrictEqual(value, condition.equals);
  if (increase) {
    const previous = at(before, condition.path);
    return Number.isFinite(previous) && Number.isFinite(value) && value - previous >= condition.increase_by;
  }
  throw new Error('condition needs equals or a positive increase_by');
}

function trialBot(arena, signal) {
  return Object.freeze({
    observe: () => structuredClone(arena.observe()),
    requestAction(action) {
      signal.throwIfAborted();
      arena.arbiter.set('skill', action, 'evaluation');
    },
    releaseControls() {
      // A late cleanup from a canceled skill must not stop the next trial.
      if (!signal.aborted) arena.release();
    },
  });
}

export function createCiArena() {
  const events = new EventEmitter();
  const arbiter = new ActionArbiter();
  let state;
  const arena = {
    events, arbiter, synthetic: true,
    observe: () => structuredClone(state),
    async reset(_steps, { signal } = {}) {
      signal?.throwIfAborted();
      arena.release();
      // Test fixture only. This does not reset or connect to Minecraft.
      state = { self: { health: 20, position: { x: 0, y: 0, z: 0 } }, test: { ready: true } };
    },
    release: () => arbiter.release('evaluation_cleanup'),
    close() { arena.release(); },
    bot: (signal) => trialBot(arena, signal),
  };
  return arena;
}

// Same hostile list as server.js (HOSTILE_MOBS), kept here so the arena can
// count hostile kills without changing the server.
export const HOSTILE_MOBS = new Set(['zombie','skeleton','husk','drowned','stray','bogged','enderman','blaze','phantom','creeper','spider','cave_spider','witch','pillager','vindicator','evoker','ravager','guardian','elder_guardian','slime','magma_cube','piglin_brute','hoglin','zoglin','wither_skeleton']);

export function targetType(skill) {
  const input = skill?.requirements?.input ?? {};
  const type = input.target_type ?? skill?.requirements?.target_type ?? 'zombie';
  const allowed = input.allowed_targets ?? [...HOSTILE_MOBS];
  if (typeof type !== 'string' || !HOSTILE_MOBS.has(type) || !allowed.includes(type)) {
    throw new Error(`target_type must be one of: ${allowed.join(', ')}`);
  }
  return type;
}

export function countMobs(bot, name) {
  return Object.values(bot?.entities ?? {}).filter((entity) => entity?.name === name).length;
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set for --live`);
  return value;
}

function port(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('invalid server port');
  return number;
}

// Uses the existing runtime, never a second source of direct Mineflayer controls.
// No connection or world commands happen unless --live was explicitly selected.
export async function createLiveArena({ skill, dataDir, env = process.env, runtimeFactory = null, command = null }) {
  if (skill.requirements?.ci_only) throw new Error('this skill is test-only; use --ci');
  if (env.A37_EVAL_APPROVED_RESET !== '1') {
    throw new Error('live reset needs team approval; set A37_EVAL_APPROVED_RESET=1 only for the approved test world');
  }
  const config = {
    host: required(env, 'A37_MC_HOST'), port: port(required(env, 'A37_MC_PORT')),
    username: required(env, 'A37_EVAL_USERNAME'),
    version: required(env, 'A37_MC_VERSION'),
    webPort: env.A37_EVAL_WEB_PORT ? port(env.A37_EVAL_WEB_PORT) : 0,
    viewerPort: 0, bind: '127.0.0.1', target: targetType(skill),
    session: `eval-${process.pid}-${Date.now()}`, dataDir,
  };
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(config.username)) throw new Error('invalid bot username');
  const rcon = {
    host: required(env, 'A37_RCON_HOST'), port: port(required(env, 'A37_RCON_PORT')),
    password: required(env, 'A37_RCON_PASSWORD'),
  };
  const createRuntime = runtimeFactory ?? (await import('../server.js')).createRuntime;
  const rconCommand = command ?? (await import('../rcon.js')).rconCommand;
  const events = new EventEmitter();
  const runtime = await createRuntime(config);
  let pendingCommand = null;
  // Start at known zeros so 'increase_by' checks work on the first kill.
  const kills = { hostile_total: 0, [config.target]: 0 };
  const arena = {
    events, arbiter: runtime.arbiter, synthetic: false,
    observe() {
      const observation = runtime.state().observation;
      // Vanilla inventory item counts, not invented observations.
      const items = runtime.bot?.inventory?.items?.();
      observation.inventory = items ? items.reduce((counts, item) => {
        counts[item.name] = (counts[item.name] ?? 0) + item.count;
        return counts;
      }, {}) : null;
      // Kill counts let success checks see a target die; the server's own
      // target field moves on to the next mob or null when one dies.
      observation.kills = { ...kills };
      observation.trial = { target_type: config.target, targets: countMobs(runtime.bot, config.target) };
      return observation;
    },
    async reset(steps, { signal }) {
      signal.throwIfAborted();
      if (runtime.arbiter.sources.has('human')) {
        events.emit('human_takeover');
        throw new Error('human_takeover');
      }
      arena.release();
      if (!Array.isArray(steps) || steps.length === 0) throw new Error('live skills need verified reset_steps');
      for (const step of steps) {
        signal.throwIfAborted();
        if (typeof step.command !== 'string' || !step.command.trim() || /[\r\n]/.test(step.command) || !step.verify) {
          throw new Error('each live reset step needs one command and an observation verify condition');
        }
        // Commands belong to a team-reviewed skill in an approved test world.
        pendingCommand = rconCommand(rcon, step.command.replaceAll('{username}', config.username).replaceAll('{target}', config.target));
        try { await pendingCommand; }
        finally { pendingCommand = null; }
        signal.throwIfAborted();
        const deadline = performance.now() + 5000;
        while (!checkCondition(step.verify, null, arena.observe())) {
          signal.throwIfAborted();
          if (performance.now() >= deadline) throw new Error('reset verification failed');
          await delay(50, undefined, { signal });
        }
      }
      if (!(arena.observe().self?.health > 0)) throw new Error('bot is not alive after reset');
    },
    release() {
      runtime.arbiter.release('evaluation_cleanup');
      // These writes only apply the arbiter's released state, never a skill action.
      runtime.bot?.clearControlStates?.();
      runtime.bot?.deactivateItem?.();
    },
    // RCON already bounds each command. Let an in-flight command settle before
    // resetting the next trial, so a canceled reset cannot change it later.
    async settleReset() { await pendingCommand?.catch(() => {}); },
    close() {
      arena.release();
      runtime.recorder.stop();
      runtime.bot?.viewer?.close?.();
      for (const socket of runtime.ws.clients) socket.terminate();
      runtime.close();
    },
    bot: (signal) => trialBot(arena, signal),
  };
  runtime.bot?.on('entityDead', (entity) => {
    if (entity && entity !== runtime.bot.entity && typeof entity.name === 'string') {
      kills[entity.name] = (kills[entity.name] ?? 0) + 1;
      if (HOSTILE_MOBS.has(entity.name)) kills.hostile_total++;
    }
  });
  runtime.bot?.on('death', () => events.emit('failure', 'bot_death'));
  for (const event of ['error', 'kicked', 'end']) {
    runtime.bot?.on(event, () => events.emit('failure', `bot_${event}`));
  }
  // Observe the same UI messages the existing bridge uses. No server/UI edits.
  runtime.ws.on('connection', (socket) => socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw);
      if (['control', 'resume_control', 'release', 'target', 'imitation', 'setGamemode', 'emergency_stop'].includes(message.type)) events.emit('human_takeover');
      if (message.type === 'emergency_stop') events.emit('failure', 'emergency_stop');
    } catch { /* The bridge already rejects malformed messages. */ }
  }));
  try {
    let connectionFailure = null;
    const onFailure = (reason) => { connectionFailure = reason; };
    events.on('failure', onFailure);
    try {
      const deadline = performance.now() + 15000;
      while (!runtime.state().spawned) {
        if (connectionFailure) throw new Error(connectionFailure);
        if (performance.now() >= deadline) throw new Error('bot spawn timed out');
        await delay(50);
      }
    } finally { events.off('failure', onFailure); }
    // A seeded run cannot claim the configured seed without checking the world.
    const reply = await rconCommand(rcon, 'seed');
    if (!new RegExp(`\\[${SEED}\\]`).test(reply)) throw new Error(`approved world must use seed ${SEED}`);
    return arena;
  } catch (error) {
    arena.close();
    throw error;
  }
}
