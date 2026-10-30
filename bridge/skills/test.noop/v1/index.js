// Test-only skill. A passing result checks the harness, not Minecraft ability.
export async function run(bot, input, { signal }) {
  signal.throwIfAborted();
  const started = performance.now();
  const before = bot.observe();
  return {
    outcome: 'success', reason: 'noop_complete', elapsed_ms: performance.now() - started,
    before, after: bot.observe(),
  };
}
