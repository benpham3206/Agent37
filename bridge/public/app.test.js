import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page() {
  let time = 0, nextTimer = 0;
  const timers = new Map(), sockets = [], elements = new Map();
  const events = extra => ({
    listeners: new Map(), ...extra,
    addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); },
    emit(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, events({ textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, value: '', disabled: false }));
    return elements.get(id);
  };
  const groups = { '[data-drive]': [element('forward-button')], '[data-record]': [], '[data-label]': [], '[data-imitation]': [] };
  element('forward-button').dataset.drive = 'forward';
  const document = events({
    hidden: false, pointerLockElement: null, hasFocus: () => true,
    getElementById: element, querySelectorAll: query => groups[query] ?? [],
    exitPointerLock() { this.pointerLockElement = null; this.emit('pointerlockchange'); },
  });
  element('overlay').requestPointerLock = () => { document.pointerLockElement = element('overlay'); document.emit('pointerlockchange'); };
  element('overlay').getContext = () => ({ clearRect() {} });
  class Socket {
    static OPEN = 1;
    constructor() { Object.assign(this, events({ readyState: 0, sent: [] })); sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    open() { this.readyState = 1; this.emit('open'); }
    message(data) { this.emit('message', { data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const window = events({ devicePixelRatio: 1 });
  const timer = (fn, ms, repeat) => { const id = ++nextTimer; timers.set(id, { fn, at: time + ms, repeat }); return id; };
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '');
  vm.runInNewContext(source, {
    document, window, WebSocket: Socket, location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' },
    ResizeObserver: class { observe() {} },
    Date: class extends Date { static now() { return time; } },
    setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: id => timers.delete(id),
    setTimeout: (fn, ms) => timer(fn, ms, 0), clearTimeout: id => timers.delete(id),
  });
  const advance = ms => {
    const end = time + ms;
    for (;;) {
      const due = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due; time = task.at;
      if (task.repeat) task.at += task.repeat; else timers.delete(id);
      task.fn();
    }
    time = end;
  };
  const socket = sockets[0]; socket.open();
  return { socket, sockets, document, window, element, advance };
}

test('an observer sends no control/release traffic and explicitly acquires before driving', () => {
  const p = page(); p.advance(1000);
  assert.deepEqual(p.socket.sent, []);
  p.element('overlay').emit('click');
  assert.deepEqual(p.socket.sent, [{ type: 'acquire' }]);
  p.advance(100); assert.equal(p.socket.sent.some(m => m.type === 'control'), false);
  p.socket.message({ type: 'lease_granted', token: 'private-ticket', controller_id: 'controller-1' });
  assert.ok(p.socket.sent.some(m => m.type === 'resume_control' && m.token === 'private-ticket'));
  p.advance(1000);
  assert.ok(p.socket.sent.some(m => m.type === 'heartbeat' && m.token === 'private-ticket'));
  assert.ok(p.socket.sent.filter(m => m.type === 'control').every(m => m.token === 'private-ticket'));
  p.window.emit('blur');
  assert.ok(p.socket.sent.some(m => m.type === 'release' && m.token === 'private-ticket'));
  const count = p.socket.sent.length; p.advance(2000); assert.equal(p.socket.sent.length, count);
});

test('denial and lease loss clear manual movement, pointer lock, and heartbeat', () => {
  const p = page();
  p.element('forward-button').emit('click');
  assert.deepEqual(p.socket.sent, [{ type: 'acquire' }]);
  p.socket.message({ type: 'lease_denied', holder: 'controller-2' });
  assert.match(p.element('error').textContent, /controller-2/);
  p.advance(1000); assert.equal(p.socket.sent.some(m => m.type === 'control'), false);
  p.element('overlay').emit('click');
  p.socket.message({ type: 'lease_granted', token: 'private-ticket', controller_id: 'controller-1' });
  p.socket.message({ type: 'state', driver: 'controller-2', observation: {} });
  const count = p.socket.sent.length; p.advance(2000);
  assert.equal(p.socket.sent.length, count); assert.equal(p.document.pointerLockElement, null);
});

test('disconnect/reconnect drops the old token and requires a fresh acquisition', () => {
  const p = page(); p.element('overlay').emit('click');
  p.socket.message({ type: 'lease_granted', token: 'old-ticket', controller_id: 'controller-1' });
  p.socket.close(); p.advance(1000);
  const next = p.sockets[1]; next.open(); p.advance(1000);
  assert.deepEqual(next.sent, []);
  p.element('forward-button').emit('click');
  assert.deepEqual(next.sent, [{ type: 'acquire' }]);
  next.message({ type: 'lease_granted', token: 'new-ticket', controller_id: 'controller-3' });
  assert.ok(next.sent.some(m => m.type === 'control' && m.token === 'new-ticket' && m.action.forward));
  assert.ok(!JSON.stringify(next.sent).includes('old-ticket'));
});

test('a grant arriving after blur is released without starting pending movement', () => {
  const p = page(); p.element('forward-button').emit('click'); p.window.emit('blur');
  p.socket.message({ type: 'lease_granted', token: 'late-ticket', controller_id: 'controller-1' });
  assert.ok(p.socket.sent.some(m => m.type === 'release' && m.token === 'late-ticket'));
  assert.equal(p.socket.sent.some(m => m.type === 'control'), false);
});
