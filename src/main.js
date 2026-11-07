// Boot, main loop, input, and the bridge from game state to the renderer.
import { loadData, browserReader } from './game/data.js';
import { initItems, itemKind } from './game/items.js';
import { Game } from './game/game.js';
import { Renderer, Renderer as R } from './engine/renderer.js';
import { Assets, loadManifests, resolveManifest, manifestSources, themeTextures } from './engine/assets.js';
import { Audio } from './engine/audio.js';
import { FORWARD, BACK, STRAFE_LEFT, STRAFE_RIGHT } from './engine/movement.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { Town } from './ui/town.js';
import { saveToStorage } from './game/save.js';
import { $ } from './ui/dom.js';
import { ckey } from './engine/grid.js';

const MONSTER_H = { trivial: 0.55, easy: 0.65, medium: 0.75, hard: 0.85, deadly: 0.92, boss: 0.98 };
const PREF_KEY = 'aethelgard-crawler-prefs';

class UI {
  async boot() {
    const data = await loadData(browserReader);
    initItems(data);
    this.manifests = await loadManifests();
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { /* private mode */ }
    this.useClassic = !!prefs.classic && !!this.manifests.classic;
    this.assets = new Assets();
    this.audio = new Audio();
    await this.applyManifest();
    this.game = new Game(data);
    this.game.queries = { visibleCells: () => this.renderer.visibleCells };
    this.renderer = new Renderer(320, 200);
    this.canvas = $('#view');
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(320, 200);
    this.hud = new Hud(this.game, this);
    this.screens = new Screens(this.game, this);
    this.town = new Town(this.game, this);
    this.wire();
    $('#boot').hidden = true;
    this.screens.title();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    // Test hook for headless screenshots (tools/shoot.sh).
    window.__aethelgard = this;
    const q = new URLSearchParams(location.search);
    if (q.get('demo')) await this.demo(q);
  }

  // ?demo=1&seed=7&L=5&script=ffrf&ui=map&classic=1: a scripted start used for
  // screenshots. f/b forward/back, l/r turn, L/R strafe, 1-4 attack.
  async demo(q) {
    if (q.get('classic') && this.manifests.classic && !this.useClassic) await this.toggleClassic();
    const { Rng } = await import('./core/rng.js');
    const { createCharacter } = await import('./game/party.js');
    const g = this.game, D = g.data, rng = new Rng(42);
    const ports = (race) => this.manifest.portraits.filter((p) => p.race === race || p.race === 'any');
    const roster = [['Brannoc', 'Dwarf', 'Warrior'], ['Edda', 'Human', 'Cleric'], ['Sylith', 'Silvani', 'Ranger'], ['Ilvane', 'Veiled', 'Mage']];
    const party = roster.map(([name, race, cls], i) => createCharacter({ name, race, cls, portrait: ports(race)[i % ports(race).length].src }, D, rng));
    g.seed = Number(q.get('seed') || 7);
    g.startNew(party);
    this.screens.current = null;
    $('#overlay').hidden = true;
    this.onPartyReady();
    const L = Number(q.get('L') || 0);
    if (L) {
      g.enterLevel(L, 'up');
      if (q.get('px')) g.mover.place(Number(q.get('px')), Number(q.get('py')), Number(q.get('pd') || 0));
      if (q.get('god')) for (const c of g.party) { c.baseHp = 9999; c.hp = 9999; }
      for (const ch of q.get('script') || '') {
        const cmd = { f: { move: FORWARD }, b: { move: BACK }, L: { move: STRAFE_LEFT }, R: { move: STRAFE_RIGHT }, l: { turn: -1 }, r: { turn: 1 } }[ch];
        if (cmd) { g.runCommand(cmd); g.mover.update(1); } else if ('1234'.includes(ch)) g.attack(Number(ch) - 1);
      }
      g.markSeen();
    }
    const ui = q.get('ui');
    if (ui === 'inv') this.screens.inventory(0);
    if (ui === 'map') this.screens.map();
    if (ui === 'codex') this.screens.codex();
    if (ui === 'spells') this.screens.spells(3);
    if (ui === 'title') this.screens.title();
    if (ui === 'create') this.screens.create();
    if (q.get('town')) { this.town.place = q.get('town'); this.town.render(); }
  }

  async applyManifest() {
    this.manifest = resolveManifest(this.manifests, this.useClassic);
    await this.assets.loadAll(manifestSources(this.manifest));
    this.audio.setMap(this.manifest.sfx);
    this.themeCache = new Map();
  }

  async toggleClassic() {
    this.useClassic = !this.useClassic;
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ classic: this.useClassic })); } catch { /* ignore */ }
    await this.applyManifest();
    if (this.game.level) this.setTheme(this.game.level.meta.theme);
    if (this.game.party.length) this.hud.buildParty();
  }

  setTheme(theme) {
    if (!this.themeCache.has(theme)) this.themeCache.set(theme, themeTextures(this.assets, this.manifest, theme));
    this.renderer.setTextures(this.themeCache.get(theme));
    this.theme = theme;
  }

  onPartyReady() {
    this.hud.buildParty();
    if (this.game.mode === 'town') this.town.show(); else this.town.hide();
  }

  wire() {
    const g = this.game;
    g.on('sfx', (n) => this.audio.play(n));
    g.on('ambient', (t) => this.audio.setAmbient(t));
    g.on('save', () => saveToStorage(g));
    g.on('hand', () => this.updateCursor());
    g.on('mode', (m) => {
      if (m === 'town') { this.town.place = 'square'; this.town.show(); this.hud.buildParty(); saveToStorage(g); }
      if (m === 'dungeon') { this.town.hide(); this.setTheme(g.level.meta.theme); this.floorMap = null; }
      if (m === 'blackout') this.screens.blackout();
      if (m === 'victory') this.screens.victory();
    });
    document.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
    document.addEventListener('keydown', (e) => this.key(e));
    this.canvas.addEventListener('click', (e) => this.clickView(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => { const c = $('#cursor-item'); if (!c.hidden) { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; } });
    const cmds = { fw: { move: FORWARD }, bk: { move: BACK }, sl: { move: STRAFE_LEFT }, sr: { move: STRAFE_RIGHT }, tl: { turn: -1 }, tr: { turn: 1 } };
    for (const b of document.querySelectorAll('#nav button')) b.addEventListener('click', () => g.command(cmds[b.dataset.cmd]));
    for (const b of document.querySelectorAll('#tools button')) b.addEventListener('click', () => this.tool(b.dataset.ui));
  }

  tool(name) {
    if (!this.game.party.length) return;
    if (name === 'inv') this.screens.inventory();
    if (name === 'map') this.screens.map();
    if (name === 'codex') this.screens.codex();
    if (name === 'menu') this.screens.menu();
  }

  key(e) {
    const g = this.game;
    this.audio.unlock();
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key;
    if (k === 'Escape') {
      if (this.screens.current) this.screens.close(); else if (g.party.length) this.screens.menu();
      e.preventDefault();
      return;
    }
    if (this.screens.current) {
      if (k.toLowerCase() === 'i' && this.screens.current === 'inventory') this.screens.close();
      if (k.toLowerCase() === 'm' && this.screens.current === 'map') this.screens.close();
      if (k.toLowerCase() === 'c' && this.screens.current === 'codex') this.screens.close();
      return;
    }
    const map = {
      w: { move: FORWARD }, arrowup: { move: FORWARD }, s: { move: BACK }, arrowdown: { move: BACK },
      a: { move: STRAFE_LEFT }, d: { move: STRAFE_RIGHT }, q: { turn: -1 }, arrowleft: { turn: -1 }, e: { turn: 1 }, arrowright: { turn: 1 },
    };
    const low = k.toLowerCase();
    if (map[low] && !e.ctrlKey && !e.metaKey) { g.command(map[low]); e.preventDefault(); return; }
    const digit = e.code && e.code.startsWith('Digit') ? Number(e.code.slice(5)) : NaN;
    if (digit >= 1 && digit <= 4) {
      const slot = digit - 1;
      if (e.shiftKey) { const c = g.party[slot]; if (c?.lastSpell) g.cast(slot, c.lastSpell); else this.screens.spells(slot); }
      else g.attack(slot);
      e.preventDefault();
      return;
    }
    if (low === 'r') g.toggleRest();
    if (low === 'i') this.tool('inv');
    if (low === 'm') this.tool('map');
    if (low === 'c') this.tool('codex');
  }

  clickView(e) {
    const g = this.game;
    if (g.mode !== 'dungeon') return;
    const r = this.canvas.getBoundingClientRect();
    // object-fit: contain letterboxing
    const scale = Math.min(r.width / 320, r.height / 200);
    const ox = (r.width - 320 * scale) / 2, oy = (r.height - 200 * scale) / 2;
    const sx = (e.clientX - r.left - ox) / scale, sy = (e.clientY - r.top - oy) / scale;
    if (sx < 0 || sy < 0 || sx >= 320 || sy >= 200) return;
    const hit = this.renderer.pick(g.level, g.mover, sx, sy, this.sprites || []);
    g.interact(hit);
    this.updateCursor();
  }

  updateCursor() {
    const g = this.game, c = $('#cursor-item');
    if (g.hand) {
      const k = itemKind(g.hand.key);
      c.style.backgroundImage = `url(assets/${this.manifest.icons[k] || this.manifest.icons.bag})`;
      c.style.backgroundSize = 'contain';
      c.hidden = false;
    } else c.hidden = true;
  }

  buildSprites() {
    const g = this.game, lv = g.level, M = this.manifest, A = this.assets;
    const out = [];
    for (const m of lv.monsters) {
      if (!m.alive) continue;
      const variants = M.monsterVariants[m.family] || M.monsterVariants.humanoid;
      const v = variants[m.variant % variants.length];
      const tex = A.t(m.attackAnim > 0 ? v.attack : v.front) || A.t(v.front);
      if (!tex) continue;
      const lunge = m.attackAnim > 0 ? 1.06 : 1;
      out.push({ kind: 'monster', ref: m, x: m.vx ?? m.x + 0.5, y: m.vy ?? m.y + 0.5, tex, h: (MONSTER_H[m.tier] || 0.8) * lunge,
        tint: this.useClassic && !m.rareDrop ? null : m.tint, flash: m.flash, pickable: true });
      if (!g.flags.seenMonsters[m.key] && this.renderer.visibleCells.has(ckey(m.x, m.y))) {
        g.flags.seenMonsters[m.key] = true;
        g.log(`${m.name}: ${m.desc}`, 'lore');
      }
    }
    for (const [k, c] of lv.cells) {
      if (!c.chest && !c.items.length) continue;
      const [x, y] = k.split(',').map(Number);
      if (c.chest) out.push({ kind: 'chest', cx: x, cy: y, x: x + 0.5, y: y + 0.5, tex: A.t(c.chest.opened ? M.objects.chest_open : M.objects.chest), h: 0.42, pickable: true });
      // Items in the party's own square lie in its front half, where the eye can see them.
      const own = x === g.mover.x && y === g.mover.y;
      const fdx = [0, 1, 0, -1][g.mover.dir], fdy = [-1, 0, 1, 0][g.mover.dir];
      c.items.slice(-4).forEach((it, i) => {
        const tex = A.t(M.icons[itemKind(it.key)] || M.icons.bag);
        const off = [[-0.18, 0.12], [0.18, -0.1], [0.15, 0.2], [-0.15, -0.18]][i];
        const ix = own ? x + 0.5 + fdx * 0.28 + fdy * off[0] : x + 0.5 + off[0];
        const iy = own ? y + 0.5 + fdy * 0.28 - fdx * off[0] : y + 0.5 + off[1];
        out.push({ kind: 'item', cx: x, cy: y, x: ix, y: iy, tex, h: 0.2, pickable: true });
      });
    }
    return out;
  }

  frame(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const g = this.game;
    g.update(dt);
    if (g.mode === 'dungeon' && g.level) {
      if (this.theme !== g.level.meta.theme) this.setTheme(g.level.meta.theme);
      if (!this.floorMap || g.floorMapDirty) { this.floorMap = R.floorMap(g.level); g.floorMapDirty = false; }
      this.renderer.tint = g.viewTint ? g.viewTint.rgb : [1, 1, 1];
      this.sprites = this.buildSprites();
      const buf = this.renderer.render(g.level, g.mover, this.sprites, this.floorMap);
      this.image.data.set(new Uint8ClampedArray(buf.buffer));
      this.ctx.putImageData(this.image, 0, 0);
      g.markSeen(this.renderer.visibleCells);
      const s = g.shake;
      this.canvas.style.transform = s > 0.01 ? `translate(${(Math.random() - 0.5) * 8 * s}px, ${(Math.random() - 0.5) * 6 * s}px)` : '';
      const hurt = Math.max(0, ...g.party.map((c) => c.flash));
      $('#view-fx').style.background = hurt > 0.05 ? `radial-gradient(ellipse at center, transparent 50%, rgba(170,20,10,${hurt * 0.55}))` : 'transparent';
    }
    if (g.party.length) this.hud.update();
    requestAnimationFrame((tt) => this.frame(tt));
  }
}

new UI().boot().catch((e) => {
  console.error(e);
  $('#boot').textContent = `Failed to start: ${e.message}`;
});
