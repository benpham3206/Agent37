import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LABELS = new Set(['good', 'bad', 'excluded', 'unlabelled']);
const nonemptyString = value => typeof value === 'string' && value.trim() ? value : null;

export class Recorder {
  constructor({ dataDir, sessionId, target, environmentSuite = 'open_surface', environmentLabel = 'open_surface', notes = '' }) {
    this.dataDir = dataDir; this.baseSessionId = sessionId; this.target = target;
    this.environmentSuite = environmentSuite; this.environmentLabel = environmentLabel; this.notes = notes;
    this.state = 'idle'; this.encounterId = null; this.fd = null; this.path = null; this.tick = 0; this.label = 'unlabelled';
    this.newSession(null);
  }
  newSession(agentName) {
    // Reserve a fresh directory. Never append v2 rows to historical session metadata.
    let sessionId = this.baseSessionId;
    fs.mkdirSync(path.dirname(path.join(this.dataDir, sessionId)), { recursive: true });
    for (;;) {
      const sessionDir = path.join(this.dataDir, sessionId);
      try { fs.mkdirSync(sessionDir); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; sessionId = `${this.baseSessionId}-${randomUUID()}`; }
    }
    this.sessionId = sessionId; this.sessionDir = path.join(this.dataDir, sessionId); this.agentName = agentName;
    fs.writeFileSync(path.join(this.sessionDir, 'session.json'), JSON.stringify({ schema_version: 2, session_id: sessionId, target: this.target, source: 'human', environment_suite: this.environmentSuite, environment_label: this.environmentLabel, notes: this.notes, created_at: new Date().toISOString(), agent_name: agentName }, null, 2) + '\n');
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
  row(observation, teacherAction, appliedAction, arbiter, timestampMs = Date.now(), identity = {}) {
    if (this.state !== 'recording' || this.fd === null) return false;
    const agentName = nonemptyString(identity.agentName) ?? nonemptyString(identity.configuredUsername);
    if (agentName !== this.agentName) {
      this.closeEncounter(); this.newSession(agentName); this.newEncounter();
    }
    const controllerId = arbiter?.source === 'teacher' ? nonemptyString(identity.controllerId) : null;
    // No authoritative server wall-clock source is available. World time and the host clock are not substitutes.
    fs.writeSync(this.fd, JSON.stringify({ schema_version: 2, session_id: this.sessionId, encounter_id: this.encounterId, tick: this.tick++, timestamp_ms: timestampMs, server_tick: null, source: 'privileged_hitbox', recording_state: this.state, label: this.label, observation, teacher_action: teacherAction, applied_action: appliedAction, arbiter, server_time_ms: null, agent_name: this.agentName, controller_id: controllerId }) + '\n'); return true;
  }
}
