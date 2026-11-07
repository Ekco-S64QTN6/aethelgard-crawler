#!/usr/bin/env python3
"""Import Aethelgard's !rpg content from a Kaiacord checkout into data/*.json.

Kaiacord is read, never modified or imported: every registry is parsed with
`ast` and evaluated with `ast.literal_eval`, so none of Kaiacord's code (or its
Discord / LLM dependencies) runs. The game only ever reads data/*.json, so there
is no runtime link back to the Kaiacord folder.

Usage:
    python3 -I tools/import_kaiacord.py [KAIACORD_DIR]

KAIACORD_DIR defaults to $AETHELGARD_KAIACORD_DIR or ../Kaiacord.
Names borrowed from other franchises are renamed through tools/name_scrub.json.
"""
import ast
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

FILES = [
    "utils/ttrpg/monster_registry.py",
    "utils/ttrpg/equipment_registry.py",
    "utils/ttrpg/loot_tables.py",
    "utils/ttrpg/class_advancement.py",
    "utils/ttrpg/alchemy.py",
    "utils/ttrpg/lore.py",
    "utils/ttrpg/npc_registry.py",
    "utils/ttrpg/quest_registry.py",
    "utils/ttrpg/pantheon.py",
    "utils/ttrpg/progression.py",
    "utils/ttrpg/dungeon.py",
    "utils/ttrpg/rare_spawns.py",
    "utils/ttrpg/combat_engine.py",
    "utils/ttrpg/world.py",
    "utils/ttrpg/spine_dungeon.py",
    "utils/ttrpg/spine_layouts.json",
    "utils/ttrpg/rpg_character_creation_handler.py",
    "docs/ttrpg/aethelgard_lore_bible.md",
]


def jsonable(v):
    if isinstance(v, (set, frozenset)):
        return sorted(jsonable(x) for x in v)
    if isinstance(v, tuple):
        return [jsonable(x) for x in v]
    if isinstance(v, list):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    return v


class Module:
    """Literal assignments of one Python source file, found without executing it."""

    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            self.tree = ast.parse(f.read(), filename=path)

    def top(self, name):
        for node in self.tree.body:
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == name:
                        return jsonable(ast.literal_eval(node.value))
        raise KeyError(name)

    def in_function(self, func, name):
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func:
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Assign):
                        for t in sub.targets:
                            if isinstance(t, ast.Name) and t.id == name:
                                return jsonable(ast.literal_eval(sub.value))
        raise KeyError(f"{func}.{name}")


# ── Monster families (drive sprite choice, Undead Bane, Tree Memory, Ley-Bleed) ──
FAMILY_OVERRIDES = {
    "bone_weaver_spider": "insect", "the_mountain_heart": "horror", "aeridorian_echo": "undead",
    "whisperwood_heart": "plant", "the_living_forge": "elemental", "the_mountains_white_blood": "ooze",
    "core_parasite": "horror", "vessel_husk": "undead", "chain_horror": "demon",
    "pit_viper": "beast", "smoldering_ash_walker": "elemental", "slag_horror": "elemental",
}
FAMILY_RULES = [
    # Whole-word matches against the key and the display name, most specific first.
    ("elemental", r"elemental|elementals|wisp|mote|element"),
    ("demon", r"devil|fiend|demon|balor|glabrezu|hezrou|marilith|vrock|imp|imps|rakshasa|prince|twin-maw|pit"),
    ("dragon", r"dragon|wyrm|drake|wyvern|hydra|dracolich|hoard"),
    ("giant", r"giant|gigas|titan|troll|ogre|hulk|behemoth|minotaur|colossus"),
    ("construct", r"golem|construct|sentinel|guardian|soldier|clockwork|engine|anvil|bellows|automaton|crystelle|architect|warden|forge"),
    ("undead", r"skeleton|skeletal|zombie|ghoul|ghast|ghost|wight|wraith|spectre|spectral|lich|revenant|dullahan|vampire|knight|unburied|bones?|ossuary|crypt|cairn|corpse|burial|charnel|skull|shade|dread|count|tomb|marrow|entombed|husk|undying|mummy|banshee"),
    ("ooze", r"ooze|slime|cube|pudding|gel|lamprey|leech|parasite|blood"),
    ("insect", r"spider|spiderling|beetle|bee|hornet|centipede|mantis|ant|antlion|skitterer|crawler|weaver|stirge|moth|scorpion|worm|wurm|lurker|stalk"),
    ("plant", r"tree|treant|bloom|moss|spore|mold|vine|briar|thorn|root|whisperwood|puffcap|maw|ochu|creeper|myconid"),
    ("horror", r"horror|thought|mind|eye|eyeless|gaze|void|abomination|nerve|pulse|psychic|null|dreamer|lurking|nightmare|folio|starless|unmaking|watcher|walker"),
    ("elemental", r"elemental|wisp|mote|fire|flame|ember|cinder|slag|molten|furnace|ash|storm|air|crystal|lightning|bloat"),
    ("beast", r"wolf|bear|owlbear|boar|bat|rat|hound|cat|panther|stag|bunny|lizard|snake|serpent|viper|adder|toad|basilisk|cockatrice|griffon|manticore|chimera|roc|raptor|harpy|eel|ray|crab|claw|crayfish|tortoise|kraken|bulette|leaper|beast|aevis|coeurl|sahuagin|bird|tiger"),
]


def family_of(key, mon):
    if key in FAMILY_OVERRIDES:
        return FAMILY_OVERRIDES[key]
    words = set(re.split(r"[^a-z-]+", f"{key} {mon.get('name', '')}".lower().replace("_", " ")))
    words |= {w2 for w in list(words) for w2 in w.split("-")}
    for fam, rx in FAMILY_RULES:
        alts = rx.split("|")
        if any(re.fullmatch(a, w) for a in alts for w in words if w):
            return fam
    return "humanoid"


def git_head(repo):
    try:
        head = open(os.path.join(repo, ".git", "HEAD")).read().strip()
        if head.startswith("ref: "):
            ref = head[5:]
            p = os.path.join(repo, ".git", ref)
            if os.path.exists(p):
                return ref, open(p).read().strip()
            packed = os.path.join(repo, ".git", "packed-refs")
            if os.path.exists(packed):
                for line in open(packed):
                    if line.strip().endswith(ref):
                        return ref, line.split()[0]
            return ref, None
        return None, head
    except OSError:
        return None, None


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
        "AETHELGARD_KAIACORD_DIR", os.path.join(os.path.dirname(ROOT), "Kaiacord"))
    src = os.path.abspath(src)
    for rel in FILES:
        if not os.path.exists(os.path.join(src, rel)):
            sys.exit(f"missing {rel} in {src}: is this a Kaiacord checkout?")
    if os.path.commonpath([src, ROOT]) == ROOT:
        sys.exit("refusing: the source must live outside this project")

    def mod(rel):
        return Module(os.path.join(src, "utils", "ttrpg", rel))

    with open(os.path.join(HERE, "name_scrub.json"), encoding="utf-8") as f:
        scrub = json.load(f)

    # ── Monsters ────────────────────────────────────────────────────────────
    mr = mod("monster_registry.py")
    monsters = mr.top("MONSTERS")
    encounter_tables = mr.top("ENCOUNTER_TABLES")

    # ── Items ───────────────────────────────────────────────────────────────
    eq = mod("equipment_registry.py")
    items = {}
    for table, slot in (("WEAPONS", "weapon"), ("ARMOR", "armor"), ("HEADGEAR", "head"),
                        ("BOOTS", "boots"), ("ACCESSORIES", "accessory"), ("CONSUMABLES", "consumable")):
        for key, it in eq.top(table).items():
            it = dict(it)
            it["slot"] = slot
            if "gil" in it:
                it["gold"] = it.pop("gil")
            items[key] = it
    shop = {s: eq.top(f"HEMLOCK_STOCK_{s.upper()}") for s in
            ("weapons", "armor", "headgear", "boots", "accessories", "consumables")}
    lt = mod("loot_tables.py")
    loot = {"gear": lt.in_function("get_gear_loot", "tables"),
            "consumable": lt.in_function("get_consumable_loot", "tables")}
    al = mod("alchemy.py")
    alchemy = {"recipes": al.top("ALCHEMY_RECIPES"),
               "discovers": al.top("INGREDIENT_DISCOVERS"),
               "secondary": al.top("SECONDARY_DISCOVERS")}

    # ── Classes, races, progression ─────────────────────────────────────────
    ca = mod("class_advancement.py")
    pr = mod("progression.py")
    ce = mod("combat_engine.py")
    pa = mod("pantheon.py")
    cc = Module(os.path.join(src, "utils/ttrpg/rpg_character_creation_handler.py"))
    classes = {
        "attack_stat": ce.in_function("_resolve_combat", "CLASS_ATTACK_STAT"),
        "hp_per_level": pr.top("HP_PER_LEVEL"),
        "procs": ca.top("CLASS_PROCS"),
        "advanced": ca.top("ADVANCED_CLASSES"),
        "titles": ca.top("TITLES"),
        "undead_names": ca.top("_UNDEAD_NAMES"),
        "xp_thresholds": pr.top("XP_THRESHOLDS"),
        "races": None,  # a local inside the creation handler; found below
        "deities": pa.top("DEITIES"),
        "class_deity": pa.top("CLASS_DEITY"),
    }
    for node in ast.walk(cc.tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "RACE_BONUSES"
                                                for t in node.targets):
            classes["races"] = jsonable(ast.literal_eval(node.value))
    if not classes["races"]:
        sys.exit("RACE_BONUSES not found")
    combat = {"one_fight_buffs": ce.top("ONE_FIGHT_BUFFS"), "buff_labels": ce.top("BUFF_LABELS"),
              "tier_damage": ce.top("TIER_DAMAGE")}

    # ── Dungeons ────────────────────────────────────────────────────────────
    dg = mod("dungeon.py")
    rs = mod("rare_spawns.py")
    dungeon = {
        "themes": dg.top("DUNGEON_THEMES"),
        "location_theme_weights": dg.top("LOCATION_THEME_WEIGHTS"),
        "boss_prefixes": dg.top("_BOSS_PREFIXES"),
        "boss_titles": dg.top("_BOSS_TITLES"),
        "boss_suffixes": dg.top("_BOSS_SUFFIXES"),
        "shrine_sealed": dg.top("SHRINE_ROOM_SEALED"),
        "shrine_unlocked": dg.top("SHRINE_ROOM_UNLOCKED"),
        "shrine_completed": dg.top("SHRINE_ROOM_COMPLETED"),
        "encounter_tables": encounter_tables,
        "rare_variants": rs.top("VARIANTS"),
        "rare_one_in": rs.top("RARE_ONE_IN"),
        "gem_drops": rs.top("GEM_DROPS"),
    }
    sp = mod("spine_dungeon.py")
    with open(os.path.join(src, "utils/ttrpg/spine_layouts.json"), encoding="utf-8") as f:
        layouts = json.load(f)
    spine = {"stair_guardians": sp.top("STAIR_GUARDIANS"), "floors": {}}
    for k in sorted(layouts, key=int):
        fl = layouts[k]
        rooms = {}
        for ck, r in fl["rooms"].items():
            rooms[ck] = {kk: r[kk] for kk in ("type", "monster_key", "boss_name", "description",
                                              "is_room", "label", "room_name") if r.get(kk) is not None}
        spine["floors"][k] = {"name": fl["floor_name"], "flavor": fl["floor_flavor"],
                              "grid": fl["grid_size"], "up": fl["stairs_up_key"],
                              "down": fl.get("stairs_down_key"), "rooms": rooms,
                              "links": fl["connections"]}

    # ── Lore ────────────────────────────────────────────────────────────────
    lo = mod("lore.py")
    lore = {
        "sets": lo.top("LORE_SETS"),
        "pages": lo.top("LORE_PAGES"),
        "npcs": mod("npc_registry.py").top("NPCS"),
        "quests": mod("quest_registry.py").top("QUESTS"),
        "locations": mod("world.py").top("LOCATION_DATA"),
    }

    out = {"monsters": monsters, "items": {"items": items, "shop": shop, "loot": loot, "alchemy": alchemy},
           "classes": classes, "combat": combat, "dungeon": dungeon, "spine": spine, "lore": lore}

    # ── Name scrub: rename keys everywhere, then names, then free text ──────
    key_map = {old: new for old, (new, _) in scrub["monsters"].items()}
    key_map.update({old: new for old, (new, _) in scrub["items"].items()})
    key_map.update(scrub.get("keys", {}))
    name_map = {new: name for _, (new, name) in list(scrub["monsters"].items()) + list(scrub["items"].items())}
    collisions = set(key_map.values()) & (set(monsters) | set(items)) - set(key_map)
    if collisions:
        sys.exit(f"scrub would collide with existing keys: {sorted(collisions)}")
    text_rx = [(re.compile(r"(?<![\w-])" + re.escape(a.strip()) + r"(?![\w-])"), b.strip())
               for a, b in scrub["text"]]

    def fix_text(s):
        for rx, b in text_rx:
            s = rx.sub(b, s)
        return s

    def walk(v, parent_key=None):
        if isinstance(v, dict):
            return {key_map.get(k, k): walk(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, str):
            if v in key_map:
                return key_map[v]
            return fix_text(v)
        return v

    out = walk(out)
    for key, name in name_map.items():
        for table in (out["monsters"], out["items"]["items"]):
            if key in table:
                table[key]["name"] = name
    for key, m in out["monsters"].items():
        if "gil" in m:
            m["gold"] = m.pop("gil")
        m["family"] = family_of(key, m)

    flag = re.compile(scrub["flag_regex"])
    leftovers = []

    def scan(v, path):
        if isinstance(v, dict):
            for k, x in v.items():
                scan(k, path + "/<key>")
                scan(x, f"{path}/{k}")
        elif isinstance(v, list):
            for i, x in enumerate(v):
                scan(x, f"{path}[{i}]")
        elif isinstance(v, str) and flag.search(v):
            leftovers.append(f"{path}: {v[:100]}")

    scan(out, "")

    # ── Write ───────────────────────────────────────────────────────────────
    os.makedirs(DATA, exist_ok=True)
    for name, payload in out.items():
        with open(os.path.join(DATA, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1 if name != "spine" else None,
                      sort_keys=False)
            f.write("\n")
    ref, sha = git_head(src)
    prov = {"source": "Kaiacord !rpg (utils/ttrpg, docs/ttrpg)", "git_ref": ref, "git_commit": sha,
            "files": {rel: hashlib.sha256(open(os.path.join(src, rel), "rb").read()).hexdigest()
                      for rel in FILES},
            "renamed": len(key_map), "unscrubbed_mentions": leftovers}
    with open(os.path.join(DATA, "SOURCE.json"), "w", encoding="utf-8") as f:
        json.dump(prov, f, indent=1)
        f.write("\n")

    print(f"monsters {len(out['monsters'])}, items {len(out['items']['items'])}, "
          f"floors {len(out['spine']['floors'])}, lore pages {len(out['lore']['pages'])}, "
          f"npcs {len(out['lore']['npcs'])}, quests {len(out['lore']['quests'])}")
    print(f"renamed {len(key_map)} keys; {len(leftovers)} flagged mentions left (see data/SOURCE.json)")
    for line in leftovers[:40]:
        print("  ", line)


if __name__ == "__main__":
    main()
