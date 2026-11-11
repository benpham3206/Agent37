import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SkillRegistry } from '../skills/registry.js';
import { createLiveArena } from '../eval/arena.mjs';
import { runTrial } from '../eval/run.mjs';
import { createRuntime } from '../server.js';
import { rconCommand } from '../rcon.js';
import { run as enterNether } from '../skills/travel.enter_nether/v1/index.js';
import { run as lightPortal } from '../skills/portal.light/v1/index.js';
import { evalSeed, resultsDir } from './local.js';

export const FRAME = Object.freeze({ x: 5000, y: 100, z: 5000 });
const USERNAME = 'Ben_bot';
const overworld = (command) => 'execute in minecraft:overworld run ' + command;
const locationCheck = 'execute in minecraft:overworld if entity @a[name=Ben_bot,x=4994,y=-64,z=4993,dx=13,dy=384,dz=14,limit=1]';
const portalCheck = 'execute in minecraft:overworld if block 5001 101 5000 minecraft:nether_portal[axis=x]';
const arrivalCheck = 'execute in minecraft:the_nether if entity @a[name=Ben_bot,limit=1,distance=0..]';
const frameCells = [];
for (let x = 0; x < 4; x++) for (let y = 0; y < 5; y++) frameCells.push('if block ' + (FRAME.x + x) + ' ' + (FRAME.y + y) + ' ' + FRAME.z + ' minecraft:' + (x === 0 || x === 3 || y === 0 || y === 4 ? 'obsidian' : 'air'));
const unlitCheck = 'execute in minecraft:overworld ' + frameCells.join(' ');
const litSetup = overworld('fill 5001 101 5000 5002 103 5000 minecraft:nether_portal[axis=x]');
const flintSetup = 'item replace entity Ben_bot hotbar.0 with minecraft:flint_and_steel 1';
const setupCommands = [
  'gamemode survival Ben_bot',
  'effect give Ben_bot minecraft:slow_falling 30 0 true',
  overworld('tp Ben_bot 5001.5 140 4996.5'),
  locationCheck,
  overworld('fill 4994 101 4993 5007 108 5007 minecraft:air'),
  overworld('fill 4994 99 4993 5007 100 5007 minecraft:stone'),
  overworld('tp Ben_bot 5001.5 101 4996.5'),
  'effect clear Ben_bot minecraft:slow_falling',
  'clear Ben_bot',
  'effect give Ben_bot minecraft:instant_health 1 10 true',
  'effect give Ben_bot minecraft:saturation 1 10 true',
  overworld('fill 5000 100 5000 5003 104 5000 minecraft:obsidian'),
  overworld('fill 5001 101 5000 5002 103 5000 minecraft:air'),
];
const allowedCommands = new Set(['seed', 'tick query', portalCheck, unlitCheck, arrivalCheck, litSetup, flintSetup, ...setupCommands]);

async function lightAndEnter(bot, input, context, send, stages) {
  const started = performance.now();
  let before;
  try {
    context.signal.throwIfAborted();
    before = bot.observe();
    const light = await lightPortal(bot, input, context);
    const stage = { skill: 'portal.light', ...light };
    stages.push(stage);
    if (light.outcome !== 'success') return { ...light, before, elapsed_ms: Math.max(0, performance.now() - started) };
    context.signal.throwIfAborted();
    stage.rcon_portal = await send(portalCheck);
    context.signal.throwIfAborted();
    if (!stage.rcon_portal.includes('Test passed')) return { outcome: 'failure', reason: 'portal_lighting_not_confirmed', elapsed_ms: Math.max(0, performance.now() - started), before, after: bot.observe() };
    const enter = await enterNether(bot, {}, context);
    stages.push({ skill: 'travel.enter_nether', ...enter });
    return { ...enter, before, elapsed_ms: Math.max(0, performance.now() - started) };
  } finally {
    bot.releaseControls();
  }
}

export function parseOptions(args, env) {
  let values;
  try { ({ values } = parseArgs({ args, strict: true, options: { milestone: { type: 'string' }, trials: { type: 'string' } } })); }
  catch { throw new Error('invalid_arguments'); }
  const trials = Number(values.trials);
  if (!['enter', 'light', 'build'].includes(values.milestone) || !Number.isSafeInteger(trials) || trials < 1 || trials > 100) throw new Error('invalid_arguments');
  if (values.milestone === 'build') throw new Error('milestone_not_implemented');
  if (!['127.0.0.1', 'localhost'].includes(env.A37_MC_HOST)) throw new Error('minecraft_host_not_loopback');
  if (!['127.0.0.1', 'localhost'].includes(env.A37_RCON_HOST)) throw new Error('rcon_host_not_loopback');
  if (env.A37_MC_PORT !== '25565' || env.A37_RCON_PORT !== '25575' || env.A37_MC_VERSION !== '1.21.1') throw new Error('unexpected_server_settings');
  if (env.A37_EVAL_USERNAME !== USERNAME || env.A37_EVAL_APPROVED_RESET !== '1' || env.A37_EVAL_WEB_PORT !== '8741') throw new Error('unexpected_lane_settings');
  if (env.AGENT37_JEV === '1' || env.A37_JEV_ENABLED === '1' || env.A37_JEV === '1') throw new Error('jev_must_be_disabled');
  return { milestone: values.milestone, trials };
}

async function waitFor(check, signal, reason, limit = 10000) {
  const deadline = performance.now() + limit;
  while (!check()) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error(reason);
    await delay(100, undefined, { signal });
  }
}

export async function closeRuntime(runtime, arena) {
  if (!runtime && !arena) return;
  const bot = runtime?.bot;
  let ended = !bot || bot._client?.ended === true;
  const onEnd = () => { ended = true; };
  bot?.once?.('end', onEnd);
  try {
    if (arena) await arena.close();
    else if (runtime) {
      runtime.recorder?.stop();
      bot?.viewer?.close?.();
      for (const socket of runtime.ws?.clients ?? []) socket.terminate();
      runtime.close();
    }
  } finally {
    if (runtime) {
      try { bot?.viewer?.close?.(); } catch {}
      for (const socket of runtime.ws?.clients ?? []) {
        try { socket.terminate(); } catch {}
      }
      try { runtime.server?.close(); } catch {}
      try { runtime.ws?.close?.(); } catch {}
    }
    try { bot?.quit?.(); } catch {}
    const deadline = performance.now() + 3000;
    while (!ended && performance.now() < deadline) await delay(25);
    if (!ended) bot?._client?.socket?.destroy();
    bot?.removeListener?.('end', onEnd);
  }
}

function failureReason(error) {
  const message = error?.message ?? '';
  if (message.startsWith('approved world must use seed')) return 'seed_mismatch';
  if (message === 'bot spawn timed out') return 'bot_spawn_timeout';
  if (/^listen EADDRINUSE/.test(message)) return 'port_in_use';
  return /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)?$/.test(message) ? message : 'execution_error';
}

function summarize(rows, requested) {
  const arrivals = rows.filter((row) => row.outcome === 'success' && row.nether_arrival);
  const times = arrivals.map((row) => row.elapsed_ms).sort((a, b) => a - b);
  return {
    requested_trials: requested, trials: rows.length, nether_arrivals: arrivals.length,
    median_ms: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
    range_ms: times.length ? [times[0], times.at(-1)] : null,
    failure_reasons: rows.filter((row) => row.outcome !== 'success').reduce((counts, row) => { counts[row.reason] = (counts[row.reason] ?? 0) + 1; return counts; }, {}),
  };
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  const { milestone, trials } = parseOptions(args, env);
  const sendCommand = dependencies.command ?? rconCommand;
  const makeArena = dependencies.makeArena ?? createLiveArena;
  const makeRuntime = dependencies.makeRuntime ?? createRuntime;
  const trialRunner = dependencies.trialRunner ?? runTrial;
  const mkdir = dependencies.mkdir ?? ((directory) => fs.mkdirSync(directory, { recursive: true }));
  const write = dependencies.write ?? ((filename, report) => fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\n'));
  const log = dependencies.log ?? console.log;
  const password = env.A37_RCON_PASSWORD || dependencies.readPassword?.();
  if (!password) throw new Error('rcon_password_unavailable');
  const config = { host: env.A37_RCON_HOST, port: Number(env.A37_RCON_PORT), password, timeoutMs: 5000 };
  const SEED = evalSeed(), RESULTS_DIR = resultsDir('portal');
  const output = path.join(RESULTS_DIR, milestone + '-' + new Date().toISOString().replaceAll(':', '-') + '-' + process.pid + '.json');
  const report = { milestone, seed: SEED, frame: FRAME, username: USERNAME, synthetic: false, started_at: new Date().toISOString(), commands: [], tick_health: [], trials: [] };
  mkdir(RESULTS_DIR);
  const persist = () => { report.summary = summarize(report.trials, trials); write(output, report); };
  let pending = null, runtime, arena, phase = 'startup', currentTrial = 1, stopReason = null;
  const stop = (reason) => {
    stopReason = reason;
    arena?.events.emit('failure', reason);
    try { runtime?.bot?.quit?.(); } catch {}
  };
  const onSignal = () => stop('interrupted');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const watchdog = setTimeout(() => stop('run_deadline'), dependencies.runBudgetMs ?? 30000 + trials * (milestone === 'light' ? 100000 : 80000));
  watchdog.unref();
  const command = async (_config, text) => {
    if (stopReason) throw new Error(stopReason);
    if (!allowedCommands.has(text)) throw new Error('unapproved_rcon_command');
    const entry = { command: text, started_at: new Date().toISOString() };
    report.commands.push(entry);
    const operation = sendCommand(config, text);
    pending = operation;
    try { entry.reply = await operation; if (stopReason) throw new Error(stopReason); return entry.reply; }
    catch (error) { entry.error = failureReason(error); throw error; }
    finally { if (pending === operation) pending = null; }
  };
  const send = (text) => command(config, text);
  const tick = async (trial, when) => report.tick_health.push({ trial, when, reply: await send('tick query') });
  const printRow = (row) => log((row.outcome === 'success' ? 'PASS' : 'FAIL') + ' portal ' + milestone + ' trial ' + row.trial + '/' + trials + ' reason=' + row.reason + ' nether_arrival=' + row.nether_arrival + ' elapsed_ms=' + row.elapsed_ms);
  const fail = (error) => {
    const row = { trial: currentTrial, outcome: 'failure', reason: failureReason(error), phase, elapsed_ms: 0, nether_arrival: false, before: null, after: null, synthetic: false };
    report.trials.push(row);
    printRow(row);
  };
  persist();
  try {
    await tick(0, 'startup');
    const registry = new SkillRegistry();
    const entry = registry.load('travel.enter_nether', 1);
    const lighting = milestone === 'light' ? registry.load('portal.light', 1) : null;
    const skill = lighting ? { ...entry, reset_steps: lighting.reset_steps, success_check: { ...entry.success_check, time_limit_ms: entry.success_check.time_limit_ms + lighting.success_check.time_limit_ms } } : entry;
    const arenaEnv = { ...env, A37_RCON_PASSWORD: password };
    arena = await makeArena({ skill, dataDir: path.join(RESULTS_DIR, 'sessions'), env: arenaEnv, expectedSeed: SEED, command, runtimeFactory: async (config) => {
      if (stopReason) throw new Error(stopReason);
      runtime = await makeRuntime({ ...config, viewerPort: 3741, jev: null });
      if (!runtime.bot) throw new Error('bot_creation_failed');
      if (stopReason) throw new Error(stopReason);
      return runtime;
    } });
    arena.settleReset = async () => { await pending?.catch(() => {}); };
    arena.reset = async (_steps, { signal }) => {
      signal.throwIfAborted();
      if (arena.arbiter.sources.has('human')) {
        arena.events.emit('human_takeover');
        throw new Error('human_takeover');
      }
      arena.release();
      for (const text of [...setupCommands, milestone === 'enter' ? litSetup : flintSetup]) {
        signal.throwIfAborted();
        const reply = await send(text);
        signal.throwIfAborted();
        if (text === locationCheck && !reply.includes('Test passed')) throw new Error('bot_not_in_region');
      }
      await waitFor(() => {
        const o = arena.observe();
        const ready = milestone === 'enter' ? o.facts?.nearest_blocks?.nether_portal : !o.facts?.nearest_blocks?.nether_portal && o.facts?.nearest_blocks?.obsidian && o.self?.held_item === 'flint_and_steel' && o.self?.hotbar_slot === 0;
        return o.facts?.dimension === 'overworld' && o.self?.health > 4 && Math.abs(o.self.position?.x - 5001.5) < 0.2 && Math.abs(o.self.position?.z - 4996.5) < 0.2 && Math.abs(o.self.position?.y - 101) < 0.2 && ready;
      }, signal, 'region_setup_not_observed');
      signal.throwIfAborted();
      if (!(await send(milestone === 'enter' ? portalCheck : unlitCheck)).includes('Test passed')) throw new Error(milestone === 'enter' ? 'portal_setup_not_verified' : 'unlit_frame_not_verified');
      signal.throwIfAborted();
    };
    for (currentTrial = 1; currentTrial <= trials; currentTrial++) {
      phase = 'tick_before';
      await tick(currentTrial, 'before');
      phase = 'trial';
      const samples = [];
      const started = performance.now();
      let sampleError = null;
      const sample = setInterval(() => {
        try {
          const o = arena.observe();
          samples.push({ elapsed_ms: Math.round(performance.now() - started), position: o.self?.position, health: o.self?.health, dimension: o.facts?.dimension, nearby_mobs: o.facts?.nearby_mobs, portal: o.facts?.nearest_blocks?.nether_portal, held_item: o.self?.held_item, hotbar_slot: o.self?.hotbar_slot, inventory: o.inventory, controls: arena.arbiter.tick().action });
        } catch { sampleError = 'observation_error'; }
      }, 500);
      const stages = [];
      const run = milestone === 'enter' ? enterNether : (bot, input, context) => lightAndEnter(bot, input, context, send, stages);
      let row;
      try { row = await trialRunner({ arena, skill, run, input: milestone === 'enter' ? {} : { frame: FRAME }, trial: currentTrial }); }
      finally { clearInterval(sample); }
      row.phase = phase;
      row.samples = samples;
      row.stages = stages;
      row.nether_arrival = false;
      if (sampleError) { row.outcome = 'failure'; row.reason = sampleError; }
      try {
        row.rcon_nether = await send(arrivalCheck);
        row.confirmation_observation = arena.observe();
        row.nether_arrival = row.after?.facts?.dimension === 'the_nether' && row.confirmation_observation?.facts?.dimension === 'the_nether' && row.rcon_nether.includes('Test passed');
        if (row.confirmation_observation?.self?.health != null && row.confirmation_observation.self.health <= 0) { row.outcome = 'failure'; row.reason = 'bot_death'; }
        if (row.outcome === 'success' && !row.nether_arrival) { row.outcome = 'failure'; row.reason = 'nether_arrival_not_confirmed'; }
      } catch (error) { row.outcome = 'failure'; row.reason = failureReason(error); }
      report.trials.push(row);
      printRow(row);
      persist();
      phase = 'tick_after';
      try { await tick(currentTrial, 'after'); }
      catch (error) { report.fatal = { phase, reason: failureReason(error) }; break; }
      if (['bot_end', 'bot_error', 'bot_kicked', 'bot_death', 'bot_not_in_region', 'region_setup_not_observed', 'portal_setup_not_verified', 'unlit_frame_not_verified', 'portal_not_lit', 'portal_lighting_not_confirmed', 'rcon_timeout', 'rcon_unreachable', 'rcon_auth_failed', 'reset_timeout', 'run_deadline', 'interrupted', 'human_takeover', 'emergency_stop'].includes(row.reason)) break;
    }
  } catch (error) {
    fail(error);
  } finally {
    await pending?.catch(() => {});
    try { await closeRuntime(runtime, arena); }
    catch (error) { report.fatal = { phase: 'cleanup', reason: failureReason(error) }; }
    clearTimeout(watchdog);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    report.finished_at = new Date().toISOString();
    persist();
  }
  const passed = !report.fatal && report.trials.length === trials && report.trials.every((row) => row.outcome === 'success' && row.nether_arrival);
  log('SUMMARY ' + (passed ? 'PASS' : 'FAIL') + ' portal ' + milestone + ' trials=' + report.summary.trials + '/' + trials + ' nether_arrivals=' + report.summary.nether_arrivals + ' median_ms=' + (report.summary.median_ms ?? 'null') + ' fatal=' + (report.fatal?.reason ?? 'none') + ' results=' + output);
  return { passed, report, output };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(({ passed }) => { process.exitCode = passed ? 0 : 1; }).catch((error) => {
    console.error('FAIL portal preflight reason=' + failureReason(error));
    console.error('SUMMARY FAIL portal trials=0 nether_arrivals=0');
    process.exitCode = 1;
  });
}

