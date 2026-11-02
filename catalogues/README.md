# Catalogues

One folder per app minor version, holding that version's `en-US.json` (the keys and arguments a pack may use) and one `<locale>.json` per downloadable language:

```
catalogues/3.0/en-US.json
catalogues/3.0/es.json
```

`en-US.json` is copied from the app at the release it serves (`ui/src/shared/i18n/en-US.json`); it is never a pack. Each other file becomes `<locale>-<major>.<minor>.json` when a release is made.
