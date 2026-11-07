// Loads the game's JSON data (imported from Kaiacord by tools/import_kaiacord.py)
// through an injected reader, so the same code runs in the browser (fetch) and
// in Node tests (fs).
const FILES = ['monsters', 'items', 'classes', 'combat', 'dungeon', 'spine', 'lore'];

export async function loadData(readJson) {
  const out = {};
  await Promise.all(FILES.map(async (f) => { out[f] = await readJson(`data/${f}.json`); }));
  return out;
}

export const browserReader = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};
