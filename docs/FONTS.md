# Fonts

Longitude ships its fonts with the app, so text looks the same on every
machine and nothing is fetched from a font service. Every bundled font is
under the SIL Open Font License 1.1 or the Apache License 2.0. Licence texts
are in `web/fonts/LICENSES/`, one file per family.

```
web/fonts/
  fonts.json            the list the app reads (one entry per family)
  original/             fonts made for Longitude (built from tools/fonts/)
  <family>/             bundled fonts, subset to Latin
  ui/                   the app's own UI fonts (Manrope, Syne, Space Mono)
  LICENSES/<family>.txt licence texts
tools/fonts/
  build_original.py     builds the four original fonts
  meridian.py           Meridian glyph skeletons
  gridline.txt          Gridline pixel source
  skeleton.py           stroke skeleton helpers used by meridian.py
  specimen.py           renders PNG specimens
  fetch_fonts.py        downloads upstream files from google/fonts
  build_bundled.py      subsets them into web/fonts/
  check_manifest.py     checks fonts.json against the files
  sources.json          which upstream files go where
```

## What is included

The font picker shows these groups, in this order.

| Family | Group | Licence | Designer | Files |
| --- | --- | --- | --- | --- |
| Longitude Meridian | Original | OFL-1.1 | Longitude contributors | `original/LongitudeMeridian-Regular.woff2` |
| Longitude Meridian Slant | Original | OFL-1.1 | Longitude contributors | `original/LongitudeMeridianSlant-Italic.woff2` |
| Longitude Gridline | Original | OFL-1.1 | Longitude contributors | `original/LongitudeGridline-Regular.woff2` |
| Longitude Gridline Dot | Original | OFL-1.1 | Longitude contributors | `original/LongitudeGridlineDot-Regular.woff2` |
| Anton | Classics | OFL-1.1 | Vernon Adams | `anton/` |
| Bebas Neue | Classics | OFL-1.1 | Ryoichi Tsunekawa (Dharma Type) | `bebasneue/` |
| Montserrat | Classics | OFL-1.1 | Julieta Ulanovsky, Sol Matas, Juan Pablo del Peral, Jacques Le Bailly | `montserrat/` (variable 100-900, upright and italic) |
| Oswald | Classics | OFL-1.1 | Vernon Adams, Kalapi Gajjar, Cyreal | `oswald/` (variable 200-700) |
| Archivo Black | Classics | OFL-1.1 | Omnibus-Type | `archivoblack/` |
| Poppins | Classics | OFL-1.1 | Indian Type Foundry, Jonny Pinhorn, Ninad Kale | `poppins/` (ExtraBold, Black, Black Italic) |
| Luckiest Guy | Classics | Apache-2.0 | Astigmatic | `luckiestguy/` |
| Lilita One | Classics | OFL-1.1 | Juan Montoreano | `lilitaone/` (unmodified TTF) |
| Rubik | Classics | OFL-1.1 | Hubert and Fischer, Meir Sadan, Cyreal, Daniel Grumer, Omaima Dajani | `rubik/` (variable 300-900, opens at Black) |
| Impact | Meme | system | installed on most Windows and macOS machines | none |
| Arial Black | Meme | system | installed on most Windows and macOS machines | none |
| Bangers | Meme | OFL-1.1 | Vernon Adams | `bangers/` |
| Comic Neue | Meme | OFL-1.1 | Craig Rozynski, Hrant Papazian | `comicneue/` (Bold, Bold Italic) |
| Permanent Marker | Meme | Apache-2.0 | Font Diner | `permanentmarker/` |
| Bungee | Display | OFL-1.1 | David Jonathan Ross | `bungee/` |
| Monoton | Display | OFL-1.1 | Vernon Adams | `monoton/` (unmodified TTF) |
| Black Ops One | Display | OFL-1.1 | James Grieshaber, Eben Sorkin | `blackopsone/` |
| Press Start 2P | Display | OFL-1.1 | CodeMan38 | `pressstart2p/` (unmodified TTF) |
| Creepster | Display | OFL-1.1 | Sideshow | `creepster/` (unmodified TTF) |
| Unbounded | Display | OFL-1.1 | NaN | `unbounded/` (variable 200-900) |
| Righteous | Display | OFL-1.1 | Astigmatic | `righteous/` (unmodified TTF) |
| Russo One | Display | OFL-1.1 | Jovanny Lemonad | `russoone/` (unmodified TTF) |
| Syne | Display | OFL-1.1 | Bonjour Monde, Lucas Descroix, George Triantafyllakos | `ui/syne.woff2` (variable 400-800, shared with the UI) |
| Rubik Glitch | Display | OFL-1.1 | NaN, Luke Prowse | `rubikglitch/` |
| Inter | Clean | OFL-1.1 | Rasmus Andersson | `inter/` (variable 100-900, optical size, upright and italic) |
| Manrope | Clean | OFL-1.1 | Mikhail Sharanda | `ui/manrope.woff2` (variable 200-800, shared with the UI) |

UI fonts (not in the picker except where listed above): Manrope, Syne and
Space Mono (Colophon Foundry, OFL-1.1), in `web/fonts/ui/`.

Impact and Arial Black are not shipped. Longitude measures whether they are
installed and lists them only when they are. A project that uses Impact on a
machine without it draws with Anton instead (Arial Black falls back to
Archivo Black).

Two more groups fill up as you use the app: **Yours** (font files you add,
stored in this browser only) and **System** (system fonts that mods register).

All bundled font files together are about 1.1 MB. Each face downloads only the
first time a design uses it or the picker shows it.

## The original fonts

Four families were drawn for Longitude and are released under the OFL with
the copyright "Longitude contributors". No name is reserved, so forks can
keep the names.

- **Longitude Meridian**: heavy, rounded, slightly condensed capitals for
  thumbnails. Every glyph is a centre line stroked at 156 units (22% of the
  cap height) with round caps and joins, so terminals and corners are all
  soft and the weight stays even. Rounds are squircles that overshoot by 12
  units. Lowercase letters type capitals. Covers ASCII, the accented Latin-1 letters
  (accented capitals, which lowercase also maps to), £ € © ® ™ « » ± ÷,
  curly quotes, dashes, ellipsis, arrows, a heart and a star, with kerning
  for the pairs that need it (AV, AT, LT, T., quotes and so on).
- **Longitude Meridian Slant**: Meridian sheared 12 degrees, as its own
  family so it works without an italic toggle.
- **Longitude Gridline**: a pixel font. Capitals and figures sit on a 5 by 7
  grid, lowercase has real descenders on a 5 by 9 cell, every printable ASCII
  character is there, plus the accented Latin-1 letters, ß, £ € ¢ ¥ © ® ™ « » ± ÷,
  curly quotes, arrows, a heart and a star. One pixel is 100 units.
- **Longitude Gridline Dot**: the same grid drawn with round dots, like an
  LED sign.

Characters a font does not have fall back to the next font in its stack, so
text never disappears.

### Building them

```
pip install --user fonttools skia-pathops brotli pillow
python tools/fonts/build_original.py              # writes web/fonts/original/*.woff2
python tools/fonts/build_original.py --specimen   # also renders tools/fonts/out/*.png
```

The build is deterministic: the same sources produce the same bytes. It:

1. Builds each Meridian glyph from its skeleton in `meridian.py`, strokes it
   with skia-pathops (round caps and joins) and unions the parts into clean
   outlines. Gridline glyphs come from the pixel rows in `gridline.txt`; the
   build also composes accented letters from the base letter and an accent
   bitmap.
2. Converts the curves to TrueType quadratics, rounds to integer units and
   drops collinear points and degenerate contours.
3. Places each glyph by its side bearings (Meridian) or on the pixel grid
   (Gridline), and writes cmap, hmtx, name (family, style, version 1.000,
   OFL licence and URL), OS/2 (typo metrics 900 / -200, USE_TYPO_METRICS),
   post, head and a `.notdef` box. Meridian also gets a GPOS kern feature
   and a legacy `kern` table.
4. Validates every glyph: no contour with fewer than three points or a
   near-zero area, and consistent winding (outer contours clockwise, holes
   counter-clockwise, judged by nesting). Any problem fails the build.
5. Saves TTF copies and specimens to `tools/fonts/out/` (git-ignored) and
   WOFF2 to `web/fonts/original/`, and writes the OFL texts.

To change a Meridian letter, edit its function in `meridian.py` (a `Sk` path
is a centre line: `.l()` draws a line, `.c(cx, cy, x, y)` a rounded corner
through the corner point, `rbox()` a rounded box) and rebuild with
`--specimen` to look at the result. To change a Gridline glyph, edit its rows
in `gridline.txt`.

## The bundled fonts

```
python tools/fonts/fetch_fonts.py      # downloads into tools/fonts/cache/ (git-ignored)
python -P tools/fonts/build_bundled.py # subsets into web/fonts/, copies licences
python -P tools/fonts/check_manifest.py
```

`build_bundled.py` keeps Google Fonts' "latin" set plus Latin Extended-A
(Central European, Turkish, Baltic), Romanian comma letters, arrows and a few
symbols. It keeps every variable axis at its full range (Inter keeps its
optical size axis, which the browser sets from the text size), keeps kerning
and ligatures, and drops hinting, which large canvas text does not use. The
UI fonts keep their hinting.

Six fonts reserve their name under the OFL (Creepster, Lilita One, Monoton,
Press Start 2P, Righteous, Russo One). A subset would be a Modified Version,
which may not carry the reserved name, so these are copied byte for byte as
TTF instead. The build detects reserved names from the licence header and
refuses to subset them.

`check_manifest.py` opens every file listed in `fonts.json` and checks that
it covers A-Z, 0-9 and its sample text, that the weight axis matches the
`variable` range, and that the total stays under the 4 MB budget. With
`pip install --user opentype-sanitizer` it also runs every file through the
OpenType Sanitizer, the same check browsers apply to web fonts.

## Adding a font

### To Longitude itself

1. Put the files in `web/fonts/<family>/` (WOFF2 preferred, TTF and OTF
   work) and the licence text in `web/fonts/LICENSES/<family>.txt`. Only
   OFL or Apache fonts, please.
2. Add an entry to `web/fonts/fonts.json`, in the group you want:

```json
{
  "family": "Anton", "label": "Anton", "category": "classic",
  "faces": [{ "file": "anton/Anton-Regular.woff2", "weight": 400, "style": "normal" }],
  "variable": null, "fallback": "Impact, sans-serif",
  "license": "OFL-1.1", "credit": "Vernon Adams",
  "tags": ["impact", "condensed"], "sample": "WAIT WHAT"
}
```

| Field | Meaning |
| --- | --- |
| `family` | The CSS family name. Unique. Saved designs refer to fonts by this name. |
| `label` | What the picker shows. |
| `category` | `original`, `classic`, `meme`, `display`, `clean`, `system` or `custom`. |
| `faces` | One entry per file: `file` (relative to `web/fonts/`), `weight`, `style` (`normal` or `italic`). A variable font has one face per style. Faces without a `file` describe a system font. |
| `variable` | `{ "min": 100, "max": 900 }` for a variable weight axis, else `null`. |
| `fallback` | Fonts to use for missing characters, as a CSS list without quotes. |
| `license`, `credit` | SPDX licence id and the designer credit. |
| `tags` | Search words ("pixel", "horror", "condensed"). |
| `sample` | A short caps line in thumbnail voice, drawn in the picker. |
| `source` | Optional. `"system"` for a font that must already be installed. |
| `defaultWeight` | Optional. The weight to switch to when this font is picked (Rubik opens at 900). |

3. Run `python -P tools/fonts/check_manifest.py` and the font tests
   (`deno test --allow-read tests/fonts.test.js`).

### From a mod

A code mod can register fonts that live in its own folder:

```js
export function activate(api) {
  api.fonts.register({
    family: "My Display", label: "My display", category: "display",
    faces: [{ url: "fonts/MyDisplay-Bold.woff2", weight: 700, style: "normal" }],
    base: import.meta.url,             // resolve urls next to this module
    license: "OFL-1.1", credit: "Someone", tags: ["wide"], sample: "HELLO",
  });                                  // returns a dispose function; the loader calls it on deactivate
}
```

Faces without a `url` register a system font, which is listed only when it is
installed.

### As a user

Drop a `.ttf`, `.otf`, `.woff` or `.woff2` file on the canvas, or use "Add a
font file" in the font picker. Longitude reads the family name from the file
(WOFF2 files use the file name), keeps the file in this browser's storage and
lists it under Yours. Saving a `.longitude` file includes the custom fonts the
design uses, so it opens the same elsewhere.

## How the app loads fonts

`web/js/core/fonts.js` (`FontRegistry`) reads `fonts.json`, detects system
fonts by measuring text against a fallback, and restores custom fonts from
IndexedDB. A face loads through `FontFace` the first time something asks for
it, and only once. A style with a single static face is registered for every
weight, so the browser never fakes a bold; variable fonts register their axis
range. When a face finishes loading the registry fires `load` and text is
measured again. Exports wait for every face a design uses (three seconds at
most per face).

A face that fails to load (offline, or a mod font whose file is missing) logs
one warning. Rendering asks for it again as text redraws, so the registry
backs off: one quick retry, then 1, 2, 4 … seconds apart, never more than 30
seconds. `load(family, weight, style, { retry: true })` and
`ensureDoc(doc, { retry: true })` skip the wait, for when the user picks the
font or opens a design, and going back online clears it for every failed face.

## Credits

Thanks to every designer listed above, and to the Google Fonts team for
keeping these families open and easy to find. The original fonts were made
for Longitude by its contributors.
