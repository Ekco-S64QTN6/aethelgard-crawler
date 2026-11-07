// Game state and rules: the glue between the engine (grid, movement,
// renderer) and Aethelgard's content (party, combat, magic, levels, town).
import { DX, DY, ckey, DIR_NAMES } from '../engine/grid.js';
import { Mover, FORWARD } from '../engine/movement.js';
import { Rng, rng as globalRng } from '../core/rng.js';
import { buildLevel, levelInfo, TOTAL_LEVELS, RUINS_FLOORS, rollLoot, lootTier, computeLey } from './levelgen.js';
import { makeMonster, updateMonsters } from './monsters.js';
import { itemDef } from './items.js';
import {
  maxHp, maxMp, gainXp, addToPack, removeFromPack, packHas, attackCooldown, reach, klass, title, advance,
} from './party.js';
import { resolvePlayerHit, resolveMonsterHit, targetSlot, undeadCheck } from './combat.js';
import {
  SPELLS, knownSpells, feedbackRisk, mitigation, amplification, rollFeedback, healAmount, damageAmount, mpRegenPerSec, bleedLabel,
} from './magic.js';

// "the goblin", but "The Mountain Heart" already carries its article.
const the = (m) => (/^The /.test(m.name) ? m.name : `the ${m.name}`);
const The = (m) => { const s = the(m); return s[0].toUpperCase() + s.slice(1); };

const DOOR_SPEED = 1.8;     // panel travel per second
const REACH_FACE = 1.05;    // click distance for wall objects (the adjacent wall)
const REACH_DOOR = 1.6;     // a door one block ahead

export class Game {
  constructor(data, { seed = (Date.now() & 0x7fffffff), rng = globalRng } = {}) {
    this.data = data;
    this.seed = seed;
    this.rng = rng;
    this.party = [];
    this.gold = 0;
    this.mode = 'title';      // title | create | dungeon | town | blackout | victory
    this.L = 0;
    this.level = null;
    this.levels = new Map();  // L -> Level (kept for the session; saved by save.js)
    this.mover = new Mover(0, 0, 0);
    this.time = 0;
    this.hand = null;         // item held on the cursor: { key, n }
    this.flags = { flame: false, altar: false, symbolGiven: false, liftStops: [], kills: {}, seenMonsters: {}, pagesFound: [], setsDone: [], quests: {}, fountainUsed: false };
    this.deepest = 0;
    this.listeners = {};
    this.viewTint = null;     // { rgb:[r,g,b], t }
    this.shake = 0;
    this.lastRoom = null;
    this.input = [];          // buffered movement commands
  }

  // ── Events (UI, audio) ────────────────────────────────────────────────────
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, ...a) { for (const fn of this.listeners[ev] || []) fn(...a); }
  log(msg, cls = '') { this.emit('log', msg, cls); }
  sfx(name) { this.emit('sfx', name); }

  // ── Setup ─────────────────────────────────────────────────────────────────
  startNew(party) {
    this.party = party;
    this.gold = 30;
    this.flags.quests = {};
    this.goTown('You arrive in Oakhaven, where the Trade Road meets the Whisperwood edge. Grey, damp, watchful. The smell of woodsmoke and wet earth.');
  }

  goTown(msg) {
    this.mode = 'town';
    this.level = null;
    this.flags.fountainUsed = false;
    this.emit('ambient', null);
    if (msg) this.log(msg, 'lore');
    this.emit('mode', 'town');
  }

  // arrive: 'up' = came down the stairs (start at the up stairs), 'down' = climbed up.
  enterLevel(L, arrive = 'up') {
    this.L = L;
    if (!this.levels.has(L)) this.levels.set(L, buildLevel(L, this.data, this.seed));
    this.level = this.levels.get(L);
    const lv = this.level;
    const m = lv.meta;
    if (arrive === 'down' && m.down) {
      const [sx, sy] = m.down;
      const [fx, fy, d] = lv.openNeighbors(sx, sy)[0];
      this.mover.place(fx, fy, d);
    } else {
      this.mover.place(m.start.x, m.start.y, m.start.dir);
    }
    this.mode = 'dungeon';
    this.resting = false;
    this.deepest = Math.max(this.deepest, L);
    if (m.kind === 'spine' && (m.floor === 1 || m.floor % 5 === 0) && !this.flags.liftStops.includes(L)) {
      this.flags.liftStops.push(L);
      this.log(`The Resonance Lift will now stop here (Ironvein Deep ${m.floor}).`, 'good');
    }
    this.lastRoom = null;
    this.floorMapDirty = true;
    this.log(`${m.name}`, 'title');
    this.log(m.flavor, 'lore');
    this.emit('mode', 'dungeon');
    this.emit('ambient', m.theme);
    this.markSeen();
    this.emit('save');
  }

  liftStops() {
    return [1, ...this.flags.liftStops.filter((l) => l > RUINS_FLOORS)];
  }

  // ── Per-frame update ──────────────────────────────────────────────────────
  update(dt) {
    if (this.mode !== 'dungeon') return;
    this.time += dt;
    const finished = this.mover.update(dt);
    if (finished) this.markSeen();
    if (!this.mover.busy && this.input.length) this.runCommand(this.input.shift());
    const lv = this.level;
    for (const c of lv.cells.values()) {
      for (const b of [c.door, c.gate]) {
        if (!b || b.open === b.target) continue;
        const dir = Math.sign(b.target - b.open);
        b.open = Math.max(0, Math.min(1, b.open + dir * DOOR_SPEED * dt));
        if ((dir > 0 && b.open >= b.target) || (dir < 0 && b.open <= b.target)) b.open = b.target;
      }
    }
    updateMonsters(this, dt);
    for (const m of lv.monsters) {
      m.vx = m.vx === undefined ? m.x + 0.5 : m.vx + (m.x + 0.5 - m.vx) * Math.min(1, dt * 9);
      m.vy = m.vy === undefined ? m.y + 0.5 : m.vy + (m.y + 0.5 - m.vy) * Math.min(1, dt * 9);
    }
    for (const c of this.party) {
      for (const k of Object.keys(c.cond)) {
        if (c.cond[k] === Infinity) continue;
        c.cond[k] -= dt;
        if (c.cond[k] <= 0) delete c.cond[k];
      }
      c.flash = Math.max(0, c.flash - dt * 3);
      if (c.alive) {
        const mm = maxMp(c);
        if (mm && c.mp < mm) c.mp = Math.min(mm, c.mp + mpRegenPerSec(c) * dt);
      }
    }
    if (this.viewTint) { this.viewTint.t -= dt; if (this.viewTint.t <= 0) this.viewTint = null; }
    this.shake = Math.max(0, this.shake - dt * 2);
    if (this.resting) this.restTick(dt);
  }

  // ── Resting ───────────────────────────────────────────────────────────────
  // Camp in place: HP and mana come back while nothing hostile is near.
  threatNear() {
    const P = this.mover;
    return this.level.monsters.some((m) => m.alive && Math.abs(m.x - P.x) + Math.abs(m.y - P.y) <= (m.awake ? 7 : 2));
  }

  toggleRest() {
    if (this.mode !== 'dungeon') return;
    if (this.resting) { this.stopRest('You break camp.'); return; }
    if (this.threatNear()) { this.log('You cannot rest with enemies nearby.', 'bad'); return; }
    this.resting = true;
    this.log('The party sits with their backs to the stone and rests. (R to stop)');
  }

  stopRest(msg) {
    if (!this.resting) return;
    this.resting = false;
    if (msg) this.log(msg);
  }

  restTick(dt) {
    if (this.threatNear()) { this.stopRest('Something is coming. You scramble to your feet.'); return; }
    let full = true;
    for (const c of this.party) {
      if (!c.alive) continue;
      const mh = maxHp(c, this.data), mm = maxMp(c);
      c.hp = Math.min(mh, c.hp + mh * 0.05 * dt);
      if (mm) c.mp = Math.min(mm, c.mp + mm * 0.06 * dt);
      if (c.hp < mh || (mm && c.mp < mm)) full = false;
    }
    if (full) this.stopRest('Rested. Everyone is whole again.');
  }

  // ── Movement ──────────────────────────────────────────────────────────────
  command(cmd) {
    if (this.mode !== 'dungeon') return;
    this.stopRest();
    if (this.mover.busy) { if (this.input.length < 2) this.input.push(cmd); return; }
    this.runCommand(cmd);
  }

  runCommand(cmd) {
    if (cmd.turn) { this.mover.turn(cmd.turn); return; }
    this.step(cmd.move);
  }

  step(rel) {
    if (this.party.every((c) => !c.alive)) return;
    const lv = this.level;
    const [nx, ny] = this.mover.target(rel);
    const c = lv.cell(nx, ny);
    if (c && c.stairs) { this.takeStairs(c.stairs); return; }
    const r = this.mover.step(lv, rel);
    if (!r.ok) {
      this.sfx('bump');
      if (r.reason === 'barrier') {
        const b = lv.barrierAt(nx, ny);
        this.log(b && b.locked ? 'The door is locked.' : lv.cell(nx, ny).gate ? 'A portcullis bars the way.' : 'The door is shut.');
      } else if (r.reason === 'monster') {
        const m = lv.monsterAt(nx, ny);
        this.log(`${The(m)} blocks the way.`);
      }
      return;
    }
    this.sfx('step');
    this.onArrive(nx, ny);
  }

  onArrive(x, y) {
    const lv = this.level;
    const c = lv.cell(x, y);
    if (c && c.plate && c.plate.armed) this.triggerPlate(x, y, c.plate);
    if (c && c.items.length) {
      const names = c.items.map((i) => itemDef(i.key)?.name || i.key);
      this.log(`On the floor: ${names.join(', ')}.`);
    }
    const room = lv.meta.rooms?.get(ckey(x, y));
    if (room && room.name !== this.lastRoom) {
      this.lastRoom = room.name;
      this.log(`${room.name}. ${room.desc}`, 'lore');
    } else if (!room) this.lastRoom = null;
    const f = lv.ley[lv.idx(x, y)];
    if (f > 0.9 && this.rng.chance(0.08)) this.log('The stone here is wet with Resonance. Your teeth ache.', 'ley');
  }

  takeStairs(kind) {
    if (kind === 'down') {
      if (this.L >= TOTAL_LEVELS) return;
      this.sfx('stairs');
      this.enterLevel(this.L + 1, 'up');
    } else {
      this.sfx('stairs');
      if (this.L === 1) this.goTown('You climb out of the ruins into grey daylight, and walk back to Oakhaven.');
      else this.enterLevel(this.L - 1, 'down');
    }
  }

  triggerPlate(x, y, plate) {
    const scout = this.party.find((c) => c.alive && (c.cls === 'Rogue' || c.cls === 'Ranger'));
    if (scout && this.rng.d(20) + Math.floor((scout.stats.dex - 10) / 2) >= 14) {
      plate.armed = false;
      this.log(`${scout.name} spots the pressure plate and jams it with a dagger. Disarmed.`, 'good');
      this.sfx('plate');
      return;
    }
    this.sfx('trap');
    this.log('Click. Darts hiss out of the walls.', 'bad');
    for (const c of this.party) {
      if (!c.alive || !this.rng.chance(0.6)) continue;
      this.damageChar(c, this.rng.dice(plate.dmg, 6), 'the trap');
    }
  }

  // Cells the party can see this frame are written to the automap.
  markSeen(cells = null) {
    const lv = this.level;
    if (!lv) return;
    const mark = (x, y) => { if (lv.inBounds(x, y)) lv.seen[lv.idx(x, y)] = 1; };
    mark(this.mover.x, this.mover.y);
    for (let d = 0; d < 4; d++) mark(this.mover.x + DX[d], this.mover.y + DY[d]);
    if (cells) for (const k of cells) { const [x, y] = k.split(',').map(Number); mark(x, y); for (let d = 0; d < 4; d++) mark(x + DX[d], y + DY[d]); }
  }

  // ── Party actions ─────────────────────────────────────────────────────────
  ready(c) { return c.alive && this.time >= c.ready; }

  setCooldown(c, sec) { c.ready = this.time + sec; c.cdTotal = sec; }

  // The first living monster straight ahead within `max` blocks, with clear sight.
  monsterAhead(max) {
    const lv = this.level;
    const d = this.mover.dir;
    let x = this.mover.x, y = this.mover.y;
    for (let i = 1; i <= max; i++) {
      x += DX[d]; y += DY[d];
      if (lv.isSolid(x, y) || lv.barrierAt(x, y)) return null;
      const m = lv.monsterAt(x, y);
      if (m) return m;
    }
    return null;
  }

  attack(slot) {
    const c = this.party[slot];
    if (!c || !this.ready(c) || this.mode !== 'dungeon') return;
    this.stopRest();
    const ranged = reach(c) === 'ranged';
    if (!ranged && slot > 1) { this.log(`${c.name} can't reach from the back rank.`); this.setCooldown(c, 0.4); return; }
    const m = this.monsterAhead(ranged ? 3 : 1);
    const cd = attackCooldown(c);
    if (!m) { this.sfx('swing'); this.setCooldown(c, cd * 0.5); return; }
    this.setCooldown(c, cd);
    this.sfx('swing');
    m.awake = true;
    const r = resolvePlayerHit(c, m, this.data, this.rng);
    if (r.fumble) { this.log(`${c.name} fumbles.`); this.sfx('miss'); return; }
    if (!r.hit) { this.log(`${c.name} misses ${the(m)}.`); this.sfx('miss'); return; }
    this.sfx('hit');
    const procs = r.procs.length ? ` (${r.procs.join(', ')})` : '';
    this.log(`${c.name} ${r.crit ? 'CRITS' : 'hits'} ${the(m)} for ${r.dmg}${procs}.`, r.crit ? 'crit' : '');
    if (r.heal) this.healChar(c, r.heal);
    this.damageMonster(m, r.dmg, c);
  }

  damageMonster(m, dmg, by) {
    m.hp -= dmg;
    m.flash = 1;
    if (m.hp <= 0) this.killMonster(m, by);
  }

  killMonster(m, by) {
    const lv = this.level;
    m.alive = false;
    m.hp = 0;
    this.sfx('monster_die');
    this.log(`${The(m)} is destroyed.`, 'good');
    this.flags.kills[m.key] = (this.flags.kills[m.key] || 0) + 1;
    this.questEvent(`kill_${m.key}`);
    const living = this.party.filter((c) => c.alive);
    for (const c of living) for (const msg of gainXp(c, m.xp, this.data)) { this.log(msg, 'good'); this.sfx('levelup'); }
    const gb = Math.max(0, ...living.map((c) => this.data.classes.advanced[c.cls]?.[c.adv]?.bonuses?.gil_bonus_pct || 0));
    const gold = Math.round(m.gold * (1 + gb));
    if (gold) { this.gold += gold; this.log(`+${gold} gold.`); this.sfx('coin'); }
    if (by && by.adv) {
      const b = this.data.classes.advanced[by.cls]?.[by.adv]?.bonuses || {};
      if (b.heal_on_kill) this.healChar(by, b.heal_on_kill);
    }
    // Drops (Kaiacord loot tables): one gear roll, one consumable roll; bosses more.
    const cell = lv.ensureCell(m.x, m.y);
    const drops = [...m.carries];
    const tier = m.tier;
    const g = rollLoot(this.data.items.loot.gear, tier, this.rng);
    if (g) drops.push(g);
    const cons = rollLoot(this.data.items.loot.consumable, tier, this.rng);
    if (cons) drops.push(cons);
    if (m.guardian || m.boss) {
      const g2 = rollLoot(this.data.items.loot.gear, tier === 'boss' ? 'boss' : 'deadly', this.rng);
      if (g2) drops.push(g2);
    }
    if (m.rareDrop) drops.push(this.rareDrop(m.rareDrop, tier));
    for (const k of drops.filter(Boolean)) if (itemDef(k)) cell.items.push({ key: k, n: 1 });
    if (drops.length) this.log('Something clatters to the floor.');
    if (m.guardian) {
      this.questEvent('complete_dungeon');
      if (lv.meta.finalBossId === m.id) { this.victory(); return; }
      this.log(lv.meta.kind === 'ruins' ? 'The boss falls. The stair it guarded is clear.' : 'The stair guardian falls. The way down is open.', 'good');
    }
  }

  rareDrop(kind, tier) {
    if (kind === 'gem') return this.rng.weighted(this.data.dungeon.gem_drops);
    if (kind === 'gear') return rollLoot(this.data.items.loot.gear, { trivial: 'easy', easy: 'medium', medium: 'hard', hard: 'deadly', deadly: 'boss', boss: 'boss' }[tier], this.rng);
    if (kind.startsWith('lore:')) {
      const set = kind.slice(5);
      const pages = Object.entries(this.data.lore.pages).filter(([id, p]) => (set === 'any' || p[0] === set) && !this.flags.pagesFound.includes(id));
      return pages.length ? `lore:${this.rng.pick(pages)[0]}` : 'opal';
    }
    return null;
  }

  monsterAttacks(m) {
    const slot = targetSlot(this.party, this.mover.x, this.mover.y, this.mover.dir, m.x, m.y, this.rng);
    if (slot < 0) return;
    const c = this.party[slot];
    const r = resolveMonsterHit(m, c, this.data, this.rng);
    this.sfx('growl');
    if (!r.hit) { this.log(`${The(m)} misses ${c.name}.`); return; }
    this.log(`${The(m)} ${r.crit ? 'savages' : 'hits'} ${c.name} for ${r.dmg}.`, 'bad');
    this.damageChar(c, r.dmg, m.name);
  }

  onMonsterMoved() {}

  damageChar(c, dmg, src) {
    if (!c.alive || dmg <= 0) return;
    this.stopRest('The party is attacked!');
    c.hp -= dmg;
    c.flash = 1;
    this.sfx('hurt');
    this.shake = Math.min(1, this.shake + 0.35);
    if (c.hp <= 0) {
      c.hp = 0;
      c.alive = false;
      c.cond = {};
      this.log(`${c.name} falls to ${src}.`, 'bad');
      this.sfx('death');
      if (this.party.every((p) => !p.alive)) this.blackout();
    }
  }

  healChar(c, n) {
    if (!c.alive) return 0;
    const before = c.hp;
    c.hp = Math.min(maxHp(c, this.data), c.hp + n);
    return c.hp - before;
  }

  // Kaiacord's Blackout: lose 10% XP and 5% gold, wake at the Shrine.
  blackout() {
    this.mode = 'blackout';
    for (const c of this.party) { c.xp = Math.floor(c.xp * 0.9); c.alive = true; c.hp = 1; c.cond = {}; }
    this.gold = Math.floor(this.gold * 0.95);
    this.emit('mode', 'blackout');
  }

  victory() {
    this.mode = 'victory';
    this.emit('mode', 'victory');
  }

  // ── Magic ─────────────────────────────────────────────────────────────────
  partyHasSymbol() { return this.party.some((c) => packHas(c, 'symbol_of_the_silent_ones')) || this.hand?.key === 'symbol_of_the_silent_ones'; }

  bleedHere() {
    const lv = this.level;
    return lv ? lv.ley[lv.idx(this.mover.x, this.mover.y)] : 0;
  }

  cast(slot, id) {
    const c = this.party[slot];
    const sp = SPELLS[id];
    if (!c || !sp || !this.ready(c) || this.mode !== 'dungeon') return;
    if (!knownSpells(c).includes(id)) return;
    this.stopRest();
    if ((c.cond.silenced || 0) > 0) { this.log(`${c.name} cannot find the words.`); return; }
    if (c.mp < sp.mp) { this.log(`${c.name} has too little mana.`); return; }
    if (sp.melee && slot > 1) { this.log(`${c.name} must be in the front rank for ${sp.name}.`); return; }
    c.mp -= sp.mp;
    c.lastSpell = id;
    this.setCooldown(c, 1.2 + sp.power * 0.35);
    const field = this.bleedHere();
    const risk = feedbackRisk(field, sp.power, mitigation(c, this.partyHasSymbol()));
    let amp = amplification(field);
    this.sfx('cast');
    if (this.rng.next() < risk) {
      const fb = rollFeedback(this.rng, field);
      this.sfx('leybleed');
      this.log(`Ley-Bleed (${bleedLabel(field)}): ${fb.text}`, 'ley');
      this.viewTint = { rgb: [0.7, 0.9, 1.4], t: 0.6 };
      if (fb.cancels) return;
      if (fb.id === 'surge') amp *= 2;
      else this.applyFeedback(fb.id, c, sp, field);
      if (!c.alive || this.mode !== 'dungeon') return;
    }
    this.resolveSpell(c, sp, amp);
  }

  resolveSpell(c, sp, amp) {
    const D = this.data;
    const r = this.rng;
    switch (sp.kind) {
      case 'bolt': case 'drain': {
        const m = this.monsterAhead(sp.melee || sp.kind === 'drain' ? 1 : 3);
        if (!m) { this.log(`${sp.name} finds no target.`); this.sfx('fizzle'); return; }
        let dmg = damageAmount(c, r, sp.dice, amp);
        if (sp.undeadMul && undeadCheck(m, D)) dmg = Math.round(dmg * sp.undeadMul);
        if (m.ward) dmg = Math.max(1, Math.round(dmg * (1 - m.ward / 100)));
        m.awake = true;
        this.log(`${c.name}'s ${sp.name} strikes ${the(m)} for ${dmg}.`, 'magic');
        if (sp.kind === 'drain') this.healChar(c, Math.ceil(dmg / 2));
        this.sfx('hit');
        this.damageMonster(m, dmg, c);
        return;
      }
      case 'hold': {
        const m = this.monsterAhead(3);
        if (!m) { this.log(`${sp.name} finds no target.`); return; }
        m.held = sp.dur * amp;
        this.log(`${The(m)} goes still, held in silence.`, 'magic');
        return;
      }
      case 'storm': case 'nova': {
        const lv = this.level;
        const vis = this.emitQuery('visibleCells') || new Set();
        const targets = lv.monsters.filter((m) => m.alive && (sp.kind === 'storm'
          ? vis.has(ckey(m.x, m.y))
          : Math.abs(m.x - this.mover.x) + Math.abs(m.y - this.mover.y) <= 2));
        if (!targets.length) { this.log(`${sp.name} crackles over empty stone.`); return; }
        this.log(`${c.name} casts ${sp.name}!`, 'magic');
        for (const m of targets) {
          let dmg = damageAmount(c, r, sp.dice, amp);
          if (m.ward) dmg = Math.max(1, Math.round(dmg * (1 - m.ward / 100)));
          m.awake = true;
          this.log(`  ${m.name}: ${dmg}.`, 'magic');
          this.damageMonster(m, dmg, c);
        }
        return;
      }
      case 'heal': {
        const t = this.party.filter((p) => p.alive).sort((a, b) => a.hp / maxHp(a, D) - b.hp / maxHp(b, D))[0];
        const n = this.healChar(t, healAmount(c, r, sp.dice, amp, D));
        this.log(`${c.name}'s ${sp.name} restores ${n} HP to ${t.name}.`, 'magic');
        this.sfx('heal');
        return;
      }
      case 'heal_all': {
        for (const p of this.party) this.healChar(p, healAmount(c, r, sp.dice, amp, D));
        this.log(`${sp.name} washes over the party.`, 'magic');
        this.sfx('heal');
        return;
      }
      case 'ward': case 'bless': case 'buff': {
        const cond = sp.kind === 'ward' ? 'fortified' : sp.kind === 'bless' ? 'blessed' : sp.cond;
        for (const p of this.party) if (p.alive) p.cond[cond] = sp.dur * amp;
        this.log(`${sp.name}: the party is ${cond.replace('_', ' ')}.`, 'magic');
        this.sfx('heal');
        return;
      }
    }
  }

  applyFeedback(id, caster, sp, field) {
    const lv = this.level, r = this.rng, P = this.mover;
    switch (id) {
      case 'backlash': this.damageChar(caster, r.d(6) * sp.power + Math.floor(field * 8), 'Ley backlash'); break;
      case 'hemorrhage': for (const c of this.party) c.mp = Math.floor(c.mp / 2); break;
      case 'silence': for (const c of this.party) if (c.alive) c.cond.silenced = 10; break;
      case 'flare':
        for (const m of lv.monsters) if (m.alive && Math.abs(m.x - P.x) + Math.abs(m.y - P.y) <= 3) m.held = 3;
        this.viewTint = { rgb: [2, 2, 2], t: 0.3 };
        break;
      case 'quake': {
        const n = 1 + Math.floor(field * 3);
        this.sfx('quake');
        this.shake = 1;
        for (const c of this.party) this.damageChar(c, r.dice(n, 6), 'falling stone');
        for (const m of lv.monsters) if (m.alive && Math.abs(m.x - P.x) + Math.abs(m.y - P.y) <= 2) this.damageMonster(m, r.dice(n, 6), null);
        break;
      }
      case 'phase_slip': {
        const dist = lv.bfs(P.x, P.y, (x, y) => lv.passable(x, y) && !lv.cell(x, y)?.stairs);
        const opts = [];
        for (let i = 0; i < dist.length; i++) if (dist[i] >= 3 && dist[i] <= 7) opts.push(i);
        if (opts.length) {
          const i = r.pick(opts);
          P.place(i % lv.w, Math.floor(i / lv.w), r.int(4));
          this.markSeen();
        }
        break;
      }
      case 'rupture': {
        const cr = (lv.meta.crystals || []).filter((c) => !c.sealed)
          .sort((a, b) => (Math.abs(a.ax - P.x) + Math.abs(a.ay - P.y)) - (Math.abs(b.ax - P.x) + Math.abs(b.ay - P.y)))[0];
        if (cr) { cr.strength += 0.25; cr.tex = 'crystal_cracked'; computeLey(lv, lv.meta.theme, this.L); }
        break;
      }
      case 'echo': {
        for (let d = 0; d < 4; d++) {
          const x = P.x + DX[(P.dir + d) & 3], y = P.y + DY[(P.dir + d) & 3];
          if (lv.passable(x, y) && !lv.cell(x, y)?.stairs) {
            const m = makeMonster(this.data, 'aeridorian_echo', x, y, this.L);
            m.awake = true;
            lv.monsters.push(m);
            break;
          }
        }
        break;
      }
      case 'blight_bloom':
        for (const m of lv.monsters) if (m.alive) m.hp = Math.min(m.maxHp, m.hp + Math.ceil(m.maxHp / 4));
        this.viewTint = { rgb: [0.8, 1.3, 0.5], t: 2.5 };
        break;
      case 'whisper': {
        const n = this.data.lore.npcs;
        const lines = [...(n.hooded_figure?.topics || []), ...(n.elara?.topics || []), ...(n.bard?.topics || [])].filter((t) => !t.startsWith('['));
        this.log(`"${r.pick(lines)}"`, 'lore');
        for (const c of this.party) gainXp(c, 10, this.data);
        break;
      }
    }
  }

  // UI-provided queries (e.g. the renderer's visible cells).
  emitQuery(name) { return this.queries?.[name]?.(); }

  // ── Click-to-interact ─────────────────────────────────────────────────────
  // `hit` is the renderer's raycast result for the clicked view pixel.
  interact(hit) {
    if (this.mode !== 'dungeon' || !hit) return;
    const lv = this.level, P = this.mover;
    const front = [P.x + DX[P.dir], P.y + DY[P.dir]];
    switch (hit.type) {
      case 'sprite': return this.clickSprite(hit.sprite, front);
      case 'door': case 'gate':
        if (hit.dist > REACH_DOOR) return this.log('Too far away.');
        return this.clickBarrier(hit.x, hit.y);
      case 'stairs':
        if (hit.dist > REACH_FACE) return this.log('Stairs, further on.');
        return this.takeStairs(lv.cell(hit.x, hit.y).stairs);
      case 'face':
        if (hit.dist > REACH_FACE) return this.log('Too far away to reach.');
        return this.clickFace(hit);
      case 'floor': {
        const own = hit.x === P.x && hit.y === P.y;
        const ahead = hit.x === front[0] && hit.y === front[1];
        if (!own && !ahead) return;
        return this.clickFloor(hit.x, hit.y);
      }
    }
  }

  clickSprite(s, front) {
    const P = this.mover;
    if (s.kind === 'monster') {
      const m = s.ref;
      this.log(`${m.name} (${m.tier}). ${m.desc}`, 'lore');
      return;
    }
    const near = (s.cx === P.x && s.cy === P.y) || (s.cx === front[0] && s.cy === front[1]);
    if (!near) { this.log('Too far away.'); return; }
    if (s.kind === 'chest') return this.openChest(s.cx, s.cy);
    if (s.kind === 'item') return this.clickFloor(s.cx, s.cy);
  }

  clickBarrier(x, y) {
    const c = this.level.cell(x, y);
    if (c.gate) { this.log('A heavy iron portcullis. It will not lift by hand. Somewhere, a lever.'); return; }
    const d = c.door;
    if (d.locked) {
      const holder = this.hand?.key === d.key ? 'hand' : this.party.find((p) => packHas(p, d.key));
      if (!holder) { this.log(`Locked. The keyhole wants a ${itemDef(d.key).name}.`); this.sfx('bump'); return; }
      if (holder === 'hand') this.hand = null; else removeFromPack(holder, d.key);
      d.locked = false;
      d.deco = null;
      this.sfx('key');
      this.log(`The ${itemDef(d.key).name} turns. The lock gives.`, 'good');
      this.emit('hand');
    }
    if (d.target < 1 && this.level.monsterAt(x, y)) return;
    d.target = d.target >= 1 ? 0 : 1;
    if (d.target === 0 && (this.level.monsterAt(x, y) || (this.mover.x === x && this.mover.y === y))) { d.target = 1; return; }
    this.sfx('door');
  }

  clickFace(hit) {
    const lv = this.level;
    const f = lv.face(hit.x, hit.y, hit.face);
    if (!f) { this.log('Cold stone.'); return; }
    const inRect = (u0, u1, v0, v1) => hit.u >= u0 && hit.u <= u1 && hit.v >= v0 && hit.v <= v1;
    switch (f.kind) {
      case 'lever': {
        if (!inRect(0.3, 0.72, 0.1, 1)) return this.log('Cold stone.');
        f.on = !f.on;
        f.tex = f.on ? 'lever_down' : 'lever_up';
        const [gx, gy] = f.target.split(',').map(Number);
        const g = lv.cell(gx, gy).gate;
        g.target = f.on ? 1 : 0;
        if (!f.on && (lv.monsterAt(gx, gy) || (this.mover.x === gx && this.mover.y === gy))) g.target = 1;
        this.sfx('lever');
        this.sfx('gate');
        this.log(f.on ? 'You haul the lever down. Somewhere, chains run and iron grinds upward.' : 'The lever snaps back. Iron slams down in the distance.');
        return;
      }
      case 'button': {
        if (!inRect(0.3, 0.7, 0.3, 0.75)) return this.log('Cold stone.');
        if (f.on) return this.log('The button is already pressed in.');
        f.on = true;
        f.tex = 'button_on';
        this.sfx('button');
        const [sx, sy] = f.opens.split(',').map(Number);
        lv.setOpen(sx, sy);
        const c = lv.ensureCell(sx, sy);
        if (c.secret) { c.items.push(...c.secret.items); c.secret = null; }
        computeLey(lv, lv.meta.theme, this.L);
        this.sfx('gate');
        this.log('Click. A section of wall grinds aside, revealing a hidden niche.', 'good');
        return;
      }
      case 'crystal': return this.clickCrystal(f);
      case 'shrine': return this.clickShrine(f);
      case 'inscription':
        if (!inRect(0.1, 0.9, 0.15, 0.85)) return this.log('Cold stone.');
        this.log(f.text, 'lore');
        return;
      case 'sconce': this.log('A sconce. The flame burns without consuming anything.'); return;
      default: this.log('Cold stone.');
    }
  }

  clickCrystal(f) {
    if (f.sealed) { this.log('The crystal is dark and quiet. Silenced.'); return; }
    this.questEvent('look_crystals');
    if (this.hand?.key === 'symbol_of_the_silent_ones' || this.partyHasSymbol()) {
      f.sealed = true;
      f.tex = 'crystal_sealed';
      computeLey(this.level, this.level.meta.theme, this.L);
      this.sfx('seal');
      this.log('You press the Symbol to the fracture. Flame, stone, silence. The crystal goes dark, and the Bleed here ebbs.', 'good');
      for (const c of this.party) for (const m of gainXp(c, 40 + this.L * 4, this.data)) this.log(m, 'good');
      return;
    }
    // Kaiacord's Crystal Resonance event: an INT check.
    const best = this.party.filter((c) => c.alive).sort((a, b) => b.stats.int - a.stats.int)[0];
    if (!best) return;
    if (f.touched) { this.log('The crystal hums at a frequency that moves through bone. It will not answer twice.'); return; }
    f.touched = true;
    if (this.rng.d(20) + Math.floor((best.stats.int - 10) / 2) >= 12) {
      this.log(`${best.name} reaches toward it. Something opens briefly, and closes.`, 'ley');
      for (const c of this.party) gainXp(c, 25 + this.L * 3, this.data);
    } else {
      this.log(`${best.name} reaches toward it. It pushes back. Not violently. Just: no.`, 'ley');
      this.damageChar(best, this.rng.d(6) + Math.floor(this.L / 10), 'the crystal');
    }
  }

  clickShrine(f) {
    const D = this.data;
    if (f.sealed && !f.opened) {
      if (this.partyHasSymbol()) {
        f.opened = true;
        f.tex = 'seal_awake';
        this.sfx('seal');
        this.log(D.dungeon.shrine_unlocked, 'lore');
        for (const c of this.party) { if (c.alive) c.cond.blessed = 120; for (const m of gainXp(c, 150, D)) this.log(m, 'good'); }
        this.log('The party is Blessed. (+150 XP)', 'good');
        const page = this.rareDrop('lore:aeridor', 'hard');
        if (page) this.addItemToParty(page);
        return;
      }
      if (!f.used) {
        f.used = true;
        this.healParty(0.5);
        this.log('A candle burns beside a circular seal. Its warmth eases your wounds.', 'good');
      }
      this.log(D.dungeon.shrine_sealed, 'lore');
      return;
    }
    if (f.used && (!f.sealed || f.opened)) { this.log(D.dungeon.shrine_completed, 'lore'); return; }
    f.used = true;
    f.tex = 'seal_spent';
    this.healParty(0.6);
    this.sfx('heal');
    this.log('You kneel at the shrine. The candle gutters, and your wounds close.', 'good');
  }

  healParty(frac) {
    for (const c of this.party) if (c.alive) { this.healChar(c, Math.ceil(maxHp(c, this.data) * frac)); c.cond.poisoned && delete c.cond.poisoned; }
  }

  openChest(x, y) {
    const c = this.level.cell(x, y);
    if (!c || !c.chest) return;
    if (c.chest.opened) { this.log('The chest is empty.'); return; }
    c.chest.opened = true;
    const t = c.chest.tier;
    const loot = [rollLoot(this.data.items.loot.gear, t, this.rng), rollLoot(this.data.items.loot.consumable, t, this.rng), rollLoot(this.data.items.loot.consumable, t, this.rng), ...c.chest.extra].filter(Boolean);
    const gold = this.rng.range(10, 30) * (1 + Math.floor(this.L / 5));
    this.gold += gold;
    for (const k of loot) if (itemDef(k)) c.items.push({ key: k, n: 1 });
    this.sfx('coin');
    this.log(`The chest creaks open: ${gold} gold${loot.length ? ', and ' + loot.map((k) => itemDef(k)?.name).join(', ') : ''}.`, 'good');
  }

  clickFloor(x, y) {
    const lv = this.level;
    const c = lv.ensureCell(x, y);
    if (this.hand) {
      if (lv.isSolid(x, y) || lv.barrierAt(x, y)) return;
      c.items.push(this.hand);
      this.log(`Dropped ${itemDef(this.hand.key).name}.`);
      this.hand = null;
      this.emit('hand');
      return;
    }
    if (c.items.length) {
      this.hand = c.items.pop();
      this.sfx('pickup');
      this.log(`Picked up ${itemDef(this.hand.key).name}. Click a party member to stow it.`);
      this.notePage(this.hand.key);
      this.emit('hand');
      return;
    }
    if (c.plate && c.plate.armed) {
      const s = this.party.find((p) => p.alive && (p.cls === 'Rogue' || p.cls === 'Ranger'));
      if (!s) { this.log('A pressure plate. Better not.'); return; }
      if (this.rng.d(20) + Math.floor((s.stats.dex - 10) / 2) >= 12) { c.plate.armed = false; this.log(`${s.name} wedges the plate. Disarmed.`, 'good'); this.sfx('plate'); }
      else { this.log(`${s.name} slips. The plate clicks.`, 'bad'); this.triggerPlate(x, y, { ...c.plate, armed: true }); c.plate.armed = false; }
    }
  }

  addItemToParty(key) {
    for (const c of this.party) if (addToPack(c, key, 1)) { this.log(`${c.name} takes ${itemDef(key).name}.`); this.notePage(key); return true; }
    this.level?.ensureCell(this.mover.x, this.mover.y).items.push({ key, n: 1 });
    return false;
  }

  // Lore Codex: completing a set pays out once (Kaiacord lore.py).
  notePage(key) {
    if (!key.startsWith('lore:')) return;
    const id = key.slice(5);
    if (this.flags.pagesFound.includes(id)) return;
    this.flags.pagesFound.push(id);
    const set = this.data.lore.pages[id][0];
    this.log(`Lore Codex: "${this.data.lore.pages[id][1]}" added.`, 'lore');
    const ids = Object.entries(this.data.lore.pages).filter(([, p]) => p[0] === set).map(([i]) => i);
    if (ids.every((i) => this.flags.pagesFound.includes(i)) && !this.flags.setsDone.includes(set)) {
      this.flags.setsDone.push(set);
      const [name, , gold, xp, item] = this.data.lore.sets[set];
      this.gold += gold;
      for (const c of this.party) gainXp(c, xp, this.data);
      this.addItemToParty(item);
      this.log(`${name} is complete: +${gold} gold, +${xp} XP.`, 'good');
    }
  }

  // ── Items ─────────────────────────────────────────────────────────────────
  // Use a consumable from a member's pack (effects from Kaiacord's on_use set).
  useItem(c, idx) {
    const it = c.pack[idx];
    if (!it) return;
    const d = itemDef(it.key);
    const D = this.data;
    const consume = () => { it.n--; if (it.n <= 0) c.pack[idx] = null; };
    if (it.key.startsWith('lore:')) { this.log(`${d.name}: ${d.description}`, 'lore'); return; }
    if (it.key === 'phoenix_feather') {
      const dead = this.party.find((p) => !p.alive);
      if (dead) { dead.alive = true; dead.hp = Math.min(maxHp(dead, D), 50); this.log(`${dead.name} gasps back to life.`, 'good'); this.sfx('heal'); consume(); return; }
    }
    if (!c.alive) { this.log(`${c.name} is beyond using anything.`); return; }
    if (d.hp_restore) {
      const mult = D.classes.advanced[c.cls]?.[c.adv]?.bonuses?.heal_mult || (c.cls === 'Cleric' && !c.adv ? 1.25 : 1);
      const n = this.healChar(c, Math.round(d.hp_restore * mult));
      this.log(`${c.name} uses ${d.name}: +${n} HP.`, 'good');
      this.sfx('heal');
      consume();
      return;
    }
    switch (it.key) {
      case 'ether': c.mp = Math.min(maxMp(c), c.mp + 20); this.log(`${c.name} drinks the Ether. Mental clarity returns.`, 'good'); consume(); return;
      case 'aeridor_shard': case 'deep_fragment': case 'mountain_shard': {
        if (this.mode !== 'dungeon') break;
        const lv = this.level, P = this.mover;
        const dist = lv.bfs(P.x, P.y);
        for (let i = 0; i < dist.length; i++) if (dist[i] >= 0 && dist[i] <= 3) lv.ley[i] = Math.max(0, lv.ley[i] - 0.3);
        this.log(`The ${d.name} drinks the Bleed around you and goes dark.`, 'ley');
        consume();
        return;
      }
      case 'torch': case 'lightstone':
        for (const p of this.party) p.cond.torchlit = it.key === 'lightstone' ? Infinity : 300;
        this.log(it.key === 'lightstone' ? 'The Lightstone glows. It will not go out.' : 'The torch catches.', 'good');
        if (it.key === 'torch') consume();
        return;
      case 'adventurers_pack': consume(); for (const k of ['bandage', 'healing_herb', 'torch']) addToPack(c, k, 1); this.log('Bandage, Healing Herb, Torch.'); return;
    }
    switch (d.on_use) {
      case 'atk_boost': c.cond.embered = 90; this.log(`${c.name} is Embered (+2 ATK).`, 'good'); consume(); return;
      case 'def_boost': c.cond.fortified = 90; this.log(`${c.name} is Fortified (+2 DEF).`, 'good'); consume(); return;
      case 'cure_poison': delete c.cond.poisoned; this.log(`${c.name} is cured.`, 'good'); consume(); return;
      case 'luck_roll_bonus': c.cond.lucky = 60; this.log(`${c.name} feels Lucky (+1 to hit).`, 'good'); consume(); return;
      case 'xp_boost': c.cond.xp_boost = 180; this.log(`${c.name} will learn faster for a while (+25% XP).`, 'good'); consume(); return;
      case 'hunt_bonus': c.cond.hunters_focus = 60; this.log(`${c.name} narrows their eyes (+2 to hit).`, 'good'); consume(); return;
      case 'smoke_bomb':
        if (this.mode === 'dungeon') for (const m of this.level.monsters) if (m.alive && Math.abs(m.x - this.mover.x) + Math.abs(m.y - this.mover.y) <= 2) m.held = 4;
        this.log('Smoke fills the corridor. Nothing near you can see.', 'good'); consume(); return;
    }
    this.log(`${d.name}. ${d.description || ''}`.trim());
  }

  // ── Quests (Kaiacord quest_registry, the tasks this game can track) ───────
  questEvent(task) {
    for (const [id, st] of Object.entries(this.flags.quests)) {
      if (st.state !== 'active') continue;
      const q = this.data.lore.quests[id];
      if (q.tasks.includes(task) && !st.done.includes(task)) {
        st.done.push(task);
        this.log(`Quest "${q.name}": ${task.replace(/_/g, ' ')} done.`, 'good');
      }
    }
  }

  completeQuest(id) {
    const q = this.data.lore.quests[id];
    const st = this.flags.quests[id];
    st.state = 'done';
    const r = q.rewards;
    this.gold += r.gold || 0;
    for (const c of this.party) for (const m of gainXp(c, r.xp || 0, this.data)) this.log(m, 'good');
    if (r.item && itemDef(r.item)) this.addItemToParty(r.item);
    this.log(q.completion_msg, 'lore');
  }

  // ── Info for the UI ───────────────────────────────────────────────────────
  compass() { return DIR_NAMES[this.mover.dir]; }
  floorLabel() { return this.level ? this.level.meta.name : 'Oakhaven'; }
  charTitle(c) { return `(${title(c, this.data)}) ${klass(c)}`; }
  advanceChar(c, choice) { const o = advance(c, choice, this.data); if (o) this.log(`${c.name}: ${o.flavor}`, 'lore'); }
  levelInfo(L) { return levelInfo(L, this.data); }
  lootTier(L) { return lootTier(L); }
}

export { FORWARD, TOTAL_LEVELS };
