// Fake world for B1 tests and the latency bench --ci mode. No Minecraft server.
// Bot at 0,64,0. iron_ore at 3,60,4 (distance about 6.4), lava 10 blocks away,
// water nearby, no obsidian, a zombie and a cow nearby, 3 iron_ingot in the inventory.
import { EventEmitter } from 'node:events';

export const BLOCKS = { iron_ore: { x: 3, y: 60, z: 4 }, lava: { x: 10, y: 64, z: 0 }, water: { x: -2, y: 63, z: 1 }, stone: { x: 0, y: 63, z: 0 }, diamond_ore: { x: 0, y: 40, z: 0 } };
const NAMES = ['iron_ore','deepslate_iron_ore','coal_ore','diamond_ore','deepslate_diamond_ore','stone','oak_log','lava','water','obsidian','crafting_table','furnace','nether_portal'];

export function fakeWorldBot({ blocks = BLOCKS, dimension = 'minecraft:overworld', timeOfDay = 6000 } = {}) {
  const bot = new EventEmitter();
  const blocksByName = Object.fromEntries(NAMES.map((name, id) => [name, { id, name }]));
  const byId = Object.fromEntries(NAMES.map((name, id) => [id, name]));
  bot._client = new EventEmitter();
  bot.registry = { blocksByName };
  bot.entity = { id: 1, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true };
  bot.health = 20; bot.food = 18;
  bot.game = { dimension, gameMode: 'survival' };
  bot.time = { timeOfDay };
  bot.entities = {
    1: bot.entity,
    2: { id: 2, type: 'hostile', name: 'zombie', position: { x: 5, y: 64, z: 0 } },
    3: { id: 3, type: 'animal', name: 'cow', position: { x: 0, y: 64, z: -8 } },
    4: { id: 4, type: 'hostile', name: 'skeleton', position: { x: 40, y: 64, z: 0 } },
  };
  bot.inventory = { items: () => [{ name: 'iron_ingot', count: 2 }, { name: 'iron_ingot', count: 1 }, { name: 'oak_log', count: 4 }], slots: [] };
  bot.findBlock = ({ matching, maxDistance }) => {
    const position = blocks[byId[matching]];
    if (!position) return null;
    const p = bot.entity.position;
    return Math.hypot(position.x - p.x, position.y - p.y, position.z - p.z) <= maxDistance ? { name: byId[matching], position } : null;
  };
  // Flat solid ground below y=64 so the skill terrain guard allows movement.
  bot.blockAt = (p) => (p.y < 64 ? { name: 'stone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p });
  bot.calls = [];
  bot.setControlState = (key, value) => { bot.calls.push(['control', key, value]); bot.emit('control', key, value); };
  bot.setQuickBarSlot = (slot) => { bot.calls.push(['hotbar', slot]); bot.emit('hotbar', slot); };
  bot.look = () => {}; bot.attack = () => {}; bot.activateItem = () => {}; bot.deactivateItem = () => {};
  bot.closeWindow = (w) => { bot.calls.push(['closeWindow', w]); bot.currentWindow = null; };
  bot.quit = () => {};
  return bot;
}
