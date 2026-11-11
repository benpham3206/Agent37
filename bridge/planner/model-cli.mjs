// A model plug-in for the planner: one `claude -p` call per decision.
// The child gets no tools, no MCP servers, no hooks and no session files, runs in an
// empty temp directory, and sees only an explicit allow-list of environment variables.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{1,79}$/;
const SYSTEM_PROMPT = 'You are a JSON-only decision function. Output exactly one JSON object and no other text.';
const MAX_OUTPUT = 1_000_000;

// The child needs its login files and a working shell path, nothing else.
const ENV_ALLOW = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USERDOMAIN', 'LANG', 'LC_ALL', 'TERM', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);
const SECRET_NAME = /KEY|TOKEN|PASSWORD|SECRET|SESSION/i;

export function childEnv(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value == null || !ENV_ALLOW.has(name.toUpperCase()) || SECRET_NAME.test(name)) continue;
    env[name] = value;
  }
  return env;
}

export function cliArgs(model) {
  if (typeof model !== 'string' || !MODEL.test(model)) throw new Error('model must be haiku, sonnet or a full model id');
  return ['-p', '--model', model, '--output-format', 'json',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--disable-slash-commands',
    '--system-prompt', SYSTEM_PROMPT];
}

export function parseCliOutput(stdout, requestedModel) {
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('model_cli_output_not_json'); }
  if (Array.isArray(data)) data = data.findLast((x) => x?.type === 'result') ?? null;
  if (!data || typeof data !== 'object') throw new Error('model_cli_output_unexpected');
  if (data.is_error || (data.subtype && data.subtype !== 'success')) {
    throw new Error(`model_cli_error:${String(data.result ?? data.subtype ?? 'unknown').slice(0, 200)}`);
  }
  if (typeof data.result !== 'string') throw new Error('model_cli_no_result_text');
  const u = data.usage ?? {};
  const n = (v) => Number.isFinite(v) ? v : 0;
  return { text: data.result,
    usage: { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens),
      cache_read_input_tokens: n(u.cache_read_input_tokens), cache_creation_input_tokens: n(u.cache_creation_input_tokens) },
    cost_usd: n(data.total_cost_usd),
    model: Object.keys(data.modelUsage ?? {})[0] ?? requestedModel };
}

export function createCliModel({ model, timeoutMs = 60000, spawnImpl = spawn, command = 'claude', env = process.env } = {}) {
  const args = cliArgs(model);
  let dir = null;
  const workDir = () => dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'a37-planner-'));
  async function callModel(prompt) {
    if (typeof prompt !== 'string' || !prompt) throw new Error('prompt must be a non-empty string');
    const cwd = workDir();
    return new Promise((resolve, reject) => {
      let out = '', err = '', settled = false;
      const child = spawnImpl(command, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        done(reject, new Error(`model_cli_timeout:${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on('data', (d) => {
        out += d;
        if (out.length > MAX_OUTPUT) { try { child.kill(); } catch { /* gone */ } done(reject, new Error('model_cli_output_too_large')); }
      });
      child.stderr?.on('data', (d) => { if (err.length < 2000) err += d; });
      child.on('error', (e) => done(reject, new Error(`model_cli_spawn_failed:${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) return done(reject, new Error(`model_cli_exit_${code}:${err.trim().slice(0, 200)}`));
        try { done(resolve, parseCliOutput(out, model)); } catch (e) { done(reject, e); }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    });
  }
  callModel.close = () => { if (dir) { try { fs.rmdirSync(dir); } catch { /* not empty: leave it */ } dir = null; } };
  callModel.model = model;
  return callModel;
}
