# Third-party notices

Longitude is MIT licensed (see `LICENSE`). It includes, or downloads on
demand, the third-party works listed here under their own licenses.

## Fonts

The font files live in `web/fonts/`. Each family's full license text is in
`web/fonts/LICENSES/<family>.txt`. All were taken from the
[google/fonts](https://github.com/google/fonts) repository.

"Subset" means Longitude kept the Latin and Latin Extended-A characters (plus
a few symbols), removed hinting and converted the file to WOFF2, using
`tools/fonts/build_bundled.py`. Glyph outlines, metrics, kerning and variable
axes are unchanged. "Unmodified" files are the upstream TTF byte for byte;
these fonts have a Reserved Font Name, which a modified copy could not use.

### SIL Open Font License 1.1

| Family | Copyright | Upstream | Shipped as |
| --- | --- | --- | --- |
| Anton | Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git) | `ofl/anton` | subset |
| Archivo Black | Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack) | `ofl/archivoblack` | subset |
| Bangers | Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers) | `ofl/bangers` | subset |
| Bebas Neue | Copyright 2010 by Dharma Type | `ofl/bebasneue` | subset |
| Black Ops One | Copyright 2022 The Black-Ops Project Authors | `ofl/blackopsone` | subset |
| Bungee | Copyright 2023 The Bungee Project Authors (https://github.com/djrrb/Bungee) | `ofl/bungee` | subset |
| Comic Neue | Copyright 2014 The Comic Neue Project Authors (https://github.com/crozynski/comicneue) | `ofl/comicneue` | subset |
| Creepster | Copyright (c) 2011, Font Diner, Inc, with Reserved Font Names "Creepster" | `ofl/creepster` | unmodified |
| Inter | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) | `ofl/inter` | subset |
| Lilita One | Copyright (c) 2011 Juan Montoreano, with Reserved Font Name Lilita | `ofl/lilitaone` | unmodified |
| Manrope | Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope) | `ofl/manrope` | subset (also the UI font) |
| Monoton | Copyright (c) 2011 by Vernon Adams, with Reserved Font Names "Monoton" | `ofl/monoton` | unmodified |
| Montserrat | Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git) | `ofl/montserrat` | subset |
| Oswald | Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont) | `ofl/oswald` | subset |
| Poppins | Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) | `ofl/poppins` | subset |
| Press Start 2P | Copyright 2012 The Press Start 2P Project Authors, with Reserved Font Name "Press Start 2P" | `ofl/pressstart2p` | unmodified |
| Righteous | Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI), with Reserved Font Names "Righteous" | `ofl/righteous` | unmodified |
| Rubik | Copyright 2015 The Rubik Project Authors (https://github.com/googlefonts/rubik) | `ofl/rubik` | subset |
| Rubik Glitch | Copyright 2020 The Rubik Filtered Project Authors (https://github.com/NaN-xyz/Rubik-Filtered) | `ofl/rubikglitch` | subset |
| Russo One | Copyright (c) 2011-2012, Jovanny Lemonad, with Reserved Font Name "Russo" | `ofl/russoone` | unmodified |
| Space Mono | Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono) | `ofl/spacemono` | subset (UI font) |
| Syne | Copyright 2017 The Syne Project Authors (https://gitlab.com/bonjour-monde/fonderie/syne-typeface) | `ofl/syne` | subset (also the UI font) |
| Unbounded | Copyright 2022 The Unbounded Project Authors (https://github.com/googlefonts/unbounded) | `ofl/unbounded` | subset |

### Apache License 2.0

| Family | Copyright | Upstream | Shipped as |
| --- | --- | --- | --- |
| Luckiest Guy | Copyright (c) 2010 by Brian J. Bonislawsky DBA Astigmatic (AOETI) | `apache/luckiestguy` | subset |
| Permanent Marker | Copyright (c) 2010 by Font Diner, Inc | `apache/permanentmarker` | subset |

As the Apache License asks, a note on changes: Longitude subset these two
fonts to Latin characters, removed hinting and converted them to WOFF2. The
glyphs themselves are unchanged.

### Longitude's own fonts

Longitude Meridian, Longitude Meridian Slant, Longitude Gridline and
Longitude Gridline Dot are Copyright 2026 Longitude contributors, licensed
under the SIL Open Font License 1.1 with no Reserved Font Name. Their sources
and build script are in `tools/fonts/`.

### System fonts

Impact and Arial Black are not included. Longitude uses them only when they
are already installed on your computer.

## Icons

Longitude's UI icons (`web/js/ui/icons.js`) include path data from
[Lucide](https://lucide.dev), ISC License. Copyright (c) for portions of
Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other
copyright (c) for Lucide are held by Lucide Contributors 2022.

## Background removal (downloaded on first use)

These are not in the repository. Longitude downloads them only when you first
remove a background, checks each file's size and SHA-256, and keeps them in
the browser's Cache Storage. `tools/fetch_model.py` can put copies in
`web/vendor/` for offline use. Details and sources are in `docs/BGREMOVE.md`.

| Work | Used for | License | Source |
| --- | --- | --- | --- |
| onnxruntime-web 1.27.0 | Runs the models | MIT, Copyright (c) Microsoft Corporation | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime), served by jsDelivr |
| IS-Net general use (DIS), int8 weights | "Fast" | Apache-2.0 (weights, [DIS](https://github.com/xuebinqin/DIS)); MIT (ONNX conversion) | [xrds/isnet-general-onnx-int8](https://huggingface.co/xrds/isnet-general-onnx-int8) |
| BiRefNet lite | "Best" | MIT ([BiRefNet](https://github.com/ZhengPeng7/BiRefNet)) | [runes/birefnet-lite-webgpu](https://huggingface.co/runes/birefnet-lite-webgpu), [CoderViking/birefnet-lite-onnx](https://huggingface.co/CoderViking/birefnet-lite-onnx) |

## Other

Nothing else. Longitude has no other runtime dependencies.
