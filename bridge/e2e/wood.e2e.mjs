import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { SkillRegistry } from '../skills/registry.js';
import { createLiveArena } from '../eval/arena.mjs';
import { runTrial } from '../eval/run.mjs';
import { createRuntime } from '../server.js';
import { rconCommand } from '../rcon.js';
import { run, countLogs } from '../skills/resource.collect_wood/v1/index.js';
import { evalSeed, resultsDir } from './local.js';

const USERNAME = 'SparPartner';
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const inRegion = (p, radius = 390) => p && Math.hypot(p.x - 9000, p.z - 5000) <= radius;
const hasLog = (o) => Object.keys(o.facts?.nearest_blocks ?? {}).some((name) => name.endsWith('_log'));
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null;
};

export function parseOptions(args, env) {
  const { values } = parseArgs({ args, strict: true, options: {
    milestone: { type: 'string' }, trials: { type: 'string' },
  } });
  if (values.milestone === 'fresh') throw new Error('fresh_deferred:near_live_result_required');
  if (values.milestone !== 'near' || !/^[1-5]$/.test(values.trials ?? '')) {
    throw new Error('usage: node e2e/wood.e2e.mjs --milestone near --trials N (1..5)');
  }
  if (!['127.0.0.1', 'localhost'].includes(env.A37_MC_HOST)) throw new Error('loopback_mc_host_required');
  if (!['127.0.0.1', 'localhost'].includes(env.A37_RCON_HOST)) throw new Error('loopback_rcon_host_required');
  if (env.A37_EVAL_USERNAME !== USERNAME || env.A37_EVAL_APPROVED_RESET !== '1') throw new Error('approved_SparPartner_reset_required');
  for (const [name, expected] of Object.entries({ A37_MC_PORT: '25565', A37_RCON_PORT: '25575', A37_MC_VERSION: '1.21.1', A37_EVAL_WEB_PORT: '8743' })) {
    if (env[name] !== expected) throw new Error('invalid_' + name);
  }
  if (env.AGENT37_JEV === '1') throw new Error('jev_must_be_disabled');
  return { milestone: 'near', trials: Number(values.trials), count: 1 };
}

export async function main(args = process.argv.slice(2), services = {}) {
  const env = services.env ?? process.env, options = parseOptions(args, env);
  const root = services.resultsDir ?? resultsDir('wood'), log = services.log ?? console.log, wait = services.wait ?? delay;
  const disk = services.files ?? fs;
  const password = env.A37_RCON_PASSWORD || services.readPassword?.();
  if (!password) throw new Error('rcon_password_unavailable');
  env.A37_RCON_PASSWORD = password;
  disk.mkdirSync(root, { recursive: true });
  const output = path.join(root, new Date().toISOString().replaceAll(':', '-') + '-' + process.pid + '-near.json');
  const report = { milestone: 'near', requested_trials: options.trials, seed: evalSeed(),
    username: USERNAME, goal_count: 1, synthetic: Boolean(services.makeRuntime),
    trials: [], setups: [], commands: [], tick_health: [], fatal_reason: null, cleanup: null, natural_terrain: true };
  const save = () => disk.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const used = disk.readdirSync(root).filter((name) => name.endsWith('-near.json')).flatMap((name) => {
    const previous = JSON.parse(disk.readFileSync(path.join(root, name), 'utf8'));
    return [...(previous.trials ?? []).flatMap((row) => row.start_position ? [row.start_position] : []),
      ...(previous.setups ?? []).map((setup) => setup.spot)];
  });
  const spots = [-270, -90, 90, 270].flatMap((x) => [-270, -90, 90, 270].map((z) => ({ x: 9000 + x, z: 5000 + z })));
  let runtime, arena, sampler, activeSamples, activeActions, trialSetup, fatal = null, pendingReset = null;
  let closing = null, activeTrial = null;
  const controller = new AbortController();
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(sampler);
      if (!runtime) { report.cleanup = { disconnected: true, reason: 'runtime_not_started' }; return; }
      let endTimer;
      const ended = new Promise((resolve) => {
        runtime.bot.once('end', () => { clearTimeout(endTimer); resolve(true); });
        endTimer = setTimeout(() => resolve(false), 2000);
      });
      if (arena) arena.close();
      else { runtime.bot?.viewer?.close?.(); runtime.close(); }
      const disconnected = runtime.bot?._client?.state === 'disconnected' || await ended;
      clearTimeout(endTimer);
      if (!disconnected) runtime.bot?._client?.end?.('wood_e2e_cleanup');
      report.cleanup = { disconnected: disconnected || runtime.bot?._client?.state === 'disconnected', forced: !disconnected };
    })();
    return closing;
  };
  const interrupt = (reason) => {
    fatal = reason; controller.abort(new Error(fatal)); arena?.events.emit('failure', fatal);
  };
  const stop = () => interrupt('operator_interrupt');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const watchdog = setTimeout(() => interrupt('run_deadline'), options.trials * 210000 + 25000);
  const rcon = { host: env.A37_RCON_HOST, port: Number(env.A37_RCON_PORT), password };
  const command = async (text, signal) => {
    signal?.throwIfAborted(); controller.signal.throwIfAborted();
    const allowed = text === 'seed' || text === 'tick query' ||
      text === 'gamemode survival ' + USERNAME || text === 'clear ' + USERNAME || text === 'effect clear ' + USERNAME ||
      /^effect give SparPartner minecraft:(instant_health|saturation) 1 10 true$/.test(text) ||
      /^spreadplayers -?\d+ -?\d+ 0 8 false SparPartner$/.test(text) ||
      /^tp SparPartner -?[\d.]+ -?[\d.]+ -?[\d.]+$/.test(text);
    if (!allowed) throw new Error('command_outside_bot_scope');
    const timeoutMs = text.startsWith('spreadplayers ') ? 15000 : 3000;
    const record = { at: new Date().toISOString(), command: text, timeout_ms: timeoutMs };
    report.commands.push(record);
    let reply;
    try { reply = await (services.sendCommand ?? rconCommand)({ ...rcon, timeoutMs }, text); record.reply = reply; }
    catch (error) { fatal = error.message; record.error = fatal; throw error; }
    signal?.throwIfAborted(); controller.signal.throwIfAborted();
    return reply;
  };
  const tick = async () => {
    const reply = await command('tick query');
    report.tick_health.push({ at: new Date().toISOString(), reply }); log('TICK ' + reply);
  };
  const settled = async (signal, spreadSpot = null) => {
    const deadline = performance.now() + 7000;
    let stable = 0, arrived = !spreadSpot;
    for (let attempt = 0; attempt < 70 && performance.now() < deadline; attempt++) {
      signal.throwIfAborted();
      const position = arena.observe().self?.position;
      arrived = !spreadSpot || position && Math.abs(position.x - spreadSpot.x) <= 8.5 && Math.abs(position.z - spreadSpot.z) <= 8.5;
      if (arrived && runtime.bot.entity?.onGround && runtime.bot.health > 0) stable++; else stable = 0;
      if (stable >= 4) return position;
      await wait(100, undefined, { signal });
    }
    if (!arrived) throw new Error('spreadplayers_position_unverified');
    throw new Error('surface_settle_timeout');
  };
  const surface = (p) => {
    const below = runtime.bot.blockAt(new Vec3(p.x, p.y - 1, p.z));
    return below?.boundingBox === 'block' && !/leaves|log|water|lava/.test(below.name);
  };
  async function setup(signal) {
    arena.release();
    if (fatal) throw new Error(fatal);
    if (runtime.bot.health <= 0) await settled(signal);
    for (const text of ['gamemode survival ' + USERNAME, 'clear ' + USERNAME, 'effect clear ' + USERNAME,
      'effect give ' + USERNAME + ' minecraft:instant_health 1 10 true', 'effect give ' + USERNAME + ' minecraft:saturation 1 10 true']) {
      await command(text, signal);
    }
    const spot = spots.find((p) => used.every((old) => distance(p, old) >= 168));
    if (!spot) throw new Error('no_unused_trial_spot');
    used.push(spot); report.setups.push({ trial: activeTrial, spot, before_spread_position: arena.observe().self?.position }); save();
    const reply = await command('spreadplayers ' + spot.x + ' ' + spot.z + ' 0 8 false ' + USERNAME, signal);
    if (!/^Spread 1 player\(s\) around /.test(reply) && !reply.includes('Successfully spread')) throw new Error('spreadplayers_failed');
    report.setups.at(-1).spread_position = await settled(signal, spot); save();
    await wait(550, undefined, { signal });
    let o = arena.observe();
    if (!hasLog(o) || !surface(o.self.position)) {
      const trees = runtime.bot.findBlocks({ matching: (b) => b.name.endsWith('_log'), maxDistance: 64, count: 100 });
      let destination;
      for (const tree of trees) {
        for (const [dx, dz] of [[5, 0], [-5, 0], [0, 5], [0, -5], [8, 0], [0, 8]]) {
          const x = tree.x + dx, z = tree.z + dz;
          if (!inRegion({ x, z }) || used.some((old) => old !== spot && distance({ x, z }, old) < 150)) continue;
          for (let y = tree.y + 2; y >= tree.y - 5; y--) {
            const p = { x: x + 0.5, y, z: z + 0.5 };
            const body = runtime.bot.blockAt(new Vec3(x, y, z)), head = runtime.bot.blockAt(new Vec3(x, y + 1, z));
            if (surface(p) && body?.boundingBox === 'empty' && head?.boundingBox === 'empty' && !/water|lava/.test(body.name)) {
              destination = p; break;
            }
          }
          if (destination) break;
        }
        if (destination) break;
      }
      if (!destination) throw new Error('near_setup:no_natural_tree_surface');
      await command('tp ' + USERNAME + ' ' + destination.x + ' ' + destination.y + ' ' + destination.z, signal);
      await settled(signal); await wait(550, undefined, { signal }); o = arena.observe();
    }
    const start = o.self.position;
    if (!hasLog(o)) throw new Error('near_setup:no_log_within_16');
    if (!inRegion(start) || used.some((old) => old !== spot && distance(start, old) < 150)) throw new Error('start_outside_region_or_too_close');
    if (!surface(start)) throw new Error('near_setup:not_natural_ground');
    if (countLogs(o.inventory) !== 0 || runtime.bot.game.gameMode !== 'survival') throw new Error('reset_inventory_or_gamemode');
    used.push(start);
    trialSetup = { start_position: start, natural_logs: o.facts.nearest_blocks, gamemode: runtime.bot.game.gameMode };
    report.setups.at(-1).start_position = start; save();
    log('START trial=' + activeTrial + ' position=' + JSON.stringify(start) + ' logs=0 mode=survival');
  }
  save();
  try {
    const skill = new SkillRegistry().load('resource.collect_wood', 1);
    arena = await createLiveArena({ skill, env, dataDir: path.join(root, 'sessions'), expectedSeed: report.seed,
      command: (_config, text) => command(text), runtimeFactory: async (config) => {
        runtime = await (services.makeRuntime ?? createRuntime)({ ...config, viewerPort: 3743 }); return runtime;
      },
    });
    const observe = arena.observe.bind(arena);
    arena.observe = () => {
      const o = observe();
      o.wood = { total_logs: countLogs(o.inventory), goal_reached: countLogs(o.inventory) >= options.count }; return o;
    };
    arena.events.on('failure', (reason) => {
      if (['bot_end', 'bot_error', 'bot_kicked'].includes(reason)) fatal = reason;
    });
    const originalBot = arena.bot;
    arena.bot = (signal) => {
      const adapter = originalBot(signal);
      return { ...adapter, requestAction(action) {
        if (!inRegion(runtime.bot.entity.position, 395)) throw new Error('region_boundary');
        activeActions.push({ ms: Date.now(), ...action }); adapter.requestAction(action);
      } };
    };
    arena.reset = (_steps, { signal }) => { pendingReset = setup(signal); return pendingReset; };
    arena.settleReset = () => pendingReset?.catch(() => {});
    await tick(); log('VIEWER http://127.0.0.1:3743/');
    for (let trial = 1; trial <= options.trials; trial++) {
      if (fatal) throw new Error(fatal);
      activeTrial = trial; activeSamples = []; activeActions = []; trialSetup = null;
      sampler = setInterval(() => {
        if (!trialSetup) return;
        try {
          const o = arena.observe();
          activeSamples.push({ ms: Date.now(), position: o.self.position, health: o.self.health, logs: countLogs(o.inventory),
            yaw: o.self.yaw, terrain: o.terrain, nearby_mobs: o.facts.nearby_mobs, nearest_blocks: o.facts.nearest_blocks,
            arbiter: runtime.state().arbiter, recent_events: o.self.recent_events });
        } catch { arena.events.emit('failure', 'observation_error'); }
      }, 1000);
      const row = await runTrial({ arena, skill, run, input: { count: options.count }, trial });
      clearInterval(sampler); sampler = null;
      const positions = [row.before?.self?.position, ...activeSamples.map((s) => s.position), row.after?.self?.position].filter(Boolean);
      const travelled = positions.slice(1).reduce((sum, p, i) => sum + distance(p, positions[i]), 0);
      report.trials.push({ ...row, synthetic: report.synthetic, ...trialSetup,
        logs_collected: row.before ? Math.max(0, countLogs(row.after?.inventory) - countLogs(row.before.inventory)) : 0,
        distance_travelled: travelled, distance_method: 'horizontal polyline through one-second position samples',
        samples: activeSamples, actions: activeActions });
      save();
      log((row.outcome === 'success' ? 'PASS' : 'FAIL') + ' trial=' + trial + ' reason=' + row.reason +
        ' logs=' + countLogs(row.after?.inventory) + ' seconds=' + (row.elapsed_ms / 1000).toFixed(2) + ' distance=' + travelled.toFixed(2));
      if (fatal) throw new Error(fatal);
      await tick();
    }
  } catch (error) {
    report.fatal_reason = fatal ?? error.message; log('FAIL run reason=' + report.fatal_reason);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    clearTimeout(watchdog);
    try { await close(); }
    catch (error) { report.cleanup = { disconnected: false, reason: error.message }; report.fatal_reason ??= 'cleanup_failed'; }
    if (report.cleanup?.disconnected === false) report.fatal_reason ??= 'cleanup_failed';
    report.summary = { trials: report.trials.length, successes: report.trials.filter((r) => r.outcome === 'success').length,
      logs_collected: report.trials.map((r) => r.logs_collected),
      median_seconds: median(report.trials.map((r) => r.elapsed_ms / 1000)),
      median_distance: median(report.trials.map((r) => r.distance_travelled)),
      failure_reasons: report.trials.filter((r) => r.outcome !== 'success').reduce((counts, r) => ({ ...counts, [r.reason]: (counts[r.reason] ?? 0) + 1 }), {}) };
    report.passed = report.summary.successes === options.trials && !report.fatal_reason;
    save();
    log('SUMMARY ' + (report.passed ? 'PASS' : 'FAIL') + ' milestone=near passed=' + report.summary.successes +
      '/' + options.trials + ' completed=' + report.summary.trials + ' results=' + output);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((report) => process.exit(report.passed ? 0 : 1))
    .catch((error) => { console.error('SUMMARY FAIL reason=' + error.message); process.exit(1); });
}
