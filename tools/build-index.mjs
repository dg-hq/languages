// Writes index.json from the index entries build-pack.mjs left in a folder: what the app lists before it downloads anything.
// The index is signed like a pack; its sha256s are a damage check only, and the app verifies each pack's own signature.
//   node tools/build-index.mjs <out dir>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildIndex(entries) {
  const locales = entries.map((e) => e.locale);
  const twice = locales.filter((l, i) => locales.indexOf(l) !== i);
  if (twice.length > 0) throw new Error(`refused: one pack a locale, and these come twice: ${[...new Set(twice)].join(', ')}`);
  const packs = [...entries].sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));
  return Buffer.from(`${JSON.stringify({ format: 1, packs }, null, 2)}\n`, 'utf8');
}

if (process.argv[1] === import.meta.filename) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: build-index.mjs <out dir>');
  const entries = readdirSync(out)
    .filter((f) => f.endsWith('.index-entry.json'))
    .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')));
  writeFileSync(join(out, 'index.json'), buildIndex(entries));
  console.log(`wrote ${join(out, 'index.json')} (${entries.length} packs)`);
}
