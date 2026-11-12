// Plans the crafts needed to make one more of an item from an inventory.
// Pure: no bot, no network. Recipes come from minecraft-data for the game version.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataByVersion = new Map();
function gameData(version) {
  if (!dataByVersion.has(version)) dataByVersion.set(version, require('minecraft-data')(version));
  return dataByVersion.get(version);
}

// How many of each item id one craft uses, and whether it needs the 3x3 grid.
function shape(recipe) {
  const uses = new Map();
  const cells = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients;
  for (const id of cells) if (id != null) uses.set(id, (uses.get(id) ?? 0) + 1);
  const needsTable = Boolean(recipe.inShape) &&
    (recipe.inShape.length > 2 || recipe.inShape.some((row) => row.length > 2));
  return { uses, needsTable, makes: recipe.result.count };
}

// Returns the ordered steps, for example for wooden_pickaxe from 3 oak_log:
//   craft oak_planks, craft stick, craft crafting_table, place crafting_table, craft wooden_pickaxe.
// Each craft step is { action: 'craft', item, count, crafts, table, uses }, where count is
// how many items it makes and table says it needs a placed crafting table.
// Throws an error with code 'missing_materials' when the inventory cannot cover the chain.
export function recipeChain(itemName, inventory = {}, { version = '1.21.1', tableNearby = false, prefer = 'oak' } = {}) {
  const mc = gameData(version);
  const target = mc.itemsByName[itemName];
  if (!target) throw new Error(`unknown item: ${itemName}`);
  const name = (id) => mc.items[id].name;
  const held = (id) => (id === target.id ? 0 : Math.max(0, inventory[name(id)] ?? 0));
  const tableId = mc.itemsByName.crafting_table.id;

  // An item is makeable if we hold it or some recipe for it uses only makeable items.
  const makeableMemo = new Map();
  function makeable(id, visiting = new Set()) {
    if (held(id) > 0) return true;
    if (makeableMemo.has(id)) return makeableMemo.get(id);
    if (visiting.has(id)) return false;
    visiting.add(id);
    const ok = (mc.recipes[id] ?? []).some((r) => [...shape(r).uses.keys()].every((i) => makeable(i, visiting)));
    visiting.delete(id);
    makeableMemo.set(id, ok);
    return ok;
  }

  // Pick one recipe per item: all ingredients held, then all makeable, then any
  // (so the error names real raw materials). Ties go to the preferred wood, then file order.
  const chosen = new Map();
  function choose(id) {
    if (chosen.has(id)) return chosen.get(id);
    const options = (mc.recipes[id] ?? []).map((r, index) => {
      const s = shape(r), ids = [...s.uses.keys()];
      const score = ids.every((i) => held(i) >= s.uses.get(i)) ? 2 : ids.every((i) => makeable(i)) ? 1 : 0;
      const preferred = ids.some((i) => name(i).startsWith(`${prefer}_`)) ? 1 : 0;
      return { s, score, preferred, index };
    }).sort((a, b) => b.score - a.score || b.preferred - a.preferred || a.index - b.index);
    const pick = options[0]?.s ?? null;
    chosen.set(id, pick);
    return pick;
  }

  // Depth-first walk. Post-order lists ingredients before the items made from them.
  const needsPlacedTable = (s) => s?.needsTable && !tableNearby;
  const order = [], seen = new Set(), path = new Set();
  function visit(id) {
    if (seen.has(id)) return;
    if (path.has(id)) { chosen.set(id, null); return; } // a recipe cycle: treat as raw material
    path.add(id);
    const s = choose(id);
    if (s) {
      for (const i of s.uses.keys()) visit(i);
      if (needsPlacedTable(s)) visit(tableId);
    }
    path.delete(id);
    seen.add(id);
    order.push(id);
  }
  visit(target.id);

  // Walk from the target down, adding up demand. Every item comes before its ingredients.
  const demand = new Map([[target.id, 1]]);
  const steps = [], missing = [];
  let tableDemanded = false, tableStepNeeded = false;
  for (const id of [...order].reverse()) {
    const need = demand.get(id) ?? 0, short = need - held(id);
    if (short <= 0) continue;
    const s = chosen.get(id);
    if (!s) { missing.push({ item: name(id), need, have: held(id) }); continue; }
    const crafts = Math.ceil(short / s.makes);
    for (const [i, n] of s.uses) demand.set(i, (demand.get(i) ?? 0) + n * crafts);
    if (needsPlacedTable(s)) {
      tableStepNeeded = true;
      if (!tableDemanded) { demand.set(tableId, (demand.get(tableId) ?? 0) + 1); tableDemanded = true; }
    }
    steps.push({ action: 'craft', item: name(id), count: crafts * s.makes, crafts, table: s.needsTable,
      uses: Object.fromEntries([...s.uses].map(([i, n]) => [name(i), n * crafts])) });
  }
  if (missing.length) {
    const error = new Error(`missing materials for ${itemName}: ` +
      missing.map((m) => `need ${m.need} ${m.item}, have ${m.have}`).join('; '));
    error.code = 'missing_materials';
    error.missing = missing;
    throw error;
  }
  steps.reverse();
  // Place the table right before the first craft that needs it.
  if (tableStepNeeded) {
    const first = steps.findIndex((step) => step.table);
    steps.splice(first, 0, { action: 'place', item: 'crafting_table' });
  }
  return steps;
}
