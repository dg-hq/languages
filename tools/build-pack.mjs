// Builds one downloadable language pack from a catalogue, and its index entry (PLAN §2; Ekow's design read, PLAN §8).
// Never signs with the owner's key, which never leaves the owner's machine: it prints the minisign command for them.
//   node tools/build-pack.mjs --en <en-US.json> <catalogue.json> <locale> <name> <nativeName> <version> <app range> <out dir> [--rtl] [--keys a,b] [--test-sign <seed file>]
// --keys keeps only those keys (a small fixture). --test-sign signs with a test seed (64 hex characters in a file) for fixtures:
// such a pack is for tests only, and its key never ships (tests/build-pack.test.mjs pins that). --en is the app's en-US catalogue for
// the app minor the pack is for: the keys and arguments a pack may have.
// It refuses what the app refuses: a key en-US lacks; arguments that differ from en-US's, read as the window's own parser reads them;
// a value that is not a string or does not parse; U+E000/U+E001 (tRich's markers); a control character other than \n; a bidi
// override or isolate (U+202A–202E, U+2066–2069; LRM and RLM stay); a locale tag we do not ship; a version that is not semver.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The app's message parser (datagator ui/src/shared/i18n/messages.ts: Reader and walk), with its types dropped, so a select or plural
// form's words (`other {Delete}`) are text and the quoting rules are the window's.
class Reader {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }

  top() {
    const nodes = this.nodes(false);
    if (this.i < this.s.length) throw new Error(`Unmatched closing brace in message: ${this.s}`);
    return nodes;
  }

  /** Nodes up to a closing brace (left unread) or the end. `inPlural` makes `#` a syntax character. */
  nodes(inPlural) {
    const out = [];
    let text = '';
    const flush = () => {
      if (text !== '') out.push({ kind: 'text', text });
      text = '';
    };
    while (this.i < this.s.length) {
      const c = this.s.charAt(this.i);
      if (c === '}') break;
      if (c === "'") {
        const next = this.s.charAt(this.i + 1);
        if (next === "'") {
          text += "'";
          this.i += 2;
        } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
          // Quoted text: to the next lone apostrophe, `''` inside it being one apostrophe.
          this.i += 1;
          while (this.i < this.s.length) {
            const q = this.s.charAt(this.i);
            if (q === "'") {
              if (this.s.charAt(this.i + 1) === "'") {
                text += "'";
                this.i += 2;
                continue;
              }
              this.i += 1;
              break;
            }
            text += q;
            this.i += 1;
          }
        } else {
          text += "'";
          this.i += 1;
        }
      } else if (c === '{') {
        flush();
        out.push(this.argument());
      } else if (c === '#' && inPlural) {
        flush();
        out.push({ kind: 'pound' });
        this.i += 1;
      } else {
        text += c;
        this.i += 1;
      }
    }
    flush();
    return out;
  }

  skip() {
    while (/\s/.test(this.s.charAt(this.i))) this.i += 1;
  }

  word(stops) {
    const start = this.i;
    while (this.i < this.s.length && !/\s/.test(this.s.charAt(this.i)) && !stops.includes(this.s.charAt(this.i))) this.i += 1;
    return this.s.slice(start, this.i);
  }

  expect(c) {
    if (this.i >= this.s.length) throw new Error(`Unclosed brace in message: ${this.s}`);
    if (this.s.charAt(this.i) !== c) throw new Error(`Expected "${c}" at ${String(this.i)} in message: ${this.s}`);
    this.i += 1;
  }

  /** From the opening brace of an argument to its closing one. */
  argument() {
    this.expect('{');
    this.skip();
    const name = this.word(',}');
    if (name === '') throw new Error(`An argument with no name in message: ${this.s}`);
    this.skip();
    if (this.s.charAt(this.i) === '}') {
      this.i += 1;
      return { kind: 'arg', name, number: false };
    }
    this.expect(',');
    this.skip();
    const type = this.word(',}');
    this.skip();
    if (type === 'number') {
      this.expect('}');
      return { kind: 'arg', name, number: true };
    }
    if (type !== 'plural' && type !== 'select') throw new Error(`Unknown argument type "${type}" in message: ${this.s}`);
    this.expect(',');
    const cases = new Map();
    for (;;) {
      this.skip();
      if (this.s.charAt(this.i) === '}') break;
      const selector = this.word('{}');
      if (selector === '') throw new Error(`Expected a form name in message: ${this.s}`);
      this.skip();
      this.expect('{');
      // `#` and its quoting are syntax only directly inside a plural's own forms, as in formatjs and ICU4J: a select nested there writes it as it is.
      cases.set(selector, this.nodes(type === 'plural'));
      this.expect('}');
    }
    this.i += 1;
    if (!cases.has('other')) throw new Error(`A ${type} needs an "other" form in message: ${this.s}`);
    return { kind: type, name, cases };
  }
}

function walk(nodes, found) {
  for (const node of nodes) {
    if (node.kind === 'arg' || node.kind === 'plural' || node.kind === 'select') found.add(node.name);
    if (node.kind === 'plural' || node.kind === 'select') for (const c of node.cases.values()) walk(c, found);
  }
}


const argsOf = (text) => {
  const found = new Set();
  walk(new Reader(text).top(), found);
  return [...found].sort().join('|');
};
const unreadable = (text) => {
  try {
    new Reader(text).top();
    return null;
  } catch (e) {
    return e.message;
  }
};

/** A tag we ship: a language, then a script and a region if any (es, en-GB, zh-Hans, es-419). Nothing else names a file. */
export const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;

/** The app range as Rust's semver VersionReq reads it, in one form: comparators such as >=3.0.0 joined by ", ". */
export const APP_RANGE = /^(>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+(, (>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+)*$/;

/** The words that guard a risky step: the TLS, Production and host-key questions, Connect anyway, the tunnel and edit guards. */
const SAFETY = ['common.cancel', 'common.connect', 'compare.envWarn', 'connect.choice', 'env.', 'errors.connection.tls.', 'errors.connection.tunnel.', 'generate.blocked', 'gridEdit.review', 'guard.', 'hostKey.', 'sync.envWarn', 'tls.', 'tunnel.'];
export const safetyKeys = (messages) => Object.keys(messages).filter((k) => SAFETY.some((p) => k.startsWith(p))).sort();

/** The pack's bytes and its index entry. Throws "refused: …", one line a problem, as the app would refuse it. */
export function buildPack(en, source, { locale, name, nativeName, version, app, rtl = false }, only = null) {
  const bad = [];
  if (!LOCALE.test(locale ?? '')) bad.push(`not a locale tag we ship: ${JSON.stringify(locale)}`);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) bad.push(`not a semver version: ${JSON.stringify(version)}`);
  if (!APP_RANGE.test(app ?? '')) bad.push(`not an app range Rust's semver reads (comparators joined by ", "): ${JSON.stringify(app)}`);
  const messages = {};
  for (const key of Object.keys(source).sort()) {
    if (only && !only.has(key)) continue;
    const v = source[key];
    if (typeof v !== 'string') bad.push(`${key}: not a string`);
    else if (en[key] === undefined) bad.push(`${key}: not in en-US`);
    else if (unreadable(v)) bad.push(`${key}: ${unreadable(v)}`);
    else if (argsOf(v) !== argsOf(en[key])) bad.push(`${key}: args ${argsOf(v)} ≠ en-US ${argsOf(en[key])}`);
    else if (/[\uE000\uE001]/.test(v)) bad.push(`${key}: holds a tRich marker`);
    else if (/[\u0000-\u0009\u000B-\u001F\u007F]/.test(v)) bad.push(`${key}: a control character`);
    else if (/[\u202A-\u202E\u2066-\u2069]/.test(v)) bad.push(`${key}: a bidi override or isolate`);
    else messages[key] = v;
  }
  if (only) for (const k of only) if (!(k in messages) && !bad.some((b) => b.startsWith(`${k}:`))) bad.push(`${k}: not in the catalogue`);
  if (bad.length > 0) throw new Error(`refused:\n${bad.join('\n')}`);
  const keys = Object.keys(messages).length;
  const pack = { format: 1, manifest: { locale, name, nativeName, version, app, keys, rtl }, messages };
  const [major, minor] = version.split('.');
  const bytes = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { fileName: `${locale}-${major}.${minor}.json`, bytes, entry: { locale, name, nativeName, version, app, keys, of: Object.keys(en).length, bytes: bytes.length, sha256, rtl } };
}

const keysOf = (seed) => {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pk = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12);
  return { privateKey, pk, id: createHash('sha256').update(pk).digest().subarray(0, 8) };
};

/** A minisign public key file for a 32-byte seed: "Ed", the key id, the Ed25519 key. */
export function publicKeyOf(seed) {
  const { pk, id } = keysOf(seed);
  return `untrusted comment: minisign public key ${Buffer.from(id).reverse().toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), id, pk]).toString('base64')}\n`;
}

/** A .minisig for `bytes` in minisign's prehashed form ("ED": Ed25519 over BLAKE2b-512), with the global signature over the trusted comment. */
export function signPack(bytes, seed, trusted) {
  if (/[\r\n]/.test(trusted)) throw new Error('a trusted comment is one line');
  const { privateKey, id } = keysOf(seed);
  const sig = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), privateKey);
  return `untrusted comment: signature from a Datagator packs test key\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const named = new Set(['--en', '--keys', '--test-sign']);
  const plain = args.filter((a, i) => !a.startsWith('--') && !named.has(args[i - 1]));
  const [file, locale, name, nativeName, version, app, out] = plain;
  if (!out || flag('--en') === null) throw new Error('usage: build-pack.mjs --en <en-US.json> <catalogue.json> <locale> <name> <nativeName> <version> <app range> <out dir> [--rtl] [--keys a,b] [--test-sign <seed file>]');
  const rest = args;
  const only = flag('--keys') === null ? null : new Set(flag('--keys').split(','));
  const en = JSON.parse(readFileSync(flag('--en'), 'utf8'));
  const { fileName, bytes, entry } = buildPack(en, JSON.parse(readFileSync(file, 'utf8')), { locale, name, nativeName, version, app, rtl: rest.includes('--rtl') }, only);
  mkdirSync(out, { recursive: true });
  const path = join(out, fileName);
  writeFileSync(path, bytes);
  writeFileSync(`${path}.index-entry.json`, `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`wrote ${path} (${entry.keys} of ${entry.of} keys, ${entry.bytes} bytes, sha256 ${entry.sha256})`);
  const safety = safetyKeys(JSON.parse(bytes.toString('utf8')).messages);
  console.log(`safety keys this pack words (${safety.length}): read each before signing`);
  for (const k of safety) console.log(`  ${k}: ${JSON.parse(bytes.toString('utf8')).messages[k]}`);
  const seedFile = flag('--test-sign');
  if (seedFile !== null) {
    const seed = Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'hex');
    if (seed.length !== 32) throw new Error('a test seed is 64 hex characters');
    writeFileSync(`${path}.minisig`, signPack(bytes, seed, `${fileName} ${version}`));
    console.log(`signed with a TEST key (never ship it): ${path}.minisig`);
  } else console.log(`sign it (owner): minisign -S -s <packs secret key> -t "${fileName} ${version}" -m ${path}`);
}
