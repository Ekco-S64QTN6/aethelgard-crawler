// First-person step-frustum renderer.
//
// The view is rendered in software into a small framebuffer (default 320x200)
// and scaled up with nearest-neighbour filtering. Walls are found per screen
// column with a grid DDA that stops at the view-distance field (VIEW_DEPTH
// cells deep); nothing beyond it is drawn, it fades into the level's fog.
// Because the camera only yaws, every wall projects to a vertical strip, so
// interpolated 90-degree turns and steps render with the same code as rest.
import { DX, DY } from './grid.js';

export const VIEW_DEPTH = 4;   // cells of corridor visible ahead
const CAM_H = 0.5;             // eye height (walls are 1.0 tall)
// The eye sits near the back of the party's square, looking slightly down
// (horizon above centre), so the front half of the party's own square, and
// whatever lies on it, is in view, as in the classic blobbers.
export const CAM_BACK = 0.4;
const HORIZON = 0.42;
const MAX_DIST = VIEW_DEPTH + 0.5 + CAM_BACK;

export function textureFromImage(img) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(img.width, img.height)
    : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height);
  return { w: img.width, h: img.height, px: new Uint32Array(d.data.buffer.slice(0)) };
}

// Solid-colour texture (used before images load and in tests).
export function flatTexture(r, g, b, a = 255, w = 8, h = 8) {
  const px = new Uint32Array(w * h).fill(((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
  return { w, h, px };
}

export function scaleTexture(tex, w, h) {
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(tex.h - 1, Math.floor(y * tex.h / h));
    for (let x = 0; x < w; x++) px[y * w + x] = tex.px[ty * tex.w + Math.min(tex.w - 1, Math.floor(x * tex.w / w))];
  }
  return { w, h, px };
}

function light(dist) {
  // Torchlight falloff, then a fade to fog at the edge of the view field.
  let k = 0.92 / (1 + dist * 0.18 + dist * dist * 0.1);
  if (dist > MAX_DIST - 0.9) k *= Math.max(0, (MAX_DIST - dist) / 0.9);
  return k;
}

export class Renderer {
  constructor(width = 320, height = 200) {
    this.W = width;
    this.H = height;
    this.focal = width / 2;               // 90-degree horizontal field of view
    this.horizon = Math.round(height * HORIZON);
    this.buf = new Uint32Array(width * height);
    this.depth = new Float32Array(width * height);
    this.colDepth = new Float32Array(width);
    this.fog = [0, 0, 0];
    this.tint = [1, 1, 1];                // whole-view tint (Ley-Bleed effects)
    this.textures = null;
    this.backdrop = null;
    this.visibleCells = new Set();        // cells inside the step frustum this frame
  }

  setTextures(t) {
    this.textures = t;
    this.backdrop = t.backdrop ? scaleTexture(t.backdrop, this.W, this.H) : null;
    this.fog = t.fog || [0, 0, 0];
  }

  // Precompute floor-feature lookup (0 none, 1 plate, 2 pit) for the floor caster.
  static floorMap(level) {
    const m = new Uint8Array(level.w * level.h);
    for (const [k, c] of level.cells) {
      if (!c.plate && !c.pit) continue;
      const [x, y] = k.split(',').map(Number);
      m[y * level.w + x] = c.pit ? 2 : (c.plate && !c.plate.hidden ? 1 : 0);
    }
    return m;
  }

  shade(v, k, mul = 1) {
    const r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255;
    const f = this.fog, t = this.tint, kk = k * mul;
    const R = r * kk * t[0] + f[0] * (1 - k);
    const G = g * kk * t[1] + f[1] * (1 - k);
    const B = b * kk * t[2] + f[2] * (1 - k);
    return (0xff000000 | (Math.min(255, B) << 16) | (Math.min(255, G) << 8) | Math.min(255, R)) >>> 0;
  }

  render(level, cam, sprites = [], floorMap = null) {
    const { W, H, buf, depth, focal } = this;
    const hz = this.horizon;
    const T = this.textures;
    const dirX = Math.sin(cam.ca), dirY = -Math.cos(cam.ca);
    const plX = Math.cos(cam.ca), plY = Math.sin(cam.ca); // tan(45deg) = 1
    const px = cam.cx - dirX * CAM_BACK, py = cam.cy - dirY * CAM_BACK;
    const fogPix = this.shade(0, 0);
    this.visibleCells.clear();

    // ── Floor and ceiling ───────────────────────────────────────────────
    const bd = this.backdrop;
    if (bd) buf.set(bd.px); else buf.fill(fogPix);
    depth.fill(1e9);
    const fl = T.floor, ce = T.ceil, plate = T.plate, pit = T.pit;
    for (let y = Math.ceil(hz); y < H; y++) {
      const rowDist = (CAM_H * focal) / (y + 0.5 - hz);
      if (rowDist > MAX_DIST) continue;
      const k = light(rowDist);
      const lx0 = dirX - plX, ly0 = dirY - plY;
      const stepX = (2 * plX * rowDist) / W, stepY = (2 * plY * rowDist) / W;
      let wx = px + lx0 * rowDist + stepX * 0.5, wy = py + ly0 * rowDist + stepY * 0.5;
      const cy = 2 * Math.ceil(hz) - 1 - y; // ceiling row at the same distance, mirrored about the horizon
      const rowF = y * W, rowC = cy * W;
      for (let x = 0; x < W; x++, wx += stepX, wy += stepY) {
        const cx = Math.floor(wx), cyy = Math.floor(wy);
        const fx = wx - cx, fy = wy - cyy;
        let feat = 0;
        if (floorMap && cx >= 0 && cyy >= 0 && cx < level.w && cyy < level.h) feat = floorMap[cyy * level.w + cx];
        let v = -1;
        if (feat) {
          const ot = feat === 2 ? pit : plate;
          const o = ot.px[Math.floor(fy * ot.h) * ot.w + Math.floor(fx * ot.w)];
          if ((o >>> 24) > 128) v = o;
        }
        if (v === -1 && !bd) v = fl.px[Math.floor(fy * fl.h) * fl.w + Math.floor(fx * fl.w)];
        if (v !== -1) { buf[rowF + x] = this.shade(v, k); depth[rowF + x] = rowDist + 0.02; }
        if (!bd && cy >= 0) {
          const c = ce.px[Math.floor(fy * ce.h) * ce.w + Math.floor(fx * ce.w)];
          buf[rowC + x] = this.shade(c, k, 0.85);
          depth[rowC + x] = rowDist + 0.02;
        }
      }
    }

    // ── Walls, doors, gates (per column DDA up to the view field) ────────
    for (let x = 0; x < W; x++) {
      const camX = (2 * (x + 0.5)) / W - 1;
      const rdx = dirX + plX * camX, rdy = dirY + plY * camX;
      let mx = Math.floor(px), my = Math.floor(py);
      const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      const sx = rdx < 0 ? -1 : 1, sy = rdy < 0 ? -1 : 1;
      let sdx = rdx < 0 ? (px - mx) * ddx : (mx + 1 - px) * ddx;
      let sdy = rdy < 0 ? (py - my) * ddy : (my + 1 - py) * ddy;
      const layers = []; // see-through layers, nearest last
      let opaque = null;
      this.visibleCells.add(mx + ',' + my);
      for (let i = 0; i < 64; i++) {
        let side;
        if (sdx < sdy) { sdx += ddx; mx += sx; side = 0; } else { sdy += ddy; my += sy; side = 1; }
        const perp = side === 0 ? sdx - ddx : sdy - ddy;
        if (perp > MAX_DIST) break;
        if (!level.inBounds(mx, my)) break;
        const cell = level.cell(mx, my);
        const solid = level.isSolid(mx, my);
        if (solid || (cell && cell.stairs)) {
          const face = side === 0 ? (sx > 0 ? 3 : 1) : (sy > 0 ? 0 : 2);
          let u = side === 0 ? py + perp * rdy : px + perp * rdx;
          u -= Math.floor(u);
          if (face === 1 || face === 0) u = 1 - u;
          opaque = { perp, u, side, mx, my, face, cell, solid };
          break;
        }
        this.visibleCells.add(mx + ',' + my);
        const bar = cell && (cell.door || cell.gate);
        if (bar && bar.open < 1) {
          // Panel across the middle of the cell, perpendicular to the passage.
          let t, u, flip;
          if (bar.axis === 'x') { t = (my + 0.5 - py) / rdy; u = px + rdx * t - mx; flip = rdy > 0; }
          else { t = (mx + 0.5 - px) / rdx; u = py + rdy * t - my; flip = rdx < 0; }
          if (t > 0 && u >= 0 && u < 1) {
            if (flip) u = 1 - u;
            const hit = { perp: t, u, side: bar.axis === 'x' ? 1 : 0, mx, my, bar, cell };
            if (!cell.gate && bar.open <= 0) { opaque = hit; break; }
            layers.push(hit);
          }
        }
      }
      this.colDepth[x] = opaque ? opaque.perp : MAX_DIST;
      if (opaque) this.drawWallColumn(x, opaque, level);
      for (let j = layers.length - 1; j >= 0; j--) this.drawWallColumn(x, layers[j], level);
    }

    // ── Sprites (monsters, chests, floor items) ─────────────────────────
    for (const s of sprites) this.drawSprite(s, px, py, dirX, dirY, plX, plY);
    return buf;
  }

  drawWallColumn(x, hit, level) {
    const { W, H, buf, depth, focal } = this;
    const hz = this.horizon;
    const T = this.textures;
    const perp = Math.max(0.05, hit.perp);
    const top = hz - ((1 - CAM_H) * focal) / perp;
    const bot = hz + (CAM_H * focal) / perp;
    const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(H, Math.ceil(bot));
    const k = light(perp);
    const sideMul = hit.side === 1 ? 0.78 : 1.0;
    let tex, deco = null, vOff = 0, cut = 1, alphaTest = false;
    if (hit.bar) {
      const b = hit.bar;
      tex = T.doors[b.tex] || T.wall;
      alphaTest = !!hit.cell.gate;
      vOff = b.open;          // panel slides up into the ceiling
      cut = 1 - b.open;       // visible fraction from the top
    } else if (hit.cell && hit.cell.stairs) {
      tex = T.decor[hit.cell.stairs === 'down' ? 'stairs_down' : 'stairs_up'] || T.wall;
    } else {
      tex = T.wall;
      const f = level.face(hit.mx, hit.my, hit.face);
      if (f && f.tex) deco = T.decor[f.tex] || null;
      if (f && f.wallTex && T.decor[f.wallTex]) tex = T.decor[f.wallTex];
    }
    const tu = Math.min(tex.w - 1, Math.floor(hit.u * tex.w));
    const du = deco ? Math.min(deco.w - 1, Math.floor(hit.u * deco.w)) : 0;
    const span = bot - top;
    for (let y = y0; y < y1; y++) {
      const i = y * W + x;
      if (depth[i] <= perp) continue;
      const v = (y + 0.5 - top) / span;
      if (v > cut) break;
      let c = tex.px[Math.min(tex.h - 1, Math.floor((v + vOff) * tex.h)) * tex.w + tu];
      if (alphaTest && (c >>> 24) < 128) continue;
      if (deco) {
        const dc = deco.px[Math.min(deco.h - 1, Math.floor(v * deco.h)) * deco.w + du];
        if ((dc >>> 24) > 128) c = dc;
      }
      buf[i] = this.shade(c, k, sideMul);
      depth[i] = perp;
    }
  }

  drawSprite(s, px, py, dirX, dirY, plX, plY) {
    const { W, H, buf, depth, focal } = this;
    const hz = this.horizon;
    const dx = s.x - px, dy = s.y - py;
    const dep = dx * dirX + dy * dirY;
    if (dep < 0.25 || dep > MAX_DIST) return;
    const lat = dx * plX + dy * plY;
    const scx = W / 2 + (lat / dep) * focal;
    const tex = s.tex;
    const hgt = (s.h * focal) / dep;
    const wid = hgt * (tex.w / tex.h) * (s.wScale || 1);
    const bottom = hz + ((CAM_H - (s.lift || 0)) * focal) / dep;
    const top = bottom - hgt;
    const x0 = Math.max(0, Math.floor(scx - wid / 2)), x1 = Math.min(W, Math.ceil(scx + wid / 2));
    const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(H, Math.ceil(bottom));
    if (x0 >= x1 || y0 >= y1) return;
    const k = light(dep);
    const tint = s.tint || null, flash = s.flash || 0;
    for (let x = x0; x < x1; x++) {
      const u = Math.min(tex.w - 1, Math.floor(((x + 0.5 - (scx - wid / 2)) / wid) * tex.w));
      const uu = s.mirror ? tex.w - 1 - u : u;
      for (let y = y0; y < y1; y++) {
        const i = y * W + x;
        if (depth[i] <= dep) continue;
        const v = Math.min(tex.h - 1, Math.floor(((y + 0.5 - top) / hgt) * tex.h));
        let c = tex.px[v * tex.w + uu];
        if ((c >>> 24) < 128) continue;
        if (tint || flash) {
          let r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
          if (tint) { r *= tint[0]; g *= tint[1]; b *= tint[2]; }
          if (flash) { r += (255 - r) * flash; g += (255 - g) * flash * 0.6; b += (255 - b) * flash * 0.6; }
          c = (0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;
        }
        buf[i] = this.shade(c, k);
        depth[i] = dep;
      }
    }
  }

  // Click raycast: which grid object is under view pixel (sx, sy)?
  // Returns {type:'face'|'door'|'gate'|'stairs'|'floor'|'sprite', ...} or null.
  pick(level, cam, sx, sy, sprites = []) {
    const { W, focal } = this;
    const hz = this.horizon;
    const dirX = Math.sin(cam.ca), dirY = -Math.cos(cam.ca);
    const plX = Math.cos(cam.ca), plY = Math.sin(cam.ca);
    const px = cam.cx - dirX * CAM_BACK, py = cam.cy - dirY * CAM_BACK;
    // Sprites first (they stand in front of whatever wall the ray reaches).
    let best = null;
    for (const s of sprites) {
      if (!s.pickable) continue;
      const dx = s.x - px, dy = s.y - py;
      const dep = dx * dirX + dy * dirY;
      if (dep < 0.25 || dep > MAX_DIST) continue;
      const lat = dx * plX + dy * plY;
      const scx = W / 2 + (lat / dep) * focal;
      const hgt = (s.h * focal) / dep, wid = hgt * (s.tex.w / s.tex.h) * (s.wScale || 1);
      const bottom = hz + ((CAM_H - (s.lift || 0)) * focal) / dep;
      if (sx >= scx - wid / 2 && sx <= scx + wid / 2 && sy >= bottom - hgt && sy <= bottom) {
        if (!best || dep < best.dist) best = { type: 'sprite', sprite: s, dist: dep };
      }
    }
    const camX = (2 * (sx + 0.5)) / W - 1;
    const rdx = dirX + plX * camX, rdy = dirY + plY * camX;
    let mx = Math.floor(px), my = Math.floor(py);
    const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx), ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
    const stx = rdx < 0 ? -1 : 1, sty = rdy < 0 ? -1 : 1;
    let sdx = rdx < 0 ? (px - mx) * ddx : (mx + 1 - px) * ddx;
    let sdy = rdy < 0 ? (py - my) * ddy : (my + 1 - py) * ddy;
    let hit = null;
    for (let i = 0; i < 64 && !hit; i++) {
      let side;
      if (sdx < sdy) { sdx += ddx; mx += stx; side = 0; } else { sdy += ddy; my += sty; side = 1; }
      const perp = side === 0 ? sdx - ddx : sdy - ddy;
      if (perp > MAX_DIST || !level.inBounds(mx, my)) break;
      const cell = level.cell(mx, my);
      const vAt = (d) => (sy + 0.5 - (hz - ((1 - CAM_H) * focal) / d)) / (focal / d);
      if (level.isSolid(mx, my) || (cell && cell.stairs)) {
        const face = side === 0 ? (stx > 0 ? 3 : 1) : (sty > 0 ? 0 : 2);
        let u = side === 0 ? py + perp * rdy : px + perp * rdx;
        u -= Math.floor(u);
        if (face === 1 || face === 0) u = 1 - u;
        hit = cell && cell.stairs
          ? { type: 'stairs', x: mx, y: my, dist: perp }
          : { type: 'face', x: mx, y: my, face, u, v: vAt(perp), dist: perp };
        break;
      }
      const bar = cell && (cell.door || cell.gate);
      if (bar && bar.open < 1) {
        let t, u;
        if (bar.axis === 'x') { t = (my + 0.5 - py) / rdy; u = px + rdx * t - mx; }
        else { t = (mx + 0.5 - px) / rdx; u = py + rdy * t - my; }
        const v = vAt(t);
        if (t > 0 && u >= 0 && u < 1 && v >= 0 && v <= 1 - bar.open) {
          hit = { type: cell.gate ? 'gate' : 'door', x: mx, y: my, u, v, dist: t };
        }
      }
    }
    // Floor under the cursor, if nearer than the wall.
    if (sy > hz) {
      const rowDist = (CAM_H * focal) / (sy + 0.5 - hz);
      if (rowDist <= MAX_DIST && (!hit || rowDist < hit.dist)) {
        const wx = px + rdx * rowDist, wy = py + rdy * rowDist;
        const f = { type: 'floor', x: Math.floor(wx), y: Math.floor(wy), dist: rowDist };
        if (!best || rowDist < best.dist) return f;
      }
    }
    if (best && (!hit || best.dist < hit.dist)) return best;
    return hit;
  }
}

export { DX, DY };
