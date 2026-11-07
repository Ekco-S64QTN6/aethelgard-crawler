# Aethelgard Crawler

A first-person, grid-based, real-time dungeon crawler (a "blobber") set in **Aethelgard**, the world
of Kaiacord's `!rpg`. Four adventurers leave Oakhaven, go down through the toppled white spires of
Aeridor, and descend the 77 floors of the Ironvein Deep beneath the Spine of the World to the
rotting, blighted heart of the mountain.

- **Step movement and 90° turns**, with a short camera interpolation; every step is checked against
  the map array first, so walls, closed doors, portcullises and monsters block it.
- **Step-frustum renderer**: a software column caster that draws exactly 4 blocks deep and lets the
  rest fall into darkness. Floors and ceilings are perspective-cast, wall objects are composited
  onto the faces they belong to, doors slide, portcullises are see-through, and monsters, chests and
  items are depth-sorted billboards.
- **Real-time combat** on a cooldown per party slot (keys 1-4), Kaiacord's to-hit, damage, crit and
  proc rules, and monsters that hunt the party by breadth-first search and strike whichever rank faces them.
- **Click-to-interact**: a click is raycast into the grid to find the lever, wall button, keyholed
  door, pressure plate, shrine, crystal, inscription, chest or item under the cursor.
- **The Ley-Bleed** replaces ordinary magic: casting near fractured Aeridorian crystal is stronger
  and may feed back (surge, backlash, silence, quake, phase-slip, rupture, blight bloom, things
  answering the call). See [docs/DESIGN.md](docs/DESIGN.md).
- **Oakhaven** between descents: rest at the Stone Hearth, trade with Hemlock, pray at the Shrine
  (and learn the three-flame seal), brew at Maren's, take quests from Elara and the Watchtower,
  ride the Resonance Lift to every fifth floor reached.

## Play

Requirements: Node 18+ (only to serve the files; the game itself has no dependencies) and a browser.

```sh
npm start            # http://127.0.0.1:8137/
```

| Key | Action |
|---|---|
| W / ↑, S / ↓ | step forward / back |
| A / D | strafe left / right |
| Q / E, ← / → | turn 90° |
| 1-4 | attack with party member 1-4 |
| Shift + 1-4 | recast that member's last spell |
| R | rest (interrupted by anything hostile nearby) |
| I / M / C / Esc | inventory, automap, codex, menu |

Click portraits to open inventories (or to stow the item held on the cursor), click in the view to
use things, right-click or double-click pack items to use or equip them. The game saves on every
stair and in town; the menu exports and imports save files.

## Build steps

The repository ships its data and original art already built. To rebuild:

```sh
npm run data      # python3 -I tools/import_kaiacord.py [../Kaiacord]   -> data/*.json
npm run assets    # python3 -I tools/gen_assets.py                      -> assets/generated/
npm run classic   # python3 -I tools/import_dhplus.py [../Dungeon Hack+] -> assets/imported/ (optional)
npm test          # node --test tests/
tools/shoot.sh out.png 'demo=1&L=20'   # headless screenshot of any level
```

The importers only read their source folders. Neither Kaiacord nor Dungeon Hack+ is needed at run time.

### Where things come from

| Source | What is used | How |
|---|---|---|
| Kaiacord `!rpg` (`utils/ttrpg`, `docs/ttrpg`) | 369 monsters, 453 items (weapons, armour, headgear, boots, accessories, consumables, gems, ingredients), loot tables, Hemlock's stock, alchemy, races, classes, advanced classes, titles, procs, XP curve, pantheon, NPCs and their dialogue, quests, the Lore Codex, rare variants, dungeon themes, the 77 Ironvein Deep floors and their stair guardians | `tools/import_kaiacord.py` parses the registries with `ast.literal_eval` (no Kaiacord code runs) into `data/*.json`; `data/SOURCE.json` records the commit and file hashes |
| Kaiacord rules | combat math (`combat_engine`), DEF soft cap, attack caps, Blackout, guardian scaling, Resonance Ward | ported to `src/game/combat.js`, `party.js`, `monsters.js` |
| Dungeon Hack+ | its decoded asset pool: wallset front panels, floor/ceiling backdrops, 74 monster sprites (front + attack frames), 184 portraits, 25 sound effects | `tools/import_dhplus.py` copies a curated set to `assets/imported/` (git-ignored) with a manifest; switch with **Art** on the title screen or in the menu |
| Dungeon Hack (via DH+'s notes) | the dungeon feature taxonomy: doors, door buttons, illusionary/false walls, stairs, wall buttons, levers, locks, pits/plates | the level feature pass in `src/game/levelgen.js` |

Dungeon Hack+ is a patcher for the 1993 DOS game, not an engine: it contains no movement,
inventory or cooldown code to lift. The engine here (grid, movement, renderer, combat loop,
inventory) is new, built to the structure the brief describes.

Some `!rpg` names come from other franchises (Final Fantasy, Magic: The Gathering, D&D product
identity, Dragonlance). This is a standalone game, so the importer renames 112 of them through
`tools/name_scrub.json` (for example Tonberry → Hollow Pilgrim, Cactuar → Needle Sprite, Beholder →
Gaze Tyrant, Phoenix Down → Phoenix Feather, gil → gold). Stats, tiers, descriptions and placement
are unchanged; edit the file and re-run `npm run data` to change any of them.

### Art packs

- **Original** (default, committed): procedural textures, sprites, portraits and synthesized sound
  from `tools/gen_assets.py`.
- **Classic** (local only): Dungeon Hack / Eye of the Beholder / Menzoberranzan art decoded by
  Dungeon Hack+ from your own game copies. It is commercial game data: keep it out of anything you
  publish (it is git-ignored).

## Layout

```
index.html, src/main.js     boot, loop, input, view <-> game bridge
src/engine/                 grid.js (map array, collision, BFS), movement.js (step controller),
                            renderer.js (frustum renderer + click raycast), assets.js, audio.js
src/game/                   game.js (rules, interaction), levelgen.js (layouts + feature pass),
                            party.js, combat.js, magic.js (spells + Ley-Bleed), monsters.js,
                            items.js, save.js, data.js
src/ui/                     hud.js (party grid, log), screens.js (overlays), town.js (Oakhaven)
data/                       imported Kaiacord content (generated, committed)
assets/generated/           original art and sound (generated, committed)
tools/                      importers, asset generator, static server, screenshot script
tests/                      levels (all 80 solvable), game rules + autopilot, renderer
```
