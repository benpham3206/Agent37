import path from 'node:path';

// The world seed and local folders stay out of this public repo; the local launchers set them.
export function evalSeed() {
  const seed = process.env.A37_EVAL_SEED;
  if (!/^-?\d+$/.test(seed ?? '')) throw new Error('eval_seed_unset');
  return seed;
}

export const resultsDir = (name) => path.resolve(process.env.A37_E2E_RESULTS ?? 'e2e-results', name);
