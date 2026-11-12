import { hotbarSlotOf } from './craft.js';

const equipping = new WeakMap();

// Holds `name` in the main hand: a no-op when already held, a synchronous
// hotbar select when a copy sits in the hotbar, otherwise one bot.equip per
// bot at a time. Never throws; the apply loop calls this every tick.
export function equipItem(bot, name) {
  const slots = bot?.inventory?.slots;
  if (!slots || typeof name !== 'string') return;
  if (bot.heldItem?.name === name) return;
  const hotbar = hotbarSlotOf(bot, name);
  if (hotbar != null) { try { bot.setQuickBarSlot?.(hotbar); } catch {} return; }
  const item = (bot.inventory.items?.() ?? []).find((i) => i?.name === name);
  if (!item || typeof bot.equip !== 'function') return;
  let state = equipping.get(bot);
  if (!state) { state = { busy: false }; equipping.set(bot, state); }
  if (state.busy) return;
  state.busy = true;
  (async () => { await bot.equip(item, 'hand'); })()
    .catch(() => {})
    .finally(() => { state.busy = false; });
}
