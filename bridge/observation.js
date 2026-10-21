import { buildAabb, chooseAimPoint, angularError, inReach } from './geometry.js';
import { Vec3 } from 'vec3';
const vec = (v) => v ? { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Number(v.z) || 0 } : null;
const hazardNames = new Set(['lava','fire','cactus','sweet_berry_bush']);
const blockName = (b) => b?.name ?? null;
function readBlock(bot, p) { try { return bot?.blockAt?.(new Vec3(p.x,p.y,p.z)) ?? null; } catch { return null; } }
export function buildTerrainObservation(bot, { environmentLabel = null, target = null } = {}) {
  const e=bot?.entity, p=e?.position, yaw=e?.yaw;
  if (!p || yaw == null) return { dimension:bot?.game?.dimension ?? null, biome:null, environment_label:environmentLabel, support_grid:null, clearance:null, hazards:null, cover_samples:null };
  const world=(rx,rz,y=p.y)=>({x:Math.floor(p.x + rx*Math.cos(yaw) - rz*Math.sin(yaw)),y:Math.floor(y),z:Math.floor(p.z - rx*Math.sin(yaw) - rz*Math.cos(yaw))});
  const support_grid=[]; let unavailable=false;
  for(let rz=-1;rz<=1;rz++){const row=[];for(let rx=-1;rx<=1;rx++){const b=readBlock(bot,world(rx,rz,p.y-1));if(!b) unavailable=true;let drop_depth=null;if(b){drop_depth=0;for(let d=1;d<=8;d++){if(readBlock(bot,world(rx,rz,p.y-1-d)))break;drop_depth=d;}}row.push({support:blockName(b),solid:Boolean(b?.boundingBox==='block'),drop_depth,available:Boolean(b)});}support_grid.push(row);}
  const dirs={forward:[0,1],back:[0,-1],left:[-1,0],right:[1,0]}, clearance={};
  for(const [name,[rx,rz]] of Object.entries(dirs)){const body=readBlock(bot,world(rx,rz,p.y)),head=readBlock(bot,world(rx,rz,p.y+1));if(!body||!head)unavailable=true;clearance[name]={body:blockName(body),head:blockName(head),body_clear:Boolean(body?.boundingBox==='empty'),head_clear:Boolean(head?.boundingBox==='empty'),available:Boolean(body&&head)};}
  const hazards={lava:false,fire:false,cactus:false,sweet_berry:false,void:false,deep_drop:false};
  for(const row of support_grid)for(const c of row){if(!c.available){hazards.void=true;continue;}if(c.drop_depth==null||c.drop_depth>=4)hazards.deep_drop=true;for(const h of hazardNames)if(c.support?.includes(h))hazards[h==='sweet_berry_bush'?'sweet_berry':h]=true;}
  let cover_samples=[]; if(target?.position&&bot.world?.raycast){const o=new Vec3(p.x,p.y+1.6,p.z), dx=target.position.x-o.x,dy=target.position.y-o.y,dz=target.position.z-o.z,len=Math.hypot(dx,dy,dz);for(const fraction of [0.33,0.66,1]){try{const hit=bot.world.raycast(o,new Vec3(dx/len,dy/len,dz/len),len*fraction);cover_samples.push({fraction,blocked:Boolean(hit),block:hit?.name??null,available:true});}catch{cover_samples.push({fraction,blocked:null,block:null,available:false});}}} else cover_samples=null;
  const center=support_grid[1]?.[1]??null, ahead=support_grid[2]?.[1]??null;
  const cell=(rz,rx)=>support_grid[rz+1]?.[rx+1]??null;
  return {dimension:bot?.game?.dimension??null,biome:bot?.biome??null,environment_label:environmentLabel,support_grid,clearance,hazards,cover_samples,support_center:center?.solid==null?null:Number(center.solid),support_forward:cell(1,0)?.solid??null,support_back:cell(-1,0)?.solid??null,support_left:cell(0,-1)?.solid??null,support_right:cell(0,1)?.solid??null,drop_forward:cell(1,0)?.drop_depth??null,drop_back:cell(-1,0)?.drop_depth??null,drop_left:cell(0,-1)?.drop_depth??null,drop_right:cell(0,1)?.drop_depth??null,clearance_forward:clearance.forward?.body_clear&&clearance.forward?.head_clear?1:0,clearance_back:clearance.back?.body_clear&&clearance.back?.head_clear?1:0,clearance_left:clearance.left?.body_clear&&clearance.left?.head_clear?1:0,clearance_right:clearance.right?.body_clear&&clearance.right?.head_clear?1:0,hazard_near:Number(Object.values(hazards).some(Boolean)),support:center?.solid==null?null:Number(center.solid),drop:center?.drop_depth??null,clearance_score:Object.values(clearance).filter(x=>x.available).length/4,hazard:Number(Object.values(hazards).some(Boolean)),solid_ahead:ahead?.solid??null,liquid:Boolean(hazards.lava),slope:null};
}
export function buildObservation(bot, target = null, { hostiles = [], projectiles = [], lineOfSight = () => true, tick = 0, selector = {}, recentEvents = [] } = {}) {
  const selfPos = vec(bot?.entity?.position), selfVel = vec(bot?.entity?.velocity) ?? { x: 0, y: 0, z: 0 };
  let targetState = null;
  if (target?.position) {
    const eye = selfPos ? { x:selfPos.x, y:selfPos.y+1.62, z:selfPos.z } : { x:0,y:1.62,z:0 };
    const aabb = buildAabb(target), aim = chooseAimPoint(aabb, eye, lineOfSight), worldRel = selfPos ? { x: target.position.x-selfPos.x, y: target.position.y-selfPos.y, z: target.position.z-selfPos.z } : null, yaw=bot.entity?.yaw ?? 0, rel = worldRel ? { x: worldRel.x*Math.cos(yaw)-worldRel.z*Math.sin(yaw), y: worldRel.y, z: -worldRel.x*Math.sin(yaw)-worldRel.z*Math.cos(yaw) } : null;
    const distance = rel ? Math.hypot(rel.x, rel.y, rel.z) : null;
    const err = aim && selfPos ? angularError(eye, bot.entity?.yaw ?? 0, bot.entity?.pitch ?? 0, aim) : null;
    const bearing = err?.yaw ?? null;
    targetState = { id: target.id ?? target.entityId ?? null, mob_type: target.name ?? target.mobType ?? null, position: vec(target.position), velocity: vec(target.velocity), width: Number(target.width ?? 0.6), height: Number(target.height ?? 1.8), aabb, relative_position: rel, distance, bearing, elevation: rel ? Math.atan2(rel.y, Math.hypot(rel.x, rel.z)) : null, angular_error: err ? { yaw: err.yaw, pitch: err.pitch } : null, line_of_sight: Boolean(aim), in_reach: Boolean(aim && inReach(eye, aim)), aim_point: aim, health: Number.isFinite(target.health) ? target.health : null, events: recentEvents.filter((event) => event.source_id === target.id || event.entity_id === target.id) };
  }
  const e = bot?.entity;
  const terrain=buildTerrainObservation(bot,{target,environmentLabel:selector.environment_label??null});
  const offhand = bot?.inventory?.slots?.[45]?.name ?? null;
  const now=Date.now(), incomingSwing=recentEvents.findLast?.((event)=>event.type==='incoming_swing')??[...recentEvents].reverse().find((event)=>event.type==='incoming_swing'), selfDamage=recentEvents.findLast?.((event)=>event.type==='self_damage')??[...recentEvents].reverse().find((event)=>event.type==='self_damage');
  const incoming_attack={swing_detected:Boolean(incomingSwing&&now-incomingSwing.timestamp_ms<=700),hit_received:Boolean(selfDamage&&now-selfDamage.timestamp_ms<=1500),attacker_id:incomingSwing?.source_id??selfDamage?.source_id??null,attacker_name:incomingSwing?.source_name??selfDamage?.source_name??null,attacker_mob_type:incomingSwing?.source_mob_type??selfDamage?.source_mob_type??null,swing_age_ms:incomingSwing?now-incomingSwing.timestamp_ms:null,hit_age_ms:selfDamage?now-selfDamage.timestamp_ms:null,damage:selfDamage?.amount??0};
  return { self: { position: selfPos, velocity: selfVel, yaw: e?.yaw ?? null, pitch: e?.pitch ?? null, on_ground: e?.onGround ?? null, health: Number.isFinite(bot?.health) ? bot.health : null, hunger: Number.isFinite(bot?.food) ? bot.food : null, armor: null, effects: [], held_item: bot?.heldItem?.name ?? null, offhand_item:offhand, hotbar_slot: Number.isInteger(bot?.quickBarSlot) ? bot.quickBarSlot : null, cooldown: null, sprinting: bot?.getControlState?.('sprint') ?? null, sneaking: bot?.getControlState?.('sneak') ?? null, using_item: bot?.usingHeldItem ?? null, incoming_attack, recent_events: recentEvents }, target: targetState, hostiles: hostiles.map((x) => ({ id:x.id ?? null, mob_type:x.name ?? null, position:vec(x.position) })), projectiles: projectiles.map((x) => ({ id:x.id ?? null, position:vec(x.position), velocity:vec(x.velocity) })), collision: {}, dimension: terrain.dimension, terrain, selector };
}
