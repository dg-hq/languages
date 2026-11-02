// Refuses a signature the app would refuse: the app verifies prehashed (ED) minisign signatures only, and minisign -V also takes
// the legacy Ed form (Edem's Low on #1). The release job runs it on every .minisig before it publishes, and requires its last line.
// No entry guard: this file is only ever run, so it checks its arguments however it is started (Ekow's delta).
//   node tools/check-prehashed.mjs <file.minisig>...
import { readFileSync } from 'node:fs';
import { prehashed } from './build-pack.mjs';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: check-prehashed.mjs <file.minisig>...');
const bad = files.filter((f) => !prehashed(readFileSync(f, 'utf8')));
if (bad.length > 0) {
  console.error(`refused: not a prehashed (ED) signature, which the app refuses: ${bad.join(', ')}`);
  process.exit(1);
}
console.log(`${files.length} signatures are prehashed (ED)`);
