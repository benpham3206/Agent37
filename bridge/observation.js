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

// B1: structured facts for goal checks ("has 3 iron", "lava within 16 blocks").
// Computed on demand by GET /api/observation, not in the 20 Hz control tick,
// so recordings and the control loop stay unchanged and block scans stay cheap.
export const WATCHED_BLOCKS = Object.freeze(['iron_ore','deepslate_iron_ore','coal_ore','diamond_ore','deepslate_diamond_ore','stone','oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','cherry_log','mangrove_log','lava','water','obsidian','crafting_table','furnace','nether_portal']);
export const HOSTILE_MOBS = new Set(['zombie','skeleton','husk','drowned','stray','bogged','enderman','blaze','phantom','creeper','spider','cave_spider','witch','pillager','vindicator','evoker','ravager','guardian','elder_guardian','slime','magma_cube','piglin_brute','hoglin','zoglin','wither_skeleton','ghast','zombified_piglin','piglin','silverfish','endermite','shulker','vex','warden','breeze']);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
function offset(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return { distance: round(Math.hypot(dx, dy, dz)), dx: round(dx), dy: round(dy), dz: round(dz) };
}
export function normalizeDimension(value) {
  const d = String(value ?? '').replace(/^minecraft:/, '');
  if (d === 'overworld' || d === 'the_nether' || d === 'the_end') return d;
  if (d === 'nether') return 'the_nether';
  if (d === 'end') return 'the_end';
  return d || null;
}
export function buildFacts(bot, { radius = 16, watched = WATCHED_BLOCKS, sounds = [] } = {}) {
  const pos = bot?.entity?.position;
  const position = pos ? { x: round(pos.x), y: round(pos.y), z: round(pos.z) } : null;
  const inventory = {};
  for (const item of bot?.inventory?.items?.() ?? []) inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
  const nearest_blocks = {};
  if (pos && typeof bot.world?.getBlockStateId === 'function' && bot.registry?.blocksByStateId) {
    // One pass over the cube reading cheap state ids. Calling findBlock once per type
    // built a Block for every cell of common types (stone, water), ~0.5 s per call on a
    // real world, which stalled the 50 ms tick.
    const want = new Set(watched), byState = bot.registry.blocksByStateId, cache = new Map();
    const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z), r2 = radius * radius, cursor = new Vec3(0, 0, 0);
    const minY = bot.game?.minY ?? -64, maxY = minY + (bot.game?.height ?? 384) - 1;
    const best = {};
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy; if (y < minY || y > maxY) continue;
      for (let dz = -radius; dz <= radius; dz++) {
        const d2 = dx * dx + dy * dy + dz * dz; if (d2 > r2) continue;
        cursor.x = cx + dx; cursor.y = y; cursor.z = cz + dz;
        let sid; try { sid = bot.world.getBlockStateId(cursor); } catch { continue; }
        if (sid == null) continue;
        let name = cache.get(sid); if (name === undefined) { name = want.has(byState[sid]?.name) ? byState[sid].name : null; cache.set(sid, name); }
        if (!name) continue;
        const exact = (cursor.x - pos.x) ** 2 + (cursor.y - pos.y) ** 2 + (cursor.z - pos.z) ** 2;
        if (!best[name] || exact < best[name].d) best[name] = { d: exact, x: cursor.x, y: cursor.y, z: cursor.z };
      }
    }
    for (const type of watched) if (best[type] && Math.sqrt(best[type].d) <= radius) nearest_blocks[type] = { type, ...offset(pos, best[type]) };
  } else if (pos && typeof bot.findBlock === 'function') {
    for (const type of watched) {
      const id = bot.registry?.blocksByName?.[type]?.id;
      if (id == null) continue; // unknown in this game version
      const block = bot.findBlock({ matching: id, maxDistance: radius, point: pos });
      if (block?.position) nearest_blocks[type] = { type, ...offset(pos, block.position) };
    }
  }
  const nearby_mobs = [];
  if (pos) {
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity?.position || entity === bot.entity || entity.type === 'player' || entity.type === 'object' || !entity.name) continue;
      const o = offset(pos, entity.position);
      if (o.distance <= radius) nearby_mobs.push({ id: entity.id ?? null, type: entity.name, ...o, hostile: HOSTILE_MOBS.has(entity.name) });
    }
    nearby_mobs.sort((a, b) => a.distance - b.distance || String(a.type).localeCompare(String(b.type)));
  }
  const tod = bot?.time?.timeOfDay;
  return {
    position, dimension: normalizeDimension(bot?.game?.dimension),
    health: Number.isFinite(bot?.health) ? bot.health : null,
    food: Number.isFinite(bot?.food) ? bot.food : null,
    inventory, nearest_blocks, nearby_mobs, sounds, radius,
    time_of_day: Number.isFinite(tod) ? tod : null,
    is_day: typeof bot?.time?.isDay === 'boolean' ? bot.time.isDay : (Number.isFinite(tod) ? tod < 13000 || tod >= 23000 : null),
  };
}

function invCount(inventory, name) {
  const n = inventory?.[name];
  return Number.isFinite(n) ? n : 0;
}
function invHasSuffix(inventory, suffix) {
  for (const [name, count] of Object.entries(inventory ?? {})) {
    if (name.endsWith(suffix) && Number(count) >= 1) return name;
  }
  return null;
}
function nearestHasSuffix(nearest, suffix) {
  for (const name of Object.keys(nearest ?? {})) {
    if (name.endsWith(suffix)) return name;
  }
  return null;
}
function hasAny(inventory, names) {
  for (const name of names) if (invCount(inventory, name) >= 1) return name;
  return null;
}

// Nether demo chain from facts only. Iron demo-ready when iron_ingot >= 7
// (pickaxe 3 + bucket 3 + flint_and_steel 1), or iron_pickaxe plus a bucket
// and flint_and_steel, or iron_pickaxe with iron_ingot >= 3 leftover.
export function scoreNetherChain(facts = {}) {
  const inventory = facts?.inventory ?? {};
  const nearest = facts?.nearest_blocks ?? {};
  const position = facts?.position ?? null;
  const dimension = normalizeDimension(facts?.dimension);
  const knownDim = dimension === 'overworld' || dimension === 'the_nether' || dimension === 'the_end';
  const steps = [];

  // spawn
  if (position || knownDim) {
    steps.push({ id: 'spawn', status: 'demo-ready', detail: position ? 'has position' : `dimension ${dimension}` });
  } else {
    steps.push({ id: 'spawn', status: 'not-started' });
  }

  // wood
  const woodInv = invHasSuffix(inventory, '_log') || invHasSuffix(inventory, '_stem');
  const woodNear = nearestHasSuffix(nearest, '_log') || nearestHasSuffix(nearest, '_stem');
  if (woodInv) steps.push({ id: 'wood', status: 'demo-ready', detail: woodInv });
  else if (woodNear) steps.push({ id: 'wood', status: 'close', detail: `nearby ${woodNear}` });
  else steps.push({ id: 'wood', status: 'not-started' });

  // tools
  const pick = invHasSuffix(inventory, '_pickaxe');
  if (pick) steps.push({ id: 'tools', status: 'demo-ready', detail: pick });
  else steps.push({ id: 'tools', status: 'not-started' });

  // iron
  const ingots = invCount(inventory, 'iron_ingot');
  const hasIronPick = invCount(inventory, 'iron_pickaxe') >= 1;
  const bucket = hasAny(inventory, ['bucket', 'water_bucket', 'lava_bucket']);
  const flint = invCount(inventory, 'flint_and_steel') >= 1;
  if (ingots >= 7) {
    steps.push({ id: 'iron', status: 'demo-ready', detail: `${ingots} iron_ingot` });
  } else if (hasIronPick && bucket && flint) {
    steps.push({ id: 'iron', status: 'demo-ready', detail: 'iron_pickaxe + bucket + flint_and_steel' });
  } else if (hasIronPick && ingots >= 3) {
    steps.push({ id: 'iron', status: 'demo-ready', detail: `iron_pickaxe + ${ingots} iron_ingot` });
  } else if (ingots > 0 || hasIronPick) {
    steps.push({ id: 'iron', status: 'close', detail: hasIronPick ? 'iron_pickaxe partial kit' : `${ingots} iron_ingot` });
  } else {
    steps.push({ id: 'iron', status: 'not-started' });
  }

  // obsidian
  const obsInv = invCount(inventory, 'obsidian');
  const lavaBucket = invCount(inventory, 'lava_bucket') >= 1;
  if (obsInv >= 1) steps.push({ id: 'obsidian', status: 'demo-ready', detail: `${obsInv} obsidian` });
  else if (nearest.obsidian) steps.push({ id: 'obsidian', status: 'demo-ready', detail: 'nearby obsidian' });
  else if (nearest.lava && nearest.water) steps.push({ id: 'obsidian', status: 'demo-ready', detail: 'lava and water nearby' });
  else if (lavaBucket) steps.push({ id: 'obsidian', status: 'demo-ready', detail: 'lava_bucket' });
  else if (nearest.lava || nearest.water) steps.push({ id: 'obsidian', status: 'close', detail: nearest.lava ? 'lava nearby' : 'water nearby' });
  else steps.push({ id: 'obsidian', status: 'not-started' });

  // light
  if (flint) steps.push({ id: 'light', status: 'demo-ready', detail: 'flint_and_steel' });
  else if (nearest.nether_portal) steps.push({ id: 'light', status: 'demo-ready', detail: 'nether_portal nearby' });
  else steps.push({ id: 'light', status: 'not-started' });

  // enter — demo-ready only in the Nether; portal nearby while still overworld is close
  if (dimension === 'the_nether') steps.push({ id: 'enter', status: 'demo-ready', detail: 'in the_nether' });
  else if (nearest.nether_portal) steps.push({ id: 'enter', status: 'close', detail: 'nether_portal nearby' });
  else steps.push({ id: 'enter', status: 'not-started' });

  const blockerStep = steps.find((s) => s.status !== 'demo-ready') ?? null;
  const blocker = blockerStep
    ? { id: blockerStep.id, reason: blockerStep.detail ?? `${blockerStep.id} is ${blockerStep.status}` }
    : null;
  return { steps, blocker };
}
