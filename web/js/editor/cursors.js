// Cursors drawn for the exact handle angle, so a resize cursor on a rotated
// layer points along the edge it moves. Cached by angle. Each has a keyword
// fallback for browsers that refuse image cursors.

const cache = new Map();

const url = (svgText) => `url("data:image/svg+xml,${encodeURIComponent(svgText)}")`;

// Double arrow along `deg` (0 = left/right, 90 = up/down, y down).
export function resizeCursor(deg) {
  const a = ((Math.round(deg) % 180) + 180) % 180;
  const key = `r${a}`;
  let c = cache.get(key);
  if (c) return c;
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<g transform="rotate(${a} 12 12)">` +
    `<path d="M3 12 7.6 7.4V10.3H16.4V7.4L21 12 16.4 16.6V13.7H7.6V16.6Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>` +
    `</g></svg>`;
  const fallback = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][Math.round(a / 45) % 4];
  c = `${url(body)} 12 12, ${fallback}`;
  cache.set(key, c);
  return c;
}

// Curved double arrow that wraps a corner pointing at `deg` (direction from
// the layer centre to the corner, y down).
export function rotateCursor(deg) {
  const a = (((Math.round(deg / 5) * 5 + 135) % 360) + 360) % 360;
  const key = `o${a}`;
  let c = cache.get(key);
  if (c) return c;
  const arc = "M6.5 16.5A10 10 0 0 1 16.5 6.5";
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24">` +
    `<g transform="rotate(${a} 12 12)">` +
    `<path d="${arc}" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>` +
    `<path d="${arc}" fill="none" stroke="#111" stroke-width="1.8" stroke-linecap="round"/>` +
    `<path d="M3.4 14.6 6.5 20 9.6 14.6Z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<path d="M14.6 3.4 20 6.5 14.6 9.6Z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>` +
    `</g></svg>`;
  c = `${url(body)} 13 13, grab`;
  cache.set(key, c);
  return c;
}
