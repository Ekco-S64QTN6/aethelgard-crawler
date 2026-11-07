// Save / load. Levels are rebuilt from the seed and then patched with their
// saved state (tiles, cells, faces, monsters, automap), so saves stay small.
import { buildLevel, computeLey } from './levelgen.js';

export const SAVE_KEY = 'aethelgard-crawler-save-v1';

function packLevel(lv) {
  return {
    tiles: Array.from(lv.tiles).join(''),
    seen: Array.from(lv.seen).join(''),
    cells: [...lv.cells.entries()],
    faces: [...lv.faces.entries()],
    monsters: lv.monsters.map(({ base, vx, vy, ...m }) => m),
    crystals: (lv.meta.crystals || []).map((c) => [...lv.faces.entries()].find(([, f]) => f === c)?.[0]).filter(Boolean),
  };
}

function unpackLevel(L, s, data, seed) {
  const lv = buildLevel(L, data, seed);
  for (let i = 0; i < lv.tiles.length; i++) { lv.tiles[i] = Number(s.tiles[i]); lv.seen[i] = Number(s.seen[i]); }
  lv.cells = new Map(s.cells);
  lv.faces = new Map(s.faces);
  lv.monsters = s.monsters.map((m) => ({ ...m, base: data.monsters[m.key] }));
  lv.meta.crystals = s.crystals.map((k) => lv.faces.get(k)).filter(Boolean);
  computeLey(lv, lv.meta.theme, L);
  return lv;
}

export function serialize(game) {
  const cond = (c) => Object.fromEntries(Object.entries(c.cond).map(([k, v]) => [k, v === Infinity ? -1 : v]));
  return JSON.stringify({
    v: 1, seed: game.seed, gold: game.gold, L: game.L, mode: game.mode === 'town' ? 'town' : 'dungeon',
    pos: [game.mover.x, game.mover.y, game.mover.dir], deepest: game.deepest, flags: game.flags,
    hand: game.hand,
    party: game.party.map((c) => ({ ...c, cond: cond(c), ready: 0 })),
    levels: [...game.levels.entries()].map(([L, lv]) => [L, packLevel(lv)]),
    savedAt: new Date().toISOString(),
  });
}

export function deserialize(game, json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (s.v !== 1) throw new Error('unknown save version');
  game.seed = s.seed;
  game.gold = s.gold;
  game.deepest = s.deepest;
  game.flags = s.flags;
  game.hand = s.hand;
  game.party = s.party.map((c) => ({ ...c, cond: Object.fromEntries(Object.entries(c.cond).map(([k, v]) => [k, v === -1 ? Infinity : v])) }));
  game.levels = new Map(s.levels.map(([L, p]) => [L, unpackLevel(L, p, game.data, s.seed)]));
  game.time = 0;
  if (s.mode === 'town' || !s.L) { game.goTown('You return to Oakhaven.'); return; }
  game.L = s.L;
  game.level = game.levels.get(s.L) || buildLevel(s.L, game.data, s.seed);
  game.levels.set(s.L, game.level);
  game.mover.place(s.pos[0], s.pos[1], s.pos[2]);
  game.mode = 'dungeon';
  game.emit('mode', 'dungeon');
  game.emit('ambient', game.level.meta.theme);
  game.log(`${game.level.meta.name}. You pick up where you left off.`, 'title');
}

export function saveToStorage(game) {
  try { localStorage.setItem(SAVE_KEY, serialize(game)); return true; } catch { return false; }
}

export function loadFromStorage() {
  try { return localStorage.getItem(SAVE_KEY); } catch { return null; }
}
