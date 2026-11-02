// Writes index.json from the index entries build-pack.mjs left in a folder: what the app lists before it downloads anything.
// The index is signed like a pack; its sha256s are a damage check only, and the app verifies each pack's own signature.
//   node tools/build-index.mjs <out dir>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file a pack is, from its version: the name the app downloads and checks the signature's trusted comment against. */
const fileOf = (e) => `${e.locale}-${e.version.split('.').slice(0, 2).join('.')}.json`;

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

// A range in one of two shapes, so the tools can tell when two of a locale's ranges overlap.
export const RANGE = /^>=(\d\S*?)(?:, <(\d\S*))?$/;

const isPre = (v) => v.includes('-');
const xyz = (v) => v.split('-')[0];
const max = (a, b) => (compareVersions(a, b) >= 0 ? a : b);

/**
 * Whether one app version can match both ranges, as Rust's semver matches: inside both intervals, and, for a pre-release, only
 * where a comparator of each range names its x.y.z with a pre-release (so "<1.1.0" never takes 1.1.0-beta.1).
 */
export function overlaps(a, b) {
  const lo = max(a.from, b.from);
  const tops = [a.to, b.to].filter((t) => t !== undefined);
  const below = (v) => tops.every((t) => compareVersions(v, t) < 0);
  if (below(isPre(lo) ? xyz(lo) : lo)) return true;
  const named = (r) => [r.from, r.to].filter((c) => c !== undefined && isPre(c)).map(xyz);
  return named(a)
    .filter((t) => named(b).includes(t))
    .some((t) => {
      const v = max(lo, `${t}-0`);
      return isPre(v) && xyz(v) === t && below(v);
    });
}

export function buildIndex(entries) {
  // Every supported minor's pack sits in the one latest release (Edem's M2), so a file, not a locale, comes once.
  const files = entries.map(fileOf);
  const twice = files.filter((f, i) => files.indexOf(f) !== i);
  if (twice.length > 0) throw new Error(`refused: one pack a file, and these come twice: ${[...new Set(twice)].join(', ')}`);
  // The app installs the first entry whose range takes its version, so a locale's ranges must not overlap.
  const ranges = entries.map((e) => {
    const [, from, to] = RANGE.exec(e.app ?? '') ?? [];
    if (from === undefined) throw new Error(`refused: ${fileOf(e)}: the tools take a range ">=A" or ">=A, <B", not ${JSON.stringify(e.app)}`);
    return { e, from, to };
  });
  for (const [i, a] of ranges.entries()) {
    for (const b of ranges.slice(i + 1)) {
      if (a.e.locale === b.e.locale && overlaps(a, b)) throw new Error(`refused: ${a.e.locale}: the ranges of ${fileOf(a.e)} and ${fileOf(b.e)} overlap`);
    }
  }
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
