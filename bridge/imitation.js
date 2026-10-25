import fs from 'node:fs';
import path from 'node:path';
import { emptyAction } from './arbiter.js';
import { aimDelta, angularError, clamp, wrapRadians } from './geometry.js';

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const itemName = (item) => item?.name ?? null;

export function inferDemonstratorAction(entity, previous = null, swing = false) {
  const velocity=entity?.velocity??{}, yaw=number(entity?.yaw), vx=number(velocity.x), vy=number(velocity.y), vz=number(velocity.z);
  const forwardSpeed=vx*(-Math.sin(yaw))+vz*(-Math.cos(yaw));
  const rightSpeed=vx*Math.cos(yaw)+vz*(-Math.sin(yaw));
  const horizontalSpeed=Math.hypot(vx,vz), handState=number(entity?.metadata?.[8]);
  return {...emptyAction(),forward:forwardSpeed>0.025,back:forwardSpeed<-.025,right:rightSpeed>0.025,left:rightSpeed<-.025,jump:vy>0.12,sprint:horizontalSpeed>0.16,attack:Boolean(swing),use:Boolean(handState&1),yaw_delta:previous?clamp(wrapRadians(yaw-number(previous.yaw)),-1,1):0,pitch_delta:previous?clamp(number(entity?.pitch)-number(previous.pitch),-1,1):0};
}

export function gateMimicToTarget(action, observation = null) {
  const out={...action}, distance=Number(observation?.target?.distance);
  if(!Number.isFinite(distance))return {...out,forward:false,back:false,left:false,right:false,sprint:false};
  const closing=distance>2.75, retreating=distance<1.65;
  out.forward=closing;out.back=retreating;
  if(closing||retreating){out.left=false;out.right=false;}
  out.sprint=closing&&Boolean(action.sprint);
  return out;
}

const DEFAULT_COMBAT_OPTIONS = Object.freeze({
  minRange: 1.65,
  maxRange: 2.75,
  attackRange: 3.1,
  criticalVelocity: -0.05,
  axeHotbar: 0,
});

const targetBearing = (self, target) => Math.atan2(
  Number(target.x) - Number(self.x),
  Number(target.z) - Number(self.z),
);

export function buildTargetRelativeMimicAction(action, observation = null, state = {}, options = {}) {
  const out = { ...emptyAction(), ...action };
  const self = observation?.self;
  const target = observation?.target;
  const combat = { ...DEFAULT_COMBAT_OPTIONS, ...options };
  const hotbar = Number(combat.axeHotbar);
  if (Number.isInteger(hotbar) && hotbar >= 0 && hotbar <= 8) out.hotbar = hotbar;
  if (!self?.position || !target?.position) return out;

  const distance = Number.isFinite(Number(target.distance))
    ? Number(target.distance)
    : Math.hypot(
      Number(target.position.x) - Number(self.position.x),
      Number(target.position.y) - Number(self.position.y),
      Number(target.position.z) - Number(self.position.z),
    );
  const bearing = targetBearing(self.position, target.position);
  if (Number.isFinite(state.lastBearing)) state.orbitTravel = Number(state.orbitTravel ?? 0) + Math.abs(wrapRadians(bearing - state.lastBearing));
  state.lastBearing = bearing;
  state.orbitDirection = state.orbitDirection === -1 ? -1 : 1;
  if (Number(state.orbitTravel) >= 2 * Math.PI) {
    state.orbitDirection *= -1;
    state.orbitTravel = 0;
  }

  const tooFar = distance > combat.maxRange;
  const tooClose = distance < combat.minRange;
  out.forward = tooFar;
  out.back = tooClose;
  out.left = !tooFar && !tooClose && state.orbitDirection < 0;
  out.right = !tooFar && !tooClose && state.orbitDirection > 0;
  out.sprint = tooFar && Boolean(action.sprint);

  const aimPoint = target.aim_point ?? target.position;
  const eye = { x: Number(self.position.x), y: Number(self.position.y) + 1.62, z: Number(self.position.z) };
  const aim = aimDelta(angularError(eye, Number(self.yaw ?? 0), Number(self.pitch ?? 0), aimPoint));
  out.yaw_delta = aim.yaw;
  out.pitch_delta = aim.pitch;

  const velocityY = Number(self.velocity?.y ?? 0);
  const descending = velocityY <= combat.criticalVelocity;
  if (action.attack) state.criticalPending = true;
  const canAttack = state.criticalPending
    && descending
    && distance <= combat.attackRange
    && target.line_of_sight !== false;
  out.attack = canAttack;
  out.jump = Boolean(action.jump || (state.criticalPending && !descending && velocityY <= 0.05));
  out.use = !out.attack;
  if (out.attack) {
    state.criticalPending = false;
    out.jump = false;
  }
  return out;
}

export class ImitationSession {
  constructor({ dataDir, sessionId, demonstrator = 'unknown', maxObserveMs = 120000 } = {}) {
    this.dir=path.join(dataDir,sessionId,'demonstrations'); this.demonstrator=demonstrator; this.maxObserveMs=maxObserveMs;
    this.state='idle'; this.id=null; this.frames=[]; this.startedAt=null; this.previous=null; this.lastSwingAt=0; this.playStartedAt=null; this.playIndex=0; this.path=null;
    this.combatState={};
    fs.mkdirSync(this.dir,{recursive:true});
    this.loadLatest();
  }
  loadLatest() {
    const files=fs.readdirSync(this.dir).filter((name)=>name.endsWith('.json')).map((name)=>path.join(this.dir,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
    for(const file of files)try{const payload=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(payload.frames)||!payload.frames.length)continue;this.state='ready';this.id=payload.demonstration_id??path.basename(file,'.json');this.frames=payload.frames;this.startedAt=number(payload.started_at_ms,null);this.previous=this.frames.at(-1)?.state??null;this.path=file;return true;}catch{}
    return false;
  }
  startObserve(now=Date.now()) { this.state='observing'; this.id=`demo-${now}-${Math.random().toString(36).slice(2,8)}`;this.frames=[];this.startedAt=now;this.previous=null;this.lastSwingAt=now;this.playStartedAt=null;this.playIndex=0;this.path=path.join(this.dir,`${this.id}.json`);return this.status(now); }
  observe(entity,recentEvents=[],now=Date.now()) {
    if(this.state!=='observing'||!entity)return null;
    if(now-this.startedAt>=this.maxObserveMs){this.stopObserve(now);return null;}
    const swing=[...recentEvents].reverse().find((event)=>event.type==='incoming_swing'&&event.source_id===entity.id&&event.timestamp_ms>this.lastSwingAt);
    if(swing)this.lastSwingAt=swing.timestamp_ms;
    const action=inferDemonstratorAction(entity,this.previous,Boolean(swing));
    const frame={t_ms:now-this.startedAt,state:{position:{x:number(entity.position?.x),y:number(entity.position?.y),z:number(entity.position?.z)},velocity:{x:number(entity.velocity?.x),y:number(entity.velocity?.y),z:number(entity.velocity?.z)},yaw:number(entity.yaw),pitch:number(entity.pitch),on_ground:entity.onGround??null,held_item:itemName(entity.heldItem??entity.equipment?.[0]),offhand_item:itemName(entity.equipment?.[1])},action};
    this.frames.push(frame);this.previous=frame.state;return frame;
  }
  stopObserve(now=Date.now()) { if(this.state!=='observing')return this.status(now);this.state='ready';const payload={schema_version:1,demonstration_id:this.id,demonstrator:this.demonstrator,rate_hz:20,started_at_ms:this.startedAt,duration_ms:Math.max(0,now-this.startedAt),frames:this.frames};fs.writeFileSync(this.path,JSON.stringify(payload,null,2)+'\n');return this.status(now); }
  startMimic(now=Date.now()) { if(!this.frames.length)return false;if(this.state==='observing')this.stopObserve(now);this.state='mimicking';this.playStartedAt=now;this.playIndex=0;this.combatState={};return true; }
  mimicAction(now=Date.now(), observation=null, options={}) {
    if(this.state!=='mimicking')return null;
    const elapsed=now-this.playStartedAt;
    while(this.playIndex+1<this.frames.length&&this.frames[this.playIndex+1].t_ms<=elapsed)this.playIndex++;
    if(elapsed>(this.frames.at(-1)?.t_ms??0)+75){this.state='ready';return null;}
    const action={...this.frames[this.playIndex].action}, previous=this.frames[this.playIndex-1]?.action;
    action.jump=Boolean(action.jump&&!previous?.jump);
    return observation ? buildTargetRelativeMimicAction(action, observation, this.combatState, options) : action;
  }
  stop(now=Date.now()) { if(this.state==='observing')this.stopObserve(now);if(this.state==='mimicking')this.state='ready';return this.status(now); }
  status(now=Date.now()) { return {state:this.state,demonstration_id:this.id,demonstrator:this.demonstrator,frames:this.frames.length,duration_ms:this.startedAt?Math.max(0,(this.state==='observing'?now-this.startedAt:(this.frames.at(-1)?.t_ms??0))):0,path:this.path}; }
}
