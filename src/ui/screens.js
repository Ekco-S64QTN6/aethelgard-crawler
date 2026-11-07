// Overlay screens: title, party setup, inventory, spells, automap, codex,
// menu, advancement, blackout, victory.
import { h, $ } from './dom.js';
import { Rng } from '../core/rng.js';
import {
  BASE_CLASSES, createCharacter, rollStats, maxHp, maxMp, attackMod, defense, critThreshold, attackCooldown, reach,
  equipFromPack, unequip, addToPack, klass, raiseStat, xpFor, mod, SLOTS, PACK_SLOTS,
} from '../game/party.js';
import { itemDef, itemKind, describeItem, canEquip, isStackable } from '../game/items.js';
import { knownSpells, SPELLS, feedbackRisk, mitigation, bleedLabel } from '../game/magic.js';
import { serialize, deserialize, saveToStorage, loadFromStorage } from '../game/save.js';

const STAT_NAMES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export class Screens {
  constructor(game, ui) {
    this.g = game;
    this.ui = ui;
    this.overlay = $('#overlay');
    this.panel = $('#panel');
    this.current = null;
    this.invChar = 0;
  }

  open(name, ...kids) {
    this.current = name;
    this.panel.replaceChildren(...kids);
    this.overlay.hidden = false;
    const f = this.panel.querySelector('button, input, select');
    if (f) f.focus({ preventScroll: true });
  }

  close() {
    if (this.current === 'title' || this.current === 'create' || this.current === 'blackout' || this.current === 'victory') return;
    this.current = null;
    this.overlay.hidden = true;
    this.g.emit('hand');
  }

  closeBtn() { return h('button', { class: 'close', onclick: () => this.close(), 'aria-label': 'Close' }, '✕'); }

  icon(key) {
    const k = itemKind(key);
    return 'assets/' + (this.ui.manifest.icons[k] || this.ui.manifest.icons.bag);
  }

  // ── Title ─────────────────────────────────────────────────────────────────
  title() {
    const save = loadFromStorage();
    const m = this.ui.manifest;
    const classicBtn = this.ui.manifests.classic
      ? h('button', { onclick: () => this.ui.toggleClassic().then(() => this.title()) }, `Art: ${m.packName}`)
      : null;
    this.open('title', h('div', { class: 'title-screen' },
      h('h1', {}, 'Aethelgard Crawler'),
      h('div', { class: 'sub' }, 'A descent beneath the Aeridor Ruins'),
      h('p', { class: 'lore' }, 'Oakhaven was built on the bones of Aeridor. Everything here is built on something older. ',
        'Beneath the ruins, the white spires of a fallen age lie toppled in the dark, and below them the Ironvein Deep runs seventy-seven floors into the Spine of the World, through catacombs of calcified bone, a forge that never went out, and the rotting, blighted heart of the mountain. ',
        'The crystals that once sang for Aeridor are cracked. Where they bleed, magic is stronger, and it does not always do what it is told.'),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.create() }, 'New party'),
        save ? h('button', { onclick: () => this.loadGame(save) }, 'Continue') : null,
        classicBtn,
        h('button', { onclick: () => this.help(true) }, 'How to play')),
      m.credits ? h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '16px' } }, m.credits) : null,
    ));
  }

  loadGame(save) {
    try {
      deserialize(this.g, save);
      this.current = null;
      this.overlay.hidden = true;
      this.ui.onPartyReady();
    } catch (e) { alert(`Could not load the save: ${e.message}`); }
  }

  // ── Party setup ───────────────────────────────────────────────────────────
  create() {
    const D = this.g.data;
    const races = Object.keys(D.classes.races);
    const rng = new Rng((Math.random() * 2 ** 31) | 0);
    const defaults = [
      { name: 'Brannoc', race: 'Dwarf', cls: 'Warrior' },
      { name: 'Edda', race: 'Human', cls: 'Cleric' },
      { name: 'Sylith', race: 'Silvani', cls: 'Ranger' },
      { name: 'Ilvane', race: 'Veiled', cls: 'Mage' },
    ];
    const portraitsFor = (race) => this.ui.manifest.portraits.filter((p) => p.race === race || p.race === 'any').map((p) => p.src);
    const slots = defaults.map((d) => ({ ...d, stats: rollStats(rng, d.race, D), pi: 0 }));
    const cols = slots.map((s, i) => {
      const img = h('img', { alt: '' });
      const statBox = h('div', { class: 'stats' });
      const info = h('div', { class: 'muted', style: { fontSize: '12px' } });
      const paint = () => {
        const ps = portraitsFor(s.race);
        s.portrait = ps[((s.pi % ps.length) + ps.length) % ps.length];
        img.src = 'assets/' + s.portrait;
        statBox.replaceChildren(...STAT_NAMES.map((k) => h('span', {}, `${k.toUpperCase()} ${String(s.stats[k]).padStart(2)}`)));
        const bonus = Object.entries(D.classes.races[s.race]).map(([k, v]) => `${k.toUpperCase()} +${v}`).join(', ');
        info.textContent = `${s.race}: ${bonus}. ${s.cls}: attacks with ${D.classes.attack_stat[s.cls].toUpperCase()}, ${D.classes.hp_per_level[s.cls]} HP/level.`;
      };
      const race = h('select', { 'aria-label': 'Race', onchange: (e) => { s.race = e.target.value; s.stats = rollStats(rng, s.race, D); s.pi = 0; paint(); } },
        ...races.map((r) => h('option', { value: r, selected: r === s.race }, r)));
      const cls = h('select', { 'aria-label': 'Class', onchange: (e) => { s.cls = e.target.value; paint(); } },
        ...BASE_CLASSES.map((c) => h('option', { value: c, selected: c === s.cls }, c)));
      const name = h('input', { value: s.name, maxlength: 16, 'aria-label': 'Name', oninput: (e) => { s.name = e.target.value || `Hero ${i + 1}`; } });
      paint();
      return h('div', { class: 'pc' },
        h('div', { class: 'muted', style: { fontSize: '11px', letterSpacing: '.1em' } }, i < 2 ? `FRONT RANK ${i + 1}` : `BACK RANK ${i - 1}`),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { onclick: () => { s.pi--; paint(); }, 'aria-label': 'Previous portrait' }, '‹'), img,
          h('button', { onclick: () => { s.pi++; paint(); }, 'aria-label': 'Next portrait' }, '›')),
        name, race, cls, statBox,
        h('button', { onclick: () => { s.stats = rollStats(rng, s.race, D); paint(); } }, 'Reroll (4d6 drop lowest)'),
        info);
    });
    this.open('create',
      h('h2', {}, 'Your party'),
      h('p', { class: 'muted' }, 'Four adventurers. The front rank fights hand to hand; the back rank needs bows, wands, staves or spells. Every class can advance at level 5.'),
      h('div', { class: 'create' }, ...cols),
      h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'space-between' } },
        h('button', { onclick: () => this.title() }, 'Back'),
        h('button', { onclick: () => {
          const party = slots.map((s) => createCharacter({ name: s.name.trim() || 'Nameless', race: s.race, cls: s.cls, portrait: s.portrait, stats: s.stats }, D, rng));
          this.g.levels = new Map();
          this.g.seed = (Math.random() * 2 ** 31) | 0;
          this.g.startNew(party);
          this.current = null;
          this.overlay.hidden = true;
          this.ui.onPartyReady();
        } }, 'Enter Oakhaven')));
  }

  // ── Inventory ─────────────────────────────────────────────────────────────
  inventory(i = this.invChar) {
    this.invChar = i;
    const g = this.g, D = g.data, c = g.party[i];
    const tip = h('div', { class: 'tip muted' }, 'Hover an item for details. Click to pick up or place; right-click (or double-click) to use or equip.');
    const showTip = (key) => {
      if (!key) return;
      const d = itemDef(key);
      tip.replaceChildren(h('div', { style: { color: 'var(--gold)' } }, d.name), h('div', {}, describeItem(key)),
        d.description ? h('div', { class: 'lore' }, d.description) : null, d.desc ? h('div', { class: 'lore' }, d.desc) : null,
        d.value ? h('div', { class: 'muted' }, `Worth ${d.value} gold.`) : null);
    };
    const refresh = () => this.inventory(i);
    const slotEl = (it, label, onClick, onUse) => h('div', {
      class: 'slot', title: it ? itemDef(it.key).name : label || '',
      onclick: onClick, oncontextmenu: (e) => { e.preventDefault(); onUse && onUse(); }, ondblclick: onUse,
      onmouseenter: () => it && showTip(it.key),
    }, label ? h('span', { class: 'lbl' }, label) : null, it ? h('img', { alt: '', src: this.icon(it.key) }) : null, it && it.n > 1 ? h('span', { class: 'n' }, it.n) : null);

    const equipEls = SLOTS.map((s) => slotEl(c.equip[s] ? { key: c.equip[s], n: 1 } : null, s, () => {
      if (g.hand) {
        const d = itemDef(g.hand.key);
        if (d.slot !== s) return g.log(`${d.name} doesn't go there.`);
        if (!canEquip(c, g.hand.key)) return g.log(`${c.name} (${klass(c)}) can't use ${d.name}.`);
        const old = c.equip[s];
        c.equip[s] = g.hand.key;
        g.hand = old ? { key: old, n: 1 } : null;
      } else if (c.equip[s]) { g.hand = { key: c.equip[s], n: 1 }; c.equip[s] = null; }
      c.hp = Math.min(c.hp, maxHp(c, D)); c.mp = Math.min(c.mp, maxMp(c));
      g.emit('hand'); refresh();
    }, () => { const e = unequip(c, s, D); if (e) g.log(e); refresh(); }));

    const packEls = c.pack.map((it, pi) => slotEl(it, null, () => {
      if (g.hand) {
        if (it && it.key === g.hand.key && isStackable(it.key)) { it.n += g.hand.n; g.hand = null; }
        else { c.pack[pi] = g.hand; g.hand = it; }
        if (c.pack[pi]) g.notePage(c.pack[pi].key);
      } else if (it) { g.hand = it; c.pack[pi] = null; }
      g.emit('hand'); refresh();
    }, () => {
      if (!it) return;
      const d = itemDef(it.key);
      if (SLOTS.includes(d.slot)) { const e = equipFromPack(c, pi, D); if (e) g.log(e); }
      else g.useItem(c, pi);
      refresh();
    }));

    const next = c.level < 15 ? xpFor(c.level + 1, D) : null;
    const w = c.equip.weapon && itemDef(c.equip.weapon);
    const stats = h('div', { class: 'statgrid' },
      ...STAT_NAMES.flatMap((s) => [h('span', { class: 'muted' }, s.toUpperCase()), h('span', {}, `${c.stats[s]} (${mod(c.stats[s]) >= 0 ? '+' : ''}${mod(c.stats[s])})`,
        c.statPending ? h('button', { style: { padding: '0 6px', marginLeft: '6px' }, onclick: () => { raiseStat(c, s, D); refresh(); } }, '+') : null)]),
      h('span', { class: 'muted' }, 'HP'), h('span', {}, `${Math.ceil(c.hp)}/${maxHp(c, D)}`),
      h('span', { class: 'muted' }, 'Mana'), h('span', {}, maxMp(c) ? `${Math.floor(c.mp)}/${maxMp(c)}` : '-'),
      h('span', { class: 'muted' }, 'Attack'), h('span', {}, `${attackMod(c, D) >= 0 ? '+' : ''}${attackMod(c, D)} · d${w?.damage_die || 4} · crit ${critThreshold(c, D)}+`),
      h('span', { class: 'muted' }, 'Defense'), h('span', {}, String(defense(c, D))),
      h('span', { class: 'muted' }, 'Swing'), h('span', {}, `${attackCooldown(c).toFixed(1)}s, ${reach(c)}`),
      h('span', { class: 'muted' }, 'XP'), h('span', {}, next ? `${c.xp} / ${next}` : `${c.xp} (max)`));

    const others = g.party.map((p, j) => j === i ? null : h('button', { onclick: () => { [g.party[i], g.party[j]] = [g.party[j], g.party[i]]; this.ui.hud.buildParty(); this.inventory(j); } }, p.name)).filter(Boolean);

    this.open('inventory', this.closeBtn(),
      h('div', { class: 'tabs' }, ...g.party.map((p, j) => h('button', { class: j === i ? 'on' : '', onclick: () => this.inventory(j) }, p.name))),
      h('div', { class: 'inv' },
        h('div', {},
          h('div', { class: 'row' }, h('img', { src: 'assets/' + c.portrait, style: { width: '64px', height: '64px', imageRendering: 'pixelated' }, alt: '' }),
            h('div', {}, h('div', {}, c.name), h('div', { class: 'muted' }, `${c.race} ${g.charTitle(c)}`), h('div', { class: 'muted' }, `Level ${c.level}`))),
          h('h3', { style: { marginTop: '12px' } }, 'Equipped'),
          h('div', { class: 'equip' }, ...equipEls),
          c.advPending ? h('button', { style: { marginTop: '10px' }, onclick: () => this.advance(i) }, 'Choose advancement') : null,
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '12px' } }, 'Swap rank with:'),
          h('div', { class: 'row' }, ...others)),
        h('div', {}, h('h3', {}, 'Pack'), h('div', { class: 'slots' }, ...packEls), tip),
        h('div', {}, h('h3', {}, 'Statistics'), stats,
          c.statPending ? h('p', { class: 'muted' }, `${c.statPending} stat point(s) to spend.`) : null)));
  }

  advance(i) {
    const g = this.g, c = g.party[i], D = g.data;
    const opts = D.classes.advanced[c.cls];
    this.open('advance', this.closeBtn(), h('h2', {}, `${c.name}: the path forward`),
      h('p', { class: 'lore' }, '"If you\'re choosing a path forward, come back and speak to me first. Some paths have aftereffects." Sister Maren'),
      h('div', { class: 'grid-btns' }, ...Object.entries(opts).map(([name, o]) => h('button', { onclick: () => { g.advanceChar(c, name); this.inventory(i); } },
        o.is_stay ? `Stay a ${name}` : name, h('small', {}, o.description), h('small', {}, Object.entries(o.bonuses).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', '))))));
  }

  // ── Spells ────────────────────────────────────────────────────────────────
  spells(slot) {
    const g = this.g, c = g.party[slot];
    if (!c) return;
    const ids = knownSpells(c);
    const field = g.mode === 'dungeon' ? g.bleedHere() : 0;
    const mit = mitigation(c, g.partyHasSymbol());
    this.open('spells', this.closeBtn(), h('h2', {}, `${c.name}: spells`),
      h('p', { class: 'muted' }, `Ley-Bleed here: ${bleedLabel(field)} (${field.toFixed(2)}). Spells are ${Math.round((Math.min(1.2, field) * 0.5) * 100)}% stronger, and may feed back. Mitigation ${Math.round(mit * 100)}% (Blessed, Attuned, the Symbol, WIS).`),
      ids.length ? h('div', { class: 'grid-btns' }, ...ids.map((id) => {
        const s = SPELLS[id];
        const risk = feedbackRisk(field, s.power, mit);
        return h('button', { disabled: c.mp < s.mp || !c.alive, onclick: () => { this.close(); g.cast(slot, id); } },
          `${s.name} · ${s.mp} mana`, h('small', {}, s.desc), h('small', { style: { color: 'var(--ley)' } }, `Feedback risk here: ${Math.round(risk * 100)}%`));
      })) : h('p', {}, `${c.name} knows no spells yet.`));
  }

  // ── Automap ───────────────────────────────────────────────────────────────
  map() {
    const g = this.g;
    if (g.mode !== 'dungeon') return;
    const lv = g.level;
    const S = 14;
    const cv = h('canvas', { id: 'automap', width: lv.w * S, height: lv.h * S });
    const x = cv.getContext('2d');
    x.fillStyle = '#050406'; x.fillRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < lv.h; y++) for (let xx = 0; xx < lv.w; xx++) {
      if (!lv.seen[lv.idx(xx, y)]) continue;
      const c = lv.cell(xx, y);
      if (lv.isSolid(xx, y)) { x.fillStyle = '#3a3140'; x.fillRect(xx * S, y * S, S, S); continue; }
      const ley = lv.ley[lv.idx(xx, y)];
      x.fillStyle = `rgb(${40 + ley * 30},${36 + ley * 90},${44 + ley * 110})`;
      x.fillRect(xx * S, y * S, S, S);
      const mark = (col, txt) => { x.fillStyle = col; x.font = `${S - 2}px monospace`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, xx * S + S / 2, y * S + S / 2 + 1); };
      if (c?.stairs) mark('#8fcf7a', c.stairs === 'down' ? '>' : '<');
      else if (c?.door) mark(c.door.locked ? '#e06650' : '#d0a84e', c.door.open >= 1 ? '/' : '#');
      else if (c?.gate) mark('#9a8f86', c.gate.open >= 1 ? ':' : '=');
      else if (c?.chest) mark('#d0a84e', '$');
      else if (c?.plate && c.plate.armed) mark('#e06650', '^');
      else if (c?.items?.length) mark('#ddd5c6', '*');
    }
    for (const [k, f] of lv.faces) {
      const [fx, fy, fd] = k.split(',').map(Number);
      if (!lv.seen[lv.idx(fx, fy)] || !['crystal', 'shrine', 'lever', 'button'].includes(f.kind)) continue;
      x.fillStyle = { crystal: f.sealed ? '#556' : '#62d6ea', shrine: '#b79cff', lever: '#d0a84e', button: '#d0a84e' }[f.kind];
      const cx = fx * S + S / 2 + [0, 1, 0, -1][fd] * (S / 2 - 2), cy = fy * S + S / 2 + [-1, 0, 1, 0][fd] * (S / 2 - 2);
      x.fillRect(cx - 2, cy - 2, 4, 4);
    }
    const P = g.mover;
    x.save(); x.translate(P.x * S + S / 2, P.y * S + S / 2); x.rotate(P.dir * Math.PI / 2);
    x.fillStyle = '#ffd36b'; x.beginPath(); x.moveTo(0, -S / 2 + 1); x.lineTo(S / 2 - 2, S / 2 - 2); x.lineTo(-S / 2 + 2, S / 2 - 2); x.fill(); x.restore();
    this.open('map', this.closeBtn(), h('h2', {}, lv.meta.name), cv,
      h('p', { class: 'muted', style: { fontSize: '12px' } }, '< > stairs · # door (red: locked) · = portcullis · $ chest · ^ trap · * items · cyan pips: Ley crystals · brighter floor: stronger Ley-Bleed'));
  }

  // ── Codex ─────────────────────────────────────────────────────────────────
  codex(tab = 'lore') {
    const g = this.g, D = g.data;
    const tabs = h('div', { class: 'tabs' }, ...[['lore', 'Lore Codex'], ['bestiary', 'Bestiary'], ['quests', 'Quests']].map(([k, n]) => h('button', { class: k === tab ? 'on' : '', onclick: () => this.codex(k) }, n)));
    let body;
    if (tab === 'lore') {
      body = h('div', {}, ...Object.entries(D.lore.sets).map(([set, [name]]) => {
        const pages = Object.entries(D.lore.pages).filter(([, p]) => p[0] === set);
        return h('div', { style: { marginBottom: '14px' } }, h('h3', {}, `${name} (${pages.filter(([id]) => g.flags.pagesFound.includes(id)).length}/${pages.length})${g.flags.setsDone.includes(set) ? ' ✓' : ''}`),
          ...pages.map(([id, p]) => g.flags.pagesFound.includes(id) ? h('p', {}, h('b', {}, p[1]), ' ', h('span', { class: 'lore' }, p[2])) : h('p', { class: 'muted' }, '???')));
      }));
    } else if (tab === 'bestiary') {
      const seen = Object.keys(g.flags.seenMonsters);
      body = h('div', {}, h('p', { class: 'muted' }, `${seen.length} of ${Object.keys(D.monsters).length} creatures recorded.`),
        ...seen.map((k) => { const m = D.monsters[k]; return h('p', {}, h('b', {}, m.name), ` (${m.tier}${g.flags.kills[k] ? `, ${g.flags.kills[k]} slain` : ''}) `, h('span', { class: 'lore' }, m.desc)); }));
    } else {
      const qs = Object.entries(g.flags.quests);
      body = h('div', {}, qs.length ? null : h('p', { class: 'muted' }, 'No quests yet. Speak with people in Oakhaven.'),
        ...qs.map(([id, st]) => { const q = D.lore.quests[id]; return h('p', {}, h('b', {}, q.name), st.state === 'done' ? ' (complete)' : '', h('br'), h('span', { class: 'lore' }, q.description), h('br'),
          h('span', { class: 'muted' }, q.tasks.map((t) => `${st.done.includes(t) ? '✓' : '○'} ${t.replace(/_/g, ' ')}`).join('  '))); }));
    }
    this.open('codex', this.closeBtn(), tabs, body);
  }

  // ── Menu, help ────────────────────────────────────────────────────────────
  menu() {
    const g = this.g;
    this.open('menu', this.closeBtn(), h('h2', {}, 'Menu'),
      h('div', { class: 'grid-btns' },
        h('button', { onclick: () => { saveToStorage(g) ? g.log('Game saved.', 'good') : g.log('Saving failed (storage unavailable).', 'bad'); this.close(); } }, 'Save', h('small', {}, 'Also saves on every stair and in town.')),
        h('button', { onclick: () => { const s = loadFromStorage(); if (s) this.loadGame(s); } }, 'Load last save'),
        h('button', { onclick: () => {
          const blob = new Blob([serialize(g)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'aethelgard-save.json' }); a.click();
        } }, 'Export save file'),
        h('button', { onclick: () => {
          const inp = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => { const f = inp.files[0]; if (f) this.loadGame(await f.text()); } }); inp.click();
        } }, 'Import save file'),
        h('button', { onclick: () => { const m = this.ui.audio.toggleMute(); g.log(m ? 'Sound off.' : 'Sound on.'); } }, 'Toggle sound'),
        this.ui.manifests.classic ? h('button', { onclick: () => this.ui.toggleClassic().then(() => this.close()) }, `Art pack: ${this.ui.manifest.packName}`, h('small', {}, 'Switch between original art and the Dungeon Hack+ classic pack.')) : null,
        h('button', { onclick: () => this.help() }, 'How to play'),
        h('button', { onclick: () => { this.current = null; this.title(); } }, 'Quit to title')));
  }

  help(fromTitle = false) {
    this.open(fromTitle ? 'help-title' : 'help', h('button', { class: 'close', onclick: () => (fromTitle ? this.title() : this.close()) }, '✕'),
      h('h2', {}, 'How to play'),
      h('table', { class: 'keys' }, ...[
        ['W / ↑', 'step forward'], ['S / ↓', 'step back'], ['A / D', 'strafe left / right'], ['Q / E, ← / →', 'turn 90°'],
        ['1 - 4', 'attack with party member 1-4 (each has its own cooldown)'], ['Shift + 1 - 4', 'recast that member\'s last spell'],
        ['R', 'rest (only with no enemies near; any approach interrupts)'], ['I', 'inventory'], ['M', 'automap'], ['C', 'Lore Codex, bestiary, quests'], ['Esc', 'menu / close'],
      ].map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
      h('p', {}, 'Click things in the view to use them: levers, wall buttons, keyholed doors, shrines, crystals, inscriptions, chests, and items on the floor in front of you. Picked-up items ride on the cursor: click a portrait to stow them or the floor to drop them.'),
      h('p', {}, 'Only the front rank can melee. Bows, wands, staves and spells work from the back. Monsters strike whichever rank faces them.'),
      h('p', {}, h('b', {}, 'The Ley-Bleed. '), 'Aeridor\'s crystal network is cracked, and Resonance seeps out where the fractures are. The meter under the view shows the Bleed where you stand. Spells cast in strong Bleed hit harder and may feed back: surges, backlash, silence, quakes, phase-slips, blight, things answering the call. Blessings, the Shrine\'s attunement and the Symbol of the Silent Ones steady a caster. With the Symbol, you can silence a cracked crystal for good.'),
      h('p', {}, 'Every floor\'s stairs down are guarded. Levers raise portcullises; keys open locked doors; wall buttons hide niches. If the whole party falls, they wake at the Oakhaven Shrine, poorer.'));
  }

  blackout() {
    this.open('blackout', h('h2', {}, 'Blackout'),
      h('p', { class: 'lore' }, 'Darkness. Then the smell of wax and old flowers. You wake on the cold floor of the Shrine of the Silent Ones in Oakhaven, with one breath of life apiece and lighter purses.'),
      h('p', { class: 'muted' }, 'Lost 10% of XP and 5% of gold.'),
      h('button', { onclick: () => { this.current = null; this.overlay.hidden = true; this.g.goTown(); } }, 'Get up'));
  }

  victory() {
    this.open('victory', h('h2', {}, 'The Mountain Heart is still'),
      h('p', { class: 'lore' }, 'The heartbeat in the stone falters, and stops. For the first time in a thousand years the Spine of the World is quiet. Somewhere far above, the flame at the Oakhaven Shrine burns an ordinary yellow.'),
      h('p', { class: 'lore' }, '"It is done. The bones of Aeridor can finally rest. And so can we." Elder Elara'),
      h('div', { class: 'row' }, h('button', { onclick: () => { this.current = null; this.overlay.hidden = true; this.g.goTown('You return to Oakhaven as the ones who went all the way down.'); } }, 'Return to Oakhaven')));
  }
}

export { addToPack, PACK_SLOTS };
