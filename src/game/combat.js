// Combat resolution, ported from Kaiacord's combat_engine and made real-time:
// each party slot acts on its own cooldown timer instead of in rounds.
//   to-hit: d20 + attack mod vs monster DEF (nat 1 misses, crit threshold hits)
//   damage: weapon die + attack-stat mod + weapon bonus; a crit doubles the dice
//   procs:  class proc and weapon proc, 10% on a hit, 50% on a crit
//   monster: d20 + ATK vs party DEF (nat 20 hits); tier dice + ATK/2, crit = max dice
import { itemDef } from './items.js';
import { attackMod, critThreshold, advBonuses, defense, effStat, attackStat, mod, buff, klass } from './party.js';
import { isUndead, isNatural } from './monsters.js';

export function undeadCheck(mon, data) {
  return isUndead(mon, data.classes.undead_names.map((n) => n.replace(/_/g, ' ')));
}

export function resolvePlayerHit(c, mon, data, rng, { bonusDmg = 0 } = {}) {
  const undead = undeadCheck(mon, data);
  const am = attackMod(c, data, { vsUndead: undead });
  const raw = rng.d(20);
  const res = { raw, total: raw + am, hit: false, crit: false, fumble: false, dmg: 0, procs: [], heal: 0 };
  if (raw === 1) { res.fumble = true; return res; }
  const crit = raw >= critThreshold(c, data);
  if (!crit && raw + am < mon.def) return res;
  res.hit = true;
  res.crit = crit;
  const w = c.equip.weapon && itemDef(c.equip.weapon);
  const die = w?.damage_die || 4;
  const sm = mod(effStat(c, attackStat(c, data)));
  let dmg = rng.d(die) + (crit ? rng.d(die) : 0) + sm + (w?.damage_bonus || 0) + bonusDmg;
  const b = advBonuses(c, data);
  if (crit) dmg += b.crit_damage_bonus || 0;
  if (buff(c, 'mirror_resolve')) dmg += 2;
  const pChance = crit ? 0.5 : 0.1;
  // Class proc (Onslaught, True Shot, Arcane Surge, Backstab, Undead Bane, ...)
  const cp = data.classes.procs[klass(c)];
  if (cp && rng.next() < pChance) {
    if (cp.type === 'heal') { res.heal += cp.heal; res.procs.push(cp.name); }
    else if (cp.type !== 'undead' || undead) {
      dmg += rng.d(cp.die === 'weapon' ? die : cp.die);
      res.procs.push(cp.name);
    }
  }
  // Weapon proc (T3+ weapons)
  if (w?.proc && rng.next() < pChance) { dmg += rng.d(w.proc.die); res.procs.push(w.proc.name); }
  dmg = Math.max(1, dmg);
  if (mon.ward) dmg = Math.max(1, Math.round(dmg * (1 - mon.ward / 100))); // Resonance Ward
  if (b.lifesteal_pct) res.heal += Math.max(1, Math.floor(dmg * b.lifesteal_pct));
  res.dmg = dmg;
  return res;
}

export function resolveMonsterHit(mon, c, data, rng) {
  const raw = rng.d(20);
  const def = defense(c, data);
  const res = { raw, hit: false, crit: false, dmg: 0 };
  if (raw !== 20 && raw + mon.atk < def) return res;
  res.hit = true;
  res.crit = raw === 20;
  const [n, s] = data.combat.tier_damage[mon.tier] || [1, 6];
  let dmg = 0;
  for (let i = 0; i < n; i++) dmg += res.crit ? s : rng.d(s);
  dmg = Math.max(1, Math.round((dmg + Math.floor(mon.atk / 2)) * (mon.dmgScale ?? 1)));
  if (buff(c, 'tree_memory') && isNatural(mon)) dmg = Math.max(0, dmg - 2);
  res.dmg = dmg;
  return res;
}

// Which party slot a monster at (mx, my) strikes, given the party's facing:
// front rank (0, 1) from ahead, back rank (2, 3) from behind, a flank column
// from the sides. Dead or missing members are skipped.
export function targetSlot(party, partyX, partyY, dir, mx, my, rng) {
  const fdx = [0, 1, 0, -1][dir], fdy = [-1, 0, 1, 0][dir];
  const rx = -fdy, ry = fdx; // right-hand vector
  const ahead = (mx - partyX) * fdx + (my - partyY) * fdy;
  const side = (mx - partyX) * rx + (my - partyY) * ry;
  let order;
  if (ahead > 0) order = [[0, 1], [2, 3]];
  else if (ahead < 0) order = [[2, 3], [0, 1]];
  else if (side > 0) order = [[1, 3], [0, 2]];
  else order = [[0, 2], [1, 3]];
  for (const group of order) {
    const alive = group.filter((i) => party[i] && party[i].alive);
    if (alive.length) return alive[rng.int(alive.length)];
  }
  return -1;
}
