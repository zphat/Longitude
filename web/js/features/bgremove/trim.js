// Fit an image layer's box to its cutout. After background removal the layer
// still has the whole photo's box, so the selection, snapping and the Center
// pill would follow the empty frame instead of the person. These helpers
// shrink the crop to the mask's opaque area (plus a margin) and move and
// resize the box so the visible pixels stay exactly where they are.
//
// Pure: plain numbers in, plain props out, so they run in Deno tests. Crops
// are fractions of the natural image ({ x, y, w, h }, as in layer.crop).

import { fromLocal } from "../../core/geometry.js";

const FULL = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

// Alpha above this counts as part of the cutout.
export const OPAQUE = 8;

// Margin around the cutout, as a share of the image's longer side. It leaves
// room for "Shrink or grow" and "Soften edge", whose results would otherwise
// be cut off at the box edge. On a photo that fills a 1280 px canvas it is
// about 32 px, a little more than the largest grow.
export const MARGIN = 0.025;

// Edges that would move less than this many doc px are left alone.
const MIN_CHANGE = 1.5;

// Tight bounds of the pixels whose alpha is above `threshold`, in pixels
// (r and b exclusive), or null when there are none. data is one byte per pixel
// (stride 1) or RGBA (stride 4, alpha at offset 3).
export function opaqueBounds(data, width, height, { threshold = OPAQUE, stride = 1 } = {}) {
  if (!width || !height || !data || data.length < width * height * stride) return null;
  const off = stride === 4 ? 3 : 0;
  const rowHas = (y) => {
    for (let i = y * width * stride + off, end = i + width * stride; i < end; i += stride) if (data[i] > threshold) return true;
    return false;
  };
  let t = 0;
  while (t < height && !rowHas(t)) t++;
  if (t === height) return null;
  let b = height;
  while (b > t + 1 && !rowHas(b - 1)) b--;
  let l = width;
  let r = 0;
  for (let y = t; y < b; y++) {
    const row = y * width * stride + off;
    for (let x = 0; x < l; x++) {
      if (data[row + x * stride] > threshold) {
        l = x;
        break;
      }
    }
    for (let x = width - 1; x >= r; x--) {
      if (data[row + x * stride] > threshold) {
        r = x + 1;
        break;
      }
    }
  }
  return { l, t, r, b };
}

export function sameCrop(a, b, eps = 1e-6) {
  const A = a || FULL;
  const B = b || FULL;
  return Math.abs(A.x - B.x) <= eps && Math.abs(A.y - B.y) <= eps && Math.abs(A.w - B.w) <= eps && Math.abs(A.h - B.h) <= eps;
}

export function unionCrop(a, b) {
  const A = a || FULL;
  const B = b || FULL;
  const x = Math.min(A.x, B.x);
  const y = Math.min(A.y, B.y);
  return { x, y, w: Math.max(A.x + A.w, B.x + B.w) - x, h: Math.max(A.y + A.h, B.y + B.h) - y };
}

// The crop that holds the opaque pixels of a mask (bounds in mask px, from
// opaqueBounds) plus the margin, inside `container`. Null when no opaque
// pixel falls inside the container.
export function cutoutCrop(bounds, maskW, maskH, container = FULL, margin = MARGIN) {
  if (!bounds || !maskW || !maskH) return null;
  const K = container || FULL;
  const kr = K.x + K.w;
  const kb = K.y + K.h;
  let l = Math.max(K.x, bounds.l / maskW);
  let t = Math.max(K.y, bounds.t / maskH);
  let r = Math.min(kr, bounds.r / maskW);
  let b = Math.min(kb, bounds.b / maskH);
  if (!(r > l) || !(b > t)) return null;
  const pad = Math.max(1, Math.ceil(margin * Math.max(maskW, maskH)));
  l = Math.max(K.x, l - pad / maskW);
  t = Math.max(K.y, t - pad / maskH);
  r = Math.min(kr, r + pad / maskW);
  b = Math.min(kb, b + pad / maskH);
  return { x: l, y: t, w: r - l, h: b - t };
}

// Props that show `crop` instead of layer.crop without moving any visible
// pixel: same scale, rotation and flips; the box grows or shrinks around the
// new region. Works for shrinking (trim) and growing (restore) alike.
export function recrop(layer, crop) {
  const c = layer.crop || FULL;
  const sx = layer.w / c.w; // doc px per unit of image width
  const sy = layer.h / c.h;
  const local = {
    x: (crop.x + crop.w / 2 - (c.x + c.w / 2)) * sx,
    y: (crop.y + crop.h / 2 - (c.y + c.h / 2)) * sy,
  };
  const center = fromLocal(layer, local);
  return {
    crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    x: center.x,
    y: center.y,
    w: crop.w * sx,
    h: crop.h * sy,
  };
}

// Whether the box can follow the cutout without changing how the layer looks.
// An ellipse frame, rounded corners or mod filters depend on the box itself.
export function canTrim(layer) {
  return !!layer && layer.type === "image" && layer.frame !== "ellipse" && !(layer.radius > 0) && !(layer.filters?.length) && layer.w > 0 && layer.h > 0;
}

// recrop() props, or null when no edge would move by a visible amount.
export function fitProps(layer, crop) {
  if (!crop) return null;
  const c = layer.crop || FULL;
  const sx = layer.w / c.w;
  const sy = layer.h / c.h;
  const moved = Math.max(
    Math.abs(crop.x - c.x) * sx,
    Math.abs(crop.x + crop.w - (c.x + c.w)) * sx,
    Math.abs(crop.y - c.y) * sy,
    Math.abs(crop.y + crop.h - (c.y + c.h)) * sy,
  );
  return moved < MIN_CHANGE ? null : recrop(layer, crop);
}
