import fs from 'node:fs';
import path from 'node:path';

const LABELS = new Set(['good', 'bad', 'excluded', 'unlabelled']);

export class Recorder {
  constructor({ dataDir, sessionId, target, environmentSuite = 'open_surface', environmentLabel = 'open_surface', notes = '' }) {
    this.dataDir = dataDir; this.sessionId = sessionId; this.target = target;
    this.environmentSuite = environmentSuite; this.environmentLabel = environmentLabel; this.notes = notes;
    this.state = 'idle'; this.encounterId = null; this.fd = null; this.path = null; this.tick = 0; this.label = 'unlabelled';
    this.sessionDir = path.join(dataDir, sessionId); fs.mkdirSync(this.sessionDir, { recursive: true });
    const sessionFile = path.join(this.sessionDir, 'session.json');
    if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, JSON.stringify({ schema_version: 1, session_id: sessionId, target, source: 'human', environment_suite: environmentSuite, environment_label: environmentLabel, notes, created_at: new Date().toISOString() }, null, 2) + '\n');
  }
  start() { if (this.state === 'recording') return; this.state = 'recording'; this.newEncounter(); }
  pause() { if (this.state === 'recording') { this.state = 'paused'; this.closeEncounter(); } }
  resume() { if (this.state === 'paused') { this.state = 'recording'; this.newEncounter(); } }
  stop() { this.state = 'stopped'; this.closeEncounter(); }
  closeEncounter() { if (this.fd !== null) { fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null; } }
  newEncounter() { this.closeEncounter(); this.encounterId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; const dir = path.join(this.sessionDir, 'encounters'); fs.mkdirSync(dir, { recursive: true }); this.path = path.join(dir, `${this.encounterId}.jsonl`); this.fd = fs.openSync(this.path, 'a'); this.tick = 0; this.label = 'unlabelled'; }
  setLabel(label) {
    if (!LABELS.has(label)) return; this.label = label; if (!this.path || !fs.existsSync(this.path)) return;
    const wasOpen = this.fd !== null; this.closeEncounter();
    const rows = fs.readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((line) => { try { const row = JSON.parse(line); row.label = label; return JSON.stringify(row); } catch { return line; } });
    fs.writeFileSync(this.path, rows.length ? rows.join('\n') + '\n' : ''); if (wasOpen) this.fd = fs.openSync(this.path, 'a');
  }
  row(observation, teacherAction, appliedAction, arbiter, timestampMs = Date.now()) {
    if (this.state !== 'recording' || this.fd === null) return false;
    fs.writeSync(this.fd, JSON.stringify({ schema_version: 1, session_id: this.sessionId, encounter_id: this.encounterId, tick: this.tick++, timestamp_ms: timestampMs, server_tick: null, source: 'privileged_hitbox', recording_state: this.state, label: this.label, observation, teacher_action: teacherAction, applied_action: appliedAction, arbiter }) + '\n'); return true;
  }
}
