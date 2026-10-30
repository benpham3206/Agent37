// No files, clocks, or bot access: the same rows and settings give the same summary.
export function summarize(rows, settings = {}) {
  const totals = { successes: 0, failures: 0, timeouts: 0, human_interventions: 0 };
  const key = { success: 'successes', failure: 'failures', timeout: 'timeouts' };
  for (const row of rows) {
    if (!Object.hasOwn(key, row.outcome)) throw new Error('invalid trial outcome');
    if (!Number.isSafeInteger(row.human_interventions) || row.human_interventions < 0) {
      throw new Error('human_interventions must be a nonnegative integer');
    }
    // Help from a person cannot count as an independent success.
    totals[row.human_interventions > 0 ? 'failures' : key[row.outcome]]++;
    totals.human_interventions += row.human_interventions;
  }
  return {
    tested_version: settings.tested_version ?? null,
    test_settings: settings.test_settings ?? null,
    baseline: settings.baseline ?? null,
    trial_count: rows.length,
    ...totals,
    synthetic: settings.synthetic !== false || rows.some((row) => row.synthetic !== false),
    results_link: settings.results_link ?? null,
  };
}
