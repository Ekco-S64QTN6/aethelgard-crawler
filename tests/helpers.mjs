import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadData } from '../src/game/data.js';
import { initItems } from '../src/game/items.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let cached = null;

export async function data() {
  if (!cached) {
    cached = await loadData(async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8')));
    initItems(cached);
  }
  return cached;
}
