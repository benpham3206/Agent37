import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRuntime } from './server.js';

async function runtimeFor(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-lease-'));
  const runtime = await createRuntime({ bot: { username: 'ConnectedBot', health: 20 }, username: 'ConfiguredBot', dataDir, session: 's', webPort: 0, ...options });
  t.after(async () => {
    for (const socket of runtime.ws.clients) socket.terminate();
    runtime.recorder.stop();
    const closed = once(runtime.server, 'close'); runtime.close(); await closed;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return runtime;
}
async function connect(runtime) {
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.server.address().port}/control`);
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw)));
  await once(socket, 'open');
  const wait = async predicate => {
    await until(() => messages.some(predicate));
    return messages.splice(messages.findIndex(predicate), 1)[0];
  };
  return {
    socket, messages, wait,
    send: message => socket.send(JSON.stringify(message)),
    async request(message, type) { this.send(message); return wait(m => m.type === type); },
  };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for lease/recording result');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const rows = runtime => runtime.recorder.path ? fs.readFileSync(runtime.recorder.path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function recorded(runtime, predicate) { await until(() => rows(runtime).some(predicate)); return rows(runtime).find(predicate); }

test('only the socket holding the lease and token can control or mutate the bot', async t => {
  const runtime = await runtimeFor(t);
  const a = await connect(runtime), b = await connect(runtime);
  const first = await a.request({ type: 'acquire' }, 'lease_granted');
  const denied = await b.request({ type: 'acquire' }, 'lease_denied');
  assert.equal(denied.holder, first.controller_id);
  assert.notEqual(first.token, first.controller_id);
  assert.equal('token' in denied, false);
  for (const token of [undefined, 'wrong-token', first.token]) {
    const result = await b.request({ type: 'control', token, action: { back: true } }, 'control_error');
    assert.equal(result.error, 'lease_required');
  }
  await b.request({ type: 'heartbeat', token: first.token }, 'heartbeat_result').then(result => assert.equal(result.ok, false));
  for (const message of [{ type: 'release' }, { type: 'resume_control' }, { type: 'target', mob_type: 'blaze' }, { type: 'record', command: 'start' }, { type: 'label', label: 'good' }, { type: 'imitation', command: 'observe' }, { type: 'setGamemode', mode: 'creative' }]) {
    await b.request({ ...message, token: first.token }, 'control_error');
  }
  assert.equal(runtime.cfg.target, 'zombie'); assert.equal(runtime.recorder.state, 'idle');
  a.send({ type: 'control', token: first.token, action: { forward: true } });
  await until(() => runtime.arbiter.tick().action.forward);
  b.socket.close(); await once(b.socket, 'close');
  assert.equal(runtime.arbiter.tick().source, 'human');
  const status = await fetch(`http://127.0.0.1:${runtime.server.address().port}/combat/status`).then(r => r.text());
  assert.ok(!status.includes(first.token)); assert.ok(!JSON.stringify(runtime.state()).includes(first.token));
});

test('recorded IDs follow accepted driver input, takeovers and reconnects, and survive relabels', async t => {
  const runtime = await runtimeFor(t);
  const a = await connect(runtime), b = await connect(runtime);
  const first = await a.request({ type: 'acquire' }, 'lease_granted');
  runtime.recorder.start();
  a.send({ type: 'control', token: first.token, action: { forward: true } });
  const teacher = await recorded(runtime, row => row.controller_id === first.controller_id);
  assert.equal(teacher.arbiter.source, 'teacher'); assert.equal(teacher.agent_name, 'ConnectedBot');
  await a.request({ type: 'release', token: first.token }, 'lease_status');
  const second = await b.request({ type: 'acquire' }, 'lease_granted');
  assert.notEqual(second.controller_id, first.controller_id);
  b.send({ type: 'control', token: second.token, action: { back: true } });
  await recorded(runtime, row => row.controller_id === second.controller_id && row.applied_action.back);
  b.socket.close(); await once(b.socket, 'close');
  await recorded(runtime, row => row.arbiter.source === 'idle' && row.controller_id === null);
  const reconnected = await connect(runtime);
  const third = await reconnected.request({ type: 'acquire' }, 'lease_granted');
  assert.notEqual(third.controller_id, second.controller_id);
  reconnected.send({ type: 'control', token: third.token, action: { left: true } });
  await recorded(runtime, row => row.controller_id === third.controller_id);
  runtime.bot.health = 1;
  await recorded(runtime, row => row.arbiter.source === 'survival' && row.controller_id === null);
  a.send({ type: 'emergency_stop' });
  await recorded(runtime, row => row.arbiter.source === 'emergency' && row.controller_id === null);
  runtime.recorder.setLabel('good'); runtime.recorder.stop();
  const actual = rows(runtime);
  for (const id of [first.controller_id, second.controller_id, third.controller_id]) assert.ok(actual.some(row => row.controller_id === id));
  assert.ok(actual.every(row => row.label === 'good' && row.server_time_ms === null));
  for (const { token } of [first, second, third]) assert.ok(!JSON.stringify(actual).includes(token));
});

test('heartbeat extends the lease, control traffic does not, and stale tokens cannot revive it', async t => {
  const runtime = await runtimeFor(t, { leaseMs: 300 });
  const a = await connect(runtime), b = await connect(runtime);
  const first = await a.request({ type: 'acquire' }, 'lease_granted');
  runtime.recorder.start();
  const control = () => a.send({ type: 'control', token: first.token, action: { forward: true } });
  control(); await recorded(runtime, row => row.controller_id === first.controller_id);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await a.request({ type: 'heartbeat', token: first.token }, 'heartbeat_result')).ok, true);
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal((await b.request({ type: 'acquire' }, 'lease_denied')).holder, first.controller_id);
  const traffic = setInterval(control, 30); t.after(() => clearInterval(traffic));
  await recorded(runtime, row => row.arbiter.source === 'idle' && row.controller_id === null && row.tick > 2);
  clearInterval(traffic);
  assert.equal((await a.request({ type: 'heartbeat', token: first.token }, 'heartbeat_result')).ok, false);
  const second = await b.request({ type: 'acquire' }, 'lease_granted');
  assert.notEqual(second.controller_id, first.controller_id);
  await a.request({ type: 'control', token: first.token, action: { attack: true } }, 'control_error');
  assert.equal(runtime.arbiter.tick().action.attack, false);
});
