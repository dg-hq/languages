// Writes index.json from the index entries build-pack.mjs left in a folder: what the app lists before it downloads anything.
// The index is signed like a pack; its sha256s are a damage check only, and the app verifies each pack's own signature.
//   node tools/build-index.mjs <out dir>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file a pack is, from its version: the name the app downloads and checks the signature's trusted comment against. */
const fileOf = (e) => `${e.locale}-${e.version.split('.').slice(0, 2).join('.')}.json`;

export function buildIndex(entries) {
  // Every supported minor's pack sits in the one latest release (Edem's M2), so a file, not a locale, comes once.
  const files = entries.map(fileOf);
  const twice = files.filter((f, i) => files.indexOf(f) !== i);
  if (twice.length > 0) throw new Error(`refused: one pack a file, and these come twice: ${[...new Set(twice)].join(', ')}`);
  const key = (e) => [e.locale, ...e.version.split('.').map(Number)];
  const packs = [...entries].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
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
