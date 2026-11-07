// Builds playable levels.
//
// Levels 1-3 are the Shattered Spires (the Aeridor Ruins), generated the way
// Kaiacord's dungeon.py does it: 9-12 rooms on a lattice, weighted room types,
// a boss at the farthest room, a guaranteed shrine. Levels 4-80 are the 77
// hand-made floors of the Ironvein Deep beneath the Spine of the World
// (Kaiacord spine_layouts.json), converted from their cell graph to a block map:
// cell (x, y) becomes block (2x+1, 2y+1) and every link opens the block between.
//
// On top of either layout, a seeded feature pass places the dungeon furniture
// from Dungeon Hack's feature taxonomy: doors, locked doors + keys, portcullis
// + lever, button-opened secret niches, pressure-plate traps, stairs, chests,
// shrines, Ley crystals, inscriptions and sconces. Puzzles sit on chokepoints of
// the route to the down stairs and their controls are always placed on the
// near side, so every floor is solvable (tests/levels.test.mjs checks all 80).
import { Level, DX, DY, ckey, fkey } from '../engine/grid.js';
import { Rng, hashStr } from '../core/rng.js';
import { makeMonster, maybeVariant } from './monsters.js';
import { THEME_KEY } from './items.js';

export const RUINS_FLOORS = 3;
export const SPINE_FLOORS = 77;
export const TOTAL_LEVELS = RUINS_FLOORS + SPINE_FLOORS;

const RUINS_NAMES = ['The Shattered Spires: Upper Galleries', 'The Shattered Spires: Crystal Vaults', 'The Shattered Spires: Sealed Antechamber'];
const RUINS_FLAVOR = 'The white spires of Aeridor, toppled and swallowed by the earth. Walls at angles that should not hold. Crystal formations absorb the light. The ground hums.';
const RUINS_ROOMS = [
  ['Hall of Tuning', 'Rows of crystal forks, each tuned to a note no one has struck in a thousand years.'],
  ['Crystal Gallery', 'The crystal here drinks your torchlight. The far wall is darker than it should be.'],
  ['Collapsed Spire Base', 'Marble the colour of old teeth, split by roots as thick as a man.'],
  ['Archive of Designations', 'Shelves of crystal slates. Some still glow when you pass. They are reading you.'],
  ['Resonance Depot', "Empty racks shaped for shards. Hemlock would know what this room was for."],
  ['Choir Vault', 'A domed room. Your footsteps come back a half-second late, and slightly wrong.'],
  ['Lantern Walk', 'Niches for lanterns line the walls. A few are still lit. Nobody lit them.'],
  ['Root-Split Atrium', 'The Whisperwood got in here. The roots have opinions about where you walk.'],
  ['Hall of Class Records', 'Carved columns list names and designations. Some of the carvings are recent.'],
  ['Cistern of Echoes', 'Black water, perfectly still. It hums at the same pitch as the floor.'],
];

export const THEMES = ['aeridor', 'tunnels', 'bones', 'forge', 'deep', 'heart'];
const LEY_BASE = { aeridor: 0.12, tunnels: 0.04, bones: 0.08, forge: 0.14, deep: 0.22, heart: 0.32 };
const CRYSTALS = { aeridor: [3, 5], tunnels: [1, 2], bones: [2, 3], forge: [2, 3], deep: [3, 4], heart: [4, 6] };
const DOOR_TEX = { aeridor: 'door_aeridor', tunnels: 'door_wood', bones: 'door_wood', forge: 'door_iron', deep: 'door_iron', heart: 'door_iron' };
const BAND_LORE_ITEM = { tunnels: 'shift_log_page', bones: 'burial_offering', forge: 'forge_manifest', deep: 'deep_fragment', heart: 'mountain_shard' };

export function themeForSpine(f) {
  if (f <= 15) return 'tunnels';
  if (f <= 30) return 'bones';
  if (f <= 45) return 'forge';
  if (f <= 60) return 'deep';
  return 'heart';
}

export function levelInfo(L, data) {
  if (L <= RUINS_FLOORS) {
    return { L, kind: 'ruins', floor: L, theme: 'aeridor', name: RUINS_NAMES[L - 1], flavor: RUINS_FLAVOR };
  }
  const f = L - RUINS_FLOORS;
  const fl = data.spine.floors[String(f)];
  return { L, kind: 'spine', floor: f, theme: themeForSpine(f), name: `Ironvein Deep ${f}: ${fl.name}`, flavor: fl.flavor };
}

export function lootTier(L) {
  if (L === 1) return 'trivial';
  if (L <= 3) return 'easy';
  const f = L - RUINS_FLOORS;
  if (f <= 8) return 'medium';
  if (f <= 25) return 'hard';
  if (f <= 55) return 'deadly';
  return 'boss';
}

// ── Layout plans ────────────────────────────────────────────────────────────
function planFromSpine(fl) {
  const G = fl.grid, W = 2 * G + 1;
  const open = new Uint8Array(W * W);
  const spots = [];
  const roomOf = new Map();
  const entrances = [];
  const B = (k) => { const [x, y] = k.split(',').map(Number); return [2 * x + 1, 2 * y + 1]; };
  const setOpen = (x, y) => { open[y * W + x] = 1; };
  for (const [k, r] of Object.entries(fl.rooms)) {
    const [bx, by] = B(k);
    setOpen(bx, by);
    spots.push({ x: bx, y: by, type: r.type, monster: r.monster_key || null, bossName: r.boss_name || null });
    if (r.room_name) roomOf.set(ckey(bx, by), { name: r.room_name, desc: r.description || '' });
  }
  const DIRS = 'NESW';
  for (const [k, dirs] of Object.entries(fl.links)) {
    if (!fl.rooms[k]) continue;
    const [cx, cy] = k.split(',').map(Number);
    const [bx, by] = B(k);
    for (const ch of dirs) {
      const d = DIRS.indexOf(ch);
      const nk = `${cx + DX[d]},${cy + DY[d]}`;
      if (!fl.rooms[nk]) continue;
      const jx = bx + DX[d], jy = by + DY[d];
      if (open[jy * W + jx]) continue;
      setOpen(jx, jy);
      const a = fl.rooms[k], b = fl.rooms[nk];
      if ((a.is_room || b.is_room) && (a.label !== b.label || !a.is_room || !b.is_room)) {
        entrances.push({ x: jx, y: jy, axis: d === 1 || d === 3 ? 'y' : 'x' });
      }
      if (a.is_room && b.is_room && a.label === b.label && roomOf.has(ckey(bx, by))) roomOf.set(ckey(jx, jy), roomOf.get(ckey(bx, by)));
    }
  }
  // Fill the corner block of every 2x2 group of cells that belong to one room
  // and are all linked, so multi-cell rooms become open halls, not pillar grids.
  const linked = (a, d) => (fl.links[a] || []).includes(DIRS[d]);
  for (let cy = 0; cy < G - 1; cy++) {
    for (let cx = 0; cx < G - 1; cx++) {
      const a = `${cx},${cy}`, b = `${cx + 1},${cy}`, c = `${cx},${cy + 1}`, d = `${cx + 1},${cy + 1}`;
      const rs = [a, b, c, d].map((k) => fl.rooms[k]);
      if (rs.some((r) => !r || !r.is_room || !r.label) || new Set(rs.map((r) => r.label)).size !== 1) continue;
      if (linked(a, 1) && linked(a, 2) && linked(d, 3) && linked(d, 0)) {
        setOpen(2 * cx + 2, 2 * cy + 2);
        if (roomOf.has(ckey(2 * cx + 1, 2 * cy + 1))) roomOf.set(ckey(2 * cx + 2, 2 * cy + 2), roomOf.get(ckey(2 * cx + 1, 2 * cy + 1)));
      }
    }
  }
  return { W, H: W, open, spots, roomOf, entrances, up: B(fl.up), down: fl.down ? B(fl.down) : null };
}

function planRuins(floor, rng, data) {
  const GRID = 6, PITCH = 4, W = 1 + GRID * PITCH;
  const open = new Uint8Array(W * W);
  const placed = new Map();
  const edges = new Set();
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const nRooms = rng.range(9, 12);
  const s = [rng.int(GRID), rng.int(GRID)];
  placed.set(`${s[0]},${s[1]}`, s);
  let guard = 0;
  while (placed.size < nRooms && guard++ < 5000) {
    const [gx, gy] = rng.pick([...placed.values()]);
    const d = rng.int(4);
    const nx = gx + DX[d], ny = gy + DY[d];
    if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
    const k = `${nx},${ny}`;
    if (!placed.has(k)) { placed.set(k, [nx, ny]); edges.add(ek(`${gx},${gy}`, k)); }
  }
  for (const [k, [gx, gy]] of placed) {
    for (const d of [1, 2]) {
      const nk = `${gx + DX[d]},${gy + DY[d]}`;
      if (placed.has(nk) && !edges.has(ek(k, nk)) && rng.chance(0.25)) edges.add(ek(k, nk));
    }
  }
  const org = (gx, gy) => [1 + gx * PITCH, 1 + gy * PITCH];
  const roomOf = new Map();
  const names = rng.shuffle([...RUINS_ROOMS]);
  let ni = 0;
  for (const [k, [gx, gy]] of placed) {
    const [ox, oy] = org(gx, gy);
    const nm = names[ni++ % names.length];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      open[(oy + y) * W + ox + x] = 1;
      roomOf.set(ckey(ox + x, oy + y), { name: nm[0], desc: nm[1] });
    }
  }
  const entrances = [];
  for (const e of edges) {
    const [a, b] = e.split('|').map((k) => k.split(',').map(Number));
    const [ox, oy] = org(Math.min(a[0], b[0]), Math.min(a[1], b[1]));
    if (a[1] === b[1]) { open[(oy + 1) * W + ox + 3] = 1; entrances.push({ x: ox + 3, y: oy + 1, axis: 'y' }); }
    else { open[(oy + 3) * W + ox + 1] = 1; entrances.push({ x: ox + 1, y: oy + 3, axis: 'x' }); }
  }
  // Farthest room from the start over the room graph.
  const adj = new Map([...placed.keys()].map((k) => [k, []]));
  for (const e of edges) { const [a, b] = e.split('|'); adj.get(a).push(b); adj.get(b).push(a); }
  const sk = `${s[0]},${s[1]}`;
  const dist = new Map([[sk, 0]]);
  const q = [sk];
  while (q.length) { const c = q.shift(); for (const n of adj.get(c)) if (!dist.has(n)) { dist.set(n, dist.get(c) + 1); q.push(n); } }
  const far = [...dist.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // Kaiacord dungeon themes: one theme per dungeon, weighted for the ruins.
  const themeKey = rng.weighted(data.dungeon.location_theme_weights.aeridor_ruins);
  const theme = data.dungeon.themes[themeKey];
  const pool = theme.pools[String(Math.min(5, floor))];
  const bossPool = theme.boss_pools[String(Math.min(5, floor))];
  const bossName = `${rng.pick(data.dungeon.boss_prefixes)} ${rng.pick(data.dungeon.boss_titles)} ${rng.pick(data.dungeon.boss_suffixes)}`;
  const spots = [];
  const weights = [['empty', 18], ['monster', 45], ['treasure', 15], ['shrine', 8], ['trap', 14]];
  let hasShrine = false;
  const rooms = [...placed.entries()];
  for (const [k, [gx, gy]] of rooms) {
    const [ox, oy] = org(gx, gy);
    const cx = ox + 1, cy = oy + 1;
    if (k === sk) { spots.push({ x: cx, y: cy, type: 'stairs_up' }); continue; }
    if (k === far) { spots.push({ x: cx, y: cy, type: 'stairs_down' }); continue; }
    let t = rng.weighted(weights);
    if (t === 'shrine') hasShrine = true;
    const bx = ox + rng.int(3), by = oy + rng.int(3);
    if (t === 'monster') {
      spots.push({ x: bx, y: by, type: 'monster', monster: rng.pick(pool) });
      if (floor >= 2 && rng.chance(0.35)) {
        const x2 = ox + rng.int(3), y2 = oy + rng.int(3);
        if (x2 !== bx || y2 !== by) spots.push({ x: x2, y: y2, type: 'monster', monster: rng.pick(pool) });
      }
    } else spots.push({ x: t === 'trap' ? bx : cx, y: t === 'trap' ? by : cy, type: t });
  }
  if (!hasShrine) {
    const e = spots.find((s) => s.type === 'empty') || spots.find((s) => s.type === 'treasure');
    if (e) e.type = 'shrine';
  }
  return {
    W, H: W, open, spots, roomOf, entrances,
    up: org(...s).map((v) => v + 1), down: org(...placed.get(far)).map((v) => v + 1),
    boss: { key: rng.pick(bossPool), name: bossName }, themeName: theme.name,
  };
}

// ── Feature pass ────────────────────────────────────────────────────────────
export function buildLevel(L, data, seed = 1) {
  const info = levelInfo(L, data);
  const rng = new Rng(hashStr(`aethelgard:${seed}:${L}`));
  const plan = info.kind === 'ruins'
    ? planRuins(info.floor, rng, data)
    : planFromSpine(data.spine.floors[String(info.floor)]);
  const lv = new Level(plan.W, plan.H);
  for (let i = 0; i < plan.open.length; i++) if (plan.open[i]) lv.tiles[i] = 0;
  lv.meta = { ...info, rooms: plan.roomOf, seed };
  const used = new Set(); // blocks that already carry something
  const usedFaces = new Set();
  const theme = info.theme;
  const isFinal = L === TOTAL_LEVELS;

  // Stairs sit in a wall alcove beside the cell the layout names, so they never
  // cut a corridor in two; the party starts in front of the up stairs.
  let downCell = plan.down;
  if (!downCell && !isFinal) {
    // Floors 61-76 carry no stairs cell in the source data: the way down is the
    // farthest room from the up stairs.
    const distUp = lv.bfs(plan.up[0], plan.up[1]);
    let best = -1;
    for (const s of plan.spots) {
      const d = distUp[lv.idx(s.x, s.y)];
      if (d > best && s.type !== 'stairs_up') { best = d; downCell = [s.x, s.y]; }
    }
  }
  const upA = stairsAlcove(lv, plan.up[0], plan.up[1]);
  lv.setOpen(upA.sx, upA.sy);
  lv.ensureCell(upA.sx, upA.sy).stairs = 'up';
  const start = { x: upA.fx, y: upA.fy, dir: (upA.d + 2) & 3 };
  used.add(ckey(upA.sx, upA.sy));
  used.add(ckey(start.x, start.y));
  let down = null, downFront = null;
  if (downCell) {
    const a = stairsAlcove(lv, downCell[0], downCell[1], [upA.sx, upA.sy]);
    lv.setOpen(a.sx, a.sy);
    lv.ensureCell(a.sx, a.sy).stairs = 'down';
    down = [a.sx, a.sy];
    downFront = [a.fx, a.fy];
    used.add(ckey(a.sx, a.sy));
  }
  lv.meta.start = start;
  lv.meta.down = down;

  // Route and the guardian's post: the open neighbour of the down stairs that
  // is nearest the start (Kaiacord: a floor's stair guardian guards the way down).
  const passAll = (x, y) => !lv.isSolid(x, y) && !lv.cell(x, y)?.stairs;
  const fromStart = lv.bfs(start.x, start.y, passAll);
  let post = null;
  if (down) {
    post = downFront;
  } else {
    let bd = -1;
    for (const s of plan.spots) { const d = fromStart[lv.idx(s.x, s.y)]; if (d > bd) { bd = d; post = [s.x, s.y]; } }
  }

  // Monsters from the layout.
  const depth = L;
  for (const s of plan.spots) {
    if (!s.monster || !data.monsters[s.monster]) continue;
    if (used.has(ckey(s.x, s.y))) continue;
    if (post && s.x === post[0] && s.y === post[1]) continue;
    lv.monsters.push(maybeVariant(makeMonster(data, s.monster, s.x, s.y, depth, { guard: s.type === 'guard', boss: s.type === 'boss', name: s.bossName || undefined }), data, rng, 12));
    used.add(ckey(s.x, s.y));
  }
  // Stair guardian / ruins boss / the Mountain Heart.
  if (post) {
    let gk, gname;
    if (info.kind === 'spine') gk = data.spine.stair_guardians[String(info.floor)];
    else { gk = plan.boss.key; gname = plan.boss.name; }
    if (gk && data.monsters[gk]) {
      const band = info.kind === 'spine' ? 1 + [15, 30, 45, 60, 75].filter((m) => info.floor >= m).length : 1;
      const g = makeMonster(data, gk, post[0], post[1], depth, { guardian: true, name: gname, ward: Math.min(25, (band - 1) * 5) });
      g.post = true;
      lv.monsters.push(g);
      lv.meta.guardianId = g.id;
      if (isFinal) lv.meta.finalBossId = g.id;
      used.add(ckey(post[0], post[1]));
    }
  }

  // Wanderers from Kaiacord's per-band Spine encounter tables.
  if (info.kind === 'spine') {
    const BAND_TABLE = { tunnels: 'working_tunnels', bones: 'bone_warrens', forge: 'sunken_forge', deep: 'deep_dark', heart: 'heart_of_mountain' };
    const table = data.dungeon.encounter_tables.aeridor_ruins[BAND_TABLE[theme]];
    const reachAll = lv.bfs(start.x, start.y, passAll);
    for (let i = 0, n = rng.range(3, 6); i < n && table; i++) {
      const s = farSpot(lv, rng, reachAll, used, 6);
      const key = rng.weighted(table);
      if (!s || !data.monsters[key]) continue;
      lv.monsters.push(maybeVariant(makeMonster(data, key, s.x, s.y, depth), data, rng, 12));
      used.add(ckey(s.x, s.y));
    }
  }

  // Chests, traps, shrines from the layout.
  const shrineFace = (sx, sy) => findFace(lv, rng, sx, sy, usedFaces, 2);
  for (const s of plan.spots) {
    const k = ckey(s.x, s.y);
    if (s.type === 'treasure' && !used.has(k)) {
      lv.ensureCell(s.x, s.y).chest = { opened: false, tier: lootTier(L), extra: [] };
      used.add(k);
    } else if (s.type === 'trap' && !used.has(k)) {
      lv.ensureCell(s.x, s.y).plate = { kind: 'trap', armed: true, dmg: 1 + Math.floor(L / 12), hidden: false };
      used.add(k);
    } else if (s.type === 'shrine') {
      const f = shrineFace(s.x, s.y);
      if (f) {
        const sealed = rng.chance(0.5);
        lv.setFace(f.x, f.y, f.d, { kind: 'shrine', sealed, used: false, opened: false, tex: sealed ? 'seal_sealed' : 'seal_awake' });
      }
    }
  }

  // ── Puzzles on the route ────────────────────────────────────────────────
  const route = post ? pathTo(lv, start, post, passAll) : [];
  const keyItem = THEME_KEY[theme];
  const doorTex = DOOR_TEX[theme];
  let gateAt = null, doorAt = null;
  if (route.length > 10) {
    gateAt = chokepoint(lv, route, start, post, used, rng, 0.3, 0.55);
    if (gateAt) {
      lv.ensureCell(gateAt.x, gateAt.y).gate = { open: 0, target: 0, axis: gateAt.axis, tex: 'portcullis' };
      used.add(ckey(gateAt.x, gateAt.y));
      const region = lv.bfs(start.x, start.y, (x, y) => passAll(x, y) && !(x === gateAt.x && y === gateAt.y));
      const f = findFaceInRegion(lv, rng, region, usedFaces, start);
      if (f) lv.setFace(f.x, f.y, f.d, { kind: 'lever', on: false, tex: 'lever_up', target: ckey(gateAt.x, gateAt.y) });
      else { lv.cell(gateAt.x, gateAt.y).gate = null; gateAt = null; }
    }
    doorAt = chokepoint(lv, route, start, post, used, rng, 0.6, 0.9);
    if (doorAt) {
      const c = lv.ensureCell(doorAt.x, doorAt.y);
      c.door = { open: 0, target: 0, axis: doorAt.axis, tex: doorTex, locked: true, key: keyItem, deco: 'keyhole' };
      used.add(ckey(doorAt.x, doorAt.y));
      // The key: carried by a monster on the near side, or left on the floor.
      const region = lv.bfs(start.x, start.y, (x, y) => passAll(x, y) && !(x === doorAt.x && y === doorAt.y));
      const holders = lv.monsters.filter((m) => !m.guardian && region[lv.idx(m.x, m.y)] > 2);
      if (holders.length && rng.chance(0.6)) rng.pick(holders).carries.push(keyItem);
      else {
        const spot = farSpot(lv, rng, region, used, 3) || start;
        lv.ensureCell(spot.x, spot.y).items.push({ key: keyItem, n: 1 });
      }
    }
  }

  // Ordinary doors at room entrances (closed, unlocked).
  for (const e of plan.entrances) {
    const k = ckey(e.x, e.y);
    if (used.has(k) || !rng.chance(0.3)) continue;
    const nb = lv.openNeighbors(e.x, e.y);
    if (nb.length !== 2 || (nb[0][2] + 2) % 4 !== nb[1][2]) continue;
    if (nb.some(([x, y]) => (x === start.x && y === start.y) || lv.cell(x, y)?.stairs)) continue;
    lv.ensureCell(e.x, e.y).door = { open: 0, target: 0, axis: e.axis, tex: doorTex, locked: false };
    used.add(k);
  }

  // Secret niches behind false walls, opened by a wall button.
  const regionNear = lv.bfs(start.x, start.y, (x, y) => passAll(x, y) && !(gateAt && x === gateAt.x && y === gateAt.y));
  const niches = [];
  const nNiche = 1 + (rng.chance(0.5) ? 1 : 0);
  for (let i = 0; i < nNiche; i++) {
    const n = findNiche(lv, rng, regionNear, usedFaces, used);
    if (!n) break;
    lv.setFace(n.bx, n.by, n.bd, { kind: 'button', on: false, tex: 'button_off', opens: ckey(n.sx, n.sy) });
    const c = lv.ensureCell(n.sx, n.sy);
    c.secret = { items: [] };
    niches.push(c.secret);
    used.add(ckey(n.sx, n.sy));
    used.add(ckey(n.ax, n.ay));
  }

  // Ley-line fractures: Aeridorian crystal on the walls.
  const [cmin, cmax] = CRYSTALS[theme];
  const nCrystal = rng.range(cmin, cmax);
  const allRegion = lv.bfs(start.x, start.y, passAll);
  lv.meta.crystals = [];
  for (let i = 0; i < nCrystal; i++) {
    const f = findFaceInRegion(lv, rng, allRegion, usedFaces, null, 1);
    if (!f) break;
    const strength = 0.35 + rng.next() * 0.45 + L / 160;
    const deco = lv.setFace(f.x, f.y, f.d, { kind: 'crystal', strength, sealed: false, tex: 'crystal', ax: f.ax, ay: f.ay });
    lv.meta.crystals.push(deco);
  }

  // Inscriptions and sconces.
  const echoes = inscriptionPool(data, info);
  for (let i = 0, n = rng.range(1, 3); i < n; i++) {
    const f = findFaceInRegion(lv, rng, allRegion, usedFaces, null, 1);
    if (f) lv.setFace(f.x, f.y, f.d, { kind: 'inscription', tex: 'inscription', text: rng.pick(echoes) });
  }
  for (let i = 0, n = rng.range(4, 9); i < n; i++) {
    const f = findFaceInRegion(lv, rng, allRegion, usedFaces, null, 1);
    if (f) lv.setFace(f.x, f.y, f.d, { kind: 'sconce', tex: 'sconce' });
  }

  // Loose loot, a band lore item, and this level's share of the Lore Codex.
  const tier = lootTier(L);
  for (let i = 0, n = rng.range(1, 3); i < n; i++) {
    const it = rollLoot(data.items.loot.consumable, tier, rng);
    const spot = farSpot(lv, rng, allRegion, used, 1);
    if (it && spot) lv.ensureCell(spot.x, spot.y).items.push({ key: it, n: 1 });
  }
  const chests = [...lv.cells.values()].filter((c) => c.chest);
  const stash = (key) => {
    if (niches.length) niches[rng.int(niches.length)].items.push({ key, n: 1 });
    else if (chests.length) rng.pick(chests).chest.extra.push(key);
    else { const s = farSpot(lv, rng, allRegion, used, 2); if (s) lv.ensureCell(s.x, s.y).items.push({ key, n: 1 }); }
  };
  for (const page of pagesForLevel(data, L)) stash(`lore:${page}`);
  if (info.kind === 'spine' && BAND_LORE_ITEM[theme] && info.floor % 5 === 3) stash(BAND_LORE_ITEM[theme]);
  if (isFinal) stash('spine_memory');
  for (const n of niches) if (!n.items.length) n.items.push({ key: rollLoot(data.items.loot.gear, tier, rng) || 'aeridor_shard', n: 1 });

  computeLey(lv, theme, L);
  return lv;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// A solid block next to (cx, cy) or a nearby open block whose only open
// neighbour is that block: carving stairs there leaves every route intact.
// Returns { sx, sy } (stairs) and { fx, fy } (the block in front), d = the
// direction from the front block to the stairs.
function stairsAlcove(lv, cx, cy, avoid = null) {
  let best = null;
  const near = (x, y) => avoid && Math.abs(x - avoid[0]) + Math.abs(y - avoid[1]) <= 2;
  for (let r = 0; r <= 3 && !best; r++) {
    for (let fy = cy - r; fy <= cy + r; fy++) for (let fx = cx - r; fx <= cx + r; fx++) {
      if (Math.abs(fx - cx) + Math.abs(fy - cy) !== r || lv.isSolid(fx, fy) || lv.cell(fx, fy)?.stairs) continue;
      for (let d = 0; d < 4; d++) {
        const sx = fx + DX[d], sy = fy + DY[d];
        if (sx <= 0 || sy <= 0 || sx >= lv.w - 1 || sy >= lv.h - 1 || !lv.isSolid(sx, sy) || near(sx, sy)) continue;
        if (lv.openNeighbors(sx, sy).length !== 1) continue;
        if (!best) best = { sx, sy, fx, fy, d };
      }
    }
  }
  if (best) return best;
  // Fallback: the named cell itself, entered from any open neighbour.
  const [fx, fy, d0] = lv.openNeighbors(cx, cy)[0];
  return { sx: cx, sy: cy, fx, fy, d: (d0 + 2) & 3 };
}

function pathTo(lv, start, goal, through) {
  const dist = lv.bfs(goal[0], goal[1], through);
  const path = [[start.x, start.y]];
  let [x, y] = [start.x, start.y];
  if (dist[lv.idx(x, y)] < 0) return [];
  while (!(x === goal[0] && y === goal[1])) {
    let moved = false;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (lv.inBounds(nx, ny) && dist[lv.idx(nx, ny)] === dist[lv.idx(x, y)] - 1) { x = nx; y = ny; path.push([x, y]); moved = true; break; }
    }
    if (!moved) break;
  }
  return path;
}

// A straight one-wide corridor block on the route whose closure cuts the start
// off from the goal: a natural place for a gate or a locked door.
function chokepoint(lv, route, start, goal, used, rng, lo, hi) {
  const cands = [];
  for (let i = Math.floor(route.length * lo); i < Math.floor(route.length * hi); i++) {
    const [x, y] = route[i];
    if (used.has(ckey(x, y)) || lv.monsterAt(x, y)) continue;
    const c = lv.cell(x, y);
    if (c && (c.items.length || c.plate || c.chest || c.stairs)) continue;
    const nb = lv.openNeighbors(x, y);
    if (nb.length !== 2 || (nb[0][2] + 2) % 4 !== nb[1][2]) continue;
    const cut = lv.bfs(start.x, start.y, (cx, cy) => !lv.isSolid(cx, cy) && !lv.cell(cx, cy)?.stairs && !(cx === x && cy === y));
    if (cut[lv.idx(goal[0], goal[1])] >= 0) continue;
    cands.push({ x, y, axis: nb[0][2] === 1 || nb[0][2] === 3 ? 'y' : 'x' });
  }
  return cands.length ? rng.pick(cands) : null;
}

function faceFree(lv, x, y, d, usedFaces) {
  return lv.isSolid(x, y) && !usedFaces.has(fkey(x, y, d)) && x > 0 && y > 0 && x < lv.w - 1 && y < lv.h - 1;
}

function markFace(usedFaces, x, y, d) { usedFaces.add(fkey(x, y, d)); }

// A wall face visible from open block (ax, ay), within `radius` blocks of (sx, sy).
function findFace(lv, rng, sx, sy, usedFaces, radius) {
  const opts = [];
  for (let ay = sy - radius; ay <= sy + radius; ay++) for (let ax = sx - radius; ax <= sx + radius; ax++) {
    if (!lv.inBounds(ax, ay) || lv.isSolid(ax, ay) || lv.cell(ax, ay)?.stairs) continue;
    for (let d = 0; d < 4; d++) {
      const wx = ax + DX[d], wy = ay + DY[d];
      const fd = (d + 2) & 3;
      if (faceFree(lv, wx, wy, fd, usedFaces)) opts.push({ x: wx, y: wy, d: fd, ax, ay, r: Math.abs(ax - sx) + Math.abs(ay - sy) });
    }
  }
  if (!opts.length) return null;
  opts.sort((a, b) => a.r - b.r);
  const f = rng.pick(opts.filter((o) => o.r === opts[0].r));
  markFace(usedFaces, f.x, f.y, f.d);
  return f;
}

function findFaceInRegion(lv, rng, region, usedFaces, awayFrom, minDist = 3) {
  const opts = [];
  for (let ay = 1; ay < lv.h - 1; ay++) for (let ax = 1; ax < lv.w - 1; ax++) {
    const r = region[lv.idx(ax, ay)];
    if (r < minDist || lv.cell(ax, ay)?.stairs || lv.cell(ax, ay)?.door || lv.cell(ax, ay)?.gate) continue;
    for (let d = 0; d < 4; d++) {
      const wx = ax + DX[d], wy = ay + DY[d], fd = (d + 2) & 3;
      if (faceFree(lv, wx, wy, fd, usedFaces)) opts.push({ x: wx, y: wy, d: fd, ax, ay, r });
    }
  }
  if (!opts.length) return null;
  let f;
  if (awayFrom) { opts.sort((a, b) => b.r - a.r); f = rng.pick(opts.slice(0, Math.max(1, Math.ceil(opts.length / 2)))); }
  else f = rng.pick(opts);
  markFace(usedFaces, f.x, f.y, f.d);
  return f;
}

function findNiche(lv, rng, region, usedFaces, used) {
  const opts = [];
  for (let sy = 2; sy < lv.h - 2; sy++) for (let sx = 2; sx < lv.w - 2; sx++) {
    if (!lv.isSolid(sx, sy)) continue;
    const nb = lv.openNeighbors(sx, sy);
    if (nb.length !== 1) continue;
    const [ax, ay, dToA] = nb[0];
    if (region[lv.idx(ax, ay)] < 2 || used.has(ckey(ax, ay)) || lv.cell(ax, ay)?.stairs || lv.cell(ax, ay)?.door || lv.cell(ax, ay)?.gate) continue;
    if (usedFaces.has(fkey(sx, sy, dToA))) continue; // the false wall stays plain
    // Button on another wall seen from A.
    for (let d = 0; d < 4; d++) {
      const bx = ax + DX[d], by = ay + DY[d], bd = (d + 2) & 3;
      if (bx === sx && by === sy) continue;
      if (faceFree(lv, bx, by, bd, usedFaces)) opts.push({ sx, sy, ax, ay, bx, by, bd, nd: dToA });
    }
  }
  if (!opts.length) return null;
  const n = rng.pick(opts);
  markFace(usedFaces, n.bx, n.by, n.bd);
  markFace(usedFaces, n.sx, n.sy, n.nd);
  for (let d = 0; d < 4; d++) markFace(usedFaces, n.sx, n.sy, d);
  return n;
}

function farSpot(lv, rng, region, used, minDist) {
  const opts = [];
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) {
    const r = region[lv.idx(x, y)];
    if (r < minDist || used.has(ckey(x, y)) || lv.monsterAt(x, y)) continue;
    const c = lv.cell(x, y);
    if (c && (c.stairs || c.door || c.gate || c.plate || c.chest)) continue;
    opts.push({ x, y, r });
  }
  if (!opts.length) return null;
  opts.sort((a, b) => b.r - a.r);
  return rng.pick(opts.slice(0, Math.max(1, Math.ceil(opts.length / 3))));
}

export function rollLoot(tables, tier, rng) {
  const t = tables[tier] || tables.medium;
  const v = rng.weighted(t);
  return v === 'none' ? null : v;
}

export function pagesForLevel(data, L) {
  const ids = Object.keys(data.lore.pages);
  const out = [];
  ids.forEach((id, i) => {
    const at = 1 + Math.floor((i * (TOTAL_LEVELS - 2)) / Math.max(1, ids.length - 1));
    if (at === L) out.push(id);
  });
  return out;
}

function inscriptionPool(data, info) {
  const n = data.lore.npcs;
  const lines = [
    'A ring of words, carved and re-carved: flame - stone - silence - flame - stone - silence.',
    info.flavor,
    data.dungeon.shrine_sealed,
    ...(n.hooded_figure?.topics || []).filter((t) => !t.startsWith('[')).map((t) => `Scratched beneath the soot, in a careful hand: "${t}"`),
    ...(n.bard?.topics || []).slice(0, 6).map((t) => `A verse chalked on the stone: "${t}"`),
  ];
  if (info.kind === 'spine') lines.push(...(n.elara?.topics || []).slice(0, 5).map((t) => `Words pressed into the clay, a woman's hand: "${t}"`));
  return lines.filter(Boolean);
}

export function computeLey(lv, theme, L) {
  const base = LEY_BASE[theme] + L * 0.0015;
  lv.ley.fill(0);
  for (let i = 0; i < lv.ley.length; i++) if (!lv.tiles[i]) lv.ley[i] = base;
  for (const c of lv.meta.crystals || []) {
    if (c.sealed) continue;
    const dist = lv.bfs(c.ax, c.ay);
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i];
      if (d >= 0 && d <= 5) lv.ley[i] += c.strength * (1 - d / 6);
    }
  }
}
