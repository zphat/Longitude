// The canvas pass: workspace (dot grid that moves with the view, film grain),
// the artboard with its soft shadow and a checkerboard under transparent
// backgrounds, the design itself through core's render cache, the parts of
// selected layers that hang off the artboard (ghosted), preset guides, the
// thirds grid and centre lines, crop mode, and the time-based effects (the
// background-removal scan and the lime pulse on new layers).

import { renderDoc } from "../core/render.js";
import { resetContext } from "../core/effects.js";
import { corners } from "../core/geometry.js";

const SCAN_MS = 1500;
export const FLASH_MS = 600;

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k, f) => (cs.getPropertyValue(k) || "").trim() || f;
  const num = (k, f) => {
    const n = parseFloat(v(k, ""));
    return Number.isFinite(n) ? n : f;
  };
  return {
    workspace: v("--workspace", "#07080a"),
    dot: v("--dot", "rgba(238, 241, 236, 0.07)"),
    grainOp: num("--grain-op", 0.07),
    grainBlend: v("--grain-blend", "screen"),
    scanOp: num("--scan-op", 0),
    shadow: v("--shadow", "rgba(0, 0, 0, 0.55)"),
    accent: v("--accent", "#d1ff4a"),
    lineSoft: v("--line-soft", "rgba(48, 56, 61, 0.7)"),
    red: v("--red", "#ff8f98"),
    font: v("--f-body", "Manrope, system-ui, sans-serif"),
    scheme: document.documentElement.dataset.scheme === "light" ? "light" : "dark",
  };
}

// Perceived lightness 0..1 of the doc background (for the empty hint).
export function backgroundLightness(bg) {
  const lum = (hex) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(hex || "");
    if (!m) return 0;
    let s = m[1];
    if (s.length === 3) s = [...s].map((c) => c + c).join("");
    const n = parseInt(s, 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  if (!bg || bg.kind === "transparent") return 0.9;
  if (bg.kind === "gradient") return (lum(bg.from) + lum(bg.to)) / 2;
  return lum(bg.color);
}

export function createStage(core) {
  const canvas = core.canvas;
  const g = canvas.getContext("2d", { alpha: false });
  let theme = readTheme();
  let dotTile = null;
  let grainTile = null;
  let scanTile = null;
  let checkTile = null;
  const reduced = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function tile(key, size, paint) {
    const t = makeCanvas(size, size);
    paint(t.getContext("2d"), t.width);
    return { key, pattern: g.createPattern(t, "repeat") };
  }

  // Dots sit on a doc-anchored grid whose spacing doubles or halves with
  // zoom, so the workspace feels like a surface you move over.
  function drawDots(dpr) {
    const vp = core.viewport;
    const spacingDoc = Math.pow(2, Math.round(Math.log2(24 / vp.zoom)));
    const size = Math.max(6, Math.round(spacingDoc * vp.zoom * dpr));
    const key = `${size}|${theme.dot}|${dpr}`;
    if (!dotTile || dotTile.key !== key) {
      dotTile = tile(key, size, (c) => {
        c.fillStyle = theme.dot;
        const r = Math.max(0.8, 0.9 * dpr);
        c.beginPath();
        c.arc(size / 2, size / 2, r, 0, Math.PI * 2);
        c.fill();
      });
    }
    const ox = (((vp.panX * dpr - size / 2) % size) + size) % size;
    const oy = (((vp.panY * dpr - size / 2) % size) + size) % size;
    g.save();
    g.translate(ox, oy);
    g.fillStyle = dotTile.pattern;
    g.fillRect(-ox, -oy, canvas.width, canvas.height);
    g.restore();
  }

  function drawGrain() {
    if (theme.grainOp > 0) {
      if (!grainTile) {
        grainTile = tile("grain", 160, (c, n) => {
          const img = c.createImageData(n, n);
          for (let i = 0; i < img.data.length; i += 4) {
            const v = (Math.random() * 255) | 0;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
            img.data[i + 3] = 255;
          }
          c.putImageData(img, 0, 0);
        });
      }
      g.save();
      g.globalAlpha = theme.grainOp;
      g.globalCompositeOperation = theme.grainBlend === "multiply" ? "multiply" : "screen";
      g.fillStyle = grainTile.pattern;
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.restore();
    }
    if (theme.scanOp > 0) {
      const dpr = core.viewport.dpr;
      const key = `scan|${dpr}`;
      if (!scanTile || scanTile.key !== key) {
        const n = Math.max(2, Math.round(3 * dpr));
        scanTile = tile(key, n, (c) => {
          c.fillStyle = "#ffffff";
          c.fillRect(0, 0, n, Math.max(1, Math.round(dpr)));
        });
      }
      g.save();
      g.globalAlpha = theme.scanOp;
      g.fillStyle = scanTile.pattern;
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.restore();
    }
  }

  function drawChecker(x, y, w, h, dpr) {
    const n = Math.max(4, Math.round(8 * dpr));
    const key = `check|${n}`;
    if (!checkTile || checkTile.key !== key) {
      checkTile = tile(key, n * 2, (c) => {
        c.fillStyle = "#f4f4f4";
        c.fillRect(0, 0, n * 2, n * 2);
        c.fillStyle = "#dadada";
        c.fillRect(0, 0, n, n);
        c.fillRect(n, n, n, n);
      });
    }
    g.save();
    g.translate(x, y);
    g.fillStyle = checkTile.pattern;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  function roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function label(text, x, y, dpr, { align = "left", dark = true } = {}) {
    g.save();
    g.font = `600 ${11 * dpr}px ${theme.font}`;
    g.textBaseline = "middle";
    const w = g.measureText(text).width;
    const pad = 6 * dpr;
    const bw = w + pad * 2;
    const bh = 18 * dpr;
    const bx = align === "center" ? x - bw / 2 : x;
    roundRect(bx, y - bh / 2, bw, bh, 6 * dpr);
    g.fillStyle = dark ? "rgba(0, 0, 0, 0.62)" : "rgba(255, 255, 255, 0.85)";
    g.fill();
    g.fillStyle = dark ? "#ffffff" : "#000000";
    g.fillText(text, bx + pad, y + 0.5 * dpr);
    g.restore();
  }

  // Preset guides (SPEC 12): what YouTube, Spotify and friends draw on top.
  function drawPresetGuides(art, dpr) {
    const preset = core.ctx.presets?.get?.(core.store.doc.preset);
    const guides = preset?.guides || [];
    for (const gd of guides) {
      const x = art.x + gd.x * art.w;
      const y = art.y + gd.y * art.h;
      const w = gd.w * art.w;
      const h = gd.h * art.h;
      g.save();
      switch (gd.kind) {
        case "badge": {
          roundRect(x, y, w, h, h * 0.2);
          g.fillStyle = "rgba(0, 0, 0, 0.8)";
          g.fill();
          if (gd.label) {
            g.fillStyle = "#ffffff";
            g.font = `600 ${Math.max(6, h * 0.56)}px ${theme.font}`;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(gd.label, x + w / 2, y + h / 2 + h * 0.03, w * 0.92);
          }
          break;
        }
        case "bar": {
          g.fillStyle = theme.red;
          g.globalAlpha = 0.9;
          g.fillRect(x, y, w * 0.38, Math.max(h, dpr));
          g.globalAlpha = 0.35;
          g.fillStyle = "#ffffff";
          g.fillRect(x + w * 0.38, y, w * 0.62, Math.max(h, dpr));
          break;
        }
        case "safe": {
          g.lineWidth = 3 * dpr;
          g.strokeStyle = "rgba(0, 0, 0, 0.45)";
          g.strokeRect(x, y, w, h);
          g.setLineDash([6 * dpr, 5 * dpr]);
          g.lineWidth = 1.25 * dpr;
          g.strokeStyle = "rgba(255, 255, 255, 0.9)";
          g.strokeRect(x, y, w, h);
          g.setLineDash([]);
          if (gd.label && w > 90 * dpr) label(gd.label, x + 8 * dpr, y + 16 * dpr, dpr);
          break;
        }
        case "zone": {
          g.beginPath();
          g.rect(x, y, w, h);
          g.clip();
          g.fillStyle = "rgba(0, 0, 0, 0.28)";
          g.fillRect(x, y, w, h);
          g.strokeStyle = "rgba(255, 255, 255, 0.16)";
          g.lineWidth = 1.5 * dpr;
          const step = 12 * dpr;
          g.beginPath();
          for (let d = -h; d < w; d += step) {
            g.moveTo(x + d, y + h);
            g.lineTo(x + d + h, y);
          }
          g.stroke();
          if (gd.label && w > 120 * dpr && h > 26 * dpr) label(gd.label, x + w / 2, y + h / 2, dpr, { align: "center" });
          break;
        }
        case "circle": {
          const cx = art.x + gd.cx * art.w;
          const cy = art.y + gd.cy * art.h;
          const r = gd.r * art.w;
          g.beginPath();
          g.rect(art.x, art.y, art.w, art.h);
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.fillStyle = "rgba(0, 0, 0, 0.42)";
          g.fill("evenodd");
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.setLineDash([6 * dpr, 5 * dpr]);
          g.lineWidth = 1.25 * dpr;
          g.strokeStyle = "rgba(255, 255, 255, 0.85)";
          g.stroke();
          g.setLineDash([]);
          if (gd.label && art.w > 200 * dpr) label(gd.label, art.x + 10 * dpr, art.y + 18 * dpr, dpr);
          break;
        }
      }
      g.restore();
    }
  }

  function line(x1, y1, x2, y2, dpr, color, dash) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineWidth = 3 * dpr;
    g.strokeStyle = "rgba(0, 0, 0, 0.35)";
    g.setLineDash(dash || []);
    g.stroke();
    g.lineWidth = 1 * dpr;
    g.strokeStyle = color;
    g.stroke();
    g.setLineDash([]);
  }

  function drawGrid(art, dpr) {
    const px = (v) => Math.round(v) + 0.5;
    g.save();
    for (const f of [1 / 3, 2 / 3]) {
      const x = px(art.x + art.w * f);
      const y = px(art.y + art.h * f);
      line(x, art.y, x, art.y + art.h, dpr, "rgba(255, 255, 255, 0.55)");
      line(art.x, y, art.x + art.w, y, dpr, "rgba(255, 255, 255, 0.55)");
    }
    g.restore();
  }

  function drawCentre(art, dpr) {
    const x = Math.round(art.x + art.w / 2) + 0.5;
    const y = Math.round(art.y + art.h / 2) + 0.5;
    g.save();
    g.globalAlpha = 0.85;
    line(x, art.y, x, art.y + art.h, dpr, theme.accent, [5 * dpr, 5 * dpr]);
    line(art.x, y, art.x + art.w, y, dpr, theme.accent, [5 * dpr, 5 * dpr]);
    g.restore();
  }

  function devicePoly(layer, dpr) {
    return corners(layer).map((p) => {
      const q = core.viewport.docToLocal(p);
      return { x: q.x * dpr, y: q.y * dpr };
    });
  }

  function path(pts) {
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
  }

  // Background removal in progress: a lime wash and a bright band that
  // sweeps down the layer, in the layer's own frame.
  function drawScan(layer, start, now, dpr) {
    const vp = core.viewport;
    const k = vp.zoom * dpr;
    const c = vp.docToLocal({ x: layer.x, y: layer.y });
    const r = ((layer.rotation || 0) * Math.PI) / 180;
    const w = layer.w;
    const h = layer.h;
    const t = ((now - start) % SCAN_MS) / SCAN_MS;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    g.save();
    g.setTransform(k * Math.cos(r), k * Math.sin(r), -k * Math.sin(r), k * Math.cos(r), c.x * dpr, c.y * dpr);
    g.beginPath();
    g.rect(-w / 2, -h / 2, w, h);
    g.clip();
    g.globalCompositeOperation = "source-over";
    g.fillStyle = theme.accent;
    g.globalAlpha = 0.07;
    g.fillRect(-w / 2, -h / 2, w, h);
    if (!reduced()) {
      const band = Math.max(h * 0.22, 24 / vp.zoom);
      const y = -h / 2 - band + e * (h + band * 1.2);
      const grad = g.createLinearGradient(0, y - band, 0, y + 2 / vp.zoom);
      grad.addColorStop(0, "rgba(0, 0, 0, 0)");
      grad.addColorStop(1, theme.accent);
      g.globalAlpha = 0.32;
      g.fillStyle = grad;
      g.fillRect(-w / 2, y - band, w, band);
      g.globalAlpha = 0.95;
      g.fillRect(-w / 2, y, w, Math.max(1.5 / vp.zoom, 1 / k));
    }
    g.restore();
  }

  function drawFlash(layer, start, now, dpr) {
    const t = Math.min(1, (now - start) / FLASH_MS);
    const pts = devicePoly(layer, dpr);
    const grow = reduced() ? 0 : t * 7 * dpr;
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const out = pts.map((p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * grow * 1.41, y: p.y + (dy / len) * grow * 1.41 };
    });
    g.save();
    g.globalAlpha = Math.pow(1 - t, 1.6);
    path(out);
    g.lineJoin = "round";
    g.lineWidth = (2.5 - t) * dpr;
    g.strokeStyle = theme.accent;
    g.shadowColor = theme.accent;
    g.shadowBlur = 12 * dpr * (1 - t);
    g.stroke();
    g.globalAlpha = 0.12 * (1 - t);
    path(pts);
    g.fillStyle = theme.accent;
    g.fill();
    g.restore();
  }

  // Returns true while something animates (scan or flash).
  function draw(now = performance.now()) {
    const vp = core.viewport;
    const store = core.store;
    const doc = store.doc;
    const S = core.state;
    const dpr = vp.dpr;
    const W = canvas.width;
    const H = canvas.height;
    resetContext(g);
    g.fillStyle = theme.workspace;
    g.fillRect(0, 0, W, H);
    drawDots(dpr);
    drawGrain();

    const k = vp.zoom * dpr;
    const ox = Math.round(vp.panX * dpr);
    const oy = Math.round(vp.panY * dpr);
    const art = { x: ox, y: oy, w: Math.round(doc.width * k), h: Math.round(doc.height * k) };

    g.save();
    g.fillStyle = "#000000";
    g.shadowColor = theme.shadow;
    g.shadowBlur = 44 * dpr;
    g.shadowOffsetY = 18 * dpr;
    g.fillRect(art.x, art.y, art.w, art.h);
    g.shadowBlur = 6 * dpr;
    g.shadowOffsetY = 2 * dpr;
    g.fillRect(art.x, art.y, art.w, art.h);
    g.restore();

    const opts = {
      scale: 1,
      assets: core.ctx.assets,
      fonts: core.ctx.fonts || null,
      cache: core.cache,
      editingTextId: core.textEditing || null,
      overrides: core.maskOverrides.size ? { masks: core.maskOverrides } : null,
    };

    // Selected layers that hang off the artboard show there, ghosted.
    const ghost = S.mode === "crop" ? [] : store.selection.filter((id) => !store.get(id)?.hidden);
    if (ghost.length) {
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H);
      g.rect(art.x, art.y, art.w, art.h);
      g.clip("evenodd");
      g.setTransform(k, 0, 0, k, ox, oy);
      g.globalAlpha = 0.28;
      renderDoc(g, doc, { ...opts, background: false, only: ghost });
      g.restore();
    }

    g.save();
    g.beginPath();
    g.rect(art.x, art.y, art.w, art.h);
    g.clip();
    if (doc.background?.kind === "transparent") drawChecker(art.x, art.y, art.w, art.h, dpr);
    g.setTransform(k, 0, 0, k, ox, oy);
    renderDoc(g, doc, { ...opts, background: true });
    g.restore();

    // A hairline keeps a dark artboard readable on a dark workspace.
    g.save();
    g.strokeStyle = theme.lineSoft;
    g.lineWidth = 1;
    g.strokeRect(art.x - 0.5, art.y - 0.5, art.w + 1, art.h + 1);
    g.restore();

    g.save();
    g.beginPath();
    g.rect(art.x, art.y, art.w, art.h);
    g.clip();
    if (S.overlays.safe) drawPresetGuides(art, dpr);
    if (S.overlays.grid) drawGrid(art, dpr);
    if (S.overlays.center) drawCentre(art, dpr);
    g.restore();

    core.crop.drawCanvas(g);

    let animating = false;
    for (const [id, start] of S.scanning) {
      const l = store.get(id);
      if (!l || l.hidden) continue;
      drawScan(l, start, now, dpr);
      animating = true;
    }
    S.flashes = S.flashes.filter((f) => now - f.start < FLASH_MS);
    for (const f of S.flashes) {
      for (const id of f.ids) {
        const l = store.get(id);
        if (l && !l.hidden) drawFlash(l, f.start, now, dpr);
      }
      animating = true;
    }
    return animating;
  }

  return {
    draw,
    readTheme() {
      theme = readTheme();
      dotTile = null;
      scanTile = null;
    },
    get theme() {
      return theme;
    },
  };
}
