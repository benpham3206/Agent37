// B1: the action API contract. POST /api/action bodies are validated here
// before they reach the arbiter as source "skill". Unknown fields are rejected.
import { emptyAction } from './arbiter.js';

const SHAPE = emptyAction();
export const ACTION_FIELDS = Object.freeze([...Object.keys(SHAPE), 'inventory']);

export function validateAction(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'action must be a JSON object' };
  for (const [key, value] of Object.entries(body)) {
    if (!ACTION_FIELDS.includes(key)) return { error: `unknown action field: ${key}` };
    if (key === 'inventory') { if (value !== 'open' && value !== 'close') return { error: 'inventory must be "open" or "close"' }; continue; }
    if (key === 'hotbar') { if (!Number.isInteger(value) || value < 0 || value > 8) return { error: 'hotbar must be an integer 0-8' }; continue; }
    if (typeof SHAPE[key] === 'boolean' && typeof value !== 'boolean') return { error: `${key} must be a boolean` };
    if (typeof SHAPE[key] === 'number' && !Number.isFinite(value)) return { error: `${key} must be a finite number` };
  }
  const { inventory = null, ...action } = body;
  return { action, inventory };
}
