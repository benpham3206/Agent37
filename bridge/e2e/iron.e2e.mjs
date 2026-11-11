import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLiveArena } from '../eval/arena.mjs';
import { runTrial } from '../eval/run.mjs';
import { SkillRegistry } from '../skills/registry.js';
import { run } from '../skills/resource.mine_iron_ore/v1/index.js';
import { createRuntime } from '../server.js';
import { rconCommand } from '../rcon.js';
import { spreadSucceeded } from './spread-reply.js';
import { evalSeed, resultsDir as localResults } from './local.js';

const username = 'ReplayBot';
const key = (position) => `${position.x},${position.y},${position.z}`;
const regionCenters = { surface: { x: 7000, z: 5000 }, real: { x: 3984, z: -8224 } };
const inRegion = (position, center, radius = 300) => position && Math.hypot(position.x - center.x, position.z - center.z) <= radius;

export function parseOptions(args, env = process.env) {
  const { values } = parseArgs({ args, options: { milestone: { type: 'string' }, trials: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) return { help: true };
  if (!['surface', 'real'].includes(values.milestone) || !/^[1-9]\d*$/.test(values.trials ?? '') || Number(values.trials) > 20) {
    throw new Error('usage: --milestone surface|real --trials 1..20');
  }
  for (const name of ['A37_MC_HOST', 'A37_RCON_HOST']) {
    if (!['127.0.0.1', 'localhost'].includes(env[name])) throw new Error(`${name}_must_be_loopback`);
  }
  for (const [name, value] of Object.entries({ A37_MC_PORT: '25565', A37_MC_VERSION: '1.21.1',
    A37_EVAL_USERNAME: username, A37_RCON_PORT: '25575', A37_EVAL_WEB_PORT: '8742' })) {
    if (env[name] !== value) throw new Error(`${name}_must_match_iron_packet`);
  }
  if (env.A37_EVAL_APPROVED_RESET !== '1') throw new Error('approved_reset_required');
  if (!env.A37_RCON_PASSWORD) throw new Error('rcon_password_missing');
  return { milestone: values.milestone, trials: Number(values.trials) };
}

function reserveSites(directory, count, output, milestone) {
  const reservations = path.join(directory, 'sites');
  fs.mkdirSync(reservations, { recursive: true });
  const used = new Set();
  for (const filename of fs.readdirSync(directory).filter((name) => name.startsWith(milestone + '-') && name.endsWith('.json'))) {
    const previous = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    for (const site of [...(previous.sites ?? []), ...previous.trials.map((row) => row.site)]) if (site) used.add(site.slot);
    if (!previous.sites && !previous.trials.length) used.add(0);
  }
  const sites = [];
  for (let slot = 0; sites.length < count; slot++) {
    if (slot >= 200) throw new Error('fresh_sites_exhausted');
    const site = milestone === 'surface' ? { slot, x: 7000 + (slot % 10) * 14, z: 5000 + Math.floor(slot / 10) * 14 }
      : { slot, x: 3984 + ((slot % 5) - 2) * 25, z: -8224 + ((Math.floor(slot / 5) % 5) - 2) * 25 };
    if (!inRegion(site, regionCenters[milestone], 270)) throw new Error('fresh_surface_sites_exhausted');
    if (used.has(slot)) continue;
    try { fs.writeFileSync(path.join(reservations, `${milestone}-${slot}.json`), JSON.stringify({ ...site, output }) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    sites.push(site);
  }
  return sites;
}

export async function evaluateIron({ milestone = 'surface', trials, env = process.env, resultsDirectory = localResults('iron'),
  runtimeFactory = createRuntime, command = rconCommand, skillRunner = run, writeLine = console.log, synthetic = false }) {
  parseOptions(['--milestone', milestone, '--trials', String(trials)], env);
  const expectedSeed = evalSeed();
  const center = regionCenters[milestone];
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const output = path.join(resultsDirectory, `${milestone}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
  const sites = reserveSites(resultsDirectory, trials, output, milestone);
  const report = { milestone, seed: expectedSeed, username, synthetic, requested_trials: trials, sites,
    staging: milestone === 'surface' ? ['iron_ore placed on a stone pad at y=100', 'stone_pickaxe in hotbar.0',
      'health and hunger restored before trial', 'slow_falling during pad setup only']
      : ['natural surface via spreadplayers, no blocks placed', 'stone_pickaxe in hotbar.0', 'health and hunger restored before trial'],
    startup_commands: [], trials: [], cleanup: null };
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  save();
  const rcon = { host: env.A37_RCON_HOST, port: Number(env.A37_RCON_PORT), password: env.A37_RCON_PASSWORD, timeoutMs: 10000 };
  const skill = new SkillRegistry().load('resource.mine_iron_ore', 1);
  if (milestone === 'real') skill.success_check.time_limit_ms = 540000;
  report.limits = { execution_ms: skill.success_check.time_limit_ms, reset_ms: 30000, rcon_command_ms: 10000,
    total_trial_cap_ms: milestone === 'real' ? 600000 : 110000 };
  let runtime, arena, active, pendingCommand, botEnded = false, stopReason = null;
  const send = async (text) => {
    const entry = { command: text, started_at: Date.now() };
    (active?.commands ?? report.startup_commands).push(entry);
    save();
    try {
      const timeoutMs = text.startsWith('spreadplayers ') ? 15000 : rcon.timeoutMs;
      pendingCommand = command({ ...rcon, timeoutMs }, text);
      entry.reply = await pendingCommand;
      if (/Unknown or incomplete|Incorrect argument|No player was found|not loaded|not allowed|outside of the world/i.test(entry.reply)) throw new Error('rcon_command_rejected');
      return entry.reply;
    } catch (error) { entry.error = error.message; throw error; }
    finally { entry.finished_at = Date.now(); pendingCommand = null; save(); }
  };
  const stop = () => {
    stopReason = 'operator_abort';
    arena?.events.emit('failure', stopReason);
    runtime?.bot?.quit?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const previousJev = process.env.AGENT37_JEV;
  try {
    process.env.AGENT37_JEV = '0';
    arena = await createLiveArena({ skill, dataDir: path.join(resultsDirectory, 'sessions'), env, expectedSeed,
      command: (_config, text) => send(text),
      runtimeFactory: async (config) => {
        runtime = await runtimeFactory({ ...config, viewerPort: 3742 });
        runtime.bot.on('end', () => { botEnded = true; });
        runtime.bot.on('diggingCompleted', (air) => {
          const requested = active?.requested_digs[key(air.position)];
          if (requested) active.broken.push({ ...requested, completed_as: air.name, at: Date.now() });
        });
        runtime.bot.on('death', () => active?.incidents.push({ type: 'death', at: Date.now() }));
        return runtime;
      } });
    arena.settleReset = async () => { await pendingCommand?.catch(() => {}); };
    arena.reset = async (_steps, { signal }) => {
      signal.throwIfAborted();
      if (stopReason) throw new Error(stopReason);
      if (runtime.arbiter.sources.has('human')) throw new Error('human_takeover');
      arena.release();
      const { x, z } = active.site;
      let spreadSpot = null;
      const setup = async (text) => { signal.throwIfAborted(); const reply = await send(text); signal.throwIfAborted(); return reply; };
      await setup(`gamemode survival ${username}`);
      if (milestone === 'surface') {
        await setup(`effect give ${username} minecraft:slow_falling 20 0 true`);
        await setup(`tp ${username} ${x + 0.5} 105 ${z + 0.5}`);
        const tpDeadline = Date.now() + 5000;
        for (;;) {
          signal.throwIfAborted();
          const position = arena.observe().self.position;
          if (inRegion(position, center, 280) && Math.hypot(position.x - x - 0.5, position.z - z - 0.5) <= 0.2) break;
          if (Date.now() >= tpDeadline) throw new Error('region_teleport_not_observed');
          await delay(100, undefined, { signal });
        }
        await setup(`fill ${x - 5} 100 ${z - 5} ${x + 7} 100 ${z + 5} minecraft:stone`);
        await setup(`fill ${x - 5} 101 ${z - 5} ${x + 7} 104 ${z + 5} minecraft:air`);
        await setup(`setblock ${x + 3} 101 ${z} minecraft:iron_ore`);
        await setup(`tp ${username} ${x + 0.5} 101 ${z + 0.5} -90 0`);
      } else {
        for (const spot of [{ x, z }, { x: x + 60, z }, { x: x - 60, z }, { x, z: z + 60 }, { x, z: z - 60 }]) {
          if (!inRegion(spot, center, 280)) continue;
          if (spreadSucceeded(await setup(`spreadplayers ${spot.x} ${spot.z} 0 25 false ${username}`))) { spreadSpot = spot; break; }
        }
        if (!spreadSpot) throw new Error('region_spread_failed');
        active.spread_spot = spreadSpot;
      }
      await setup(`clear ${username}`);
      await setup(`item replace entity ${username} hotbar.0 with minecraft:stone_pickaxe`);
      await setup(`effect give ${username} minecraft:instant_health 1 4 true`);
      await setup(`effect give ${username} minecraft:saturation 1 4 true`);
      if (milestone === 'surface') await setup(`effect clear ${username} minecraft:slow_falling`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const o = arena.observe(), ore = o.facts?.nearest_blocks?.iron_ore;
        active.reset_observation = { game_mode: runtime.bot.game?.gameMode, observation: o };
        const positionReady = milestone === 'surface'
          ? Math.hypot(o.self.position.x - x - 0.5, o.self.position.z - z - 0.5) < 0.1 && Math.abs(o.self.position.y - 101) < 0.1 &&
            ore && Math.round(o.facts.position.x + ore.dx) === x + 3 && Math.round(o.facts.position.y + ore.dy) === 101 && Math.round(o.facts.position.z + ore.dz) === z
          : Math.hypot(o.self.position.x - spreadSpot.x, o.self.position.z - spreadSpot.z) <= 30 && o.facts.dimension === 'overworld' && o.terrain?.support_center === 1;
        if (runtime.bot.game?.gameMode === 'survival' && o.self?.on_ground === true && o.self?.health === 20 && o.self?.hunger === 20 &&
            o.self?.held_item === 'stone_pickaxe' && o.self.hotbar_slot === 0 && o.inventory?.stone_pickaxe === 1 && !o.inventory.raw_iron &&
            positionReady) return;
        await delay(100, undefined, { signal });
      }
      throw new Error('region_reset_verification_failed');
    };
    for (let trial = 1; trial <= trials; trial++) {
      active = { trial, site: sites[trial - 1], commands: [], broken: [], requested_digs: {}, incidents: [], trace: [] };
      report.active_trial = active;
      save();
      let row;
      try {
        if (stopReason) throw new Error(`not_run:${stopReason}`);
        active.tick_before = await send('tick query');
        let lastTrace = 0, lastObservation;
        const measuredRun = async (bot, input, context) => {
          const result = await skillRunner({ ...bot,
          observe() {
            const o = bot.observe();
            lastObservation = o;
            if (!inRegion(o.self.position, center, 290)) throw new Error('region_boundary');
            if (Date.now() - lastTrace >= 2000) {
              lastTrace = Date.now();
              active.trace.push({ at: Date.now(), position: o.self.position, health: o.self.health, hunger: o.self.hunger,
                on_ground: o.self.on_ground, velocity: o.self.velocity, terrain: o.terrain,
                inventory: o.inventory, ores: Object.fromEntries(Object.entries(o.facts?.nearest_blocks ?? {}).filter(([type]) => type.includes('iron_ore'))),
                hazards: o.terrain?.hazards, hostiles: o.hostiles, incoming_attack: o.self.incoming_attack });
              save();
            }
            return o;
          },
          requestAction(action) {
            if (action.dig) {
              if (!inRegion(action.dig, center)) throw new Error('region_boundary');
              let typeAtDig = null;
              for (const type of Object.keys(lastObservation?.facts?.nearest_blocks ?? {})) {
                const fact = lastObservation?.facts?.nearest_blocks[type], position = lastObservation?.facts?.position;
                if (fact && key(action.dig) === key({ x: Math.round(position.x + fact.dx), y: Math.round(position.y + fact.dy), z: Math.round(position.z + fact.dz) })) {
                  typeAtDig = type;
                }
              }
              const p = lastObservation.self.position, yaw = lastObservation.self.yaw;
              const forward = { x: Math.floor(p.x - Math.sin(yaw)), z: Math.floor(p.z - Math.cos(yaw)) };
              if (action.dig.x === forward.x && action.dig.z === forward.z) {
                const terrain = lastObservation.terrain;
                typeAtDig ??= action.dig.y === Math.floor(p.y) + 1 ? terrain.clearance?.forward?.head
                  : action.dig.y === Math.floor(p.y) ? terrain.clearance?.forward?.body : terrain.support_grid?.[2]?.[1]?.support;
              }
              const previous = active.requested_digs[key(action.dig)];
              active.requested_digs[key(action.dig)] = previous ? { ...previous, requests: previous.requests + 1, last_at: Date.now() }
                : { type: typeAtDig ?? 'unknown', position: action.dig, first_at: Date.now(), requests: 1, first_on_ground: lastObservation.self.on_ground, first_held_item: lastObservation.self.held_item };
            }
            bot.requestAction(action);
          },
          }, input, context);
          active.navigation = result.navigation ?? null;
          return result;
        };
        row = await runTrial({ arena, skill, run: measuredRun, trial,
          input: milestone === 'real' ? { descent: true, bounds: { x: 3984, z: -8224, radius: 280 }, min_y: -48, max_steps: 120 } : {} });
      } catch (error) { row = { trial, outcome: 'failure', reason: error.message, elapsed_ms: 0, before: null, after: null, synthetic }; }
      row.raw_iron_collected = (row.after?.inventory?.raw_iron ?? 0) - (row.before?.inventory?.raw_iron ?? 0);
      Object.assign(row, active);
      row.synthetic = synthetic;
      if (row.outcome === 'success' && !row.broken.some((block) => ['iron_ore', 'deepslate_iron_ore'].includes(block.type))) {
        row.outcome = 'failure'; row.reason = 'no_bot_ore_break_evidence';
      }
      report.trials.push(row);
      delete report.active_trial;
      save();
      if (/rcon_|bot_(end|error|kicked|death)|operator_abort|human_takeover|emergency_stop/.test(row.reason)) stopReason ??= row.reason;
      if (!stopReason) {
        try { row.tick_after = await send('tick query'); }
        catch (error) { row.tick_after_error = error.message; stopReason = error.message; report.health_error = error.message; }
      }
      save();
      writeLine(`${row.outcome === 'success' ? 'PASS' : 'FAIL'} ${milestone} trial=${trial} reason=${row.reason} seconds=${(row.elapsed_ms / 1000).toFixed(3)} raw_iron=${row.raw_iron_collected}`);
    }
  } catch (error) {
    report.startup_error = error.message;
    for (let trial = report.trials.length + 1; trial <= trials; trial++) {
      const row = { trial, site: sites[trial - 1], outcome: 'failure', reason: `startup:${error.message}`, elapsed_ms: 0, raw_iron_collected: 0, before: null, after: null, synthetic };
      report.trials.push(row);
      writeLine(`FAIL ${milestone} trial=${trial} reason=${row.reason} seconds=0.000 raw_iron=0`);
    }
  } finally {
    const cleanup = { bot_end_observed: botEnded, forced_socket_close: false, errors: [] };
    try { arena?.close(); }
    catch (error) { cleanup.errors.push(error.message); }
    if (runtime && !botEnded) {
      const deadline = Date.now() + 5000;
      while (!botEnded && Date.now() < deadline) await delay(50);
      if (!botEnded) {
        try { runtime.bot?._client?.socket?.destroy(); cleanup.forced_socket_close = Boolean(runtime.bot?._client?.socket?.destroyed); }
        catch (error) { cleanup.errors.push(error.message); }
      }
    }
    cleanup.bot_end_observed = botEnded;
    cleanup.ok = (!runtime || botEnded || cleanup.forced_socket_close) && !cleanup.errors.length;
    report.cleanup = cleanup;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (previousJev === undefined) delete process.env.AGENT37_JEV;
    else process.env.AGENT37_JEV = previousJev;
    save();
  }
  const times = report.trials.filter((row) => row.before !== null).map((row) => row.elapsed_ms).sort((a, b) => a - b);
  report.summary = { trials: report.trials.length, successes: report.trials.filter((row) => row.outcome === 'success').length,
    timed_trials: times.length, timing: 'skill execution after reset',
    median_seconds: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2000 : null,
    raw_iron_collected: report.trials.reduce((total, row) => total + row.raw_iron_collected, 0),
    failures: report.trials.filter((row) => row.outcome !== 'success').reduce((counts, row) => ({ ...counts, [row.reason]: (counts[row.reason] ?? 0) + 1 }), {}) };
  const passed = report.summary.successes === trials && report.cleanup.ok && !report.health_error;
  report.summary.status = passed ? 'PASS' : 'FAIL';
  save();
  writeLine(`SUMMARY ${report.summary.status} milestone=${milestone} trials=${report.summary.trials} successes=${report.summary.successes} raw_iron=${report.summary.raw_iron_collected} median_seconds=${report.summary.median_seconds} failures=${JSON.stringify(report.summary.failures)} health_error=${report.health_error ?? 'none'} cleanup_ok=${report.cleanup.ok} results=${output}`);
  return { report, output, exitCode: passed ? 0 : 1 };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('Usage: node e2e/iron.e2e.mjs --milestone surface|real --trials N');
    console.log('Set the loopback server, RCON and A37_EVAL_SEED settings first. Real mining uses natural terrain and places no blocks.');
    console.log(`Viewer http://127.0.0.1:3742/. No control websocket is opened. Results ${localResults('iron')}.`);
    return 0;
  }
  return (await evaluateIron(options)).exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`FAIL setup reason=${error.message}`);
    console.error('SUMMARY FAIL trials=0 successes=0');
    process.exit(1);
  });
}
