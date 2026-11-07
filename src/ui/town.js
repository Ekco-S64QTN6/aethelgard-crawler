// Oakhaven: the hub between descents. Services and NPCs from Kaiacord's !rpg
// (world.py LOCATION_DATA, npc_registry, quest_registry, alchemy, Hemlock's stock).
import { h, $ } from './dom.js';
import { itemDef, itemKind, describeItem } from '../game/items.js';
import { maxHp, maxMp, addToPack, removeFromPack, packHas, mod, gainXp } from '../game/party.js';
import { RUINS_FLOORS } from '../game/levelgen.js';
import { saveToStorage } from '../game/save.js';

const TALKABLE = { elara: 'Elder Elara', hemlock: 'Old Man Hemlock', barkeep: 'Mira', hooded_figure: 'The Hooded Figure', guard: 'Watchtower Guard', maren: 'Sister Maren', bard: 'Caelindra' };

export class Town {
  constructor(game, ui) {
    this.g = game;
    this.ui = ui;
    this.root = $('#town');
    this.place = 'square';
    this.spawnable = null;
  }

  show() { this.root.hidden = false; this.render(); }
  hide() { this.root.hidden = true; }

  chaMod() { return Math.max(0, ...this.g.party.map((c) => mod(c.stats.cha))); }
  buyPrice(key) { return Math.max(1, Math.round(itemDef(key).value * (1 - Math.min(0.1, 0.02 * this.chaMod())))); }
  sellPrice(key) { return Math.max(1, Math.floor((itemDef(key).value || 0) * 0.5 * (1 + Math.min(0.1, 0.02 * this.chaMod())))); }

  // Monsters that can appear somewhere below, so kill quests stay achievable.
  canSpawn() {
    if (this.spawnable) return this.spawnable;
    const D = this.g.data, s = new Set();
    for (const f of Object.values(D.spine.floors)) for (const r of Object.values(f.rooms)) if (r.monster_key) s.add(r.monster_key);
    for (const k of Object.values(D.spine.stair_guardians)) s.add(k);
    for (const t of Object.values(D.dungeon.encounter_tables.aeridor_ruins)) for (const [k] of t) s.add(k);
    for (const [th] of D.dungeon.location_theme_weights.aeridor_ruins) {
      const T = D.dungeon.themes[th];
      for (const lv of ['1', '2', '3', '4']) for (const k of [...(T.pools[lv] || []), ...(T.boss_pools[lv] || [])]) s.add(k);
    }
    this.spawnable = s;
    return s;
  }

  questDoable(q) {
    return q.tasks.every((t) => {
      if (t.startsWith('talk_')) return TALKABLE[t.slice(5)];
      if (t.startsWith('kill_')) return this.canSpawn().has(t.slice(5));
      return ['pray_shrine', 'complete_dungeon', 'look_crystals'].includes(t);
    });
  }

  render() {
    const g = this.g;
    const places = [
      ['square', 'Town Square', 'The muddy square. The Tricklebrook gurgles under the bridge planks.'],
      ['hearth', 'The Stone Hearth', 'Rest, drink, rumours. Mira, Caelindra, and the corner table.'],
      ['store', "Hemlock's General Store", 'Buy and sell. Hemlock buys Aeridor shards.'],
      ['shrine', 'Shrine of the Silent Ones', 'Pray, heal, raise the fallen. The flame and the altar.'],
      ['hut', "Sister Maren's Hut", 'Alchemy from what you carry.'],
      ['elara', 'Elder Elara', 'Quests, and things she will not say.'],
      ['tower', 'The Watchtower', 'The guard keeps his eyes on the treeline.'],
      ['descend', 'The Aeridor Ruins', 'Go down.'],
    ];
    const nav = h('div', { class: 'grid-btns', style: { marginBottom: '16px' } },
      ...places.map(([id, name, sub]) => h('button', { class: this.place === id ? 'on' : '', style: this.place === id ? { borderColor: 'var(--gold)' } : {}, onclick: () => { this.place = id; this.render(); } }, name, h('small', {}, sub))));
    this.root.replaceChildren(h('h2', {}, 'Oakhaven'), nav, this[`p_${this.place}`]());
  }

  talk(id) {
    const g = this.g, n = g.data.lore.npcs[id];
    const topics = n.topics.filter((t) => !t.startsWith('['));
    const line = topics[Math.floor(Math.random() * topics.length)];
    g.log(`${n.name}: "${line}"`, 'lore');
    // Talking completes a quest whose other tasks are done.
    for (const [qid, st] of Object.entries(g.flags.quests)) {
      if (st.state !== 'active') continue;
      const q = g.data.lore.quests[qid];
      const t = `talk_${id}`;
      if (!q.tasks.includes(t) || st.done.includes(t)) continue;
      const others = q.tasks.filter((x) => x !== t && !x.startsWith('talk_'));
      if (others.every((x) => st.done.includes(x))) {
        st.done.push(t);
        if (q.tasks.every((x) => st.done.includes(x))) g.completeQuest(qid);
      }
    }
    return h('div', { class: 'card', style: { marginTop: '10px' } },
      h('div', { style: { color: 'var(--gold)' } }, n.name), h('div', { class: 'muted' }, n.dialogue_hook || n.description), h('p', { class: 'lore' }, `"${line}"`));
  }

  npcButtons(ids) {
    const out = h('div', {});
    return [h('div', { class: 'row' }, ...ids.map((id) => h('button', { onclick: () => out.replaceChildren(this.talk(id)) }, `Talk to ${TALKABLE[id]}`))), out];
  }

  p_square() {
    const D = this.g.data, L = D.lore.locations.oakhaven || {};
    return h('div', {}, h('p', { class: 'lore' }, L.description || 'Oakhaven, population about two hundred.'),
      h('p', { class: 'lore' }, 'The Notice Board: REWARD 40 gold for proof of the bog creature\'s death (see Elder Elara). MISSING: three sheep from Aldric\'s farm, east pasture. The Garrison has withdrawn. Travel in groups.'),
      h('p', { class: 'muted' }, `Deepest reached: ${this.g.deepest ? this.g.levelInfo(this.g.deepest).name : 'nowhere yet'}.`));
  }

  p_hearth() {
    const g = this.g;
    const living = g.party.filter((c) => c.alive);
    const cost = 5 * living.length;
    return h('div', {}, h('p', { class: 'lore' }, 'Low beams, a fire that is always lit, ale that is always warm. The Hooded Figure sits in the same corner as every night.'),
      h('div', { class: 'row' },
        h('button', { disabled: g.gold < cost, onclick: () => {
          g.gold -= cost;
          for (const c of living) { c.hp = maxHp(c, g.data); c.mp = maxMp(c); for (const k of Object.keys(c.cond)) if (c.cond[k] !== Infinity) delete c.cond[k]; }
          g.log(`You rest at the Stone Hearth (${cost} gold). Everyone wakes whole.`, 'good'); this.render();
        } }, `Rest (${cost} gold)`),
        h('button', { disabled: g.gold < 2, onclick: () => { g.gold -= 2; for (const c of living) c.hp = Math.min(maxHp(c, g.data), c.hp + 3); g.log('Ale Warmth: +3 HP all round. Mira does not charge for the second one.', 'good'); this.render(); } }, 'Drink (2 gold)')),
      ...this.npcButtons(['barkeep', 'hooded_figure', 'bard']));
  }

  p_store() {
    const g = this.g, D = g.data;
    const stock = Object.values(D.items.shop).flat().filter((k) => itemDef(k));
    const sellRows = [];
    for (const c of g.party) c.pack.forEach((it, i) => {
      if (!it || !itemDef(it.key)?.value || it.key.startsWith('lore:')) return;
      sellRows.push(h('button', { onclick: () => { g.gold += this.sellPrice(it.key); removeFromPack(c, it.key, 1); g.log(`Sold ${itemDef(it.key).name} for ${this.sellPrice(it.key)} gold.`); this.render(); } },
        `${itemDef(it.key).name}${it.n > 1 ? ' x' + it.n : ''}`, h('small', {}, `${c.name} · sell for ${this.sellPrice(it.key)}`)));
    });
    return h('div', {}, h('p', { class: 'lore' }, 'Cluttered shelves, dried herbs and iron. Something sealed in wax on the top shelf. He does not look up when you enter.'),
      ...this.npcButtons(['hemlock']),
      h('h3', { style: { marginTop: '12px' } }, 'Buy'),
      h('div', { class: 'grid-btns' }, ...stock.map((k) => h('button', { disabled: g.gold < this.buyPrice(k), onclick: () => {
        const to = g.party.find((c) => addToPack(c, k, 1));
        if (!to) return g.log('Every pack is full.');
        g.gold -= this.buyPrice(k); g.log(`Bought ${itemDef(k).name} (${to.name}).`); this.render();
      }, title: describeItem(k) }, `${itemDef(k).name} · ${this.buyPrice(k)}g`, h('small', {}, describeItem(k))))),
      h('h3', { style: { marginTop: '12px' } }, 'Sell'),
      sellRows.length ? h('div', { class: 'grid-btns' }, ...sellRows) : h('p', { class: 'muted' }, 'Nothing to sell.'));
  }

  p_shrine() {
    const g = this.g, D = g.data;
    const dead = g.party.filter((c) => !c.alive);
    const out = h('div', {});
    const lookFlame = () => { g.flags.flame = true; g.log('The flame moves in three interlocked spirals. The pattern stays with you after you look away.', 'lore'); this.checkSymbol(); this.render(); };
    const lookAltar = () => { g.flags.altar = true; g.log('Carved in a ring around the altar: flame - stone - silence - flame - stone - silence. The three-flame seal.', 'lore'); this.checkSymbol(); this.render(); };
    return h('div', {}, h('p', { class: 'lore' }, 'Crumbling stone, carvings worn smooth. Forest sounds stop at the threshold. Someone left fresh flowers this morning.'),
      h('div', { class: 'grid-btns' },
        h('button', { onclick: () => {
          for (const c of g.party) if (c.alive) { c.cond.blessed = 180; c.cond.attuned = 600; }
          g.questEvent('pray_shrine');
          g.log('You pray. The flame burns white-blue. The party is Blessed and Attuned (steadier against the Ley-Bleed).', 'good'); this.render();
        } }, 'Pray', h('small', {}, 'Blessed (+2 to hit) and Attuned: Ley feedback risk is lower.')),
        h('button', { disabled: g.flags.fountainUsed, onclick: () => { g.flags.fountainUsed = true; for (const c of g.party) if (c.alive) { c.hp = maxHp(c, D); c.mp = maxMp(c); } g.log('The sacred spring. Full health, once per visit.', 'good'); this.render(); } }, 'Drink from the fountain', h('small', {}, g.flags.fountainUsed ? 'Used this visit.' : 'Full heal, once per visit.')),
        h('button', { onclick: lookFlame }, 'Look at the flame', h('small', {}, g.flags.flame ? 'You carry its pattern.' : '')),
        h('button', { onclick: lookAltar }, 'Look at the altar', h('small', {}, g.flags.altar ? 'You read the inscription.' : '')),
        ...dead.map((c) => h('button', { disabled: g.gold < 25 * c.level, onclick: () => { g.gold -= 25 * c.level; c.alive = true; c.hp = Math.ceil(maxHp(c, D) / 2); g.log(`${c.name} returns, gasping. (${25 * c.level} gold)`, 'good'); this.ui.hud.buildParty(); this.render(); } }, `Raise ${c.name}`, h('small', {}, `${25 * c.level} gold`))),
        h('button', { disabled: g.gold < 100, onclick: () => { g.gold -= 100; for (const c of g.party) for (const m of gainXp(c, 60, D)) g.log(m, 'good'); g.log('You leave 100 gold in the offering bowl, beside the old copper coin and the tooth. (+60 XP each)'); this.render(); } }, 'Offer 100 gold', h('small', {}, '+60 XP each'))),
      out);
  }

  checkSymbol() {
    const g = this.g;
    if (g.flags.flame && g.flags.altar && !g.flags.symbolGiven) {
      g.flags.symbolGiven = true;
      g.addItemToParty('symbol_of_the_silent_ones');
      g.log('Flame and altar: the same pattern. You understand the three-flame seal. (Symbol of the Silent Ones: opens sealed shrines, silences cracked crystals, steadies casters against the Ley-Bleed.)', 'good');
    }
  }

  p_hut() {
    const g = this.g, D = g.data;
    const have = (k) => g.party.some((c) => packHas(c, k));
    const recipes = Object.entries(D.items.alchemy.recipes);
    return h('div', {}, h('p', { class: 'lore' }, 'A lean-to behind the shrine, thick with drying herbs. Her ledger has margin notes in an older, shakier hand.'),
      ...this.npcButtons(['maren']),
      h('div', { class: 'grid-btns', style: { marginTop: '10px' } }, ...recipes.map(([id, r]) => {
        const ok = r.ingredients.every(have);
        return h('button', { disabled: !ok, onclick: () => {
          for (const k of r.ingredients) { const c = g.party.find((p) => packHas(p, k)); removeFromPack(c, k, 1); }
          g.addItemToParty(r.result);
          g.log(`Brewed ${itemDef(r.result)?.name || r.name}.`, 'good'); this.render();
        } }, r.name, h('small', {}, r.ingredients.map((k) => `${have(k) ? '✓' : '○'} ${itemDef(k)?.name || k}`).join(' + ')), h('small', {}, r.description));
      })));
  }

  questBoard(npc) {
    const g = this.g, D = g.data;
    const lvl = Math.max(...g.party.map((c) => c.level));
    const rows = Object.entries(D.lore.quests).filter(([, q]) => q.npc === npc && this.questDoable(q)).map(([id, q]) => {
      const st = g.flags.quests[id];
      const req = q.requirements?.level || 1;
      if (st?.state === 'done') return h('p', { class: 'muted' }, `${q.name}: complete.`);
      if (st) return h('p', {}, h('b', {}, q.name), ' (active) ', h('span', { class: 'muted' }, q.tasks.map((t) => `${st.done.includes(t) ? '✓' : '○'} ${t.replace(/_/g, ' ')}`).join('  ')));
      return h('div', { class: 'row', style: { marginBottom: '6px' } }, h('button', { disabled: lvl < req, onclick: () => { g.flags.quests[id] = { state: 'active', done: [] }; g.log(`Quest accepted: ${q.name}.`, 'good'); this.render(); } }, `Accept: ${q.name}`),
        h('span', { class: 'lore' }, q.description), lvl < req ? h('span', { class: 'muted' }, `(level ${req})`) : null);
    });
    return rows.length ? h('div', { style: { marginTop: '10px' } }, h('h3', {}, 'Quests'), ...rows) : null;
  }

  p_elara() {
    return h('div', {}, h('p', { class: 'lore' }, 'A weary woman with silver-streaked hair and careful eyes. Her hands are folded on the table.'), ...this.npcButtons(['elara']), this.questBoard('elara'));
  }

  p_tower() {
    return h('div', {}, h('p', { class: 'lore' }, 'Rickety stairs, a view of the Whisperwood canopy. The guard does not turn from the window.'), ...this.npcButtons(['guard']), this.questBoard('guard'), this.questBoard('hooded_figure'));
  }

  p_descend() {
    const g = this.g;
    const stops = g.liftStops();
    return h('div', {}, h('p', { class: 'lore' }, 'Two days east through the Whisperwood, the Aeridor Ruins. Stone older than memory. The ground hums. Beneath them, the white spires lie toppled in the dark, and below the spires the Ironvein Deep goes down into the Spine of the World.'),
      h('div', { class: 'grid-btns' }, ...stops.map((L) => h('button', { onclick: () => { saveToStorage(g); this.hide(); g.enterLevel(L, 'up'); } },
        L === 1 ? 'Enter the Shattered Spires' : `Resonance Lift: ${g.levelInfo(L).name}`,
        h('small', {}, L === 1 ? 'The ruins, from the top.' : 'The lift stops at every fifth floor you have reached.')))));
  }
}

export { RUINS_FLOORS, itemKind };
