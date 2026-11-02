// Builds every pack catalogues/packs.json lists, and index.json, into <out dir>: what a release publishes, before signing.
//   node tools/build-all.mjs <out dir> [--root <dir with catalogues/>]
// packs.json, one entry a pack, every supported minor's side by side: [{ "minor": "1.0", "locale": "es", "name": "Spanish", "nativeName": "Español", "version": "1.0.0", "app": ">=1.0.0-beta.1, <1.1.0", "rtl": false }]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, compareVersions, RANGE } from './build-index.mjs';
import { buildPack, safetyKeys } from './build-pack.mjs';

export { compareVersions };

const ROOT = join(import.meta.dirname, '..');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function buildAll(list, root = ROOT) {
  if (list.length === 0) throw new Error('refused: packs.json lists no packs, and a release with none would sign an empty index');
  const built = list.map(({ minor, locale, name, nativeName, version, app, rtl = false }) => {
    if (!/^\d+\.\d+$/.test(minor ?? '') || !version?.startsWith(`${minor}.`)) throw new Error(`refused: ${locale}: version ${version} is not for app minor ${minor}`);
    const en = read(join(root, 'catalogues', minor, 'en-US.json'));
    const pack = buildPack(en, read(join(root, 'catalogues', minor, `${locale}.json`)), { locale, name, nativeName, version, app, rtl });
    const [, from, to] = RANGE.exec(app) ?? [];
    if (from === undefined) throw new Error(`refused: ${locale} ${minor}: build-all takes a range ">=A" or ">=A, <B", not ${JSON.stringify(app)}`);
    if (!from.startsWith(`${minor}.`)) throw new Error(`refused: ${locale} ${minor}: the range must start in app minor ${minor}, not at ${from}`);
    if (to !== undefined && compareVersions(from, to) >= 0) throw new Error(`refused: ${locale} ${minor}: the range ${app} is empty`);
    return { ...pack, minor };
  });
  const names = built.map((b) => b.fileName);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0) throw new Error(`refused: one pack a file, and packs.json makes ${[...new Set(twice)].join(', ')} twice`);
  buildIndex(built.map((b) => b.entry)); // refuses one locale's overlapping ranges, as Rust's semver reads them
  return built;
}

if (process.argv[1] === import.meta.filename) {
  const [out, flag, dir] = process.argv.slice(2);
  if (!out || (flag !== undefined && (flag !== '--root' || !dir))) throw new Error('usage: build-all.mjs <out dir> [--root <dir with catalogues/>]');
  // The release builds the real catalogues; the test job passes the fixture root, as the real packs.json may be empty.
  const root = dir ?? ROOT;
  mkdirSync(out, { recursive: true });
  const built = buildAll(read(join(root, 'catalogues', 'packs.json')), root);
  for (const { fileName, bytes, entry } of built) {
    writeFileSync(join(out, fileName), bytes);
    console.log(`${fileName}: ${entry.keys} of ${entry.of} keys, ${entry.bytes} bytes, sha256 ${entry.sha256}`);
    const messages = JSON.parse(bytes.toString('utf8')).messages;
    for (const k of safetyKeys(messages)) console.log(`  safety ${k}: ${messages[k]}`);
  }
  writeFileSync(join(out, 'index.json'), buildIndex(built.map((b) => b.entry)));
  console.log(`index.json: ${built.length} packs`);
}
