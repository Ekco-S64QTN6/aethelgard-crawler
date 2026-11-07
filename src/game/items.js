// Item definitions come from Kaiacord's equipment registry (data/items.json);
// a few dungeon-only items (keys, lore pages, the Symbol) are defined here.

const EXTRA = {
  ironvein_key: { name: 'Ironvein Key', slot: 'key', kind: 'key', value: 0, description: 'Stamped with the Ironclad Guild mark. Opens a Guild lock on this floor.' },
  aeridorian_key: { name: 'Aeridorian Key', slot: 'key', kind: 'key', value: 0, description: 'A crystal rod that hums against keyholes cut for it a thousand years ago.' },
  bone_key: { name: 'Bone Key', slot: 'key', kind: 'key', value: 0, description: 'A finger bone, filed into a key. It fits better than it should.' },
  forge_key: { name: 'Forge Key', slot: 'key', kind: 'key', value: 0, description: 'Still warm. The teeth are cut in the Aeridorian manner.' },
  void_key: { name: 'Void Key', slot: 'key', kind: 'key', value: 0, description: 'It is cold in a way that has nothing to do with temperature.' },
  heart_key: { name: 'Heart Key', slot: 'key', kind: 'key', value: 0, description: 'Calcified, faintly pulsing. The lock it opens is waiting for it.' },
  symbol_of_the_silent_ones: {
    name: 'Symbol of the Silent Ones', slot: 'consumable', kind: 'coin', value: 0, quest: true,
    description: 'Flame - stone - silence. The pattern from the Shrine flame and altar. Sealed shrines answer it; fractured crystals quiet when it touches them.',
  },
};

export const THEME_KEY = { aeridor: 'aeridorian_key', tunnels: 'ironvein_key', bones: 'bone_key', forge: 'forge_key', deep: 'void_key', heart: 'heart_key' };

let DEFS = null;
let PAGES = {};

export function initItems(data) {
  DEFS = { ...data.items.items, ...EXTRA };
  PAGES = data.lore.pages;
  return DEFS;
}

export function itemDef(key) {
  if (key.startsWith('lore:')) {
    const p = PAGES[key.slice(5)];
    return p ? { name: `Lore: ${p[1]}`, slot: 'consumable', kind: 'page', value: 0, page: key.slice(5), description: p[2] } : null;
  }
  return DEFS[key] || null;
}

const INGREDIENTS = new Set(['blood_thistle', 'silver_moss', 'honey_sap', 'dire_root', 'silverleaf', 'gilded_mushroom']);
const LORE_DROPS = new Set(['shift_log_page', 'burial_offering', 'forge_manifest', 'deep_fragment', 'mountain_shard', 'spine_memory', 'wingpost_letter']);

// Icon kind used by the UI / floor sprites.
export function itemKind(key) {
  const d = itemDef(key);
  if (!d) return 'bag';
  if (d.kind) return d.kind;
  const n = d.name.toLowerCase();
  switch (d.slot) {
    case 'weapon':
      if (/bow|crossbow|sling/.test(n)) return 'bow';
      if (/staff|wand|scepter|rod|focus|orb|chime|cipher|singularity|spire|speaker|voice of/.test(n)) return 'staff';
      return 'weapon';
    case 'armor': return 'armor';
    case 'head': return 'head';
    case 'boots': return 'boots';
    case 'accessory': return 'accessory';
    case 'key': return 'key';
  }
  if (key === 'ether') return 'ether';
  if (/elixir|moonwater|phoenix/.test(key)) return 'elixir';
  if (d.gem_tier || /pearl|topaz|peridot|emerald|opal|ruby|sapphire|jacinth|diamond/.test(key)) return 'gem';
  if (INGREDIENTS.has(key) || /herb|bandage/.test(key)) return 'herb';
  if (key === 'aeridor_shard' || key === 'deep_fragment' || key === 'mountain_shard') return 'shard';
  if (key === 'torch' || key === 'lightstone') return 'torch';
  if (LORE_DROPS.has(key)) return 'page';
  if (d.hp_restore) return 'potion';
  if (d.on_use) return 'potion';
  return 'bag';
}

export function isStackable(key) {
  const d = itemDef(key);
  return !!d && d.slot === 'consumable' && !key.startsWith('lore:');
}

// Weapon reach: bows, wands, staves and foci can strike from the back row.
export function weaponReach(key) {
  if (!key) return 'melee';
  const k = itemKind(key);
  return k === 'bow' || k === 'staff' ? 'ranged' : 'melee';
}

export function canEquip(char, key) {
  const d = itemDef(key);
  if (!d || !['weapon', 'armor', 'head', 'boots', 'accessory'].includes(d.slot)) return false;
  if (!d.classes) return true;
  return d.classes.includes(char.cls) || (char.adv && d.classes.includes(char.adv));
}

export function describeItem(key) {
  const d = itemDef(key);
  if (!d) return key;
  const bits = [];
  if (d.slot === 'weapon') {
    bits.push(`ATK +${d.attack_bonus || 0}`, `d${d.damage_die}${d.damage_bonus ? '+' + d.damage_bonus : ''}`);
    if (d.proc) bits.push(`${d.proc.name} (${d.proc.element} d${d.proc.die})`);
    bits.push(weaponReach(key) === 'ranged' ? 'ranged' : 'melee');
  }
  if (d.defense_bonus) bits.push(`DEF +${d.defense_bonus}`);
  if (d.attack_bonus && d.slot !== 'weapon') bits.push(`ATK +${d.attack_bonus}`);
  if (d.hp_bonus) bits.push(`HP +${d.hp_bonus}`);
  if (d.stat_bonus) for (const [s, v] of Object.entries(d.stat_bonus)) bits.push(`${s.toUpperCase()} +${v}`);
  if (d.hp_restore) bits.push(`restores ${d.hp_restore} HP`);
  if (d.tier) bits.push(`tier ${d.tier}`);
  if (d.classes) bits.push(d.classes.join('/'));
  return bits.join(' · ');
}
