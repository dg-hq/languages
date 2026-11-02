# Datagator language packs

Downloadable languages for [Datagator](https://github.com/majorpaynegh/datagator). The app ships English (US and UK), Japanese and German; every other language is a pack it downloads from this repository's releases when someone asks for it in Settings › Language, and checks before it uses a word.

## What a pack is

One file per language and app minor version, `<locale>-<major>.<minor>.json`, with its minisign signature beside it (`.minisig`):

```json
{
  "format": 1,
  "manifest": {
    "locale": "es",
    "name": "Spanish",
    "nativeName": "Español",
    "version": "1.0.0",
    "app": ">=1.0.0-beta.1, <1.1.0",
    "keys": 4584,
    "rtl": false
  },
  "messages": { "common.cancel": "Cancelar", "…": "…" }
}
```

- `locale` is a tag the app ships: a language, then a script and a region if any (`es`, `en-GB`, `zh-Hans`, `es-419`).
- `version` is semver; a pack is re-signed for each app minor.
- `app` is the app versions the pack is for, as Rust's semver reads a range: comparators joined by `, `.
- `keys` is how many messages the pack has. A key the pack lacks shows in English.
- `messages` are the app's catalogue keys and their text, in the app's ICU message syntax, sorted.

`index.json` lists the packs (locale, names, version, app range, key count, `of` = the app's key count, size, `sha256`, `rtl`) so the app can offer them before it downloads one. It is signed too. Its `sha256` only catches a damaged download; the app trusts a pack because of the pack's own signature.

## What the app checks

The app downloads over HTTPS only, with a size cap, and then:

1. checks the signature over the exact bytes it downloaded, with the packs key it ships (below), before it reads them;
2. reads the manifest from those bytes, never from the index;
3. refuses a pack for another locale, another app version, or an older version than the one installed;
4. refuses a key its English does not have, a message whose arguments differ from English, a message it cannot parse, the app's own rich-text markers (U+E000, U+E001), control characters other than a line break (C0, DEL and C1), and bidi overrides and isolates (U+202A–202E, U+2066–2069); `build-pack` refuses all of these first, and also a message that drops a select case en-US has, or a plural form en-US has that the pack's language uses (its CLDR plural categories; an exact `=N` form is the pack's choice), a pack over 2 MiB (the most the app downloads) and a `name` or `nativeName` the app would not show as written (empty, a control or bidi character, over 64 characters);
5. checks the signature again each time it starts, and shows English if anything fails.

`tools/build-pack.mjs` refuses the same things, so a pack that would be refused is never published.

## The packs key

```
untrusted comment: minisign public key 06AF8017F1321771
RWRxFzLxF4CvBv5c61B4irdglkLRU91bgCLKEG+WcpL3CM+APfBYSBhL
```

Check any file by hand with `minisign -V -P RWRxFzLxF4CvBv5c61B4irdglkLRU91bgCLKEG+WcpL3CM+APfBYSBhL -m es-1.0.json`.

The secret half is only in the `packs` environment's `LANGUAGE_PACK_SIGNING_KEY` secret (the owner approves each release run), as an unencrypted minisign secret key (`minisign -G -W`), since the release job cannot type a password. The tests sign with a test key that never ships; a test checks its public half is in no file outside `tests/`.

## Making a release

1. Put the newest `en-US.json` of the app minor in `catalogues/<minor>/`, the translations beside it, and each pack in `catalogues/packs.json`, keeping the entries of every minor still in use (see `catalogues/README.md`). build-all refuses the same file twice, a language's overlapping ranges, and an empty list.
2. Run `node --test tests/build-pack.test.mjs` and `node tools/build-all.mjs out`, and read the safety words it lists (the TLS, Production and host-key questions, Connect anyway, the edit and tunnel guards): a pack owns them.
3. Push a tag `packs-<yyyy-mm-dd>` on a commit that is on `main`. The release job refuses any other commit before it reads the key; then it tests the tools, builds every pack and the index, signs each with the packs key, checks each signature with the public key above and that it is prehashed (ED), and publishes them.

## Tools

- `tools/build-pack.mjs --en <en-US.json> <catalogue.json> <locale> <name> <nativeName> <version> <app range> <out dir>`: one pack and its index entry.
- `tools/build-index.mjs <out dir>`: `index.json` from the entries.
- `tools/build-all.mjs <out dir> [--root <dir>]`: every pack in `catalogues/packs.json`, and the index; the test job passes `--root tests/fixtures/root`, since the real list may be empty and an empty list is refused.
- `tools/check-prehashed.mjs <file.minisig>...`: refuses a signature that is not minisign's prehashed (ED) form, which is the only form the app verifies.

Node 20.11 or later, no dependencies.
