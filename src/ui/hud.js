// Party panel (2x2 grid: front rank over back rank), message log, status line.
import { h, $ } from './dom.js';
import { maxHp, maxMp, addToPack, klass } from '../game/party.js';
import { itemDef, itemKind } from '../game/items.js';
import { knownSpells, SPELLS, bleedLabel } from '../game/magic.js';

const COND_LABEL = {
  blessed: ['Blessed', 'buff'], fortified: ['Fortified', 'buff'], embered: ['Embered', 'buff'], lucky: ['Lucky', 'buff'],
  attuned: ['Attuned', 'buff'], tree_memory: ['Tree Memory', 'buff'], xp_boost: ['XP+', 'buff'], hunters_focus: ['Focus', 'buff'],
  torchlit: ['Torch', 'buff'], wisp_ward: ['Wisp Ward', 'buff'], mirror_resolve: ['Resolve', 'buff'],
  silenced: ['Silenced', 'debuff'], poisoned: ['Poisoned', 'debuff'], weakened: ['Weakened', 'debuff'],
};

export class Hud {
  constructor(game, ui) {
    this.g = game;
    this.ui = ui;
    this.cards = [];
    this.logEl = $('#log');
    game.on('log', (m, cls) => this.log(m, cls));
  }

  log(msg, cls = '') {
    const li = h('li', { class: cls }, msg);
    this.logEl.append(li);
    while (this.logEl.children.length > 80) this.logEl.firstChild.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  icon(kind) { return this.ui.manifest.icons[kind] ? 'assets/' + this.ui.manifest.icons[kind] : ''; }

  buildParty() {
    const root = $('#party');
    root.replaceChildren();
    this.cards = [];
    this.g.party.forEach((c, i) => {
      if (i === 0) root.append(h('div', { class: 'rank' }, 'Front rank'));
      if (i === 2) root.append(h('div', { class: 'rank' }, 'Back rank'));
      const portrait = h('img', { class: 'portrait', alt: '', src: 'assets/' + c.portrait });
      const name = h('div', { class: 'name' });
      const cls = h('div', { class: 'cls' });
      const hp = h('div', { class: 'meter hp', title: 'Hit points' }, h('i'), h('span'));
      const mp = h('div', { class: 'meter mp', title: 'Mana' }, h('i'), h('span'));
      const chips = h('div', { class: 'chips' });
      const wIcon = h('img', { alt: '' });
      const atk = h('button', { class: 'act', title: `Attack (${i + 1})`, onclick: () => this.g.attack(i) },
        h('span', { class: 'key' }, String(i + 1)), wIcon, h('div', { class: 'cd' }));
      const spell = h('button', { class: 'act', title: `Spells (Shift+${i + 1} recasts the last one)`, onclick: () => this.ui.screens.spells(i) },
        h('span', { class: 'key' }, `⇧${i + 1}`), h('span', { class: 'lbl' }, 'Cast'), h('div', { class: 'cd' }));
      const top = h('div', { class: 'top', title: 'Open inventory, or stow the held item', onclick: () => this.clickPortrait(i) },
        portrait, h('div', { class: 'who' }, name, cls));
      const card = h('div', { class: 'card' }, top, hp, mp, chips, h('div', { class: 'acts' }, atk, spell));
      root.append(card);
      this.cards.push({ card, portrait, name, cls, hp, mp, chips, atk, spell, wIcon, wKey: null, chipKey: '' });
    });
  }

  clickPortrait(i) {
    const g = this.g, c = g.party[i];
    if (g.hand) {
      if (addToPack(c, g.hand.key, g.hand.n)) {
        g.log(`${c.name} stows ${itemDef(g.hand.key).name}.`);
        g.notePage(g.hand.key);
        g.hand = null;
        g.emit('hand');
      } else g.log(`${c.name}'s pack is full.`);
      return;
    }
    this.ui.screens.inventory(i);
  }

  update() {
    const g = this.g, D = g.data;
    g.party.forEach((c, i) => {
      const e = this.cards[i];
      if (!e) return;
      e.name.textContent = c.name;
      e.cls.textContent = `${g.charTitle(c)} · L${c.level}${c.statPending || c.advPending ? ' ★' : ''}`;
      const mh = maxHp(c, D), mm = maxMp(c);
      e.hp.firstChild.style.width = `${Math.max(0, (c.hp / mh) * 100)}%`;
      e.hp.lastChild.textContent = `${Math.max(0, Math.ceil(c.hp))}/${mh}`;
      e.mp.style.visibility = mm ? 'visible' : 'hidden';
      if (mm) { e.mp.firstChild.style.width = `${(c.mp / mm) * 100}%`; e.mp.lastChild.textContent = `${Math.floor(c.mp)}/${mm}`; }
      e.card.classList.toggle('dead', !c.alive);
      e.card.classList.toggle('hit', c.flash > 0.2);
      const wk = c.equip.weapon || 'fist';
      if (e.wKey !== wk) { e.wKey = wk; e.wIcon.src = this.icon(c.equip.weapon ? itemKind(c.equip.weapon) : 'weapon'); e.atk.title = `Attack with ${c.equip.weapon ? itemDef(c.equip.weapon).name : 'bare hands'} (${i + 1})`; }
      const left = Math.max(0, c.ready - g.time);
      const frac = c.alive ? Math.min(1, left / (c.cdTotal || 1)) : 1;
      e.atk.querySelector('.cd').style.height = `${frac * 100}%`;
      e.spell.querySelector('.cd').style.height = `${frac * 100}%`;
      e.spell.disabled = !c.alive || !knownSpells(c).length;
      const ck = Object.keys(c.cond).sort().join(',') + (c.statPending ? '|s' : '') + (c.advPending ? '|a' : '');
      if (ck !== e.chipKey) {
        e.chipKey = ck;
        const chips = Object.keys(c.cond).filter((k) => COND_LABEL[k]).map((k) => h('span', { class: 'chip ' + COND_LABEL[k][1] }, COND_LABEL[k][0]));
        if (c.advPending) chips.push(h('span', { class: 'chip alert' }, 'Advance!'));
        if (c.statPending) chips.push(h('span', { class: 'chip alert' }, '+Stat'));
        e.chips.replaceChildren(...chips);
      }
    });
    $('#where').textContent = g.floorLabel();
    $('#gold').textContent = `${g.gold} gold`;
    if (g.mode === 'dungeon') {
      const f = g.bleedHere();
      $('#compass').textContent = `Facing ${g.compass()}`;
      $('#ley').textContent = `Ley-Bleed: ${bleedLabel(f)} (${f.toFixed(2)})`;
    } else { $('#compass').textContent = ''; $('#ley').textContent = ''; }
    const hint = $('#hand-hint');
    if (g.hand) { hint.hidden = false; hint.textContent = `Holding: ${itemDef(g.hand.key).name}${g.hand.n > 1 ? ' x' + g.hand.n : ''}. Click a portrait to stow it, or the floor to drop it.`; }
    else hint.hidden = true;
  }
}

export function spellSummary(c) {
  return knownSpells(c).map((id) => ({ id, ...SPELLS[id] }));
}

export { klass };
