// Monster instances: Kaiacord bestiary entries scaled to dungeon depth, plus
// their real-time AI (wander, hunt by BFS, attack on a per-monster timer).
import { DX, DY } from '../engine/grid.js';
import { hashStr } from '../core/rng.js';

// Attack interval (seconds) by Kaiacord tier.
const ATTACK_CD = { trivial: 2.8, easy: 2.6, medium: 2.4, hard: 2.2, deadly: 2.0, boss: 1.8 };
const MOVE_CD = { trivial: 1.3, easy: 1.25, medium: 1.2, hard: 1.15, deadly: 1.1, boss: 1.0 };
let nextId = 1;

// depth = overall level index (1..80). Kaiacord's Spine runs everything at
// difficulty 5 (1.6x) for level-15 characters; here the multiplier ramps from
// 0.5 at the surface to 1.6 at the Mountain Heart, with Kaiacord's floor caps.
export function scaleFor(depth) {
  return 0.5 + (1.1 * (Math.max(1, depth) - 1)) / 79;
}

export function makeMonster(data, key, x, y, depth, opts = {}) {
  const base = data.monsters[key];
  if (!base) throw new Error(`unknown monster ${key}`);
  const m = scaleFor(depth);
  const spineFloor = Math.max(1, depth - 3);
  const hpCap = 80 + spineFloor * 3;
  const atkCap = Math.min(12 + Math.floor(spineFloor / 5), 24);
  let hp = Math.max(4, Math.round(base.hp * m));
  // Attack ramps a little slower on the first floors, where a fresh party
  // fights in real time instead of Kaiacord's one exchange per command.
  let atk = Math.round(base.attack * Math.min(m, 0.35 + depth * 0.03));
  if (!opts.guardian) { hp = Math.min(hp, hpCap); atk = Math.min(atk, atkCap); }
  let def = base.defense;
  if (opts.guardian) {
    // spine_dungeon.scale_stair_guardian, eased for the full descent.
    hp = Math.max(hp + 1, Math.ceil(hpCap * 1.2 * Math.min(1, 0.35 + depth / 60)));
    atk = Math.max(atk + 2, Math.min(atkCap + 2, Math.round(atk * 1.2) + 2));
    // Kaiacord's stair guardians run DEF 20-29 against level-15 heroes; with a
    // whole descent to level through, they stay about 11 above the party's
    // expected attack bonus instead (roughly half of swings land).
    def = Math.max(def, Math.min(22, 12 + Math.floor(depth / 8)));
  }
  const h = hashStr(key);
  const hue = (h % 360) / 360;
  return {
    id: nextId++, key, name: opts.name || base.name, base, desc: base.desc,
    tier: base.tier, family: base.family,
    hp, maxHp: hp, atk, def,
    dmgScale: Math.min(1, 0.45 + depth * 0.035), // tier damage dice reach full strength ~16 levels down
    xp: Math.round(base.xp * (0.7 + depth / 30)),
    gold: Math.round((base.gold || 0) * (0.8 + depth / 40)),
    x, y, dir: 2, alive: true,
    guard: !!opts.guard, boss: !!opts.boss, guardian: !!opts.guardian,
    ward: opts.ward || 0,             // Resonance Ward: % of incoming damage absorbed
    atkCd: ATTACK_CD[base.tier] || 2.4, moveCd: MOVE_CD[base.tier] || 1.2,
    tAttack: 1.0 + (h % 100) / 100, tMove: (h % 70) / 100,
    held: 0, flash: 0, attackAnim: 0, awake: false,
    carries: opts.carries ? [...opts.carries] : [],
    variant: h,
    tint: [0.8 + 0.4 * Math.abs(Math.sin(hue * 6.28)), 0.8 + 0.4 * Math.abs(Math.sin(hue * 6.28 + 2)), 0.8 + 0.4 * Math.abs(Math.sin(hue * 6.28 + 4))],
  };
}

// Kaiacord rare_spawns: 1 spawn in 40 is a variant (Gilded, Elder, Resonant,
// or Pale between 18:00 and 06:00 local time). Whispering ones stay in the
// Whisperwood. Guardians and bosses are never variants.
export function maybeVariant(mon, data, rng, hour = new Date().getHours()) {
  if (mon.guardian || mon.boss || rng.int(data.dungeon.rare_one_in || 40) !== 0) return mon;
  const night = hour >= 18 || hour < 6;
  const pool = Object.entries(data.dungeon.rare_variants)
    .filter(([id, v]) => !(v.night_only && !night) && !(v.locations && !v.locations.includes('aeridor_ruins')))
    .map(([id]) => id);
  if (!pool.length) return mon;
  const id = rng.pick(pool);
  const v = data.dungeon.rare_variants[id];
  mon.rare = id;
  mon.name = `${v.prefix} ${mon.name}`;
  mon.hp = mon.maxHp = Math.round(mon.hp * v.hp);
  mon.xp = Math.round(mon.xp * v.xp);
  mon.gold = Math.round(mon.gold * v.gold);
  mon.rareDrop = v.drop;
  mon.desc = `${v.desc} ${mon.desc}`;
  mon.tint = id === 'gilded' ? [1.4, 1.15, 0.5] : id === 'pale' ? [1.2, 1.2, 1.25] : id === 'resonant' ? [0.7, 1.2, 1.4] : [0.9, 1.1, 0.8];
  return mon;
}

export function isUndead(mon, undeadNames) {
  if (mon.family === 'undead') return true;
  const n = mon.name.toLowerCase();
  return undeadNames.some((u) => n.includes(u));
}

// Natural creatures (for Tree Memory): not undead, not constructs.
export function isNatural(mon) {
  return !['undead', 'construct', 'elemental', 'demon', 'horror'].includes(mon.family);
}

// One AI tick for every monster. `game` supplies party position, level, and
// the attack callback. Movement uses the same collision check as the party.
export function updateMonsters(game, dt) {
  const L = game.level;
  const P = game.mover;
  let dist = null; // lazily computed BFS from the party
  for (const m of L.monsters) {
    if (!m.alive) continue;
    m.flash = Math.max(0, m.flash - dt * 4);
    m.attackAnim = Math.max(0, m.attackAnim - dt);
    if (m.held > 0) { m.held -= dt; continue; }
    m.tAttack -= dt;
    m.tMove -= dt;
    const adx = P.x - m.x, ady = P.y - m.y;
    const adjacent = Math.abs(adx) + Math.abs(ady) === 1;
    if (adjacent) {
      m.awake = true;
      m.dir = adx === 1 ? 1 : adx === -1 ? 3 : ady === 1 ? 2 : 0;
      if (m.tAttack <= 0) {
        m.tAttack = m.atkCd;
        m.attackAnim = 0.35;
        game.monsterAttacks(m);
      }
      continue;
    }
    if (m.guard || m.guardian) continue; // guards hold their room
    if (m.tMove > 0) continue;
    m.tMove = m.moveCd;
    if (!dist) dist = L.bfs(P.x, P.y, (x, y) => !L.isSolid(x, y) && !L.barrierAt(x, y) && !L.cell(x, y)?.stairs);
    const here = dist[L.idx(m.x, m.y)];
    if (here < 0) { m.awake = false; continue; }
    if (here <= 6) m.awake = true;
    if (!m.awake || here > 9) {
      if (game.rng.next() < 0.25) wander(game, m);
      continue;
    }
    // Step to the neighbour with the smallest distance to the party.
    let best = null, bestD = here;
    for (let d = 0; d < 4; d++) {
      const nx = m.x + DX[d], ny = m.y + DY[d];
      if (!L.inBounds(nx, ny)) continue;
      const nd = dist[L.idx(nx, ny)];
      if (nd < 0 || nd >= bestD) continue;
      if (nx === P.x && ny === P.y) continue;
      if (!L.passable(nx, ny) || L.cell(nx, ny)?.stairs) continue;
      best = [nx, ny, d]; bestD = nd;
    }
    if (best) { m.x = best[0]; m.y = best[1]; m.dir = best[2]; game.onMonsterMoved(m); }
  }
}

function wander(game, m) {
  const L = game.level;
  const d = game.rng.int(4);
  const nx = m.x + DX[d], ny = m.y + DY[d];
  if (L.passable(nx, ny) && !L.cell(nx, ny)?.stairs && !(nx === game.mover.x && ny === game.mover.y)) {
    m.x = nx; m.y = ny; m.dir = d;
    game.onMonsterMoved(m);
  }
}
