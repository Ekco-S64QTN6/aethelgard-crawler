// Spells and the Ley-Bleed.
//
// Aethelgard's magic is Resonance drawn through the broken crystalline network
// of Aeridor. Where a conduit is fractured, Resonance bleeds into the stone:
// every block of a level carries a Ley-Bleed value (levelgen.computeLey), high
// near cracked crystals and higher the deeper the party goes. Casting there is
// stronger and less safe: the spell is amplified, and it can feed back.
// Mitigation follows the lore: flame - stone - silence. A blessing, the
// Shrine's attunement and the Symbol of the Silent Ones all steady a caster.
import { mod, effStat, casterStat, klass, buff, maxHp, maxMp } from './party.js';

export const SPELLS = {
  arcane_surge: { name: 'Arcane Surge', classes: ['Mage', 'Wizard', 'Necromancer'], level: 1, mp: 3, kind: 'bolt', dice: [1, 8], power: 1, desc: "Sylvara's spark: raw Resonance at the first foe ahead." },
  song_of_silence: { name: 'Song of Silence', classes: ['Mage', 'Wizard', 'Necromancer'], level: 3, mp: 5, kind: 'hold', dur: 5, power: 2, desc: 'Flame, stone, silence. The foe ahead stops moving.' },
  sylvaras_storm: { name: "Sylvara's Storm", classes: ['Mage', 'Wizard', 'Necromancer'], level: 5, mp: 8, kind: 'storm', dice: [2, 6], power: 3, desc: 'Chaos and change: lightning through every foe in sight.' },
  arcane_nova: { name: 'Arcane Nova', classes: ['Wizard'], level: 6, mp: 10, kind: 'nova', dice: [2, 10], power: 4, desc: 'The resonance sings aloud: everything around the party burns.' },
  death_touch: { name: 'Death Touch', classes: ['Necromancer'], level: 6, mp: 7, kind: 'drain', dice: [2, 8], undeadMul: 1.5, power: 3, desc: "Morvenna's final lesson. Drains the foe ahead." },
  thornax_mending: { name: "Thornax's Mending", classes: ['Cleric', 'High Priest', 'Shaman', 'Paladin', 'Warden'], level: 1, mp: 3, kind: 'heal', dice: [1, 8], power: 1, desc: 'Balance restored: heals the most wounded ally.' },
  aerthis_ward: { name: "Aerthis' Ward", classes: ['Cleric', 'High Priest', 'Shaman', 'Paladin'], level: 2, mp: 4, kind: 'ward', dur: 45, power: 1, desc: 'Order and structure: the party is Fortified (+2 DEF).' },
  undead_bane: { name: 'Undead Bane', classes: ['Cleric', 'High Priest', 'Paladin'], level: 3, mp: 4, kind: 'bolt', dice: [2, 6], undeadMul: 2, power: 2, desc: 'Holy light. Twice as hard against the returned.' },
  blessing: { name: 'Blessing of the Silent Ones', classes: ['Cleric', 'High Priest', 'Shaman'], level: 4, mp: 5, kind: 'bless', dur: 40, power: 2, desc: 'The party is Blessed (+2 to hit), and steadier against the Bleed.' },
  morvennas_mercy: { name: "Morvenna's Mercy", classes: ['High Priest'], level: 6, mp: 9, kind: 'heal_all', dice: [2, 8], power: 3, desc: 'Endings deferred: heals the whole party.' },
  spirit_wrath: { name: 'Spirit Wrath', classes: ['Shaman'], level: 6, mp: 7, kind: 'bolt', dice: [3, 6], power: 3, desc: 'The old signs, read aloud. Spirits strike the foe ahead.' },
  holy_smite: { name: 'Holy Smite', classes: ['Paladin'], level: 5, mp: 4, kind: 'bolt', dice: [1, 10], undeadMul: 2, power: 2, melee: true, desc: "Aerthis' oath, struck into the foe in front." },
  harm_touch: { name: 'Harm Touch', classes: ['Shadowknight'], level: 5, mp: 4, kind: 'drain', dice: [2, 8], power: 2, desc: 'A dark blade of Morvenna drinks from the foe in front.' },
  forest_fury: { name: 'Forest Fury', classes: ['Warden'], level: 5, mp: 4, kind: 'bolt', dice: [2, 6], power: 2, desc: 'Thornax approves. Thorns lash the foe ahead.' },
  tree_memory: { name: 'Tree Memory', classes: ['Warden', 'Shaman'], level: 5, mp: 4, kind: 'buff', cond: 'tree_memory', dur: 45, power: 1, desc: 'The party remembers bark: -2 damage from natural creatures.' },
};

export function knownSpells(c) {
  const k = klass(c);
  return Object.entries(SPELLS)
    .filter(([, s]) => (s.classes.includes(k) || s.classes.includes(c.cls)) && c.level >= s.level)
    .map(([id]) => id);
}

export function spellPower(c) {
  const st = casterStat(c);
  return st ? mod(effStat(c, st)) : 0;
}

// ── Ley-Bleed ───────────────────────────────────────────────────────────────
export function bleedLabel(f) {
  if (f < 0.15) return 'Stable';
  if (f < 0.35) return 'Thrumming';
  if (f < 0.65) return 'Fractured';
  return 'Hemorrhaging';
}

export function mitigation(c, partyHasSymbol) {
  let m = 0;
  if (buff(c, 'blessed')) m += 0.25;
  if (buff(c, 'attuned')) m += 0.4;
  if (partyHasSymbol) m += 0.25;
  m += Math.max(0, mod(effStat(c, 'wis'))) * 0.03;
  return Math.min(0.8, m);
}

export function feedbackRisk(field, power, mit) {
  return Math.max(0, Math.min(0.85, field * (0.25 + 0.12 * power) * (1 - mit)));
}

export function amplification(field) {
  return 1 + Math.min(1.2, field) * 0.5;
}

// Feedback outcomes. `w(f)` weights each by local field strength, so the worst
// effects only appear where the stone is hemorrhaging.
export const FEEDBACK = [
  { id: 'surge', w: () => 3, text: 'The Bleed pours into the spell. It lands twice as hard.' },
  { id: 'backlash', w: () => 3, text: 'The Resonance bites back through the caster.' },
  { id: 'fizzle', w: () => 2, cancels: true, text: 'The stone swallows the spell whole. The crystals ring, once.' },
  { id: 'hemorrhage', w: () => 2, text: 'Mana drains out of every caster like blood from a cut.' },
  { id: 'silence', w: () => 2, text: 'Silence falls. For a while, no one can find the words.' },
  { id: 'flare', w: () => 2, text: 'A flare of white light: everything nearby reels, blinded.' },
  { id: 'quake', w: (f) => (f > 0.4 ? 3 : 1), text: 'The walls shudder. Dust and worse rains down on everyone.' },
  { id: 'phase_slip', w: (f) => (f > 0.3 ? 2 : 0.7), text: 'The floor folds. The party is somewhere else.' },
  { id: 'rupture', w: (f) => (f > 0.3 ? 2 : 0.8), text: 'A conduit tears wider. The Bleed in this place grows.' },
  { id: 'echo', w: (f) => (f > 0.35 ? 2 : 0.4), text: 'Something old answers the call and takes a shape.' },
  { id: 'blight_bloom', w: (f) => (f > 0.45 ? 2 : 0.4), text: 'Blight blooms across the stone. Every creature on this floor drinks it in.' },
  { id: 'whisper', w: () => 1.5, text: 'For a heartbeat you hear Oakhaven, very far away.' },
];

export function rollFeedback(rng, field) {
  return rng.weighted(FEEDBACK.map((f) => [f, f.w(field)]));
}

export function healAmount(c, rng, dice, amp, data) {
  const mult = (data.classes.advanced[c.cls]?.[c.adv]?.bonuses?.heal_mult) || (c.cls === 'Cleric' && !c.adv ? 1.25 : 1);
  let t = 0;
  for (let i = 0; i < dice[0]; i++) t += rng.d(dice[1]);
  return Math.max(1, Math.round((t + Math.max(0, spellPower(c))) * amp * mult));
}

export function damageAmount(c, rng, dice, amp) {
  let t = 0;
  for (let i = 0; i < dice[0]; i++) t += rng.d(dice[1]);
  return Math.max(1, Math.round((t + Math.max(0, spellPower(c))) * amp));
}

export function mpRegenPerSec(c) {
  const line = c.cls === 'Mage' ? 2 : 1; // Kaiacord's Mage "stay" path: mana regen
  return (0.18 + Math.max(0, spellPower(c)) * 0.03) * line;
}

export { maxHp, maxMp };
