#!/usr/bin/env python3
"""Build the optional "classic" art pack from a Dungeon Hack+ asset pool.

Dungeon Hack+ decodes Dungeon Hack, Eye of the Beholder I-III and
Menzoberranzan graphics/sounds from the user's own game copies into
`pool/` (git-ignored there, because it is commercial game data). This script
copies a curated subset into assets/imported/ (git-ignored here for the same
reason) and writes assets/imported/manifest.json in the same shape as
assets/generated/manifest.json, so the game can layer it on top.

The Dungeon Hack+ folder is only read. Nothing is written outside this project.

Usage:
    python3 -I tools/import_dhplus.py [DUNGEON_HACK_PLUS_DIR]
DUNGEON_HACK_PLUS_DIR defaults to $AETHELGARD_DHPLUS_DIR or "../Dungeon Hack+".
Run `python3 -I dhplus.py assets` inside Dungeon Hack+ first if its pool is empty.
"""
import json
import os
import shutil
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "imported")

# Descent bands -> DH+ wallset front panel + matching floor/ceiling backdrop.
THEMES = {
    "aeridor": ("walls/BLUE_wt0_front.png", "floors/BLUE_backdrop.png"),        # white stone of the spires
    "tunnels": ("walls/DUNG_wt0_front.png", "floors/DUNG_backdrop.png"),        # the working tunnels
    "bones": ("walls/eob3_mausoleum_front.png", "floors/eob3_mausoleum.png"),   # the bone warrens
    "forge": ("walls/CRIMSON_wt0_front.png", "floors/CRIMSON_backdrop.png"),    # the sunken forge
    "deep": ("walls/DROW_wt0_front.png", "floors/DROW_backdrop.png"),           # the deep dark
    "heart": ("walls/menzo_red_v0.png", "floors/menzo_red.png"),                # heart of the mountain
}
# Stairs art: the wt3/wt4 panels of the white-stone set.
STAIRS = {"stairs_up": "walls/BLUE_wt3_front.png", "stairs_down": "walls/BLUE_wt4_front.png"}

# Monster families -> sprite folders (frame 0 = front, frame 4 = attack).
MONSTERS = {
    "undead": ["eob3_lich", "eob1_skeleton", "eob1_skelwar", "eob1_zombie", "eob3_wight", "eob3_sword_wraith",
               "eob3_death_knight", "eob3_watch_ghost", "eob3_groaning_spirit", "eob3_undead_beast"],
    "construct": ["eob1_golem", "eob2_guardian", "eob3_steel_shadow", "eob3_scaladar"],
    "beast": ["eob2_wolf", "eob1_hellhound", "eob3_shadow_hound", "eob2_hellhnd", "eob1_disbeast", "eob2_basilisk"],
    "ooze": ["eob2_cube", "eob3_grey_pudding", "eob3_ogre_slug", "eob1_leech"],
    "dragon": ["eob3_wyvern", "eob3_bone_naga", "eob3_spirit_naga", "eob2_fsnake"],
    "elemental": ["eob3_earth_elemental", "eob3_water_elemental", "eob2_salamndr", "eob3_water_weird",
                  "eob2_willowis", "eob3_grave_mist"],
    "demon": ["eob3_hag", "eob3_feyr", "eob3_flar", "eob2_aservant"],
    "insect": ["eob2_spider", "eob2_ant", "eob1_mantis", "eob2_mantis", "eob2_wasp", "eob2_bulette"],
    "plant": ["eob3_shambling_mound", "eob2_gasspore"],
    "horror": ["eob2_beholder", "eob1_mflayer", "eob2_mindflay", "eob3_slithermorph", "eob3_shadow",
               "eob3_big_evil_bad_guy"],
    "giant": ["eob3_troll", "eob2_frgiant", "eob3_minotaur", "eob1_flind", "eob2_medusa", "eob3_chimera"],
    "humanoid": ["eob1_drowelf", "eob2_guard1", "eob2_guard2", "eob2_mage", "eob2_cleric1", "eob3_shadow_warrior",
                 "eob3_shadow_wizard", "eob1_dwarf", "eob1_kenku", "eob1_kobold", "eob1_kuotoa", "eob1_mage",
                 "eob1_shindia", "eob2_cleric2", "eob2_cleric3", "eob2_gargoyle"],
}

# Game sound -> DH/EOB3 effect (pool/sounds/wav).
SFX = {"step": "dirtstep", "bump": "thump2", "swing": "swing1", "hit": "lapc-hit", "miss": "miss7",
       "hurt": "stravhit", "monster_die": "scream2", "growl": "hound1", "door": "stdoor1", "gate": "metaldwn",
       "button": "stbutton", "lever": "wdlever", "plate": "pressure", "pickup": "clink1", "coin": "clink1",
       "cast": "spell1", "heal": "spell22", "fizzle": "invisibl", "leybleed": "spell100", "quake": "earth1",
       "trap": "13sling", "stairs": "gravstp2", "seal": "spell101", "key": "d-lock2", "death": "laugh1"}


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
        "AETHELGARD_DHPLUS_DIR", os.path.join(os.path.dirname(ROOT), "Dungeon Hack+"))
    pool = os.path.join(os.path.abspath(src), "pool")
    if not os.path.isdir(pool):
        sys.exit(f"no pool/ in {src}: point this at a Dungeon Hack+ checkout")
    if os.path.commonpath([os.path.abspath(src), ROOT]) == ROOT:
        sys.exit("refusing: the source must live outside this project")

    missing = []

    def take(rel, dest_rel):
        s = os.path.join(pool, rel)
        if not os.path.exists(s):
            missing.append(rel)
            return None
        d = os.path.join(OUT, dest_rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copyfile(s, d)
        return "imported/" + dest_rel.replace(os.sep, "/")

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    man = {"pack": "classic", "themes": {}, "decor": {}, "monsters": {}, "portraits": [], "sfx": {},
           "credits": "Dungeon Hack (DreamForge/SSI 1993), Eye of the Beholder I-III (Westwood/SSI), "
                      "Menzoberranzan (DreamForge/SSI) art and sound, decoded by Dungeon Hack+ "
                      "from the user's own copies. Local use only; do not redistribute."}
    for theme, (wall, backdrop) in THEMES.items():
        w = take(wall, f"tex/{theme}_wall.png")
        b = take(backdrop, f"tex/{theme}_backdrop.png")
        if w and b:
            man["themes"][theme] = {"wall": w, "backdrop": b}
    for name, rel in STAIRS.items():
        p = take(rel, f"tex/{name}.png")
        if p:
            man["decor"][name] = p
    for fam, names in MONSTERS.items():
        lst = []
        for n in names:
            front = take(f"monsters/{n}/0.png", f"sprites/{n}_0.png")
            attack = take(f"monsters/{n}/4.png", f"sprites/{n}_4.png")
            if front:
                lst.append({"front": front, "attack": attack or front, "name": n})
        if lst:
            man["monsters"][fam] = lst
    pdir = os.path.join(pool, "portraits")
    for fn in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
        if fn.endswith(".png") and "sheet" not in fn:
            p = take(f"portraits/{fn}", f"portraits/{fn}")
            if p:
                man["portraits"].append({"race": "any", "src": p})
    for game_name, wav in SFX.items():
        p = take(f"sounds/wav/{wav}.wav", f"sfx/{wav}.wav")
        if p:
            man["sfx"][game_name] = p
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")
    n_files = sum(len(fs) for _, _, fs in os.walk(OUT))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs)
    print(f"classic pack: {len(man['themes'])} themes, {sum(len(v) for v in man['monsters'].values())} monsters, "
          f"{len(man['portraits'])} portraits, {len(man['sfx'])} sounds; {n_files} files, {size // 1024} KB")
    if missing:
        print(f"{len(missing)} expected pool files were missing (skipped):")
        for m in missing[:20]:
            print("  ", m)


if __name__ == "__main__":
    main()
