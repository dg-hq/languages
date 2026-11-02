// Builds every pack catalogues/packs.json lists, and index.json, into <out dir>: what a release publishes, before signing.
//   node tools/build-all.mjs <out dir>
// packs.json, one entry a pack, every supported minor's side by side: [{ "minor": "1.0", "locale": "es", "name": "Spanish", "nativeName": "Español", "version": "1.0.0", "app": ">=1.0.0-beta.1, <1.1.0", "rtl": false }]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex } from './build-index.mjs';
import { buildPack, safetyKeys } from './build-pack.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Semver's order of two versions (x.y.z, then a pre-release below its release, compared identifier by identifier). */
export function compareVersions(a, b) {
  const parts = (v) => {
    const [core, pre] = v.split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre: pre === undefined ? [] : pre.split('.') };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

// build-all reads a range in one of two shapes, so it can tell when two of a locale's ranges overlap.
const RANGE = /^>=(\d\S*?)(?:, <(\d\S*))?$/;

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
    return { ...pack, minor, from, to };
  });
  const names = built.map((b) => b.fileName);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0) throw new Error(`refused: one pack a file, and packs.json makes ${[...new Set(twice)].join(', ')} twice`);
  // The app installs the first entry whose range takes its version, so a locale's ranges must not overlap.
  for (const a of built) {
    for (const b of built) {
      const below = (p, q) => p.to !== undefined && compareVersions(p.to, q.from) <= 0;
      if (a !== b && a.entry.locale === b.entry.locale && !below(a, b) && !below(b, a)) throw new Error(`refused: ${a.entry.locale}: the ranges of ${a.fileName} and ${b.fileName} overlap`);
    }
  }
  return built.map(({ from, to, ...b }) => b);
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
