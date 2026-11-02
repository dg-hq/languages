// Tests for tools/build-pack.mjs and tools/build-index.mjs. Run: node --test tests/build-pack.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Abena 11-02 (the ja pass): argument names alone let a message drop 10 of its 14 select cases, and each dropped case then read
// another case's words. A select keeps every case en-US has; a plural needs en-US's forms only where the pack's language has that
// category (CLDR: ja has only other, es has one, many and other); an exact form (=0) is the pack's choice.
test("refuses a dropped select case, and a plural form the pack's language has; takes what that language does not use", () => {
  const en = {
    'kind.label': '{kind, select, table {Table {name}} view {View {name}} other {Object {name}}}',
    'rows.count': '{n, plural, =0 {No rows} one {# row} other {# rows}}',
  };
  const build = (messages, locale = 'es') => {
    try {
      buildPack(en, messages, { ...META, locale });
    } catch (e) {
      return e.message;
    }
    return 'built';
  };
  assert.match(build({ 'kind.label': '{kind, select, table {Tabla {name}} other {Objeto {name}}}' }), /kind\.label: drops select case view of \{kind\}/);
  assert.equal(build({ 'kind.label': '{kind, select, table {Tabla {name}} view {Vista {name}} other {Objeto {name}}}' }), 'built');
  assert.match(build({ 'rows.count': '{n, plural, other {# filas}}' }, 'es'), /rows\.count: drops plural form one of \{n\}/);
  assert.equal(build({ 'rows.count': '{n, plural, one {# fila} other {# filas}}' }, 'es'), 'built');
  assert.equal(build({ 'rows.count': '{n, plural, other {#行}}' }, 'ja'), 'built');
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

// Ekow's read of #1: the app refuses C1 controls too (Rust's char::is_control), so a pack holding one would be signed and then refused.
test('refuses C1 control characters as the app does (U+0080 to U+009F), and still takes the letters after them', () => {
  for (const c of ['\u0080', '\u0085', '\u009B', '\u009F']) refused({ 'common.cancel': `a${c}b` });
  assert.equal(reason({ 'common.cancel': 'Cancelar \u00A0ya \u00E9' }), 'built');
});

// Ekow's read of #1 (Infos): what the app checks, build-pack checks first, so nothing is signed that the app would refuse or change.
test('refuses a pack over the app cap of 2 MiB, and a name or nativeName the app would not show as written', () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  assert.match(reason({ 'common.cancel': big }), /over 2 MiB/);
  for (const name of ['', 'Span\u202Eish', 'Spa\u0007nish', 'S'.repeat(65)]) assert.match(reason({ 'common.cancel': 'Cancelar' }, { ...META, name }), /name/, JSON.stringify(name));
  for (const nativeName of ['', 'Espa\u2066ñol', 'Espa\u0085ñol', 'é'.repeat(65)]) assert.match(reason({ 'common.cancel': 'Cancelar' }, { ...META, nativeName }), /nativeName/, JSON.stringify(nativeName));
  assert.equal(reason({ 'common.cancel': 'Cancelar' }, { ...META, nativeName: 'ñ'.repeat(64) }), 'built');
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

// V3 ships as 1.0.0-beta.1 (Meridian 9669), so its packs say ">=1.0.0-beta.1, <1.1.0". A comparator may carry a pre-release as
// Rust's semver reads one (dot-separated [0-9A-Za-z-] identifiers, no leading zero in a numeric one); build metadata, which a
// range ignores, and a leading zero anywhere are refused.
test('takes a pre-release in a comparator, as Rust semver reads it', () => {
  for (const app of ['>=1.0.0-beta.1, <1.1.0', '>=1.0.0-rc.0', '=1.0.0-x-y.2a', '>=1.0.0-beta, <1.1.0']) assert.equal(reason({ 'common.cancel': 'Cancelar' }, { ...META, app }), 'built', app);
  for (const app of ['>=1.0.0-', '>=1.0.0-beta..1', '>=1.0.0-beta.01', '>=1.0.0+build.1', '>=1.0-beta.1', '>=01.0.0', '>=1.0.0-beta_1']) assert.match(reason({ 'common.cancel': 'Cancelar' }, { ...META, app }), /not an app range/, app);
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

// Edem's Low on #1: the app verifies prehashed signatures only (minisign_verify, legacy off), and minisign -V takes both, so the
// release job refuses a legacy signature (algorithm Ed, base64 "RW…") before it publishes. Ekow's delta: the CLI must check what it
// is given however it is started (no entry guard to skip), and the job requires its success line.
test('the release job refuses a signature that is not prehashed (ED), as the app does', async () => {
  const minisig = signPack(buildPack(EN, { 'common.cancel': 'Cancelar' }, META).bytes, TEST_SEED, 'es-3.0.json 3.0.0');
  const lines = minisig.split('\n');
  const legacy = Buffer.from(lines[1], 'base64');
  legacy.write('Ed', 0, 'latin1');
  assert.match(legacy.toString('base64'), /^RW/);
  const legacySig = [lines[0], legacy.toString('base64'), ...lines.slice(2)].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'packs-check-'));
  try {
    writeFileSync(join(dir, 'good.minisig'), minisig);
    writeFileSync(join(dir, 'old.minisig'), legacySig);
    symlinkSync(join(ROOT, 'tools', 'check-prehashed.mjs'), join(dir, 'check.mjs'));
    for (const tool of [join(ROOT, 'tools', 'check-prehashed.mjs'), join(dir, 'check.mjs')]) {
      const run = (...files) => spawnSync(process.execPath, [tool, ...files.map((f) => join(dir, f))], { encoding: 'utf8' });
      const ok = run('good.minisig', 'good.minisig');
      assert.equal(ok.status, 0, tool);
      assert.equal(ok.stdout, '2 signatures are prehashed (ED)\n', tool);
      const no = run('good.minisig', 'old.minisig');
      assert.equal(no.status, 1, tool);
      assert.equal(no.stdout, '', tool);
      assert.match(no.stderr, /old\.minisig/, tool);
      assert.notEqual(run().status, 0, `${tool} with no files`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
  const { prehashed } = await import('../tools/build-pack.mjs');
  assert.equal(prehashed(minisig), true);
  assert.equal(prehashed(legacySig), false);
  for (const bad of ['', 'untrusted comment: x\n', 'untrusted comment: x\nnot base64!\n']) assert.equal(prehashed(bad), false, JSON.stringify(bad));
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(release, /minisign -V -P "\$PACKS_PUBKEY" -m "\$f"; done\n\s+node tools\/check-prehashed\.mjs out\/\*\.minisig \| grep -qx '\[0-9\]\* signatures are prehashed \(ED\)'\n/);
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

// Edem's M2: the latest release lists every minor's pack, so the index keys on the file a pack is (<locale>-<major>.<minor>.json).
test('the index lists each pack file once, by locale then version, in format 1, with two minors of one language side by side', () => {
  const a = buildPack(EN, ES, META).entry;
  const b = { ...a, locale: 'en-GB' };
  const c = { ...a, version: '3.1.0', app: '>=3.1.0, <3.2.0' };
  assert.deepEqual(JSON.parse(buildIndex([c, a, b]).toString('utf8')), { format: 1, packs: [b, a, c] });
  assert.throws(() => buildIndex([a, a]), /one pack a file, and these come twice: es-3\.0\.json/);
  assert.throws(() => buildIndex([a, { ...a, version: '3.0.1' }]), /es-3\.0\.json/);
});

// Edem's M2 on #1 (Abena's ruling): the app reads only the latest release, so it holds the pack of every minor still in use; the
// file name (<locale>-<minor>.json) is the key, not the locale. The app's find takes the first entry whose range matches, so one
// locale's ranges must not overlap. A pack serves its whole minor (M1: the app drops a key or argument its en-US lacks).
test('a release builds every pack packs.json lists, from the catalogues of its app minor, several minors side by side', async () => {
  const { buildAll } = await import('../tools/build-all.mjs');
  const list = JSON.parse(readFileSync(join(ROOT, 'catalogues', 'packs.json'), 'utf8'));
  if (list.length > 0) assert.equal(buildAll(list).length, list.length);
  const fixtures = join(ROOT, 'tests', 'fixtures', 'root');
  const one = { minor: '1.0', locale: 'es', name: 'Spanish', nativeName: 'Español', version: '1.0.0', app: '>=1.0.0-beta.1, <1.1.0' };
  const two = { ...one, minor: '1.1', version: '1.1.0', app: '>=1.1.0, <1.2.0' };
  assert.equal(buildAll([one], fixtures)[0].fileName, 'es-1.0.json');
  assert.deepEqual(buildAll([one, two], fixtures).map((b) => b.fileName), ['es-1.0.json', 'es-1.1.json']);
  assert.equal(buildAll([one, { ...one, locale: 'es-419', name: 'Spanish (Latin America)', nativeName: 'Español (Latinoamérica)' }], fixtures).length, 2);
  const refused = (list, why) => assert.throws(() => buildAll(list, fixtures), why, JSON.stringify(list));
  refused([], /no packs/);
  refused([{ ...one, version: '1.1.0' }], /not for app minor 1\.0/);
  refused([{ ...one, app: '>=1.1.0, <1.2.0' }], /must start in app minor 1\.0/);
  refused([{ ...one, app: '>=1.0.0, <=1.0.9' }], /">=A" or ">=A, <B"/);
  refused([{ ...one, app: '>=1.0.0, <1.0.0-beta.1' }], /empty/);
  refused([one, { ...one, version: '1.0.1' }], /es-1\.0\.json twice/);
  refused([{ ...one, app: '>=1.0.0-beta.1, <1.1.1' }, two], /overlap/);
  refused([two, { ...one, app: '>=1.0.0-beta.1' }], /overlap/);
});

// Edem's delta on #1: Rust's semver matches a pre-release only against a comparator with a pre-release on the same x.y.z, so
// "<1.1.0" never takes 1.1.0-beta.1, and 1.0's and 1.1's beta ranges do not overlap. The overlap check reads ranges that way, and
// lives in build-index, so an index made by hand is checked too (Abena).
// Abena on #1's CI: the real packs.json is empty until the Spanish pack lands, and build-all refuses an empty list, so the test job
// runs build-all, as the release does, on the fixture root (two minors of es side by side); the release keeps the real catalogues.
test('build-all, run as the release runs it, writes every pack and the index from the root it is given', () => {
  const out = mkdtempSync(join(tmpdir(), 'packs-out-'));
  try {
    const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-all.mjs'), out, '--root', join(ROOT, 'tests', 'fixtures', 'root')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['es-1.0.json', 'es-1.1.json', 'index.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).packs.map((p) => p.version), ['1.0.0', '1.1.0']);
  } finally {
    rmSync(out, { recursive: true });
  }
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(ci, /- run: node tools\/build-all\.mjs "\$RUNNER_TEMP\/out" --root tests\/fixtures\/root\n/);
  assert.match(readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'), /run: node tools\/build-all\.mjs out\n/);
});

test("judges overlap as Rust's semver matches: a pre-release only where a comparator names its x.y.z with one", async () => {
  const { buildAll } = await import('../tools/build-all.mjs');
  const fixtures = join(ROOT, 'tests', 'fixtures', 'root');
  const es = { locale: 'es', name: 'Spanish', nativeName: 'Español' };
  const one = { ...es, minor: '1.0', version: '1.0.0', app: '>=1.0.0-beta.1, <1.1.0' };
  const beta = { ...es, minor: '1.1', version: '1.1.0', app: '>=1.1.0-beta.1, <1.2.0' };
  assert.deepEqual(buildAll([one, beta], fixtures).map((b) => b.fileName), ['es-1.0.json', 'es-1.1.json']);
  const entry = buildPack(EN, ES, META).entry;
  const at = (version, app) => ({ ...entry, version, app });
  const apart = (a, b) => assert.equal(JSON.parse(buildIndex([a, b]).toString('utf8')).packs.length, 2, `${a.app} | ${b.app}`);
  const overlap = (a, b) => assert.throws(() => buildIndex([a, b]), /overlap/, `${a.app} | ${b.app}`);
  apart(at('1.0.0', '>=1.0.0-beta.1, <1.1.0'), at('1.1.0', '>=1.1.0-beta.1'));
  apart(at('1.0.0', '>=1.0.0-beta.1, <1.0.0-beta.3'), at('1.1.0', '>=1.0.0-beta.3, <1.1.0'));
  apart(at('1.0.0', '>=1.0.0, <1.1.0'), at('1.1.0', '>=1.1.0'));
  // Both name 1.0.0's pre-releases, so 1.0.0-beta.5 matches both, though no release does.
  overlap(at('1.0.0', '>=1.0.0-beta.1, <1.0.0'), at('1.1.0', '>=1.0.0-beta.5, <1.1.0'));
  // "<1.1.0-beta.2" names 1.1.0's pre-releases, so 1.1.0-beta.1 matches both.
  overlap(at('1.1.0', '>=1.1.0-beta.1, <1.2.0'), at('1.0.0', '>=1.0.0-beta.1, <1.1.0-beta.2'));
  overlap(at('1.0.0', '>=1.0.0-beta.1, <1.1.1'), at('1.1.0', '>=1.1.0, <1.2.0'));
  overlap(at('1.1.0', '>=1.1.0'), at('1.0.0', '>=1.0.0'));
  assert.throws(() => buildIndex([at('1.0.0', '^1.0.0')]), /">=A" or ">=A, <B"/);
  // Edem's delta Info: an index made by hand gets the app-range check too, so a partial or zero-led version is refused there.
  for (const app of ['>=1.0, <1.1', '>=1, <2', '>=01.0.0']) assert.throws(() => buildIndex([at('1.0.0', app)]), /not an app range/, app);
  apart(at('1.0.0', '>=1.0.0, <1.1.0'), { ...at('1.0.0', '>=1.0.0, <1.1.0'), locale: 'en-GB' });
});

test("orders app versions as semver does, pre-releases before their release", async () => {
  const { compareVersions } = await import('../tools/build-all.mjs');
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i < order.length; i++) for (let k = 0; k < order.length; k++) assert.equal(Math.sign(compareVersions(order[i], order[k])), Math.sign(i - k), `${order[i]} ${order[k]}`);
});
