# Standard Sheets — date formats & region-aware defaults

This component is the vendored **`org.standardnotes.standard-sheets`** spreadsheet
note type. It is a PREBUILT bundle:

- `dist.js` — minified standard-sheets app (NOT editable source; upstream source is
  not in this repo).
- `index.html` — editable host page that loads the vendor libs and `dist.js`.
- `vendor/js/kendo.spreadsheet.min.js` — **Kendo UI Spreadsheet, version 2021.3.914**.

## Date format support that already works today

The bundled Kendo Spreadsheet supports Excel-like **cell number/date format
strings**. A user applies them per cell via the toolbar **Format** menu (custom
number format), exactly like Excel:

| Format string | Result          | Style    |
| ------------- | --------------- | -------- |
| `yyyy-mm-dd`  | 2026-06-21      | ISO 8601 |
| `dd/mm/yyyy`  | 21/06/2026      | European |
| `dd.mm.yyyy`  | 21.06.2026      | German   |
| `mm/dd/yyyy`  | 06/21/2026      | US       |
| `d mmm yyyy`  | 21 Jun 2026     | Regional |
| `dddd, d mmmm yyyy` | Sunday, 21 June 2026 | Long |

So **ISO and European formats are achievable per-cell right now**, no changes
required. The gap this directory addresses is the **region DEFAULT** (the format
used when the user types a date and applies no explicit format) and **date
parsing**, which Kendo derives from the active *culture*.

## Region-aware defaults via Kendo cultures (the part `index.html` wires up)

Kendo is culture-aware. Loading `kendo.culture.<locale>.min.js` and calling
`kendo.culture("<locale>")` **before** `dist.js` initializes the spreadsheet
changes the default date display + parsing (e.g. German → `dd.MM.yyyy`,
UK → `dd/MM/yyyy`) instead of the en-US default.

`index.html` now detects the locale from `navigator.language` (fallback `en-US`),
and, **if** the matching culture file is present at
`./vendor/js/cultures/kendo.culture.<locale>.min.js`, loads it and activates it.
The load is guarded: if the file is missing (404) or `kendo.culture` is
unavailable, it silently no-ops and the spreadsheet falls back to the built-in
`en-US` default with **no crash**.

`en-US` (and bare `en`) is already built into the bundle, so no file is needed for
it. For region-only tags (e.g. `de-DE`) the snippet also tries the base language
(`de`).

## MANUAL STEP — culture files are NOT vendored

The Kendo culture files are **not** included in this repo. They contain
version-specific CLDR locale data and **must not be fabricated** — they have to
come from the matching Kendo UI 2021.3.914 distribution.

To enable region defaults, obtain the Kendo UI 2021.3.914 distribution (the same
release as `vendor/js/kendo.spreadsheet.min.js`) and copy the desired culture
files from its `js/cultures/` folder into:

```
vendor/js/cultures/
```

keeping the exact `kendo.culture.<locale>.min.js` naming. Files to drop in for the
app's supported locales (where a Kendo culture exists):

```
kendo.culture.en-GB.min.js
kendo.culture.de.min.js        kendo.culture.de-DE.min.js
kendo.culture.fr.min.js        kendo.culture.fr-FR.min.js
kendo.culture.es.min.js        kendo.culture.es-ES.min.js
kendo.culture.it.min.js        kendo.culture.it-IT.min.js
kendo.culture.pt-PT.min.js
kendo.culture.pt-BR.min.js
kendo.culture.nl.min.js        kendo.culture.nl-NL.min.js
kendo.culture.pl.min.js        kendo.culture.pl-PL.min.js
kendo.culture.ru.min.js        kendo.culture.ru-RU.min.js
kendo.culture.uk.min.js        kendo.culture.uk-UA.min.js
kendo.culture.tr.min.js        kendo.culture.tr-TR.min.js
kendo.culture.ja.min.js        kendo.culture.ja-JP.min.js
kendo.culture.ko.min.js        kendo.culture.ko-KR.min.js
kendo.culture.zh-CN.min.js
kendo.culture.ar.min.js
```

(`en-US` is built in — no file required.) Only the files that match the user's
`navigator.language` are ever requested at runtime, so you may ship a subset.

After dropping the files in `vendor/js/cultures/`, mirror them into the other
vendored copies of this component (see "Vendored copies" below) the same way the
rest of the bundle is mirrored.

## Hard ceiling (be honest)

A per-preference date-format **picker UI inside the spreadsheet** (a setting that
overrides the culture default app-wide) is **not** possible from `index.html`
alone — it requires modifying the standard-sheets application logic, whose source
is **not vendored here** (`dist.js` is minified). What is achievable without that
source: (1) per-cell Excel-like formats via the Format menu (already works), and
(2) region-aware defaults via the culture mechanism wired up above.

## Vendored copies

The canonical, editable copy is the `web/src` one. The same bundle is mirrored at:

- `app/packages/web/src/.../org.standardnotes.standard-sheets/dist/` (canonical)
- `app/packages/web/dist/.../org.standardnotes.standard-sheets/dist/`
- `app/packages/desktop/app/dist/web/.../org.standardnotes.standard-sheets/dist/`
- `app/packages/mobile/html/Web.bundle/src/web-src/.../org.standardnotes.standard-sheets/dist/`
- `app/packages/clipper/dist/.../org.standardnotes.standard-sheets/dist/`

The `index.html` change has been mirrored to all of them. `vendor/js/cultures/`
files (when sourced) should be mirrored the same way.

## Manual check

1. Open a spreadsheet note in a browser whose `navigator.language` is `de-DE`.
2. If `vendor/js/cultures/kendo.culture.de-DE.min.js` (or `kendo.culture.de.min.js`)
   is present, typing a date and leaving it unformatted defaults to `dd.MM.yyyy`.
   If the file is absent, it falls back to the en-US default with no error.
3. Regardless of culture, applying a custom `yyyy-mm-dd` cell format via the Format
   menu always yields ISO output.
