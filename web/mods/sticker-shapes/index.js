// Sticker shapes: a ribbon badge, a heart, a lightning bolt and a chunky
// callout arrow, the stickers thumbnails use most.
//
// Shows the shapes registry: each shape draws itself as a Path2D in a box
// centred on 0,0 and also describes its outline as points, which hit testing
// and the shape picker use. One command per shape inserts it on the canvas.

export const manifest = {
  id: "sticker-shapes",
  name: "Sticker shapes",
  version: "1.0.0",
  author: "Longitude",
  description: "Adds badge, heart, lightning and callout arrow shapes, with a command to insert each one.",
  apiVersion: 1,
};

const ICONS = {
  "sticker-badge": '<path d="M3 7h18l-3 5 3 5H3l3-5z"/>',
  "sticker-heart": '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  "sticker-lightning": '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  "sticker-callout": '<path d="M3 9h10V5l8 7-8 7v-4H3z"/>',
};

// ---- geometry (local coordinates, box centred on 0,0) ----------------------

function badgePoints(w, h, params) {
  const n = Math.min(h * (params.notch ?? 0.35), w * 0.3);
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2 - n, y: 0 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
    { x: -w / 2 + n, y: 0 },
  ];
}

function arrowPoints(w, h, params) {
  const head = Math.min(w * (params.head ?? 0.38), w);
  const shaft = (h * (params.shaft ?? 0.5)) / 2;
  const neck = w / 2 - head;
  return [
    { x: -w / 2, y: -shaft },
    { x: neck, y: -shaft },
    { x: neck, y: -h / 2 },
    { x: w / 2, y: 0 },
    { x: neck, y: h / 2 },
    { x: neck, y: shaft },
    { x: -w / 2, y: shaft },
  ];
}

// Lucide's bolt, normalised to a 1 x 1 box.
const BOLT = [[13, 2], [3, 14], [12, 14], [11, 22], [21, 10], [12, 10]].map(([x, y]) => ({ x: (x - 12) / 18, y: (y - 12) / 20 }));
const boltPoints = (w, h) => BOLT.map((p) => ({ x: p.x * w, y: p.y * h }));

// The heart as cubic curves in a 96 x 84 design box, centred.
const HEART = [
  [50, 88],
  [18, 66, 2, 48, 2, 30],
  [2, 14, 14, 4, 28, 4],
  [38, 4, 46, 10, 50, 18],
  [54, 10, 62, 4, 72, 4],
  [86, 4, 98, 14, 98, 30],
  [98, 48, 82, 66, 50, 88],
];
const hx = (x, w) => ((x - 50) / 96) * w;
const hy = (y, h) => ((y - 46) / 84) * h;

function heartPath(w, h) {
  const p = new Path2D();
  p.moveTo(hx(HEART[0][0], w), hy(HEART[0][1], h));
  for (const [a, b, c, d, e, f] of HEART.slice(1)) p.bezierCurveTo(hx(a, w), hy(b, h), hx(c, w), hy(d, h), hx(e, w), hy(f, h));
  p.closePath();
  return p;
}

function heartOutline(w, h, steps = 12) {
  const out = [];
  let [x0, y0] = HEART[0];
  for (const [a, b, c, d, e, f] of HEART.slice(1)) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * u * x0 + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * e;
      const y = u * u * u * y0 + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * f;
      out.push({ x: hx(x, w), y: hy(y, h) });
    }
    [x0, y0] = [e, f];
  }
  return out;
}

// ---- definitions -------------------------------------------------------------

// aspect: width / height when inserted; size: share of the canvas' short side.
const SHAPES = [
  {
    id: "badge",
    label: "Badge",
    icon: "sticker-badge",
    aspect: 3.4,
    size: 0.4,
    defaults: { fill: { on: true, color: "#ff2d2d" }, stroke: { on: false, color: "#ffffff", width: 8, dash: false }, params: { notch: 0.35 } },
    params: [{ key: "notch", label: "Notch", min: 0, max: 0.8, step: 0.01, default: 0.35 }],
    make: (api) => ({
      path: (w, h, params, layer) => api.shapes.polygonPath(badgePoints(w, h, params), radiusFor(layer, h / 4)),
      outline: (w, h, params, layer) => api.shapes.polygonOutline(badgePoints(w, h, params), radiusFor(layer, h / 4)),
    }),
  },
  {
    id: "heart",
    label: "Heart",
    icon: "sticker-heart",
    aspect: 1.12,
    size: 0.42,
    defaults: { fill: { on: true, color: "#ff2d55" }, stroke: { on: false, color: "#ffffff", width: 8, dash: false } },
    make: () => ({ path: heartPath, outline: (w, h) => heartOutline(w, h) }),
  },
  {
    id: "lightning",
    label: "Lightning bolt",
    icon: "sticker-lightning",
    aspect: 0.86,
    size: 0.46,
    defaults: { fill: { on: true, color: "#ffe14d" }, stroke: { on: true, color: "#000000", width: 8, dash: false } },
    make: (api) => ({
      path: (w, h, params, layer) => api.shapes.polygonPath(boltPoints(w, h), radiusFor(layer, Math.min(w, h) / 10)),
      outline: (w, h, params, layer) => api.shapes.polygonOutline(boltPoints(w, h), radiusFor(layer, Math.min(w, h) / 10)),
    }),
  },
  {
    id: "callout-arrow",
    label: "Callout arrow",
    icon: "sticker-callout",
    aspect: 2,
    size: 0.3,
    defaults: { fill: { on: true, color: "#ff2d2d" }, stroke: { on: true, color: "#ffffff", width: 8, dash: false }, params: { head: 0.38, shaft: 0.5 } },
    params: [
      { key: "head", label: "Head length", min: 0.1, max: 0.9, step: 0.01, default: 0.38 },
      { key: "shaft", label: "Shaft thickness", min: 0.1, max: 1, step: 0.01, default: 0.5 },
    ],
    make: (api) => ({
      path: (w, h, params, layer) => api.shapes.polygonPath(arrowPoints(w, h, params), radiusFor(layer, (h * (params.shaft ?? 0.5)) / 2)),
      outline: (w, h, params, layer) => api.shapes.polygonOutline(arrowPoints(w, h, params), radiusFor(layer, (h * (params.shaft ?? 0.5)) / 2)),
    }),
  },
];

// The layer's corner radius, capped so corners never swallow the shape.
const radiusFor = (layer, max) => Math.max(0, Math.min(Number(layer?.radius) || 0, max));

function insert(api, def) {
  const { width: W, height: H } = api.store.doc;
  const side = Math.min(W, H) * def.size;
  const w = def.aspect >= 1 ? side * Math.min(def.aspect, 1.8) : side * def.aspect;
  const h = w / def.aspect;
  const ids = api.store.add(
    {
      type: "shape",
      shape: def.id,
      name: def.label,
      x: W / 2,
      y: H / 2,
      w: Math.round(w),
      h: Math.round(h),
      fill: def.defaults.fill,
      stroke: def.defaults.stroke,
      params: def.defaults.params || {},
    },
    { label: `Add ${def.label.toLowerCase()}` }
  );
  api.editor.flash(ids);
}

export function activate(api) {
  api.registerIcons(ICONS);
  for (const def of SHAPES) {
    api.shapes.register({
      id: def.id,
      label: def.label,
      icon: def.icon,
      defaults: def.defaults,
      params: def.params,
      ...def.make(api),
    });
    api.commands.register({
      id: `sticker-shapes.${def.id}`,
      title: `Insert ${def.label.toLowerCase()}`,
      group: "Insert",
      icon: def.icon,
      keywords: `shape sticker ${def.id.replace("-", " ")}`,
      run: (api) => insert(api, def),
    });
  }
}
