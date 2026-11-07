// Characters and the party, following Kaiacord's !rpg rules:
// 4d6-drop-lowest + race bonuses, HP per level by class, Kaiacord's DEF soft
// cap and attack caps, titles, and level-5 class advancement (or "stay").
import { itemDef, isStackable, canEquip, weaponReach } from './items.js';

export const BASE_CLASSES = ['Warrior', 'Ranger', 'Mage', 'Rogue', 'Cleric'];
export const PACK_SLOTS = 16;
export const SLOTS = ['weapon', 'armor', 'head', 'boots', 'accessory'];

const STARTER = {
  Warrior: { weapon: 'rusted_greatsword', armor: 'iron_plating', head: 'soldiers_cap', boots: 'worn_boots' },
  Ranger: { weapon: 'hunting_bow', armor: 'rangers_vest', head: 'ranger_hat', boots: 'worn_boots' },
  Mage: { weapon: 'apprentice_wand', armor: 'novice_robes', head: 'mages_cap', boots: 'worn_boots' },
  Rogue: { weapon: 'shiv', armor: 'cutpurse_leathers', head: 'shadow_cap', boots: 'worn_boots' },
  Cleric: { weapon: 'acolyte_mace', armor: 'acolyte_vestments', head: 'novice_hood', boots: 'worn_boots' },
};

// Spellcasting: full casters and the hybrid advanced classes.
const FULL_CASTERS = { Mage: 'int', Wizard: 'int', Necromancer: 'int', Cleric: 'wis', 'High Priest': 'wis', Shaman: 'wis' };
const HALF_CASTERS = { Paladin: 'wis', Shadowknight: 'int', Warden: 'wis' };

export const mod = (v) => Math.floor((v - 10) / 2);
let uid = 1;

export function rollStats(rng, race, data) {
  const bonus = data.classes.races[race] || {};
  const out = {};
  for (const s of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
    const dice = [rng.d(6), rng.d(6), rng.d(6), rng.d(6)].sort((a, b) => a - b).slice(1);
    out[s] = dice[0] + dice[1] + dice[2] + (bonus[s] || 0);
  }
  return out;
}

export function createCharacter({ name, race, cls, portrait, stats }, data, rng) {
  const st = stats || rollStats(rng, race, data);
  const hpDie = data.classes.hp_per_level[cls];
  const baseHp = Math.max(2, hpDie + mod(st.con) + 1);
  const c = {
    id: uid++, name, race, cls, adv: null, advPending: false, statPending: 0,
    portrait, level: 1, xp: 0, stats: st, baseHp,
    hp: 0, mp: 0,
    equip: { weapon: null, armor: null, head: null, boots: null, accessory: null },
    pack: new Array(PACK_SLOTS).fill(null),
    cond: {},            // condition -> seconds left (Infinity = until used)
    ready: 0,            // game time when the next action is allowed
    cdTotal: 1,          // length of the current cooldown (for the UI sweep)
    alive: true, flash: 0, lastSpell: null,
  };
  const kit = STARTER[cls] || {};
  for (const [slot, key] of Object.entries(kit)) if (itemDef(key)) c.equip[slot] = key;
  for (const key of ['bandage', 'healing_herb', 'potion_standard']) addToPack(c, key, 1);
  if (cls === 'Mage' || cls === 'Cleric') addToPack(c, 'ether', 1);
  c.hp = maxHp(c, data);
  c.mp = maxMp(c);
  return c;
}

export const klass = (c) => c.adv || c.cls;

export function advBonuses(c, data) {
  if (!c.adv) return {};
  return data.classes.advanced[c.cls]?.[c.adv]?.bonuses || {};
}

export function effStat(c, s) {
  const a = c.equip.armor && itemDef(c.equip.armor);
  return c.stats[s] + ((a && a.stat_bonus && a.stat_bonus[s]) || 0);
}

export function attackStat(c, data) {
  if (c.adv === 'Wizard') return 'int';
  if (c.adv === 'High Priest') return 'wis';
  return data.classes.attack_stat[c.cls] || 'str';
}

export function gearHp(c) {
  let t = 0;
  for (const s of SLOTS) { const d = c.equip[s] && itemDef(c.equip[s]); if (d && d.hp_bonus) t += d.hp_bonus; }
  return t;
}

export function maxHp(c, data) {
  return Math.max(1, c.baseHp + gearHp(c) + (advBonuses(c, data).hp_bonus || 0));
}

export function casterStat(c) {
  return FULL_CASTERS[klass(c)] || HALF_CASTERS[klass(c)] || FULL_CASTERS[c.cls] || null;
}

export function maxMp(c) {
  const k = klass(c);
  if (FULL_CASTERS[k] || (!HALF_CASTERS[k] && FULL_CASTERS[c.cls])) {
    return Math.max(4, 6 + c.level * 3 + 2 * mod(effStat(c, casterStat(c))));
  }
  if (HALF_CASTERS[k]) return Math.max(2, 2 + c.level * 2 + mod(effStat(c, HALF_CASTERS[k])));
  return 0;
}

export const buff = (c, name) => (c.cond[name] || 0) > 0;

// Kaiacord combat_engine: attack modifier, capped at level * 1.15 + 4.
export function attackMod(c, data, { vsUndead = false } = {}) {
  const b = advBonuses(c, data);
  const w = c.equip.weapon && itemDef(c.equip.weapon);
  const acc = c.equip.accessory && itemDef(c.equip.accessory);
  let m = mod(effStat(c, attackStat(c, data)));
  m += (w?.attack_bonus || 0) + (acc?.attack_bonus || 0) + (b.atk_bonus || 0) + (b.spell_atk_bonus || 0);
  if (vsUndead) m += b.atk_vs_undead || 0;
  if (buff(c, 'blessed')) m += 2;
  if (buff(c, 'embered')) m += 2;
  if (buff(c, 'lucky')) m += 1;
  if (buff(c, 'hunters_focus')) m += 2;
  if (buff(c, 'weakened')) m = Math.floor(m / 2);
  return Math.min(m, Math.floor(c.level * 1.15) + 4);
}

// Kaiacord: 10 + DEX mod + soft-capped gear DEF + advanced DEF, capped at L*1.5+12.
export function defense(c, data) {
  let gear = 0;
  for (const s of ['armor', 'head', 'boots', 'accessory']) { const d = c.equip[s] && itemDef(c.equip[s]); if (d) gear += d.defense_bonus || 0; }
  const soft = Math.min(10, gear) + Math.floor(Math.max(0, gear - 10) / 2);
  let def = 10 + mod(effStat(c, 'dex')) + soft + (advBonuses(c, data).def_bonus || 0);
  if (buff(c, 'fortified')) def += 2;
  if (buff(c, 'wisp_ward')) def += 1;
  return Math.min(def, Math.floor(c.level * 1.5 + 12));
}

export function critThreshold(c, data) {
  const b = advBonuses(c, data);
  if (b.crit_threshold) return b.crit_threshold;
  return c.cls === 'Rogue' ? 19 : 20;
}

// Real-time pacing: heavier weapons swing slower, DEX quickens them.
export function attackCooldown(c) {
  const w = c.equip.weapon && itemDef(c.equip.weapon);
  const die = w?.damage_die || 4;
  return Math.max(0.6, 0.75 + die * 0.09 - mod(effStat(c, 'dex')) * 0.04);
}

export function reach(c) {
  return weaponReach(c.equip.weapon);
}

export function title(c, data) {
  const t = data.classes.titles[klass(c)] || data.classes.titles[c.cls] || {};
  let best = '';
  for (const [lv, name] of Object.entries(t)) if (c.level >= Number(lv)) best = name;
  return best;
}

export function xpFor(level, data) {
  return data.classes.xp_thresholds[String(level)] ?? Infinity;
}

// Award XP; returns a list of messages for level-ups.
export function gainXp(c, amount, data) {
  const msgs = [];
  if (!c.alive) return msgs;
  const b = advBonuses(c, data);
  c.xp += Math.round(amount * (1 + (b.xp_bonus_pct || 0)) * (buff(c, 'xp_boost') ? 1.25 : 1));
  while (c.level < 15 && c.xp >= xpFor(c.level + 1, data)) {
    c.level++;
    const gain = Math.max(1, data.classes.hp_per_level[c.cls] + mod(c.stats.con));
    c.baseHp += gain;
    c.hp += gain;
    if (c.level === 4 || c.level === 8 || c.level === 12) c.statPending++;
    if (c.level === 5 && !c.adv) c.advPending = true;
    c.mp = Math.min(maxMp(c), c.mp + 3);
    msgs.push(`${c.name} reaches level ${c.level}: ${title(c, data)} (+${gain} HP).`);
  }
  return msgs;
}

export function raiseStat(c, stat, data) {
  if (c.statPending <= 0) return false;
  const before = mod(c.stats.con);
  c.stats[stat]++;
  c.statPending--;
  if (stat === 'con') {
    const delta = (mod(c.stats.con) - before) * c.level; // Kaiacord: retroactive CON
    c.baseHp += delta;
    c.hp += delta;
  }
  c.hp = Math.min(c.hp, maxHp(c, data));
  return true;
}

export function advance(c, choice, data) {
  const opts = data.classes.advanced[c.cls];
  if (!opts || !opts[choice]) return null;
  c.adv = choice;
  c.advPending = false;
  c.hp = Math.min(maxHp(c, data), c.hp + (opts[choice].bonuses.hp_bonus || 0));
  c.mp = Math.min(maxMp(c), c.mp);
  return opts[choice];
}

// ── Inventory ───────────────────────────────────────────────────────────────
export function addToPack(c, key, n = 1) {
  if (isStackable(key)) {
    const s = c.pack.find((p) => p && p.key === key);
    if (s) { s.n += n; return true; }
  }
  const i = c.pack.indexOf(null);
  if (i < 0) return false;
  c.pack[i] = { key, n };
  return true;
}

export function removeFromPack(c, key, n = 1) {
  const i = c.pack.findIndex((p) => p && p.key === key);
  if (i < 0) return false;
  c.pack[i].n -= n;
  if (c.pack[i].n <= 0) c.pack[i] = null;
  return true;
}

export function packHas(c, key) {
  return c.pack.some((p) => p && p.key === key);
}

// Equip from the pack (swapping out whatever was worn). Returns an error string or null.
export function equipFromPack(c, idx, data) {
  const it = c.pack[idx];
  if (!it) return 'Nothing there.';
  const d = itemDef(it.key);
  if (!d || !SLOTS.includes(d.slot)) return `${d ? d.name : it.key} can't be worn.`;
  if (!canEquip(c, it.key)) return `${c.name} (${klass(c)}) can't use ${d.name}.`;
  const old = c.equip[d.slot];
  c.equip[d.slot] = it.key;
  c.pack[idx] = old ? { key: old, n: 1 } : null;
  c.hp = Math.min(c.hp, maxHp(c, data));
  c.mp = Math.min(c.mp, maxMp(c));
  return null;
}

export function unequip(c, slot, data) {
  const key = c.equip[slot];
  if (!key) return 'Nothing equipped.';
  if (!addToPack(c, key, 1)) return 'Pack is full.';
  c.equip[slot] = null;
  c.hp = Math.min(c.hp, maxHp(c, data));
  return null;
}
