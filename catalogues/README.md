# Catalogues

One folder per app minor version, holding the newest `en-US.json` of that minor (the keys and arguments a pack may use) and one `<locale>.json` per downloadable language:

```
catalogues/1.0/en-US.json
catalogues/1.0/es.json
```

`en-US.json` is copied from the app at the newest release of its minor (`ui/src/shared/i18n/en-US.json`); it is never a pack. Each other file becomes `<locale>-<major>.<minor>.json` when a release is made. An older build of the minor drops a key its own en-US lacks, or one whose arguments differ, and shows that key in English.

`packs.json` lists one entry a pack, and keeps the entries of every minor still in use: the app reads only the latest release, so that release holds every minor's pack. Each range starts in its own minor, as `">=A"` or `">=A, <B"` (V3's is `">=1.0.0-beta.1, <1.1.0"`), and one language's ranges never overlap, since the app installs the first entry that matches.
