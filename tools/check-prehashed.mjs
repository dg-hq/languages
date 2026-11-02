// Refuses a signature the app would refuse: the app verifies prehashed (ED) minisign signatures only, and minisign -V also takes
// the legacy Ed form (Edem's Low on #1). The release job runs it on every .minisig before it publishes.
//   node tools/check-prehashed.mjs <file.minisig>...
import { readFileSync } from 'node:fs';

/** Whether a .minisig's signature line is minisign's prehashed form: 74 bytes, algorithm "ED". */
export function prehashed(minisig) {
  const line = minisig.split('\n')[1] ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return false;
  const sig = Buffer.from(line, 'base64');
  return sig.length === 74 && sig.subarray(0, 2).toString('latin1') === 'ED';
}

if (process.argv[1] === import.meta.filename) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('usage: check-prehashed.mjs <file.minisig>...');
  const bad = files.filter((f) => !prehashed(readFileSync(f, 'utf8')));
  if (bad.length > 0) {
    console.error(`refused: not a prehashed (ED) signature, which the app refuses: ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log(`${files.length} signatures are prehashed (ED)`);
}
