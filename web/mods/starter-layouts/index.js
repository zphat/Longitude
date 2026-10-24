// Starter layouts: three thumbnail compositions built from shapes and text.
//
// Shows how a command can build a whole layout as one undo step with
// api.store.transaction(). Panels go to the bottom of the layer list, so a
// photo already on the canvas stays in front; text goes on top. Everything is
// sized from the canvas, so the layouts work on any preset.

export const manifest = {
  id: "starter-layouts",
  name: "Starter layouts",
  version: "1.0.0",
  author: "Longitude",
  homepage: "https://github.com/zphat/Longitude/tree/main/web/mods/starter-layouts",
  description: "Commands that lay out common thumbnails with placeholders: face and big text, versus split, before and after.",
  apiVersion: 1,
};

const NO_STROKE = { on: false };

function rect(name, x, y, w, h, color, extra = {}) {
  return { type: "shape", shape: "rect", name, x, y, w: Math.round(w), h: Math.round(h), fill: { on: true, color }, stroke: NO_STROKE, ...extra };
}

function placeholder(name, x, y, w, h, shape = "ellipse") {
  return {
    type: "shape",
    shape,
    name,
    x,
    y,
    w: Math.round(w),
    h: Math.round(h),
    fill: { on: true, color: "#ffffff1a" },
    stroke: { on: true, color: "#ffffff73", width: 5, dash: true },
  };
}

function text(name, value, x, y, size, extra = {}) {
  return {
    type: "text",
    name,
    text: value,
    x,
    y,
    font: "Anton",
    size: Math.round(size),
    color: "#ffffff",
    uppercase: true,
    lineHeight: 0.95,
    stroke: { on: true, color: "#000000", width: Math.max(2, Math.round(size * 0.06)) },
    ...extra,
  };
}

function hint(value, x, y, size) {
  return text("Placeholder hint", value, x, y, size, {
    font: "Inter",
    weight: 600,
    uppercase: false,
    color: "#ffffffa6",
    stroke: NO_STROKE,
  });
}

// ---- the layouts -----------------------------------------------------------------
// Each returns { below, above, focus }: layers for the bottom of the stack,
// layers for the top, and the index in `above` to select afterwards.

function faceAndText(W, H) {
  const s = Math.min(W, H);
  return {
    below: [
      rect("Background", W / 2, H / 2, W, H, "#111317"),
      placeholder("Face placeholder", W * 0.27, H * 0.56, s * 0.8, s * 0.9),
    ],
    above: [
      hint("Drop your photo here", W * 0.27, H * 0.56, s * 0.045),
      text("Big text", "Big\ntext", W * 0.72, H * 0.46, s * 0.3, { color: "#ffe14d" }),
      rect("Accent bar", W * 0.72, H * 0.83, W * 0.3, s * 0.035, "#ff2d2d", { radius: Math.round(s * 0.0175) }),
    ],
    focus: 1,
  };
}

function versus(W, H) {
  const s = Math.min(W, H);
  return {
    below: [
      rect("Left side", W / 4, H / 2, W / 2 + 2, H, "#e8333a"),
      rect("Right side", (W * 3) / 4, H / 2, W / 2 + 2, H, "#2d6bff"),
      rect("Divider", W / 2, H / 2, Math.max(6, W * 0.012), H * 1.3, "#ffffff", { rotation: 8 }),
      placeholder("Photo placeholder left", W / 4, H * 0.42, s * 0.52, s * 0.52),
      placeholder("Photo placeholder right", (W * 3) / 4, H * 0.42, s * 0.52, s * 0.52),
    ],
    above: [
      hint("Photo", W / 4, H * 0.42, s * 0.045),
      hint("Photo", (W * 3) / 4, H * 0.42, s * 0.045),
      text("Left label", "This", W / 4, H * 0.83, s * 0.14),
      text("Right label", "That", (W * 3) / 4, H * 0.83, s * 0.14),
      {
        type: "shape",
        shape: "burst",
        name: "VS burst",
        x: W / 2,
        y: H / 2,
        w: Math.round(s * 0.34),
        h: Math.round(s * 0.34),
        fill: { on: true, color: "#ffe14d" },
        stroke: { on: true, color: "#000000", width: Math.max(3, Math.round(s * 0.011)) },
        params: { points: 16, inner: 0.78 },
      },
      text("VS", "VS", W / 2, H / 2, s * 0.13, { color: "#111111", stroke: NO_STROKE }),
    ],
    focus: 2,
  };
}

function beforeAfter(W, H) {
  const s = Math.min(W, H);
  const pw = W * 0.465;
  const ph = H * 0.84;
  const r = Math.round(s * 0.03);
  const pill = (name, value, x, bg, color) =>
    text(name, value, x, H * 0.16, s * 0.07, {
      color,
      stroke: NO_STROKE,
      lineHeight: 1,
      bg: { on: true, color: bg, opacity: 1, padX: Math.round(s * 0.03), padY: Math.round(s * 0.012), radius: Math.round(s * 0.02) },
    });
  return {
    below: [
      rect("Background", W / 2, H / 2, W, H, "#0f1114"),
      rect("Before photo placeholder", W * 0.255, H / 2, pw, ph, "#262a31", { radius: r, stroke: { on: true, color: "#ffffff40", width: 4, dash: true } }),
      rect("After photo placeholder", W * 0.745, H / 2, pw, ph, "#262a31", { radius: r, stroke: { on: true, color: "#ffffff40", width: 4, dash: true } }),
    ],
    above: [
      hint("Before photo", W * 0.255, H * 0.55, s * 0.045),
      hint("After photo", W * 0.745, H * 0.55, s * 0.045),
      pill("Before label", "Before", W * 0.255, "#000000", "#ffffff"),
      pill("After label", "After", W * 0.745, "#d1ff4a", "#111111"),
      {
        type: "shape",
        shape: "triangle",
        name: "Arrow",
        x: W / 2,
        y: H / 2,
        w: Math.round(s * 0.11),
        h: Math.round(s * 0.11),
        rotation: 90,
        radius: Math.round(s * 0.012),
        fill: { on: true, color: "#ffffff" },
        stroke: { on: true, color: "#000000", width: Math.max(3, Math.round(s * 0.008)) },
      },
    ],
    focus: 2,
  };
}

const LAYOUTS = [
  { id: "face-text", title: "Layout: face left, big text right", label: "Face and big text layout", build: faceAndText, keywords: "reaction face portrait headline" },
  { id: "versus", title: "Layout: versus split", label: "Versus layout", build: versus, keywords: "vs compare battle split two" },
  { id: "before-after", title: "Layout: before and after", label: "Before and after layout", build: beforeAfter, keywords: "compare transformation result side by side" },
];

async function apply(api, layout) {
  const { width: W, height: H } = api.store.doc;
  await Promise.all([api.fonts.load("Anton", 400), api.fonts.load("Inter", 600)]);
  const { below, above, focus } = layout.build(W, H);
  const ids = api.store.transaction(layout.label, (store) => {
    const bottom = store.add(below, { index: 0, select: false });
    const top = store.add(above, { select: false });
    store.select([top[focus]]);
    return [...bottom, ...top];
  });
  api.editor.flash(ids);
}

export function activate(api) {
  for (const layout of LAYOUTS) {
    api.commands.register({
      id: `starter-layouts.${layout.id}`,
      title: layout.title,
      group: "Insert",
      keywords: `layout template starter placeholder ${layout.keywords}`,
      run: (api) => apply(api, layout),
    });
  }
}
