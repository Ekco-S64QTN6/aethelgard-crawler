# CLAUDE.md: Aethelgard Crawler handoff notes

A browser blobber (HTML5 canvas, ES modules, no runtime dependencies) set in Kaiacord's Aethelgard.
Read `README.md` (what and how), then `docs/DESIGN.md` (lore mapping, Ley-Bleed, balance choices).

## Ground rules
* `../Kaiacord` and `../Dungeon Hack+` are **read-only sources**. Never write into them; the
  importers refuse a source inside this project and only read. Nothing at run time references them.
* `assets/imported/` is commercial game data (decoded by Dungeon Hack+ from the user's copies):
  git-ignored, local use only. Never commit or publish it.
* Verify with evidence: `npm test` (17 tests: all 80 levels solvable for several seeds, rules,
  autopilot that plays floors through their puzzles, renderer raycast) and screenshots via
  `tools/shoot.sh OUT.png 'demo=1&L=20&px=..&py=..&pd=..&classic=1&ui=inv'`.
* Run Python with `python3 -I`. Data and generated assets are committed build products: regenerate
  them with the npm scripts, don't hand-edit `data/*.json`.

## Code map
* `src/engine/grid.js`: `Level` (tiles 0 open / 1 wall, `cells` map of features, `faces` map of wall
  objects, monsters, `seen`, `ley`). Directions 0 N, 1 E, 2 S, 3 W. A face key `x,y,d` is the side of
  solid block (x,y) facing d, i.e. seen from (x+DX[d], y+DY[d]). `passable()` is the collision check.
* `src/engine/movement.js`: `Mover` grid pose + animated camera (`cx, cy, ca`; angle 0 = north,
  forward = (sin a, -cos a)). Steps commit the grid pose immediately; the camera catches up.
* `src/engine/renderer.js`: software renderer into a 320x200 Uint32 buffer + depth buffer. Eye sits
  `CAM_BACK` (0.4) behind the block centre with the horizon at 42% height so the party's own square
  is visible; `MAX_DIST` keeps the field at `VIEW_DEPTH` = 4 blocks. `pick()` is the click raycast
  (sprites, faces, doors/gates, stairs, floor) and must stay in sync with `render()`.
* `src/game/levelgen.js`: ruins generator, Spine cell-graph → block-map conversion, feature pass,
  `computeLey`. Deterministic per (seed, level) via `Rng(hash('aethelgard:seed:L'))`.
* `src/game/game.js`: all rules and interactions; emits `log`, `sfx`, `mode`, `ambient`, `save`, `hand`.
  Use `g.rng` (seeded) for anything random in game logic; `Math.random` made the autopilot flaky once.
* `src/game/{party,combat,magic,monsters,items}.js`: Kaiacord-derived rules. `save.js`: levels are
  rebuilt from the seed then patched with saved tiles/cells/faces/monsters.
* `src/ui/`: DOM UI (`hud.js` party grid + log, `screens.js` overlays, `town.js` Oakhaven).
* `tools/import_kaiacord.py` (+ `name_scrub.json`: renames franchise names; `FAMILY_RULES` /
  `FAMILY_OVERRIDES` pick each monster's sprite family), `tools/gen_assets.py`,
  `tools/import_dhplus.py` (theme → DH+ wallset/backdrop table, family → sprite lists, sfx map).

## Gotchas
* Monster `variant` is the sprite-choice hash; a rare variant is `rare`. Mixing them crashed rendering.
* Stairs blocks are impassable to monsters and BFS routes; the party "enters" them to change level.
* Gates/doors animate `open` toward `target`; logic checks `open < 1` for blocking.
* Classic backdrops replace floor/ceiling casting; plates/pits are still cast over them.
* Balance knobs: `scaleFor`, `dmgScale`, guardian DEF in `monsters.js`; spell risk in `magic.js`.
  A quick sim: copy the autopilot from `tests/game.test.mjs`, drop `godMode`, add potion use and
  resting (fresh parties clear the ruins at level 3 and reach Spine 7 at level 5 on most seeds).
