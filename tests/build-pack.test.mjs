// Tests for tools/build-pack.mjs and tools/build-index.mjs. Run: node --test tests/build-pack.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../tools/build-index.mjs';
import { buildPack, publicKeyOf, safetyKeys, signPack } from '../tools/build-pack.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const EN = read('tests/fixtures/en-US.json');
const ES = read('tests/fixtures/es.json');
const META = { locale: 'es', name: 'Spanish', nativeName: 'Español', version: '3.0.0', app: '>=3.0.0, <3.1.0' };
// The packs test key: a fixed seed that lives in this file only and never signs a pack anyone downloads.
// The release key's public half (README, the workflow's check): the app ships this one.
const RELEASE_KEY = 'RWRxFzLxF4CvBv5c61B4irdglkLRU91bgCLKEG+WcpL3CM+APfBYSBhL';
const TEST_SEED = createHash('sha256').update('datagator packs test key, never shipped').digest();

const refused = (messages, meta = META) => assert.throws(() => buildPack(EN, messages, meta), /refused/);
const reason = (messages, meta = META) => {
  try {
    buildPack(EN, messages, meta);
  } catch (e) {
    return e.message;
  }
  return 'built';
};

test('a pack is format 1: the verified manifest, then the messages, sorted, and its index entry hashes the same bytes', () => {
  const { fileName, bytes, entry } = buildPack(EN, { 'common.cancel': 'Cancelar', 'common.close': 'Cerrar' }, META);
  assert.equal(fileName, 'es-3.0.json');
  const pack = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(pack, {
    format: 1,
    manifest: { locale: 'es', name: 'Spanish', nativeName: 'Español', version: '3.0.0', app: '>=3.0.0, <3.1.0', keys: 2, rtl: false },
    messages: { 'common.cancel': 'Cancelar', 'common.close': 'Cerrar' },
  });
  assert.ok(bytes.toString('utf8').endsWith('}\n'));
  assert.deepEqual(entry, {
    locale: 'es', name: 'Spanish', nativeName: 'Español', version: '3.0.0', app: '>=3.0.0, <3.1.0',
    keys: 2, of: Object.keys(EN).length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), rtl: false,
  });
  // No hash inside the manifest (agreed with Edem): the signature covers the bytes, the index's sha256 is a damage check only.
  assert.equal('sha256' in pack.manifest, false);
});

test('the fixture catalogue builds whole, and so does every catalogue in catalogues/, against the en-US beside it', () => {
  assert.equal(buildPack(EN, ES, META).entry.keys, Object.keys(ES).length);
  const dir = join(ROOT, 'catalogues');
  for (const minor of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
    const en = JSON.parse(readFileSync(join(dir, minor, 'en-US.json'), 'utf8'));
    for (const f of readdirSync(join(dir, minor)).filter((n) => n.endsWith('.json') && n !== 'en-US.json')) {
      const source = JSON.parse(readFileSync(join(dir, minor, f), 'utf8'));
      assert.equal(buildPack(en, source, { ...META, locale: f.slice(0, -'.json'.length) }).entry.keys, Object.keys(source).length, `${minor}/${f}`);
    }
  }
});

test("a select or plural form's words are text, not arguments; LRM, RLM and a line break pass", () => {
  const key = 'environments.delete.confirm'; // =0 {Delete}: one word in braces, a form, not an argument
  assert.equal(reason({ [key]: ES[key] }), 'built');
  assert.equal(reason({ 'common.cancel': 'Can‎celar‏\nya' }), 'built');
});

test('refuses what the app refuses: a key en-US lacks, other arguments, a non-string, an unreadable message', () => {
  assert.match(reason({ 'no.such.key': 'x' }), /no\.such\.key: not in en-US/);
  const arg = 'connections.delete.title';
  assert.match(reason({ [arg]: EN[arg].replace('{name}', '{nombre}') }), /args nombre ≠ en-US name/);
  assert.match(reason({ 'common.cancel': 3 }), /not a string/);
  assert.match(reason({ 'common.cancel': 'x {' }), /common\.cancel: An argument with no name/);
});

test("refuses tRich's markers, control characters, and bidi overrides and isolates (Ekow 8)", () => {
  for (const c of ['', '', '\u0000', '\u0007', '\t', '\u007F', '‪', '‮', '⁦', '⁩']) {
    refused({ 'common.cancel': `a${c}b` });
  }
});

test('refuses a locale tag that is not one we ship, before it names a file, and a version that is not semver (Ekow 5)', () => {
  for (const locale of ['../es', 'es/../../x', 'ES', 'es_ES', 'es-es', '']) refused({ 'common.cancel': 'Cancelar' }, { ...META, locale });
  for (const locale of ['es', 'en-GB', 'zh-Hans', 'es-419']) assert.equal(reason({ 'common.cancel': 'Cancelar' }, { ...META, locale }), 'built');
  for (const version of ['3', '3.0', 'v3.0.0', '3.0.0-beta']) refused({ 'common.cancel': 'Cancelar' }, { ...META, version });
});

// Edem on the fixture: the app reads the range with Rust's semver VersionReq, which needs a comma between comparators; a space
// alone ("expected comma after patch version number") would refuse every pack as languages.format.
test("writes the app range as Rust's semver reads it: comparators joined by a comma, and refuses any other form", () => {
  for (const app of ['>=3.0.0, <3.1.0', '>=3.0.0', '=3.0.0', '^3.0.0', '~3.0.0', '>3.0.0, <=3.0.9']) assert.equal(reason({ 'common.cancel': 'Cancelar' }, { ...META, app }), 'built', app);
  for (const app of ['>=3.0.0 <3.1.0', '>=3.0.0,<3.1.0', '3.0', '*', '', '>=3.0.0 || <2.0.0']) assert.match(reason({ 'common.cancel': 'Cancelar' }, { ...META, app }), /not an app range/, app);
});

test('lists the safety words a pack changes, for the owner to read before signing (Ekow 9)', () => {
  const s = safetyKeys(ES);
  for (const k of ['common.cancel', 'common.connect']) assert.ok(s.includes(k), k);
  assert.ok(s.some((k) => k.startsWith('errors.connection.tls.')));
  assert.ok(s.some((k) => k.startsWith('tls.')));
  assert.equal(s.includes('common.close'), false);
});

// minisign's prehashed form (the only one the app takes): "ED", the key id, Ed25519 over BLAKE2b-512 of the file; then the
// global signature over that signature and the trusted comment.
test("signs as minisign does, in the prehashed ED form with a trusted comment (Edem's minisign-verify test reads the fixture)", () => {
  const { bytes } = buildPack(EN, { 'common.cancel': 'Cancelar' }, META);
  const minisig = signPack(bytes, TEST_SEED, 'es-3.0.json 3.0.0');
  const lines = minisig.split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^untrusted comment: /);
  assert.equal(lines[2], 'trusted comment: es-3.0.json 3.0.0');
  assert.equal(lines[4], '');
  const sig = Buffer.from(lines[1], 'base64');
  assert.equal(sig.length, 74);
  assert.equal(sig.subarray(0, 2).toString('latin1'), 'ED');
  const pub = Buffer.from(publicKeyOf(TEST_SEED).split('\n')[1], 'base64');
  assert.equal(pub.length, 42);
  assert.equal(pub.subarray(0, 2).toString('latin1'), 'Ed');
  assert.deepEqual(sig.subarray(2, 10), pub.subarray(2, 10), 'the same key id');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10)]), format: 'der', type: 'spki' });
  const prehash = createHash('blake2b512').update(bytes).digest();
  assert.ok(verify(null, prehash, key, sig.subarray(10)), 'the file signature');
  assert.ok(verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice('trusted comment: '.length))]), key, Buffer.from(lines[3], 'base64')), 'the global signature');
  assert.equal(verify(null, createHash('blake2b512').update(Buffer.concat([bytes, Buffer.from(' ')])).digest(), key, sig.subarray(10)), false, 'one more byte fails');
  // The seed is the key: the same seed signs the same way (Ed25519 is deterministic).
  assert.equal(signPack(bytes, TEST_SEED, 'es-3.0.json 3.0.0'), minisig);
});

test("the test key never ships: its public half is in no file outside tests/, and it is not the release key", () => {
  const testKey = publicKeyOf(TEST_SEED).split('\n')[1];
  const raw = Buffer.from(testKey, 'base64').subarray(10);
  const needles = [testKey, raw.toString('base64'), raw.toString('hex')];
  const skip = /(^|\/)(node_modules|target|dist|\.git)(\/|$)/;
  const isTest = (p) => /^tests\//.test(p);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(ROOT, p);
      if (skip.test(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|json|md|ya?ml|pub)$/.test(name) && !isTest(rel)) {
        const text = readFileSync(p, 'utf8');
        for (const n of needles) if (text.includes(n)) hits.push(`${rel}: ${n.slice(0, 12)}…`);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
  assert.notEqual(testKey, RELEASE_KEY);
});

test('the index lists each pack once, by locale, in format 1', () => {
  const a = buildPack(EN, ES, META).entry;
  const b = { ...a, locale: 'en-GB' };
  assert.deepEqual(JSON.parse(buildIndex([a, b]).toString('utf8')), { format: 1, packs: [b, a] });
  assert.throws(() => buildIndex([a, a]), /one pack a locale/);
});

test('a release builds every pack packs.json lists, from the catalogues of its app minor, and refuses a version for another minor', async () => {
  const { buildAll } = await import('../tools/build-all.mjs');
  const list = JSON.parse(readFileSync(join(ROOT, 'catalogues', 'packs.json'), 'utf8'));
  assert.equal(buildAll(list).length, list.length);
  const fixtures = join(ROOT, 'tests', 'fixtures', 'root');
  const one = { minor: '3.0', locale: 'es', name: 'Spanish', nativeName: 'Español', version: '3.0.0', app: '>=3.0.0, <3.1.0' };
  assert.equal(buildAll([one], fixtures)[0].fileName, 'es-3.0.json');
  assert.throws(() => buildAll([{ ...one, version: '3.1.0' }], fixtures), /not for app minor 3.0/);
});
