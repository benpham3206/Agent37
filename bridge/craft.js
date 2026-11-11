import { Vec3 } from 'vec3';

const requests = new WeakMap();

// The 2x2 inventory grid. Slot 0 is the result and is never a leftover.
const GRID_2X2 = [1, 2, 3, 4];
const MAX_EXTRA_CRAFTS = 3;

// IDs are retained for the bot's lifetime. A retry must use a fresh ID.
export function craftItem(bot, request) {
  let state = requests.get(bot);
  if (!state) { state = { busy: false, seen: new Set() }; requests.set(bot, state); }
  if (state.busy || state.seen.has(request.id)) return;
  state.seen.add(request.id);
  state.busy = true;
  return (async () => {
    let table = null;
    if (request.table) {
      const p = request.table, eye = bot.entity.position;
      if (Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y - 1.62, p.z + 0.5 - eye.z) > 4.5) return;
      table = bot.blockAt(new Vec3(p.x, p.y, p.z));
      if (table?.name !== 'crafting_table') return;
    }
    const item = bot.registry.itemsByName[request.name];
    if (!item) return;
    if (!bot.inventory || typeof bot._syncWindow !== 'function' || typeof bot.clickWindow !== 'function') {
      const recipe = bot.recipesFor(item.id, null, request.count, table)[0];
      if (!recipe) return;
      await bot.craft(recipe, Math.ceil(request.count / recipe.result.count), table);
      return;
    }
    // Window.count ignores the grid and cursor, so stranded materials must be
    // recovered before recipesFor can see them.
    try { await settle(bot); } catch { return; }
    const recipe = bot.recipesFor(item.id, null, request.count, table)[0];
    if (!recipe) return;
    const batches = Math.ceil(request.count / recipe.result.count);
    const before = bot.inventory.count(item.id, null);
    for (let crafts = 0; crafts < batches + MAX_EXTRA_CRAFTS; crafts++) {
      if (bot.inventory.count(item.id, null) - before >= request.count) break;
      let interrupted = false;
      try { await bot.craft(recipe, 1, table); } catch { interrupted = true; }
      // Without an authoritative resync there is no safe basis to continue.
      try { await settle(bot); } catch { return; }
      if (interrupted) return;
    }
  })().catch(() => {}).finally(() => { state.busy = false; });
}

// Full-window resync, grid/cursor recovery, then verify against server truth.
// Throws when the window cannot be confirmed clean, so callers stop crafting.
async function settle(bot) {
  await bot._syncWindow(bot.inventory);
  await clearWindow(bot);
  await bot._syncWindow(bot.inventory);
  const window = bot.inventory;
  if (window.selectedItem || GRID_2X2.some(s => window.slots[s])) {
    throw new Error('crafting grid or cursor not clean');
  }
}

// Returns crafting-grid and cursor items to the inventory. Never drops:
// when the inventory has no room the item stays where it was.
async function clearWindow(bot) {
  const window = bot.inventory;
  const start = window.inventoryStart, end = window.inventoryEnd;
  const stash = async () => {
    while (window.selectedItem) {
      const match = window.findItemRange(start, end, window.selectedItem.type, window.selectedItem.metadata, true, window.selectedItem.nbt);
      const slot = match && match.stackSize !== match.count ? match.slot : window.firstEmptySlotRange(start, end);
      if (slot === null) return false;
      await bot.clickWindow(slot, 0, 0);
    }
    return true;
  };
  // The cursor must be empty before a grid pickup so items cannot merge back.
  if (!(await stash())) return;
  for (const s of GRID_2X2) {
    if (!window.slots[s]) continue;
    if (window.selectedItem && !(await stash())) return;
    await bot.clickWindow(s, 0, 0);
    if (!(await stash())) {
      // Only put the item back into its own emptied or mergeable slot.
      const held = window.selectedItem, back = window.slots[s];
      const mergeable = held && back && back.type === held.type && back.count + held.count <= back.stackSize;
      if (!back || mergeable) await bot.clickWindow(s, 0, 0);
      return;
    }
  }
  await stash();
}

// Hotbar index (0-8) holding the named item, or null.
export function hotbarSlotOf(bot, name) {
  const slots = bot?.inventory?.slots;
  if (!slots) return null;
  for (let i = 0; i < 9; i++) if (slots[36 + i]?.name === name) return i;
  return null;
}
