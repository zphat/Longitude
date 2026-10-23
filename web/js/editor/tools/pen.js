// Pen (P). Smooth freehand strokes with pressure (a stylus reports it; mouse
// and touch get a light speed-based thinning). Hold still for a moment at the
// end of a stroke and a rough circle, line, arrow or box morphs into a clean
// shape; keep moving to carry on drawing. The pen stays active after a
// stroke so you can draw several in a row.

import { svg } from "../../ui/dom.js";
import { createLayer } from "../../core/model.js";
import { refitPoints, arrowGeometry, fromLocal } from "../../core/geometry.js";
import { freehandSpine } from "../../core/render.js";
import { recognize, resample, totalTurn } from "../recognize.js";
import { arrowLayer } from "./arrow.js";

const RAD = Math.PI / 180;
const HOLD_MS = 450;
const STILL_PX = 4;
const UNSNAP_PX = 14;
const MORPH_MS = 220;
const SAMPLES = 96;
const MAX_POINTS = 20000;
const HINT = "Hold still to perfect the shape";
const NAMES = { ellipse: "Circle", rect: "Rectangle", line: "Line", arrow: "Arrow" };
const LABELS = { ellipse: "Add circle", rect: "Add rectangle", line: "Add line", arrow: "Add arrow" };

let hinted = false;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const f = (v) => Math.round(v * 100) / 100;
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// The clean layer for a recognized stroke, in the pen's color and width.
export function cleanLayer(result, style) {
  const q = result?.params;
  if (!q) return null;
  const { color, width } = style;
  switch (result.kind) {
    case "ellipse":
    case "rect": {
      const ellipse = result.kind === "ellipse";
      // Shape strokes sit inside the box, so grow it by the stroke width to
      // keep the line on the recognized outline.
      return createLayer("shape", {
        shape: ellipse ? "ellipse" : "rect",
        name: NAMES[result.kind],
        x: q.cx,
        y: q.cy,
        w: (ellipse ? q.rx * 2 : q.w) + width,
        h: (ellipse ? q.ry * 2 : q.h) + width,
        rotation: q.rotation || 0,
        fill: { on: false },
        stroke: { on: true, color, width, dash: false },
      });
    }
    case "line":
    case "arrow":
      return arrowLayer(style, q.a, q.b, result.kind === "arrow" ? q.c : null, {
        name: NAMES[result.kind],
        head: result.kind === "arrow" ? "triangle" : "none",
      });
    default:
      return null;
  }
}

function ellipseTarget(q, src, n, dir) {
  const c = Math.cos(q.rotation * RAD);
  const s = Math.sin(q.rotation * RAD);
  const dx = src[0].x - q.cx;
  const dy = src[0].y - q.cy;
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const t0 = Math.atan2(ly / (q.ry || 1), lx / (q.rx || 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + (dir * Math.PI * 2 * i) / (n - 1);
    const x = Math.cos(t) * q.rx;
    const y = Math.sin(t) * q.ry;
    out.push({ x: q.cx + x * c - y * s, y: q.cy + x * s + y * c });
  }
  return out;
}

function rectTarget(q, src, n, dir) {
  const c = Math.cos(q.rotation * RAD);
  const s = Math.sin(q.rotation * RAD);
  const hw = q.w / 2;
  const hh = q.h / 2;
  const P = 2 * (q.w + q.h);
  const toDoc = (x, y) => ({ x: q.cx + x * c - y * s, y: q.cy + x * s + y * c });
  // Perimeter position u: 0 at the top-left corner, clockwise.
  const at = (u) => {
    u = ((u % P) + P) % P;
    if (u < q.w) return toDoc(-hw + u, -hh);
    u -= q.w;
    if (u < q.h) return toDoc(hw, -hh + u);
    u -= q.h;
    if (u < q.w) return toDoc(hw - u, hh);
    u -= q.w;
    return toDoc(-hw, hh - u);
  };
  const dx = src[0].x - q.cx;
  const dy = src[0].y - q.cy;
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const cx = Math.max(-hw, Math.min(hw, lx));
  const cy = Math.max(-hh, Math.min(hh, ly));
  const edges = [
    [cx + hw, Math.abs(ly + hh)],
    [q.w + cy + hh, Math.abs(lx - hw)],
    [q.w + q.h + hw - cx, Math.abs(ly - hh)],
    [2 * q.w + q.h + hh - cy, Math.abs(lx + hw)],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  const u0 = edges[0][0];
  const out = [];
  for (let i = 0; i < n; i++) out.push(at(u0 + (dir * P * i) / (n - 1)));
  return out;
}

function shaftTarget(q, src, n, kind) {
  const a = q.a;
  const b = q.b;
  const c = q.c;
  // Stroke points after the tip (the hook) fold onto the tip.
  let k = n - 1;
  if (kind === "arrow") {
    let best = Infinity;
    for (let i = Math.floor(n * 0.3); i < n; i++) {
      const d = Math.hypot(src[i].x - b.x, src[i].y - b.y);
      if (d < best) {
        best = d;
        k = i;
      }
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, i / Math.max(1, k));
    if (c) {
      const u = 1 - t;
      out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    } else {
      out.push(lerp(a, b, t));
    }
  }
  return out;
}

// Where each resampled stroke point travels to during the morph.
export function morphTargets(result, src, n = src.length) {
  const dir = totalTurn(src) >= 0 ? 1 : -1;
  switch (result.kind) {
    case "ellipse":
      return ellipseTarget(result.params, src, n, dir);
    case "rect":
      return rectTarget(result.params, src, n, dir);
    case "line":
    case "arrow":
      return shaftTarget(result.params, src, n, result.kind);
    default:
      return src.map((p) => ({ ...p }));
  }
}

// SVG path data for a pressure stroke, built the same way the renderer
// builds it: a disc per sample joined by quads, all wound clockwise.
export function strokePathData(points, width) {
  if (!points.length) return "";
  const spine = freehandSpine({ points: points.map((p) => [p.x + 0.5, p.y + 0.5, p.p]), w: 1, h: 1, width: Math.max(0.5, width), smoothing: 0.5 });
  let d = "";
  for (const s of spine) {
    const r = Math.max(0.2, s.r);
    d += `M${f(s.x + r)} ${f(s.y)}A${f(r)} ${f(r)} 0 1 1 ${f(s.x - r)} ${f(s.y)}A${f(r)} ${f(r)} 0 1 1 ${f(s.x + r)} ${f(s.y)}Z`;
  }
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const q = [
      [a.x + nx * a.r, a.y + ny * a.r],
      [b.x + nx * b.r, b.y + ny * b.r],
      [b.x - nx * b.r, b.y - ny * b.r],
      [a.x - nx * a.r, a.y - ny * a.r],
    ];
    let area = 0;
    for (let j = 0; j < 4; j++) area += q[j][0] * q[(j + 1) % 4][1] - q[(j + 1) % 4][0] * q[j][1];
    if (area < 0) q.reverse();
    d += `M${f(q[0][0])} ${f(q[0][1])}L${f(q[1][0])} ${f(q[1][1])}L${f(q[2][0])} ${f(q[2][1])}L${f(q[3][0])} ${f(q[3][1])}Z`;
  }
  return d;
}

export function penTool(kit) {
  let stroke = null;
  let showingHint = false;
  let hintTimer = 0;
  // "Pen width N" is showing in the status pill (until flashTimer runs).
  let flashing = false;
  let flashTimer = 0;

  const def = {
    id: "pen",
    label: "Pen",
    icon: "pen",
    key: "P",
    cursor: "crosshair",
    sticky: true,

    activate(api) {
      api.setCursor("crosshair");
      if (!hinted) {
        hinted = true;
        showingHint = true;
        api.setStatus(HINT);
      }
    },

    deactivate(api) {
      if (stroke) finish(api);
      clearTimeout(hintTimer);
      clearTimeout(flashTimer);
      if (showingHint || flashing) api.setStatus(null);
      showingHint = false;
      flashing = false;
      kit.clearOverlay(api);
    },

    pointerDown(e, api) {
      if (e.button !== 0) return;
      if (stroke) finish(api);
      const zoom = Number(api.zoom) || 1;
      stroke = {
        style: kit.style("pen"),
        pts: [],
        ov: [],
        p: 0.55,
        lastClient: { x: e.clientX, y: e.clientY },
        lastTime: e.timeStamp || now(),
        anchor: { x: e.clientX, y: e.clientY },
        minGap: 0.6 / zoom,
        timer: 0,
        snapped: null,
        anim: null,
        pending: null,
        el: null,
        view: "",
      };
      const m = kit.overlayMap(api);
      const o = m.pt({ x: 0, y: 0 });
      stroke.view = `${f(o.x)},${f(o.y)},${m.k}`;
      addPoint(e, api, m);
      restartHold(api);
      schedule(api);
    },

    pointerMove(e, api) {
      if (!stroke) return;
      if (!(e.buttons & 1)) {
        finish(api);
        return;
      }
      const c = { x: e.clientX, y: e.clientY };
      if (stroke.snapped) {
        if (Math.hypot(c.x - stroke.snapped.at.x, c.y - stroke.snapped.at.y) <= UNSNAP_PX) return;
        unsnap(api);
      }
      const m = kit.overlayMap(api);
      for (const ev of kit.coalesced(e)) addPoint(ev, api, m);
      if (Math.hypot(c.x - stroke.anchor.x, c.y - stroke.anchor.y) > STILL_PX) {
        stroke.anchor = c;
        restartHold(api);
      }
      schedule(api);
    },

    pointerUp(e, api) {
      if (!stroke) return;
      // The OS or a second finger (pinch) took the pointer: drop the stroke
      // rather than leave a stray dot behind.
      if (e?.type === "pointercancel") discard(api);
      else finish(api);
    },

    cancel(api) {
      if (stroke) discard(api);
    },

    keyDown(e, api) {
      if (e.key === "Escape") {
        if (stroke) discard(api);
        else api.editor.setTool("select");
        return true;
      }
      if ((e.key === "[" || e.key === "]") && !e.ctrlKey && !e.metaKey) {
        // Doc px; the top step grows with big canvases like the widths do.
        const cur = kit.style("pen").width;
        const max = Math.round(120 * Math.max(1, kit.docScale()));
        const next = Math.max(1, Math.min(max, Math.round(e.key === "]" ? cur * 1.25 + 1 : cur / 1.25 - 0.5)));
        kit.saveStyle("pen", { width: next });
        if (stroke) stroke.style = { ...stroke.style, width: next };
        flashStatus(api, `Pen width ${next}`);
        return true;
      }
      return false;
    },

    // The view moved (zoom, pan): re-place the preview.
    drawOverlay(api) {
      if (!stroke) return;
      const m = kit.overlayMap(api);
      const o = m.pt({ x: 0, y: 0 });
      const view = `${f(o.x)},${f(o.y)},${m.k}`;
      if (view === stroke.view) return;
      stroke.view = view;
      stroke.ov = stroke.pts.map((p) => ({ ...m.pt(p), p: p.p }));
      if (stroke.snapped) render(api);
      else schedule(api);
    },
  };

  // A short message in the status pill; the hint (if still due) comes back
  // after it. deactivate clears it, so it never outlives the pen.
  function flashStatus(api, text) {
    clearTimeout(flashTimer);
    flashing = true;
    api.setStatus(text);
    flashTimer = setTimeout(() => {
      flashing = false;
      api.setStatus(showingHint ? HINT : null);
    }, 1400);
  }

  function pressureOf(ev) {
    if (ev.pointerType === "pen") {
      if (ev.pressure > 0) stroke.p = Math.min(1, Math.max(0.05, ev.pressure));
      return Math.round(stroke.p * 1000) / 1000;
    }
    const t = ev.timeStamp || now();
    const dt = Math.max(1, t - stroke.lastTime);
    const speed = Math.hypot(ev.clientX - stroke.lastClient.x, ev.clientY - stroke.lastClient.y) / dt;
    stroke.lastTime = t;
    stroke.lastClient = { x: ev.clientX, y: ev.clientY };
    // Slow lines a touch fuller, fast flicks thinner, eased so it never jumps.
    const target = 0.58 - 0.12 * Math.min(2.5, speed);
    stroke.p += (target - stroke.p) * 0.25;
    return Math.round(stroke.p * 1000) / 1000;
  }

  function addPoint(ev, api, m) {
    if (stroke.pts.length >= MAX_POINTS) return;
    const d = api.toDoc(ev);
    if (!Number.isFinite(d?.x) || !Number.isFinite(d?.y)) return;
    const p = pressureOf(ev);
    const last = stroke.pts[stroke.pts.length - 1];
    if (last && Math.hypot(d.x - last.x, d.y - last.y) < stroke.minGap) {
      last.p = Math.max(last.p, p);
      return;
    }
    stroke.pts.push({ x: d.x, y: d.y, p });
    stroke.ov.push({ ...m.pt(d), p });
  }

  function restartHold(api) {
    clearTimeout(stroke.timer);
    stroke.timer = setTimeout(() => onHold(api), HOLD_MS);
  }

  function onHold(api) {
    if (!stroke || stroke.snapped || stroke.pts.length < 3) return;
    const zoom = Number(api.zoom) || 1;
    const result = recognize(stroke.pts, { minLength: 30 / zoom, minConfidence: 0.55 });
    if (!result.kind) return;
    const layer = cleanLayer(result, stroke.style);
    if (!layer) return;
    const src = resample(stroke.pts, SAMPLES);
    stroke.snapped = { result, layer, src, tgt: morphTargets(result, src, src.length), start: now(), t: 0, at: { ...stroke.anchor } };
    stroke.pending?.();
    stroke.pending = null;
    animate(api);
  }

  function animate(api) {
    const step = () => {
      const sn = stroke?.snapped;
      if (!sn) return;
      sn.t = Math.min(1, (now() - sn.start) / MORPH_MS);
      render(api);
      stroke.anim = sn.t < 1 ? kit.frame(step, 16) : null;
    };
    step();
  }

  function unsnap(api) {
    stroke.anim?.();
    stroke.anim = null;
    stroke.snapped = null;
    restartHold(api);
  }

  // Freehand preview at most once per frame.
  function schedule(api) {
    if (!stroke || stroke.pending) return;
    stroke.pending = kit.frame(() => {
      if (!stroke) return;
      stroke.pending = null;
      render(api);
    }, 32);
  }

  function ensureEl(api, tag, cls) {
    if (stroke.el && stroke.el.tag === tag && stroke.el.node.isConnected) return stroke.el.node;
    kit.clearOverlay(api);
    const node = svg(tag, { class: cls });
    api.overlay.append(node);
    stroke.el = { tag, node };
    return node;
  }

  function render(api) {
    if (!stroke || !api.overlay) return;
    if (stroke.snapped) renderSnapped(api);
    else renderFree(api);
  }

  function renderFree(api) {
    const m = kit.overlayMap(api);
    const path = ensureEl(api, "path", "pen-preview");
    path.setAttribute("fill", stroke.style.color);
    path.setAttribute("d", strokePathData(stroke.ov, stroke.style.width * m.k));
  }

  function renderSnapped(api) {
    const sn = stroke.snapped;
    const m = kit.overlayMap(api);
    const g = ensureEl(api, "g", "pen-morph");
    while (g.firstChild) g.firstChild.remove();
    const e = kit.ease(sn.t);
    const pts = sn.src.map((p, i) => m.pt(lerp(p, sn.tgt[i], e)));
    const closed = (sn.result.kind === "ellipse" || sn.result.kind === "rect") && e >= 1;
    const d = "M" + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join("L") + (closed ? "Z" : "");
    const color = stroke.style.color;
    const width = stroke.style.width * m.k;
    g.append(svg("path", { d, fill: "none", stroke: color, "stroke-width": f(width), "stroke-linecap": "round", "stroke-linejoin": "round" }));
    if (sn.result.kind === "arrow") {
      const head = arrowGeometry(sn.layer).head;
      if (head?.kind === "triangle") {
        const poly = head.poly.map((p) => m.pt(fromLocal(sn.layer, p)));
        g.append(
          svg("polygon", {
            points: poly.map((p) => `${f(p.x)},${f(p.y)}`).join(" "),
            fill: color,
            stroke: color,
            "stroke-width": f(head.round * m.k),
            "stroke-linejoin": "round",
            opacity: f(Math.max(0, Math.min(1, (e - 0.45) / 0.55))),
          }),
        );
      }
    }
  }

  function endHint(api) {
    if (!showingHint) return;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      showingHint = false;
      if (!flashing) api.setStatus(null);
    }, 1600);
  }

  function stopStroke() {
    const s = stroke;
    stroke = null;
    clearTimeout(s.timer);
    s.anim?.();
    s.pending?.();
    return s;
  }

  function finish(api) {
    const s = stopStroke();
    kit.clearOverlay(api);
    const store = kit.store;
    if (s.snapped) {
      store.add([s.snapped.layer], { label: LABELS[s.snapped.result.kind] || "Add shape" });
    } else if (s.pts.length) {
      const base = createLayer("path", { color: s.style.color, width: s.style.width, smoothing: 0.5 });
      const fit = refitPoints({ ...base, x: 0, y: 0, rotation: 0, flipX: false, flipY: false }, s.pts);
      store.add([{ ...base, ...fit }], { label: "Add drawing" });
    }
    endHint(api);
    kit.done(api, def);
  }

  function discard(api) {
    stopStroke();
    kit.clearOverlay(api);
  }

  return def;
}
