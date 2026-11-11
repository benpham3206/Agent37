// combat.kill_hostile v1: wraps the bridge's existing combat loop (the same steps
// server.js runs for /combat/engage) behind the runner's skill interface.
// Every control goes through bot.requestAction, so the arbiter stays in charge;
// server.js still gates attacks to the configured target and in-reach checks.
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TacticalPolicy } from '../../../policy.js';
import { aimDelta, angularError } from '../../../geometry.js';

export const HISTORY = 4; // server.js keeps the last 4 observations
export const INFERENCE_MS = 100; // server.js infers at most every 100 ms
export const TICK_MS = 50; // 20 Hz like the bridge

export async function loadBridgePolicy(targetType = 'zombie', env = process.env) {
  const dir = env.A37_COMBAT_CANDIDATE_DIR;
  if (!dir) return { error: 'A37_COMBAT_CANDIDATE_DIR not set' };
  const policy = new TacticalPolicy({
    modelPath: path.join(dir, 'model.onnx'),
    metadataPath: path.join(dir, 'metadata.json'),
    targetType,
  });
  // load() returns false if onnxruntime-node or the model files are missing.
  return (await policy.load()) ? { policy } : { error: 'model or onnxruntime-node unavailable' };
}

// Same aim step server.js adds on top of the policy's movement output.
export function combatAction(tactical, observation) {
  const action = { ...tactical };
  delete action.disengage;
  const o = observation;
  if (o?.target?.aim_point && o?.self?.position) {
    const eye = { x: o.self.position.x, y: o.self.position.y + 1.62, z: o.self.position.z };
    const d = aimDelta(angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, o.target.aim_point));
    action.yaw_delta = d.yaw; action.pitch_delta = d.pitch;
  }
  return action;
}

export function createRun({ loadPolicy = loadBridgePolicy, tickMs = TICK_MS, inferenceMs = INFERENCE_MS, now = () => performance.now() } = {}) {
  return async function run(bot, input, { signal }) {
    signal.throwIfAborted();
    const started = now();
    const before = bot.observe();
    const startKills = before?.kills?.hostile_total ?? 0;
    const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before, after: bot.observe() });
    const loaded = await loadPolicy(input?.target_type ?? 'zombie');
    if (!loaded?.policy) return finish('failure', `requirement_unmet:${loaded?.error ?? 'no policy'}`);
    const { policy } = loaded;
    const history = [];
    let tactical = {}, lastInference = -Infinity;
    try {
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe();
        if ((o?.kills?.hostile_total ?? 0) > startKills) return finish('success', 'target_death');
        if (o?.self?.health != null && o.self.health <= 0) return finish('failure', 'bot_death');
        history.push(o); if (history.length > HISTORY) history.shift();
        if (now() - lastInference >= inferenceMs) {
          lastInference = now();
          try { tactical = await policy.infer(history); }
          catch { return finish('failure', 'inference_failed'); }
          signal.throwIfAborted();
        }
        bot.requestAction(combatAction(tactical, o));
        await delay(tickMs, undefined, { signal });
      }
    } finally {
      bot.releaseControls();
    }
  };
}

export const run = createRun();
