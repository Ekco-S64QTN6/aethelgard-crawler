// The map array: a block grid where every tile is open floor or solid wall,
// plus per-cell features (doors, stairs, plates, items) and per-face wall
// decorations (buttons, levers, keyholes, ley crystals, shrine seals).
//
// Directions: 0 = north (-y), 1 = east (+x), 2 = south (+y), 3 = west (-x).
// A face is addressed as (x, y, d): the side of solid cell (x, y) that faces
// direction d, i.e. the side an observer standing at (x+DX[d], y+DY[d]) sees.

export const N = 0, E = 1, S = 2, W = 3;
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
export const DIR_NAMES = ['North', 'East', 'South', 'West'];
export const opposite = (d) => (d + 2) & 3;
export const left = (d) => (d + 3) & 3;
export const right = (d) => (d + 1) & 3;

export const T_OPEN = 0;
export const T_WALL = 1;

export const ckey = (x, y) => `${x},${y}`;
export const fkey = (x, y, d) => `${x},${y},${d}`;

export class Level {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h).fill(T_WALL);
    this.cells = new Map();   // ckey -> { door, stairs, plate, items[], chest, gate, ... }
    this.faces = new Map();   // fkey -> { kind, ... }
    this.monsters = [];
    this.seen = new Uint8Array(w * h); // automap memory
    this.ley = new Float32Array(w * h); // Ley-Bleed field (see game/leybleed.js)
    this.meta = {};
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  idx(x, y) { return y * this.w + x; }
  tile(x, y) { return this.inBounds(x, y) ? this.tiles[y * this.w + x] : T_WALL; }
  isSolid(x, y) { return this.tile(x, y) === T_WALL; }
  setOpen(x, y) { if (this.inBounds(x, y)) this.tiles[y * this.w + x] = T_OPEN; }
  setWall(x, y) { if (this.inBounds(x, y)) this.tiles[y * this.w + x] = T_WALL; }

  cell(x, y) { return this.cells.get(ckey(x, y)); }
  ensureCell(x, y) {
    const k = ckey(x, y);
    let c = this.cells.get(k);
    if (!c) { c = { items: [] }; this.cells.set(k, c); }
    return c;
  }
  face(x, y, d) { return this.faces.get(fkey(x, y, d)); }
  setFace(x, y, d, deco) { this.faces.set(fkey(x, y, d), deco); return deco; }

  monsterAt(x, y) {
    for (const m of this.monsters) if (m.alive && m.x === x && m.y === y) return m;
    return null;
  }

  // Door/gate panels block movement unless fully open.
  barrierAt(x, y) {
    const c = this.cell(x, y);
    if (!c) return null;
    if (c.door && c.door.open < 1) return c.door;
    if (c.gate && c.gate.open < 1) return c.gate;
    return null;
  }

  // Ray/cell collision used by every step: may an entity enter (x, y)?
  // Stairs are entered (that is what triggers them), so they are passable here.
  passable(x, y, { ignoreMonsters = false } = {}) {
    if (!this.inBounds(x, y) || this.isSolid(x, y)) return false;
    if (this.barrierAt(x, y)) return false;
    if (!ignoreMonsters && this.monsterAt(x, y)) return false;
    return true;
  }

  openNeighbors(x, y) {
    const out = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!this.isSolid(nx, ny)) out.push([nx, ny, d]);
    }
    return out;
  }

  // Breadth-first distances over open tiles. `through(x, y)` decides whether a
  // tile can be crossed (default: any non-solid tile, doors and gates included).
  bfs(sx, sy, through = (x, y) => !this.isSolid(x, y)) {
    const dist = new Int32Array(this.w * this.h).fill(-1);
    const q = [sx, sy];
    dist[this.idx(sx, sy)] = 0;
    for (let i = 0; i < q.length; i += 2) {
      const x = q[i], y = q[i + 1];
      const d0 = dist[this.idx(x, y)];
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (dist[ni] >= 0 || !through(nx, ny)) continue;
        dist[ni] = d0 + 1;
        q.push(nx, ny);
      }
    }
    return dist;
  }
}
