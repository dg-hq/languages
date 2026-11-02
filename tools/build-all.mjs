// Builds every pack catalogues/packs.json lists, and index.json, into <out dir>: what a release publishes, before signing.
//   node tools/build-all.mjs <out dir>
// packs.json: [{ "minor": "1.0", "locale": "es", "name": "Spanish", "nativeName": "Español", "version": "1.0.0", "app": ">=1.0.0-beta.1, <1.1.0", "rtl": false }]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex } from './build-index.mjs';
import { buildPack, safetyKeys } from './build-pack.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function buildAll(list, root = ROOT) {
  return list.map(({ minor, locale, name, nativeName, version, app, rtl = false }) => {
    if (!/^\d+\.\d+$/.test(minor ?? '') || !version?.startsWith(`${minor}.`)) throw new Error(`refused: ${locale}: version ${version} is not for app minor ${minor}`);
    const en = read(join(root, 'catalogues', minor, 'en-US.json'));
    return { ...buildPack(en, read(join(root, 'catalogues', minor, `${locale}.json`)), { locale, name, nativeName, version, app, rtl }), minor };
  });
}

if (process.argv[1] === import.meta.filename) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: build-all.mjs <out dir>');
  mkdirSync(out, { recursive: true });
  const built = buildAll(read(join(ROOT, 'catalogues', 'packs.json')));
  for (const { fileName, bytes, entry } of built) {
    writeFileSync(join(out, fileName), bytes);
    console.log(`${fileName}: ${entry.keys} of ${entry.of} keys, ${entry.bytes} bytes, sha256 ${entry.sha256}`);
    const messages = JSON.parse(bytes.toString('utf8')).messages;
    for (const k of safetyKeys(messages)) console.log(`  safety ${k}: ${messages[k]}`);
  }
  writeFileSync(join(out, 'index.json'), buildIndex(built.map((b) => b.entry)));
  console.log(`index.json: ${built.length} packs`);
}
