// Lets a bot's own control page switch that one bot between creative and survival.
// Only two modes are allowed, the target is always the bridge's own username, and toggles are rate-limited.
export const ALLOWED_MODES = new Set(['creative', 'survival']);
const VALID_NAME = /^[A-Za-z0-9_]{1,16}$/;
export function createGamemodeSwitch({ username, run, minIntervalMs = 3000, now = Date.now } = {}) {
  const enabled = typeof run === 'function' && VALID_NAME.test(String(username ?? ''));
  let last = -Infinity, busy = false;
  return {
    enabled,
    async set(mode) {
      if (!enabled) return { ok: false, error: 'not_configured' };
      if (!ALLOWED_MODES.has(mode)) return { ok: false, error: 'invalid_mode' };
      const t = now(); if (busy || t - last < minIntervalMs) return { ok: false, error: 'rate_limited' };
      busy = true; last = t;
      try { await run(`gamemode ${mode} ${username}`); return { ok: true, mode }; }
      catch (err) { return { ok: false, error: String(err?.message ?? 'rcon_failed').replace(/[^a-z_]/g, '') || 'rcon_failed' }; }
      finally { busy = false; }
    },
  };
}
