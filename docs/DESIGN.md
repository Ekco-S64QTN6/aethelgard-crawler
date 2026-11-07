# Design notes: Aethelgard below the ruins

## Canon first

The world is Kaiacord's Aethelgard as the `!rpg` defines it: Oakhaven at the Whisperwood edge,
Aeridor and its Resonance, the three-flame seal (flame, stone, silence), the Silent Ones and the four
gods, the Ironvein Deep under the Spine of the World. The original brief asked for "floating islands
built atop calcified bones", "the Ley-Bleed" and "the Blight"; none of those terms exist in Kaiacord,
so each is mapped onto something that does:

| Brief | In Aethelgard |
|---|---|
| Fallen golden age, cracked white spires | Aeridor. Its towers ("high towers, lights", the Echo of Aeridor event) lie toppled under the Aeridor Ruins: levels 1-3, **The Shattered Spires**, white marble veined with crystal. |
| A foundation of calcified bone | **The Bone Warrens** (Ironvein Deep 16-30): "catacombs carved before the mine. The dead did not stay placed." Oakhaven itself "was built on the bones of Aeridor." |
| Descent from marble to rotting scaffolding | Spires → Working Tunnels (timber) → Bone Warrens → Sunken Forge → Deep Dark → **Heart of the Mountain** (flesh, ribs, blight, a heartbeat in the stone). |
| The Blight | The Whisperwood blight that sours Oakhaven's soil, here grown into the mountain's heart; the *blight bloom* Ley feedback heals every monster on the floor. |
| Corrupted monstrosities, bosses | Kaiacord's bestiary as-is, per-band encounter tables, 77 named stair guardians, ruins bosses named the way `dungeon.py` names them ("Rotting Warden of the Deep"), and The Mountain Heart at the bottom. |
| The Ley-Bleed | Resonance bleeding out of Aeridor's fractured crystal network. See below. |

## The Ley-Bleed

Kaiacord establishes that Aeridor ran on **Resonance** channelled through crystalline networks,
that fragments still hum ("felt rather than heard"), that the crystals "have opinions" (Crystal
Resonance: "It pushed back. Not violently. Just: no."), and that magic "is always uncertain, always
slightly wrong" (Lore Bible, Appendix A). The Ley-Bleed makes that a rule:

- Every block carries a **Bleed value**: a base for the band (low in the tunnels, high in the heart)
  plus a falloff from each fractured crystal on the walls. The HUD shows it where the party stands:
  *Stable, Thrumming, Fractured, Hemorrhaging*. Brighter floor on the automap means stronger Bleed.
- Casting draws on it. A spell is **amplified** by up to 60%, and has a **feedback risk** of
  `bleed × (0.25 + 0.12 × spell power) × (1 − mitigation)`, capped at 85%.
- **Feedback** is weighted by local Bleed, so the worst outcomes only happen where the stone is
  hemorrhaging: *surge* (double effect), *backlash* (the caster is hurt), *fizzle*, *hemorrhage* (all
  mana halved), *silence*, *flare* (nearby foes blinded), *quake* (everyone nearby takes damage),
  *phase-slip* (the party is moved), *rupture* (the crystal cracks wider, permanently raising the
  Bleed), *echo* (an Aeridorian Echo takes shape), *blight bloom* (every monster on the floor heals),
  and *whisper* (a voice from Oakhaven: a line from Elara, the Hooded Figure or Caelindra).
- **Mitigation** follows the three words: *flame* (praying at the Shrine: Blessed, Attuned),
  *stone* (an Aeridor Shard absorbs the Bleed around the party), *silence* (the **Symbol of the
  Silent Ones**, learned from the Shrine's flame and altar exactly as in Kaiacord, halves the risk
  and can seal a cracked crystal for good).
- The spells are named for the pantheon and the class procs: Arcane Surge, Sylvara's Storm, Song of
  Silence, Arcane Nova, Death Touch, Thornax's Mending, Aerthis' Ward, Undead Bane, Blessing of the
  Silent Ones, Morvenna's Mercy, Spirit Wrath, Holy Smite, Harm Touch, Forest Fury, Tree Memory.

## Real time, from a turn-based source

Kaiacord resolves one exchange per command. Here each party slot has its own cooldown (heavier
weapon dice swing slower, DEX quickens them), and each monster its own attack and move timers by
tier. Kaiacord's numbers assume a level-15 party in the Spine and single exchanges, so three things
are eased for a party that levels on the way down, all in `src/game/monsters.js`:

- stats ramp from 0.5x at the surface to Kaiacord's 1.6x (difficulty 5) at the bottom, with its floor caps;
- tier damage dice reach full strength about 16 levels down;
- stair guardians keep Kaiacord's HP floor and Resonance Ward (5% per 15 floors, 25% at 75-77) but
  their DEF tops out at 22 instead of 29.

Resting (R) is new: the dungeon has no Stone Hearth, so the party can camp when nothing hostile is near.
Blackout is Kaiacord's: lose 10% XP and 5% gold, wake at the Shrine.

## Levels

- **1-3, the Shattered Spires**: generated per game seed like `dungeon.py`: 9-12 rooms on a lattice,
  weighted room types (empty 18, monster 45, treasure 15, shrine 8, trap 14), a guaranteed shrine,
  one theme per dungeon from the Aeridor Ruins weights, a boss at the farthest room.
- **4-80, the Ironvein Deep 1-77**: Kaiacord's hand-made 24x24 floors, converted from their cell
  graph to a 49x49 block map. Linked cells of one room open into halls, stairs are carved into wall
  alcoves so they never cut a corridor, and floors 61-76 (which have no stairs cell in the data) get
  their way down at the farthest room.
- A seeded **feature pass** adds Dungeon Hack's furniture: a portcullis on a chokepoint of the route
  with its lever on the near side, a locked door further on with its key on the floor or carried by
  a monster on the near side, button-opened niches behind false walls, pressure-plate traps
  (Rogues and Rangers may spot and wedge them), chests, shrines (half of them sealed with the
  three-flame seal), Ley crystals, inscriptions and sconces, Kaiacord's 21 Lore Codex pages spread
  over the descent, and the Spine's own lore drops (shift logs, burial offerings, forge manifests).
- `tests/levels.test.mjs` builds all 80 levels for several seeds and checks every lever is reachable
  before its gate, every key before its door, and the stairs (or the Mountain Heart) after both.
