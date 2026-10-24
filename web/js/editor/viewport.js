// Pan and zoom. The view is { zoom, panX, panY }: a doc point p lands at
// (panX + p.x * zoom, panY + p.y * zoom) in host-local CSS px. Pan is kept on
// whole device pixels so pixel-aligned layer composites stay crisp. The canvas
// is sized in device pixels and follows the host with a ResizeObserver.

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
export const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0625, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function clampZoom(z) {
  return clamp(Number.isFinite(z) && z > 0 ? z : 1, MIN_ZOOM, MAX_ZOOM);
}

// New view with `zoom`, keeping the doc point under `anchor` (host-local) still.
export function zoomAround(view, zoom, anchor) {
  const z = clampZoom(zoom);
  const dx = (anchor.x - view.panX) / view.zoom;
  const dy = (anchor.y - view.panY) / view.zoom;
  return { zoom: z, panX: anchor.x - dx * z, panY: anchor.y - dy * z };
}

// View that fits a docW x docH artboard inside the free area of the host
// (insets: room taken by floating chrome).
export function fitView(docW, docH, viewW, viewH, insets = {}, { pad = 40, maxZoom = MAX_ZOOM } = {}) {
  let l = insets.left || 0;
  let r = insets.right || 0;
  let t = insets.top || 0;
  let b = insets.bottom || 0;
  if (viewW - l - r - pad * 2 < 120 || viewH - t - b - pad * 2 < 120) l = r = t = b = 0;
  const p = Math.min(pad, viewW / 8, viewH / 8);
  const aw = Math.max(1, viewW - l - r - p * 2);
  const ah = Math.max(1, viewH - t - b - p * 2);
  const zoom = clampZoom(Math.min(aw / docW, ah / docH, maxZoom));
  const cx = l + (viewW - l - r) / 2;
  const cy = t + (viewH - t - b) / 2;
  return { zoom, panX: cx - (docW * zoom) / 2, panY: cy - (docH * zoom) / 2 };
}

// The free area of a viewW x viewH host with chrome insets, keyed for
// comparing (whole px, so sub-pixel layout noise is not a change).
export function freeArea(viewW, viewH, insets = {}) {
  const r = (v) => Math.round(Number(v) || 0);
  const i = { top: insets.top || 0, right: insets.right || 0, bottom: insets.bottom || 0, left: insets.left || 0 };
  return { w: r(viewW), h: r(viewH), insets: i, key: [viewW, viewH, i.top, i.right, i.bottom, i.left].map(r).join(",") };
}

// Whether the automatic fit should run again now that the free area is
// `next` (last: the area it last fitted). null while the view is the
// user's (they zoomed or panned) or nothing changed. Only the chrome moving
// (the panel shown or hidden, same host size) glides; a resize snaps.
export function refitPlan(last, next, { auto = true, pending = false } = {}) {
  if (!auto && !pending) return null;
  if (pending || !last) return { animate: false };
  if (last.key === next.key) return null;
  return { animate: last.w === next.w && last.h === next.h };
}

// Rect fit: the doc rect { l, t, r, b } fills the free area.
export function fitRectView(rect, viewW, viewH, insets = {}, opts = {}) {
  const w = Math.max(1, rect.r - rect.l);
  const h = Math.max(1, rect.b - rect.t);
  const v = fitView(w, h, viewW, viewH, insets, opts);
  return { zoom: v.zoom, panX: v.panX - rect.l * v.zoom, panY: v.panY - rect.t * v.zoom };
}

// The next preset zoom above (dir > 0) or below (dir < 0) z.
export function stepZoom(z, dir) {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z / 1.001) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

// Keep at least `keep` px of the artboard on screen so it can never be lost.
export function clampPan(view, docW, docH, viewW, viewH, keep = 64) {
  const w = docW * view.zoom;
  const h = docH * view.zoom;
  const kx = Math.min(keep, w, viewW / 2);
  const ky = Math.min(keep, h, viewH / 2);
  return { zoom: view.zoom, panX: clamp(view.panX, kx - w, viewW - kx), panY: clamp(view.panY, ky - h, viewH - ky) };
}

// Wheel delta -> zoom factor. Mouse wheels send big integer steps, trackpad
// pinches (ctrlKey wheel) send small fractional ones.
export function wheelZoomFactor(e) {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= 400;
  const notch = Math.abs(dy) >= 50 && Number.isInteger(e.deltaY);
  if (notch) return dy < 0 ? 1.2 : 1 / 1.2;
  return Math.exp(-clamp(dy, -60, 60) * 0.01);
}

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

let probeEl = null;

// A hidden fixed element sized by the shell's --inset-top/right/bottom/left
// (calc() expressions on body), or null when they are not set. Its box is
// the free area between the chrome, so it resizes whenever that area does
// (window resize, the panel showing or hiding, the interface hidden).
export function insetProbe() {
  if (probeEl?.isConnected) return probeEl;
  const body = typeof document !== "undefined" ? document.body : null;
  if (!body || !getComputedStyle(body).getPropertyValue("--inset-top").trim()) return null;
  probeEl = document.createElement("div");
  probeEl.className = "ed-inset-probe";
  probeEl.setAttribute("aria-hidden", "true");
  Object.assign(probeEl.style, {
    position: "fixed",
    top: "var(--inset-top)",
    right: "var(--inset-right)",
    bottom: "var(--inset-bottom)",
    left: "var(--inset-left)",
    visibility: "hidden",
    pointerEvents: "none",
    zIndex: "-1",
  });
  body.append(probeEl);
  return probeEl;
}

// The insets resolved to px through the probe, relative to the host rect.
function cssInsets(hr) {
  const probe = insetProbe();
  if (!probe) return null;
  const r = probe.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return {
    top: Math.max(0, r.top - hr.top),
    left: Math.max(0, r.left - hr.left),
    right: Math.max(0, hr.right - r.right),
    bottom: Math.max(0, hr.bottom - r.bottom),
  };
}

// Room taken by the floating chrome (rail, top bar, inspector, zoom island):
// the shell's --inset-* variables when set, else measured from visible
// .island elements outside the host. Used by "fit" and the quick bar.
export function detectInsets(host) {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof document === "undefined" || !host) return out;
  const hr = host.getBoundingClientRect();
  try {
    const css = cssInsets(hr);
    if (css) return css;
  } catch {}
  const W = hr.width;
  const H = hr.height;
  if (!W || !H) return out;
  const skip = /quick|toast|tip|menu|pop|dialog|palette|home|drop|hint/i;
  for (const el of document.querySelectorAll(".island")) {
    if (host.contains(el) || skip.test(el.className?.baseVal ?? el.className ?? "")) continue;
    if (el.closest("[data-no-inset], dialog, [role=dialog], .home")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
    if (r.width > W * 0.8 && r.height > H * 0.8) continue;
    const x = r.left - hr.left;
    const y = r.top - hr.top;
    const cx = x + r.width / 2;
    const cy = y + r.height / 2;
    const tall = r.height >= r.width * 1.2 || r.height > H * 0.4;
    if (tall && cx < W * 0.4) out.left = Math.max(out.left, x + r.width);
    else if (tall && cx > W * 0.6) out.right = Math.max(out.right, W - x);
    else if (cy < H * 0.5) out.top = Math.max(out.top, y + r.height);
    else out.bottom = Math.max(out.bottom, H - y);
  }
  out.left = Math.min(out.left, W * 0.4);
  out.right = Math.min(out.right, W * 0.45);
  out.top = Math.min(out.top, H * 0.3);
  out.bottom = Math.min(out.bottom, H * 0.3);
  return out;
}

const reducedMotion = () => {
  try {
    return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

// The live viewport bound to a host element and its canvas.
export function createViewport({ host, canvas, onChange, onResize }) {
  const vp = { zoom: 1, panX: 0, panY: 0, width: 0, height: 0, dpr: 1, left: 0, top: 0, canvas };
  let anim = null;
  let mq = null;

  vp.measure = () => {
    const r = host.getBoundingClientRect();
    vp.left = r.left;
    vp.top = r.top;
    vp.width = Math.max(0, r.width);
    vp.height = Math.max(0, r.height);
    return r;
  };

  const snapPan = (v) => Math.round(v * vp.dpr) / vp.dpr;

  // Size the canvas backing store to the host in device pixels. Returns true
  // when anything changed.
  vp.syncSize = () => {
    vp.measure();
    const dpr = Math.max(0.5, Math.min(4, globalThis.devicePixelRatio || 1));
    const W = Math.max(1, Math.round(vp.width * dpr));
    const H = Math.max(1, Math.round(vp.height * dpr));
    const changed = dpr !== vp.dpr || canvas.width !== W || canvas.height !== H;
    if (dpr !== vp.dpr) {
      vp.dpr = dpr;
      watchDpr();
    }
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const cw = `${vp.width}px`;
    const ch = `${vp.height}px`;
    if (canvas.style.width !== cw) canvas.style.width = cw;
    if (canvas.style.height !== ch) canvas.style.height = ch;
    return changed;
  };

  function watchDpr() {
    mq?.removeEventListener?.("change", onDpr);
    try {
      mq = globalThis.matchMedia?.(`(resolution: ${vp.dpr}dppx)`) || null;
      mq?.addEventListener?.("change", onDpr);
    } catch {
      mq = null;
    }
  }
  function onDpr() {
    if (vp.syncSize()) onResize?.({ resized: true });
  }

  vp.docToLocal = (p) => ({ x: vp.panX + p.x * vp.zoom, y: vp.panY + p.y * vp.zoom });
  vp.localToDoc = (p) => ({ x: (p.x - vp.panX) / vp.zoom, y: (p.y - vp.panY) / vp.zoom });
  vp.clientToLocal = (x, y) => ({ x: x - vp.left, y: y - vp.top });
  vp.localToClient = (p) => ({ x: p.x + vp.left, y: p.y + vp.top });
  vp.clientToDoc = (x, y) => vp.localToDoc(vp.clientToLocal(x, y));
  vp.docToClient = (p) => vp.localToClient(vp.docToLocal(p));
  vp.view = () => ({ zoom: vp.zoom, panX: vp.panX, panY: vp.panY });

  function apply(view) {
    const zoom = clampZoom(view.zoom);
    const panX = snapPan(view.panX);
    const panY = snapPan(view.panY);
    const changed = zoom !== vp.zoom || panX !== vp.panX || panY !== vp.panY;
    const zoomChanged = zoom !== vp.zoom;
    vp.zoom = zoom;
    vp.panX = panX;
    vp.panY = panY;
    if (changed) onChange?.({ zoomChanged });
    return changed;
  }

  // Set the view now, or animate to it (120-200 ms, skipped for reduced motion).
  vp.set = (view, { animate = false, ms = 180 } = {}) => {
    const target = { zoom: clampZoom(view.zoom ?? vp.zoom), panX: view.panX ?? vp.panX, panY: view.panY ?? vp.panY };
    if (!animate || reducedMotion() || !vp.width) {
      anim = null;
      return apply(target);
    }
    anim = { from: vp.view(), to: target, start: performance.now(), ms };
    return true;
  };

  vp.stop = () => {
    anim = null;
  };

  // Advance an animation; true while one is running.
  vp.tick = (now = performance.now()) => {
    if (!anim) return false;
    const t = Math.min(1, (now - anim.start) / anim.ms);
    const e = easeOut(t);
    const { from, to } = anim;
    const z = Math.exp(lerp(Math.log(from.zoom), Math.log(to.zoom), e));
    // Interpolate the doc point at the view center so the zoom feels anchored.
    const cx = vp.width / 2;
    const cy = vp.height / 2;
    const fc = { x: (cx - from.panX) / from.zoom, y: (cy - from.panY) / from.zoom };
    const tc = { x: (cx - to.panX) / to.zoom, y: (cy - to.panY) / to.zoom };
    const dc = { x: lerp(fc.x, tc.x, e), y: lerp(fc.y, tc.y, e) };
    if (t >= 1) {
      anim = null;
      apply(to);
      return false;
    }
    apply({ zoom: z, panX: cx - dc.x * z, panY: cy - dc.y * z });
    return true;
  };

  Object.defineProperty(vp, "animating", { get: () => !!anim });

  // Watches the host and the free area between the chrome. onResize gets
  // { resized } (true when the canvas backing store changed, which clears
  // it) after layout settles, so the insets it reads are current.
  let ro = null;
  let probe = null;
  function watchProbe() {
    if (!ro || probe?.isConnected) return;
    try {
      if (probe) ro.unobserve(probe);
      probe = insetProbe();
      if (probe) ro.observe(probe);
    } catch {
      probe = null;
    }
  }
  vp.observe = () => {
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => {
        watchProbe();
        onResize?.({ resized: vp.syncSize() });
      });
      ro.observe(host);
      watchProbe();
    }
    watchDpr();
  };

  vp.dispose = () => {
    ro?.disconnect();
    mq?.removeEventListener?.("change", onDpr);
  };

  return vp;
}
