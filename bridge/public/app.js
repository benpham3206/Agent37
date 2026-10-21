import { boxEdges, cameraPoint, project } from './projection.js';
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const overlay = $('overlay');
  const viewer = $('viewer');
  const action = { forward:false, back:false, left:false, right:false, jump:false, sprint:false, sneak:false, attack:false, use:false, hotbar:0, mouse_dx:0, mouse_dy:0, yaw_delta:0, pitch_delta:0, emergency_stop:false, manual_abort:false };
  let socket, state = {}, reconnectTimer, viewerPort, armed = false, capturePending = false, emergencyLatched = false, released = false, directAction = null, directUntil = 0;
  const keys = new Map([['KeyW','forward'],['KeyS','back'],['KeyA','left'],['KeyD','right'],['Space','jump'],['ControlLeft','sprint'],['ControlRight','sprint'],['ShiftLeft','sneak'],['ShiftRight','sneak']]);
  const finite = value => Number.isFinite(value) ? value : 0;
  const send = message => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const active = () => armed && document.hasFocus() && !document.hidden && document.pointerLockElement === overlay && socket?.readyState === WebSocket.OPEN;
  const clearAction = () => { Object.keys(action).forEach(k => { if (typeof action[k] === 'boolean') action[k] = false; }); action.mouse_dx = action.mouse_dy = action.yaw_delta = action.pitch_delta = 0; };
  const release = (emergency = false) => { clearAction(); armed = false; if (emergency) { emergencyLatched = true; send({type:'emergency_stop'}); } else if (!released) { released = true; send({type:'release'}); } };
  const sendControl = () => { if(directAction){if(Date.now()<directUntil){released=false;send({type:'control',action:{...directAction}});directAction.yaw_delta=directAction.pitch_delta=0;return;}send({type:'control',action:{...emptyAction()}});directAction=null;release();return;} if (!active()) { release(); return; } released = false; send({type:'control',action:{...action, mouse_dx:finite(action.mouse_dx), mouse_dy:finite(action.mouse_dy), yaw_delta:finite(action.yaw_delta), pitch_delta:finite(action.pitch_delta)}}); action.mouse_dx=action.mouse_dy=action.yaw_delta=action.pitch_delta=0; action.emergency_stop=false; };
  const emptyAction = () => ({forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false,hotbar:action.hotbar,mouse_dx:0,mouse_dy:0,yaw_delta:0,pitch_delta:0,emergency_stop:false,manual_abort:false});
  const drive = (patch, duration=600) => { emergencyLatched=false; released=false; armed=false; send({type:'resume_control'}); directAction={...emptyAction(),...patch}; directUntil=Date.now()+duration; sendControl(); };
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/control`);
    socket.addEventListener('open', () => { released = false; $('connection').textContent = 'Connected'; $('connection').classList.add('live'); $('error').textContent = ''; });
    socket.addEventListener('message', event => { try { const message = JSON.parse(event.data); if (message.type === 'state') updateState(message); } catch (_) { $('error').textContent = 'Invalid state from bridge'; } });
    socket.addEventListener('close', () => { armed = false; $('connection').textContent = 'Disconnected'; $('connection').classList.remove('live'); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1000); });
    socket.addEventListener('error', () => { $('error').textContent = 'Control connection error'; });
  }
  function updateState(message) {
    state = message; const o = message.observation || {}; const self = o.self || {}; const target = o.target || null; const configuredTarget=o.selector && o.selector.target_type; if(configuredTarget && $('target').value!==configuredTarget) $('target').value=configuredTarget;
    $('session').textContent = message.session_id || '—'; $('encounter').textContent = message.encounter_id || '—'; $('recording').textContent = message.recording_state || 'idle';
    const imitation=message.imitation||{}; $('imitation-status').textContent=`${imitation.state||'idle'}${imitation.frames?` · ${imitation.frames} frames`:''}`;
    $('arbiter').textContent = message.arbiter ? `${message.arbiter.source || 'idle'}${message.arbiter.reason ? ` · ${message.arbiter.reason}` : ''}` : 'idle';
    $('health').textContent = display(self.health); $('target-health').textContent = target ? display(target.health) : '—'; $('distance').textContent = target ? display(target.distance, 2) : '—'; $('tracked').textContent = target ? 'yes' : 'no'; $('los').textContent = target ? (target.line_of_sight == null ? '—' : (target.line_of_sight ? 'yes' : 'no')) : '—';
    const incoming=self.incoming_attack||{}, attacker=incoming.attacker_name||incoming.attacker_mob_type; const threat=$('threat'); threat.className='threat'; if(incoming.hit_received){const amount=display(incoming.damage,1); threat.classList.add('hit'); threat.textContent=`HIT${amount==='—'?'':` −${amount} HP`}${attacker?` by ${attacker}`:''}`; $('incoming').textContent='HIT';}else if(incoming.swing_detected){threat.classList.add('swing'); threat.textContent=`SWING${attacker?` by ${attacker}`:''}`; $('incoming').textContent='SWING';}else{threat.classList.add('quiet'); threat.textContent='Incoming: quiet'; $('incoming').textContent='quiet';} $('last-hit').textContent=incoming.hit_age_ms==null?'—':`${(incoming.hit_age_ms/1000).toFixed(1)}s · ${display(incoming.damage,1)} HP`;
    if (message.viewer_port && message.viewer_port !== viewerPort) { viewerPort = message.viewer_port; viewer.src = `${location.protocol}//${location.hostname}:${viewerPort}`; }
    if (message.viewer_error) $('error').textContent = `Viewer: ${message.viewer_error}`;
    drawTarget(target, self);
  }
  function display(value, digits = 0) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits); }
  function resize() { const rect = overlay.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; overlay.width = Math.max(1, Math.round(rect.width*dpr)); overlay.height = Math.max(1, Math.round(rect.height*dpr)); overlay.getContext('2d').setTransform(dpr,0,0,dpr,0,0); drawTarget(state.observation && state.observation.target, state.observation && state.observation.self); }
  function drawTarget(target, self) {
    const ctx = overlay.getContext('2d'); const w = overlay.clientWidth, h = overlay.clientHeight; ctx.clearRect(0,0,w,h); if (!target || !target.aabb || !self?.position) return;
    const fovY = Number(state.viewer_fov_y ?? state.observation?.viewer_fov_y ?? (75 * Math.PI / 180)); const edges = boxEdges(target.aabb, { ...self, yaw: Number(self.yaw || 0), pitch: Number(self.pitch || 0) }, w, h, fovY);
    ctx.strokeStyle = target.line_of_sight === false ? '#ff786f' : '#55e68a'; ctx.lineWidth = 2; ctx.beginPath(); for (const edge of edges) { if (!edge[0] || !edge[1]) continue; ctx.moveTo(edge[0].x, edge[0].y); ctx.lineTo(edge[1].x, edge[1].y); } ctx.stroke();
    const aim = target.aim_point || { x:(target.aabb.min.x+target.aabb.max.x)/2, y:(target.aabb.min.y+target.aabb.max.y)/2, z:(target.aabb.min.z+target.aabb.max.z)/2 }; const aimScreen = project(cameraPoint(aim, { ...self, yaw:Number(self.yaw || 0), pitch:Number(self.pitch || 0) }), w, h, fovY); if (aimScreen) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(aimScreen.x, aimScreen.y, 4, 0, Math.PI*2); ctx.fill(); }
    ctx.strokeStyle = '#fff9'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(w/2-8,h/2); ctx.lineTo(w/2+8,h/2); ctx.moveTo(w/2,h/2-8); ctx.lineTo(w/2,h/2+8); ctx.stroke();
  }
  function key(event, down) { if (down && event.code === 'Escape') { release(true); document.exitPointerLock?.(); return; } if (!active()) return; const mapped = keys.get(event.code); if (mapped) { event.preventDefault(); if (mapped === 'sprint') { if (down && !event.repeat) action.sprint = !action.sprint; } else action[mapped] = down; sendControl(); } if (down && /^Digit[1-9]$/.test(event.code)) { action.hotbar = Number(event.code.slice(-1))-1; event.preventDefault(); sendControl(); } }
  document.addEventListener('keydown', e => key(e,true)); document.addEventListener('keyup', e => key(e,false));
  overlay.addEventListener('click', () => { if (socket?.readyState !== WebSocket.OPEN) return; emergencyLatched = false; capturePending = true; released = false; send({type:'resume_control'}); overlay.requestPointerLock?.(); $('start-hint').style.display='none'; });
  document.addEventListener('mousemove', e => { if (!active()) return; const width = Math.max(1, overlay.clientWidth), height = Math.max(1, overlay.clientHeight); const fovX = Math.PI/2, fovY = 2*Math.atan(Math.tan(fovX/2)/(width/height)); action.mouse_dx += finite(e.movementX); action.mouse_dy += finite(e.movementY); action.yaw_delta -= finite(e.movementX) * fovX / width; action.pitch_delta -= finite(e.movementY) * fovY / height; });
  overlay.addEventListener('mousedown', e => { if (!active()) return; e.preventDefault(); if (e.button === 0) action.attack=true; if (e.button === 2) action.use=true; sendControl(); });
  overlay.addEventListener('mouseup', e => { if (!active()) return; if (e.button === 0) action.attack=false; if (e.button === 2) action.use=false; sendControl(); }); overlay.addEventListener('wheel', e => { if (!active()) return; action.hotbar = Math.max(0, Math.min(8, action.hotbar + (e.deltaY > 0 ? 1 : -1))); e.preventDefault(); sendControl(); }); overlay.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement === overlay) { capturePending = false; armed = true; released = false; } else if (!emergencyLatched) { capturePending = false; release(); } }); window.addEventListener('blur', () => { capturePending = false; release(); }); document.addEventListener('visibilitychange', () => { if (document.hidden) { capturePending = false; release(); } });
  $('target').addEventListener('change', () => send({type:'target', mob_type:$('target').value})); document.querySelectorAll('[data-record]').forEach(button => button.addEventListener('click', () => send({type:'record',command:button.dataset.record}))); document.querySelectorAll('[data-label]').forEach(button => button.addEventListener('click', () => send({type:'label',label:button.dataset.label})));
  const drives={forward:[{forward:true,sprint:true},800],back:[{back:true},600],left:[{left:true},600],right:[{right:true},600],shield:[{use:true},800],attack:[{attack:true},180],jump:[{forward:true,jump:true},350],'turn-left':[{yaw_delta:Math.PI/15},120],'turn-right':[{yaw_delta:-Math.PI/15},120]}; document.querySelectorAll('[data-drive]').forEach(button=>button.addEventListener('click',()=>{const [patch,duration]=drives[button.dataset.drive];drive(patch,duration);}));
  document.querySelectorAll('[data-imitation]').forEach(button=>button.addEventListener('click',()=>send({type:'imitation',command:button.dataset.imitation})));
  setInterval(sendControl, 100);
  new ResizeObserver(resize).observe(overlay); window.addEventListener('resize', resize); connect();
})();
