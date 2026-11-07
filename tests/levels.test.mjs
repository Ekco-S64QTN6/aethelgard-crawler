import test from 'node:test';
import assert from 'node:assert/strict';
import { data } from './helpers.mjs';
import { buildLevel, TOTAL_LEVELS, levelInfo } from '../src/game/levelgen.js';
import { DX, DY } from '../src/engine/grid.js';

function reach(lv, from, blocked) {
  return lv.bfs(from.x, from.y, (x, y) => !lv.isSolid(x, y) && !lv.cell(x, y)?.stairs && !blocked(x, y));
}

test('all 80 levels build, and every floor is solvable from its start', async () => {
  const D = await data();
  const seeds = [1, 7, 12345];
  for (const seed of seeds) {
    for (let L = 1; L <= TOTAL_LEVELS; L++) {
      const lv = buildLevel(L, D, seed);
      const { start, down } = lv.meta;
      const tag = `seed ${seed} level ${L} (${levelInfo(L, D).name})`;
      assert.ok(!lv.isSolid(start.x, start.y), `${tag}: start inside a wall`);
      assert.equal(lv.cell(lv.meta.start.x - DX[start.dir], start.y - DY[start.dir])?.stairs, 'up', `${tag}: party should start facing away from the up stairs`);
      const gate = [...lv.cells.entries()].find(([, c]) => c.gate);
      const door = [...lv.cells.entries()].find(([, c]) => c.door?.locked);
      const at = (e) => e[0].split(',').map(Number);
      // Lever on the near side of its gate.
      if (gate) {
        const [gx, gy] = at(gate);
        const lever = [...lv.faces.entries()].find(([, f]) => f.kind === 'lever');
        assert.ok(lever, `${tag}: gate without lever`);
        const [wx, wy, wd] = lever[0].split(',').map(Number);
        const ax = wx + DX[wd], ay = wy + DY[wd];
        const r = reach(lv, start, (x, y) => (x === gx && y === gy) || (door && x === at(door)[0] && y === at(door)[1]));
        assert.ok(r[lv.idx(ax, ay)] >= 0, `${tag}: lever not reachable before its gate`);
      }
      // Key on the near side of its locked door.
      if (door) {
        const [dx, dy] = at(door);
        const keyKey = door[1].door.key;
        const r = reach(lv, start, (x, y) => x === dx && y === dy);
        let found = false;
        for (const [k, c] of lv.cells) {
          const [x, y] = k.split(',').map(Number);
          if (c.items.some((i) => i.key === keyKey) && r[lv.idx(x, y)] >= 0) found = true;
        }
        for (const m of lv.monsters) if (m.carries.includes(keyKey) && r[lv.idx(m.x, m.y)] >= 0) found = true;
        assert.ok(found, `${tag}: key ${keyKey} not reachable before its door`);
      }
      // With every barrier open, the way down (or the final guardian) is reachable.
      const all = reach(lv, start, () => false);
      if (down) {
        const nb = lv.openNeighbors(down[0], down[1]).some(([x, y]) => all[lv.idx(x, y)] >= 0);
        assert.ok(nb, `${tag}: down stairs unreachable`);
        const g = lv.monsters.find((m) => m.id === lv.meta.guardianId);
        assert.ok(g, `${tag}: no stair guardian`);
        assert.equal(Math.abs(g.x - down[0]) + Math.abs(g.y - down[1]), 1, `${tag}: guardian not beside the stairs`);
      } else {
        assert.equal(L, TOTAL_LEVELS, `${tag}: only the last floor may lack stairs down`);
        assert.ok(lv.meta.finalBossId, `${tag}: final floor needs the Mountain Heart`);
      }
      for (const m of lv.monsters) {
        assert.ok(!lv.isSolid(m.x, m.y), `${tag}: ${m.key} inside a wall`);
        assert.ok(!lv.cell(m.x, m.y)?.stairs, `${tag}: ${m.key} on stairs`);
        assert.ok(m.hp > 0 && Number.isFinite(m.atk) && Number.isFinite(m.def), `${tag}: ${m.key} bad stats`);
      }
      const others = lv.monsters.filter((m) => m.x === start.x && m.y === start.y);
      assert.equal(others.length, 0, `${tag}: monster on the start block`);
    }
  }
});

test('levels are deterministic for a seed', async () => {
  const D = await data();
  const a = buildLevel(20, D, 99), b = buildLevel(20, D, 99);
  assert.deepEqual([...a.tiles], [...b.tiles]);
  assert.deepEqual(a.monsters.map((m) => [m.key, m.x, m.y]), b.monsters.map((m) => [m.key, m.x, m.y]));
  assert.deepEqual([...a.faces.keys()], [...b.faces.keys()]);
});

test('the descent runs marble -> tunnels -> bones -> forge -> deep -> heart', async () => {
  const D = await data();
  const seq = [];
  for (let L = 1; L <= TOTAL_LEVELS; L++) {
    const t = levelInfo(L, D).theme;
    if (seq[seq.length - 1] !== t) seq.push(t);
  }
  assert.deepEqual(seq, ['aeridor', 'tunnels', 'bones', 'forge', 'deep', 'heart']);
});
