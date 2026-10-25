# Longitude logo

A matte black sphere with five lime lines of longitude that meet at the
poles. Latitude and longitude together make a coordinate, a point you can aim
at. The sibling app [Latitude](https://github.com/zphat/Latitude) takes the
horizontal line, the equator; Longitude takes the vertical ones.

## Which file to use

| File | Use it for |
| --- | --- |
| `longitude-logo.svg` | The logo at 64 px and larger: web pages, docs, slides, print. It has the full shading, the grooves beside each stripe and the thin outline. |
| `longitude-logo-small.svg` | 16 to 48 px: favicons and tab, taskbar or shortcut icons. Flatter shading, no outline, and stripe edges that land on the pixel grid at 32 px. `web/icons/favicon.svg` is a copy. |
| `longitude-logo-ui.svg` | Inside the app (top bar, home screen, About, start-up and error screens), 20 to 48 px. The same drawing as the small file on a 24-unit grid, with a faint light rim so it stays apart from dark panels. `web/js/ui/shell.js` (`logoMark`) and `web/index.html` draw it inline. Below 32 px, use it at 21 or 27 px: there each stripe fills one whole pixel column, while at 22 or 26 px the center stripe blurs across two. |
| `longitude-logo-1024.png`, `-512.png`, `-256.png` | Transparent PNGs for places that do not take SVG: store listings, chat and forum avatars, documents. |
| `longitude-logo-on-dark-1024.png` | An opaque square: the sphere at about 78% of the width on `#07080a`, the workspace color of the Signal theme. For profile pictures and social cards that need a solid background. It still works when a site crops it to a circle. |
| `source/longitude-logo-source.webp` | The original artwork. Leave it as it is. |

Make new PNG sizes from `longitude-logo.svg` or `longitude-logo-1024.png`,
never from a screenshot or from a smaller PNG. The app icons in `web/icons/`
and `src-tauri/icons/` are made from this logo, so redo them whenever it
changes.

## Colors

Measured from `longitude-logo-1024.png`.

| Name | Hex | Where |
| --- | --- | --- |
| Lime | `#d4f93a` | The stripes (the middle of each stripe, top to bottom) |
| Graphite light | `#6d6c61` | The lit upper left of the sphere |
| Graphite | `#161713` | Most of the sphere |
| Graphite shadow | `#0e0e0b` | The lower right |
| Outline | `#090a07` | The thin edge |

The interface's accent color (`#d1ff4a` in the Signal theme) is close but is
not the logo color, and other themes use other accents. The logo keeps its own
colors in every theme.

## Rules

- **Minimum size:** 16 px, using `longitude-logo-small.svg` or
  `longitude-logo-ui.svg`. Below 64 px, use one of those two rather than the
  full logo or a scaled-down PNG, because the grooves and outline turn to mud.
- **Keep the sphere round.** Scale it evenly. Do not stretch, squash or crop
  it, and do not rotate it: the stripes run straight up and down, with the light
  from the upper left.
- **Do not add effects:** no glow, drop shadow, extra outline, bevel or
  texture. The shading is already part of the drawing.
- **Do not recolor it.** Five lime stripes on a black sphere, on any
  background. It reads on dark and on light backgrounds as it is.
- **Clear space:** keep at least an eighth of the sphere's width free on every
  side.
- **With the name:** "Longitude" in Syne Bold, to the right of the sphere and
  centered on it vertically. In the app's top bar the sphere is 21 px, the name
  is 15.5 px and the gap between them is 8 px.
