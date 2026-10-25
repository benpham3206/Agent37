import fs from 'fs';
for (const f of process.argv.slice(2)) {
const L=fs.readFileSync(f,'utf8').trim().split('\n').map(JSON.parse);
const c={teacher:{},applied:{}}, arb={}, mob={};
for(const r of L){ for(const [k,a] of [['teacher',r.teacher_action],['applied',r.applied_action]]) for(const [kk,v] of Object.entries(a||{})) if(v===true) c[k][kk]=(c[k][kk]||0)+1;
 arb[r.arbiter?.source]=(arb[r.arbiter?.source]||0)+1; mob[r.observation.target?.mob_type]=(mob[r.observation.target?.mob_type]||0)+1;}
let moved=0; for(let i=1;i<L.length;i++){const a=L[i].observation.self.position,b=L[i-1].observation.self.position; if(Math.hypot(a.x-b.x,a.z-b.z)>0.01) moved++;}
console.log(f.split('\\').pop(), L.length, ((L.at(-1).timestamp_ms-L[0].timestamp_ms)/1000).toFixed(1)+'s', JSON.stringify(c), JSON.stringify(arb), JSON.stringify(mob), 'movedTicks',moved, 'label',L[0].label);
}
