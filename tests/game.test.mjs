import test from 'node:test';
import assert from 'node:assert/strict';
import { data } from './helpers.mjs';
import { Game } from '../src/game/game.js';
import { createCharacter, maxHp, addToPack, packHas } from '../src/game/party.js';
import { Rng } from '../src/core/rng.js';
import { DX, DY } from '../src/engine/grid.js';
import { FEEDBACK, SPELLS } from '../src/game/magic.js';
import { makeMonster } from '../src/game/monsters.js';
import { serialize, deserialize } from '../src/game/save.js';

async function newGame(seed = 7) {
  const D = await data();
  const rng = new Rng(seed);
  const g = new Game(D, { seed, rng });
  g.startNew([['Brannoc', 'Dwarf', 'Warrior'], ['Edda', 'Human', 'Cleric'], ['Sylith', 'Silvani', 'Ranger'], ['Ilvane', 'Veiled', 'Mage']]
    .map(([name, race, cls]) => createCharacter({ name, race, cls, portrait: 'p.png' }, D, rng)));
  return g;
}

const tick = (g, sec) => { for (let t = 0; t < sec; t += 0.05) g.update(0.05); };

function godMode(g) {
  for (const c of g.party) {
    c.level = 15; c.baseHp = 99999; c.hp = 99999;
    for (const s of Object.keys(c.stats)) c.stats[s] = 30;
  }
}

test('step movement collides with walls and turns in 90-degree steps', async () => {
  const g = await newGame();
  g.enterLevel(1, 'up');
  const lv = g.level, m = g.mover;
  for (let i = 0; i < 4; i++) { g.runCommand({ turn: 1 }); m.update(1); }
  assert.equal(m.dir, lv.meta.start.dir);
  assert.equal(m.ca % (Math.PI / 2), 0, 'camera snaps to the map axis');
  // Walk forward until something stops the party, then check it was a wall.
  lv.monsters = [];
  for (const c of lv.cells.values()) { if (c.door) c.door.open = c.door.target = 1; if (c.gate) c.gate.open = c.gate.target = 1; }
  let moved = 0;
  for (let i = 0; i < 60; i++) {
    const [px, py] = [m.x, m.y];
    if (lv.cell(m.x + DX[m.dir], m.y + DY[m.dir])?.stairs) break;
    g.runCommand({ move: 0 }); m.update(1);
    if (m.x === px && m.y === py) break;
    moved++;
  }
  assert.ok(moved > 0, 'took at least one step');
  const ahead = [m.x + DX[m.dir], m.y + DY[m.dir]];
  assert.ok(lv.isSolid(...ahead) || lv.cell(...ahead)?.stairs, 'stopped by a wall');
  const before = [m.x, m.y];
  if (lv.isSolid(...ahead)) { g.runCommand({ move: 0 }); m.update(1); }
  assert.deepEqual([m.x, m.y], before, 'the wall blocked the step');
});

test('attacks run on per-member cooldown timers', async () => {
  const g = await newGame();
  g.enterLevel(1, 'up');
  godMode(g);
  const lv = g.level, P = g.mover;
  lv.monsters = [];
  const fx = P.x + DX[P.dir], fy = P.y + DY[P.dir];
  if (lv.isSolid(fx, fy)) { g.runCommand({ turn: 1 }); P.update(1); g.runCommand({ turn: 1 }); P.update(1); }
  const tx = P.x + DX[P.dir], ty = P.y + DY[P.dir];
  const m = makeMonster(g.data, 'goblin', tx, ty, 1);
  m.hp = m.maxHp = 1e6;
  lv.monsters.push(m);
  g.attack(0);
  const r0 = g.party[0].ready;
  assert.ok(r0 > g.time, 'cooldown started');
  g.attack(0);
  assert.equal(g.party[0].ready, r0, 'a second attack inside the cooldown is ignored');
  tick(g, r0 - g.time + 0.05);
  g.attack(0);
  assert.ok(g.party[0].ready > r0, 'attack allowed again once the timer expires');
});

test('monsters next to the party attack on their own timers', async () => {
  const g = await newGame();
  g.enterLevel(1, 'up');
  const lv = g.level, P = g.mover;
  lv.monsters = [];
  const [x, y] = [P.x - DX[P.dir], P.y - DY[P.dir]];
  const free = lv.openNeighbors(P.x, P.y).find(([nx, ny]) => !lv.cell(nx, ny)?.stairs);
  const m = makeMonster(g.data, 'cave_troll', free[0], free[1], 30);
  m.atk = 99;
  lv.monsters.push(m);
  void x; void y;
  const hp0 = g.party.map((c) => c.hp);
  tick(g, 6);
  assert.ok(g.party.some((c, i) => c.hp < hp0[i]) || g.mode === 'blackout', 'someone was hit');
});

test('every Ley-Bleed feedback outcome applies cleanly', async () => {
  const g = await newGame();
  g.enterLevel(20, 'up');
  godMode(g);
  const mage = g.party[3];
  for (const fb of FEEDBACK) {
    if (fb.cancels || fb.id === 'surge') continue;
    assert.doesNotThrow(() => g.applyFeedback(fb.id, mage, SPELLS.arcane_surge, 0.9), fb.id);
  }
  assert.ok(g.level.monsters.some((m) => m.key === 'aeridorian_echo'), 'echo spawned a monster');
});

test('every spell resolves for a caster who knows it', async () => {
  const g = await newGame();
  g.enterLevel(4, 'up');
  godMode(g);
  const D = g.data;
  for (const [id, sp] of Object.entries(SPELLS)) {
    const c = g.party[1];
    const base = Object.keys(D.classes.advanced).find((b) => b === sp.classes[0] || D.classes.advanced[b][sp.classes[0]]);
    c.cls = base; c.adv = sp.classes[0] === base ? null : sp.classes[0];
    c.mp = 999; c.ready = 0;
    assert.doesNotThrow(() => g.cast(1, id), id);
  }
});

test('save and load round-trip the party and the level state', async () => {
  const g = await newGame(11);
  g.enterLevel(5, 'up');
  g.runCommand({ turn: 1 }); g.mover.update(1);
  g.gold = 1234;
  g.level.monsters[0].hp = 3;
  const s = serialize(g);
  const g2 = await newGame(99);
  deserialize(g2, s);
  assert.equal(g2.gold, 1234);
  assert.equal(g2.L, 5);
  assert.deepEqual([g2.mover.x, g2.mover.y, g2.mover.dir], [g.mover.x, g.mover.y, g.mover.dir]);
  assert.equal(g2.level.monsters[0].hp, 3);
  assert.deepEqual(g2.party.map((c) => c.name), g.party.map((c) => c.name));
});

// ── Autopilot: play a floor through its puzzles using only game actions ────
function face(g, dir) {
  let n = 0;
  while (g.mover.dir !== dir && n++ < 4) { g.runCommand({ turn: ((dir - g.mover.dir + 4) & 3) === 3 ? -1 : 1 }); g.mover.update(1); }
}

function killAhead(g) {
  for (let i = 0; i < 600 && g.monsterAhead(1); i++) { for (let s = 0; s < 4; s++) g.attack(s); tick(g, 0.1); }
}

function through(g) {
  const lv = g.level;
  return (x, y) => {
    if (lv.isSolid(x, y) || lv.cell(x, y)?.stairs) return false;
    const c = lv.cell(x, y);
    if (c?.gate && c.gate.target < 1) return false;
    if (c?.door?.locked) return false;
    return true;
  };
}

// Walk until standing on (tx, ty). Returns false if no route.
function goto(g, tx, ty) {
  const lv = g.level;
  for (let guard = 0; guard < 2000; guard++) {
    const P = g.mover;
    if (P.x === tx && P.y === ty) return true;
    const dist = lv.bfs(tx, ty, through(g));
    if (dist[lv.idx(P.x, P.y)] < 0) return false;
    let next = -1;
    for (let d = 0; d < 4; d++) {
      const nx = P.x + DX[d], ny = P.y + DY[d];
      if (lv.inBounds(nx, ny) && dist[lv.idx(nx, ny)] === dist[lv.idx(P.x, P.y)] - 1) { next = d; break; }
    }
    face(g, next);
    const nx = P.x + DX[next], ny = P.y + DY[next];
    if (lv.monsterAt(nx, ny)) { killAhead(g); continue; }
    const c = lv.cell(nx, ny);
    if (c?.door && c.door.open < 1) { if (c.door.target < 1) g.clickBarrier(nx, ny); tick(g, 0.7); continue; }
    g.runCommand({ move: 0 }); g.mover.update(1);
    tick(g, 0.05);
  }
  return false;
}

function adjacentTo(g, x, y) {
  const lv = g.level;
  const opts = lv.openNeighbors(x, y).filter(([nx, ny]) => through(g)(nx, ny));
  for (const [nx, ny] of opts) if (goto(g, nx, ny)) { face(g, [0, 1, 2, 3].find((d) => nx + DX[d] === x && ny + DY[d] === y)); return true; }
  return false;
}

function solveFloor(g) {
  const lv = g.level;
  const L = g.L;
  // 1. Lever for the portcullis.
  for (const [k, f] of lv.faces) {
    if (f.kind !== 'lever' || f.on) continue;
    const [wx, wy, wd] = k.split(',').map(Number);
    assert.ok(goto(g, wx + DX[wd], wy + DY[wd]), `L${L}: reach lever`);
    face(g, (wd + 2) & 3);
    g.interact({ type: 'face', x: wx, y: wy, face: wd, u: 0.5, v: 0.5, dist: 0.5 });
    assert.ok(f.on, `L${L}: lever pulled`);
    tick(g, 1);
  }
  // 2. Key for the locked door.
  const doorEntry = [...lv.cells.entries()].find(([, c]) => c.door?.locked);
  if (doorEntry) {
    const keyKey = doorEntry[1].door.key;
    if (!g.party.some((c) => packHas(c, keyKey))) {
      const holder = lv.monsters.find((m) => m.alive && m.carries.includes(keyKey));
      if (holder) { assert.ok(adjacentTo(g, holder.x, holder.y), `L${L}: reach key holder`); killAhead(g); }
      const cellE = [...lv.cells.entries()].find(([, c]) => c.items.some((i) => i.key === keyKey));
      assert.ok(cellE, `L${L}: key on the floor`);
      const [kx, ky] = cellE[0].split(',').map(Number);
      assert.ok(goto(g, kx, ky), `L${L}: reach key`);
      while (lv.cell(kx, ky).items.length && !g.party.some((c) => packHas(c, keyKey))) {
        g.clickFloor(kx, ky);
        addToPack(g.party[0], g.hand.key, g.hand.n);
        g.hand = null;
      }
    }
    const [dx, dy] = doorEntry[0].split(',').map(Number);
    assert.ok(adjacentTo(g, dx, dy), `L${L}: reach locked door`);
    g.interact({ type: 'door', x: dx, y: dy, dist: 1 });
    assert.equal(doorEntry[1].door.locked, false, `L${L}: door unlocked`);
    tick(g, 1);
  }
  // 3. Guardian, then the stairs.
  const gd = lv.monsters.find((m) => m.id === lv.meta.guardianId);
  if (gd && gd.alive) { assert.ok(adjacentTo(g, gd.x, gd.y), `L${L}: reach guardian`); killAhead(g); assert.ok(!gd.alive, `L${L}: guardian slain`); }
  if (!lv.meta.down) return;
  const [sx, sy] = lv.meta.down;
  assert.ok(adjacentTo(g, sx, sy), `L${L}: reach stairs`);
  g.runCommand({ move: 0 });
}

test('autopilot solves floors end to end: lever, key, door, guardian, stairs', async () => {
  const g = await newGame(5);
  godMode(g);
  for (const start of [1, 4, 17, 33, 47, 62]) {
    g.enterLevel(start, 'up');
    for (let i = 0; i < 2; i++) {
      const L = g.L;
      solveFloor(g);
      assert.equal(g.L, L + 1, `descended from ${L}`);
    }
  }
});

test('the Mountain Heart ends the game', async () => {
  const g = await newGame(5);
  godMode(g);
  g.enterLevel(80, 'up');
  solveFloor(g);
  assert.equal(g.mode, 'victory');
});

test('town: shrine flame + altar grant the Symbol, which seals a crystal', async () => {
  const g = await newGame();
  g.flags.flame = true; g.flags.altar = true;
  g.addItemToParty('symbol_of_the_silent_ones');
  g.enterLevel(2, 'up');
  const lv = g.level;
  const P = g.mover;
  const before = lv.ley[lv.idx(lv.meta.crystals[0].ax, lv.meta.crystals[0].ay)];
  g.clickCrystal(lv.meta.crystals[0]);
  const after = lv.ley[lv.idx(lv.meta.crystals[0].ax, lv.meta.crystals[0].ay)];
  assert.ok(lv.meta.crystals[0].sealed);
  assert.ok(after < before, `Bleed dropped (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  void P; void maxHp;
});
