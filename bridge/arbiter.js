export const PRIORITY = Object.freeze({ emergency: 6, survival: 5, human: 4, mimic: 4, skill: 3, navigation: 2, idle: 1 });
const BOOLS = ['forward','back','left','right','jump','sprint','sneak','attack','use','emergency_stop','manual_abort'];
export function emptyAction() { return { forward:false, back:false, left:false, right:false, jump:false, sprint:false, sneak:false, attack:false, use:false, hotbar:0, mouse_dx:0, mouse_dy:0, yaw_delta:0, pitch_delta:0, emergency_stop:false, manual_abort:false }; }
export function sanitizeAction(input = {}) {
  const a = emptyAction(); for (const k of BOOLS) a[k] = Boolean(input[k]);
  a.hotbar = Number.isInteger(input.hotbar) ? Math.max(0, Math.min(8, input.hotbar)) : 0;
  for (const k of ['mouse_dx','mouse_dy','yaw_delta','pitch_delta']) a[k] = Number.isFinite(input[k]) ? Math.max(-1, Math.min(1, input[k])) : 0;
  return a;
}
export function gateSkillTerrain(action, terrain = null) {
  if (!terrain) return action;
  const grid=terrain.support_grid, hazards=terrain.hazards??{}; const blocked=(rz,rx=1)=>{const row=grid?.[rz+1], c=row?.[rx]; return !c || c.available===false || c.drop_depth==null || c.drop_depth>=4;};
  const out={...action};
  if (out.forward && blocked(1)) out.forward=false;
  if (out.back && blocked(-1)) out.back=false;
  if (out.left && blocked(0,0)) out.left=false;
  if (out.right && blocked(0,2)) out.right=false;
  if (hazards.deep_drop||hazards.void||hazards.lava||hazards.fire) { out.sprint=false; out.jump=false; }
  return out;
}
export class ActionArbiter {
  constructor({ retreatHealth = 4, maxDurationMs = 120000 } = {}) { this.retreatHealth = retreatHealth; this.maxDurationMs = maxDurationMs; this.sources = new Map(); this.started = null; this.emergency = false; this.released = true; }
  set(source, action, reason = 'requested') { if(this.released||this.started==null)this.started=Date.now(); this.sources.set(source, { action: sanitizeAction(action), reason, at: Date.now() }); this.released = false; }
  release(reason = 'release') { this.sources.clear(); this.started=null; this.released = true; return { action: emptyAction(), source: 'idle', reason }; }
  emergencyStop(reason = 'emergency_stop') { this.emergency = true; return this.release(reason); }
  clearEmergency() { this.emergency = false; }
  tick({ health = null, terrain = null } = {}) {
    if (this.emergency) return { action: emptyAction(), source: 'emergency', reason: 'emergency_stop' };
    if (this.started != null && Date.now() - this.started > this.maxDurationMs) return this.release('timeout');
    if (health != null && health <= this.retreatHealth) { this.sources.delete('human'); this.sources.delete('skill'); return { action: sanitizeAction({ back: true, sprint: true }), source: 'survival', reason: 'retreat_health' }; }
    let winner = { source: 'idle', reason: 'idle', action: emptyAction() }, best = 0;
    for (const [source, value] of this.sources) { const p = PRIORITY[source] ?? 1; if (p > best) { best = p; winner = { source, reason: value.reason, action: source==='skill'||source==='mimic' ? gateSkillTerrain(value.action,terrain) : value.action }; } }
    return winner;
  }
}
