import test from 'node:test'; import assert from 'node:assert/strict'; import { ActionArbiter, gateSkillTerrain, emptyAction, sanitizeAction } from './arbiter.js';
test('priority and emergency release',()=>{const a=new ActionArbiter({retreatHealth:4,maxDurationMs:10000});a.set('skill',{attack:true});a.set('human',{forward:true});assert.equal(a.tick().source,'human');assert.equal(a.tick({health:3}).source,'survival');a.emergencyStop();assert.equal(a.tick().source,'emergency');});
test('camera and hotbar are bounded',()=>{const a=new ActionArbiter();a.set('human',{mouse_dx:100,hotbar:30});assert.equal(a.tick().action.mouse_dx,1);assert.equal(a.tick().action.hotbar,8);});
test('dig keeps only integer block coordinates',()=>{assert.deepEqual(sanitizeAction({dig:{x:1,y:64,z:-2,extra:true}}).dig,{x:1,y:64,z:-2});assert.equal(sanitizeAction({dig:{x:1.5,y:64,z:-2}}).dig,undefined);});
test('interact keeps integer block coordinates and one axis-aligned face',()=>{
  const target={x:1,y:63,z:-2,face:{x:0,y:1,z:0,extra:true},extra:true};
  const sanitized=sanitizeAction({hotbar:4,interact:target});
  assert.deepEqual(sanitized.interact,{x:1,y:63,z:-2,face:{x:0,y:1,z:0}});
  assert.equal(sanitized.hotbar,4);
  target.face.y=-1; assert.equal(sanitized.interact.face.y,1);
  for(const interact of [null,{}, {x:1.5,y:63,z:0,face:{x:0,y:1,z:0}}, {x:1,y:NaN,z:0,face:{x:0,y:1,z:0}}, {x:1,y:63,z:Infinity,face:{x:0,y:1,z:0}}, {x:1,y:63,z:0}, ...[{x:0,y:0,z:0},{x:1,y:1,z:0},{x:0,y:0.5,z:0},{x:2,y:0,z:0}].map(face=>({x:1,y:63,z:0,face}))]) assert.equal(sanitizeAction({interact}).interact,undefined);
  const arbiter=new ActionArbiter(); arbiter.set('skill',sanitized); assert.deepEqual(arbiter.tick().action.interact,sanitized.interact); arbiter.release(); assert.equal(arbiter.tick().action.interact,undefined);
});
test('craft keeps a bounded request and optional integer table coordinates',()=>{
  const craft={id:'run-1',name:'bucket',count:1,table:{x:1,y:64,z:-2,extra:true},extra:true};
  assert.deepEqual(sanitizeAction({craft}).craft,{id:'run-1',name:'bucket',count:1,table:{x:1,y:64,z:-2}});
  assert.deepEqual(sanitizeAction({craft:{id:'two',name:'stick',count:4}}).craft,{id:'two',name:'stick',count:4});
  for(const invalid of [null,{},...['',2,Symbol('id')].map(id=>({...craft,id})),...['minecraft:bucket','Bucket','a b','a'.repeat(65),3].map(name=>({...craft,name})),...[0,-1,1.5,65,Infinity,'1'].map(count=>({...craft,count})),...[null,{x:1.5,y:64,z:0},{x:1,y:64},'table'].map(table=>({...craft,table}))]) assert.equal(sanitizeAction({craft:invalid}).craft,undefined);
});
test('equip keeps only a plain item name',()=>{assert.equal(sanitizeAction({equip:'stone_pickaxe'}).equip,'stone_pickaxe');for(const bad of ['','Stone','minecraft:stone','a b',3,null,{},'a'.repeat(65)])assert.equal(sanitizeAction({equip:bad}).equip,undefined);});
test('skill movement is gated by missing/deep terrain while teacher remains usable',()=>{const terrain={support_grid:[[{}, {}, {}],[{}, {available:true,drop_depth:0}, {available:true,drop_depth:0}],[{}, {available:false}, {}]],hazards:{deep_drop:true}};const a=new ActionArbiter();a.set('skill',{forward:true,left:true,jump:true,sprint:true});const gated=a.tick({terrain});assert.equal(gated.action.forward,false);assert.equal(gated.action.left,false);assert.equal(gated.action.jump,false);a.set('human',{forward:true,jump:true});assert.equal(a.tick({terrain}).source,'human');assert.equal(a.tick({terrain}).action.forward,true);});
test('direct terrain gate preserves idle when unavailable',()=>{const x=gateSkillTerrain({forward:true,sprint:true},{support_grid:null,hazards:{}});assert.equal(x.forward,false);assert.equal(x.sprint,true);});
test('a fresh control session works after the prior skill session times out',()=>{let now=0;const a=new ActionArbiter({maxDurationMs:1000,now:()=>now});a.set('skill',{forward:true});now=1001;assert.equal(a.tick().reason,'timeout');a.set('skill',{attack:true});const fresh=a.tick();assert.equal(fresh.source,'skill');assert.equal(fresh.action.attack,true);});

// B3 safety rules, all on a fake clock so they are instant and never flaky.
const clock=()=>{const c={t:0};c.now=()=>c.t;return c;};
const drop={support_grid:[[{},{},{}],[{},{available:true,drop_depth:0},{}],[{},{available:true,drop_depth:10},{}]],hazards:{deep_drop:true}};
test('B3: emergency stop beats every source, including survival retreat',()=>{const a=new ActionArbiter({now:clock().now});for(const s of ['human','mimic','skill','navigation'])a.set(s,{forward:true,attack:true});a.emergencyStop();for(const health of [null,1]){const r=a.tick({health});assert.equal(r.source,'emergency');assert.deepEqual(r.action,emptyAction());}a.set('human',{forward:true});assert.equal(a.tick().source,'emergency');});
test("B3: release('lease_expired') returns an empty action and the bot idles",()=>{const a=new ActionArbiter({now:clock().now});a.set('human',{forward:true,attack:true});const r=a.release('lease_expired');assert.deepEqual(r.action,emptyAction());assert.equal(r.reason,'lease_expired');const next=a.tick();assert.equal(next.source,'idle');assert.deepEqual(next.action,emptyAction());});
test('B3: a human source still controls after 3 minutes',()=>{const c=clock();const a=new ActionArbiter({now:c.now});a.set('human',{forward:true});c.t=3*60*1000;const r=a.tick();assert.equal(r.source,'human');assert.equal(r.action.forward,true);});
test('B3: a skill is still cut off at the 2-minute cap, even while a human drives',()=>{const c=clock();const a=new ActionArbiter({now:c.now});a.set('skill',{attack:true});c.t=60000;a.set('human',{forward:true});c.t=120001;assert.equal(a.tick().source,'human');a.set('human',{});a.release('human_done');a.set('skill',{attack:true});assert.equal(a.tick().source,'skill');c.t=240002;assert.equal(a.tick().reason,'timeout');});
test('B3: a human moving forward at a drop is not blocked',()=>{const a=new ActionArbiter({now:clock().now});a.set('human',{forward:true,sprint:true});const r=a.tick({terrain:drop});assert.equal(r.source,'human');assert.equal(r.action.forward,true);assert.equal(r.action.sprint,true);});
test('B3: a skill moving forward at a drop is blocked',()=>{const a=new ActionArbiter({now:clock().now});a.set('skill',{forward:true,sprint:true});const r=a.tick({terrain:drop});assert.equal(r.source,'skill');assert.equal(r.action.forward,false);assert.equal(r.action.sprint,false);});

test('the retreat reflex defaults to 4 and a retreatHealth of 0 turns it off',()=>{
  const old=new ActionArbiter({now:clock().now});assert.equal(old.retreatHealth,4);old.set('skill',{attack:true});
  const forced=old.tick({health:4});assert.deepEqual([forced.source,forced.reason,forced.action.back,forced.action.sprint],['survival','retreat_health',true,true]);
  const free=new ActionArbiter({retreatHealth:0,now:clock().now});free.set('skill',{attack:true});
  for(const health of [4,1,0.5]){const r=free.tick({health});assert.deepEqual([r.source,r.action.attack],['skill',true]);}
  const human=new ActionArbiter({now:clock().now});human.set('human',{forward:true});human.set('skill',{attack:true});assert.equal(human.tick({health:3}).source,'survival');assert.equal(human.sources.has('human'),false,'the default still drops human and skill');
});
test('attack_entity keeps only a non-negative integer mob id',()=>{
  assert.equal(sanitizeAction({attack_entity:12}).attack_entity,12);assert.equal(sanitizeAction({attack_entity:0}).attack_entity,0);
  for(const bad of [-1,1.5,'4',null,NaN,Infinity,{},[3]])assert.equal(sanitizeAction({attack_entity:bad}).attack_entity,undefined);
  assert.equal('attack_entity' in emptyAction(),false);
  const a=new ActionArbiter({now:clock().now});a.set('skill',{attack_entity:7,forward:true});assert.equal(a.tick().action.attack_entity,7);a.release();assert.equal(a.tick().action.attack_entity,undefined);
});
