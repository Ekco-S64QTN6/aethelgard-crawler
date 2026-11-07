// Asset manifest: assets/generated/manifest.json is always present (original
// procedural art). assets/imported/manifest.json is the optional classic pack
// built from Dungeon Hack+ by tools/import_dhplus.py; when enabled it is
// layered over the generated pack (walls + backdrops, monsters, portraits, sfx).
import { textureFromImage } from './renderer.js';

const BASE = 'assets/';

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`image ${src}`));
    img.src = BASE + src;
  });
}

async function json(path) {
  try { const r = await fetch(BASE + path); return r.ok ? r.json() : null; } catch { return null; }
}

export async function loadManifests() {
  const gen = await json('generated/manifest.json');
  if (!gen) throw new Error('assets/generated/manifest.json missing: run `npm run assets`');
  const classic = await json('imported/manifest.json');
  return { gen, classic };
}

export class Assets {
  constructor() {
    this.tex = new Map();     // src -> texture {w,h,px}
    this.img = new Map();     // src -> HTMLImageElement (for DOM icons)
  }

  async loadAll(srcs) {
    const uniq = [...new Set(srcs.filter(Boolean))].filter((s) => !this.tex.has(s));
    await Promise.all(uniq.map(async (s) => {
      try {
        const im = await loadImage(s);
        this.img.set(s, im);
        this.tex.set(s, textureFromImage(im));
      } catch (e) { console.warn(e.message); }
    }));
  }

  t(src) { return this.tex.get(src); }
}

// Resolve the active manifest: generated, optionally overlaid with classic.
export function resolveManifest({ gen, classic }, useClassic) {
  const m = JSON.parse(JSON.stringify(gen));
  m.monsterVariants = Object.fromEntries(Object.entries(gen.monsters).map(([f, src]) => [f, [{ front: src, attack: src }]]));
  m.packName = 'Original';
  if (!useClassic || !classic) return m;
  m.packName = 'Classic (Dungeon Hack+)';
  for (const [t, v] of Object.entries(classic.themes || {})) Object.assign(m.themes[t], v);
  Object.assign(m.decor, classic.decor || {});
  for (const [f, list] of Object.entries(classic.monsters || {})) if (list.length) m.monsterVariants[f] = list;
  if (classic.portraits?.length) m.portraits = [...classic.portraits, ...m.portraits];
  Object.assign(m.sfx, classic.sfx || {});
  m.credits = classic.credits;
  return m;
}

export function manifestSources(m) {
  const s = [];
  for (const t of Object.values(m.themes)) s.push(t.wall, t.floor, t.ceil, t.backdrop);
  s.push(...Object.values(m.doors), ...Object.values(m.decor), ...Object.values(m.floor_decor), ...Object.values(m.objects), ...Object.values(m.icons));
  for (const list of Object.values(m.monsterVariants)) for (const v of list) s.push(v.front, v.attack);
  return s;
}

// Texture set for one theme, in the shape the renderer expects.
export function themeTextures(assets, m, theme) {
  const th = m.themes[theme];
  const T = (src) => assets.t(src);
  const decor = {};
  for (const [k, v] of Object.entries(m.decor)) decor[k] = T(v);
  const doors = {};
  for (const [k, v] of Object.entries(m.doors)) doors[k] = T(v);
  return {
    wall: T(th.wall), floor: T(th.floor), ceil: T(th.ceil), backdrop: th.backdrop ? T(th.backdrop) : null,
    fog: th.fog || [0, 0, 0], doors, decor, plate: T(m.floor_decor.plate), pit: T(m.floor_decor.pit),
  };
}
