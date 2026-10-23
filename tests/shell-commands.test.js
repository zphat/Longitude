// Tests for the pure helpers in web/js/ui/commands-core.js
//   deno test --allow-read tests/shell-commands.test.js

import assert from "node:assert/strict";
import { alignDeltas, distributeDeltas, coverCrop, untitledName, copyName, layerNameFromFile, fileKind } from "../web/js/ui/commands-core.js";
import { startBox, rescueIsNewer, writeRescue, readRescues, clearRescue, RESCUE_PREFIX, lockDesign, designOpenElsewhere, otherWindowsOpen, holdWindowLock, WINDOW_LOCK, loadDesign, session } from "../web/js/ui/commands-core.js";
import { Store } from "../web/js/core/store.js";
import { ProjectStore } from "../web/js/core/assets.js";
import { createDoc, createLayer } from "../web/js/core/model.js";

const box = (l, t, w, h) => ({ l, t, r: l + w, b: t + h, cx: l + w / 2, cy: t + h / 2, w, h });
const canvas = box(0, 0, 1280, 720);

Deno.test("alignDeltas: one box to the canvas", () => {
  const b = box(100, 50, 200, 100);
  assert.deepEqual(alignDeltas([b], "left", canvas), [{ dx: -100, dy: 0 }]);
  assert.deepEqual(alignDeltas([b], "right", canvas), [{ dx: 980, dy: 0 }]);
  assert.deepEqual(alignDeltas([b], "center-h", canvas), [{ dx: 440, dy: 0 }]);
  assert.deepEqual(alignDeltas([b], "top", canvas), [{ dx: 0, dy: -50 }]);
  assert.deepEqual(alignDeltas([b], "bottom", canvas), [{ dx: 0, dy: 570 }]);
  assert.deepEqual(alignDeltas([b], "center-v", canvas), [{ dx: 0, dy: 260 }]);
  assert.deepEqual(alignDeltas([b], "center", canvas), [{ dx: 440, dy: 260 }]);
});

Deno.test("alignDeltas: several boxes to their shared bounds", () => {
  const a = box(0, 0, 100, 100);
  const b = box(300, 200, 50, 50);
  const u = box(0, 0, 350, 250);
  assert.deepEqual(alignDeltas([a, b], "left", u), [{ dx: 0, dy: 0 }, { dx: -300, dy: 0 }]);
  assert.deepEqual(alignDeltas([a, b], "bottom", u), [{ dx: 0, dy: 150 }, { dx: 0, dy: 0 }]);
});

Deno.test("distributeDeltas: equal gaps, outer boxes stay", () => {
  const boxes = [box(0, 0, 100, 10), box(150, 0, 50, 10), box(500, 0, 100, 10)];
  const d = distributeDeltas(boxes, "h");
  // span 600, sizes 250, gap (600 - 250) / 2 = 175, so the middle box starts at 275
  assert.deepEqual(d.map((x) => x.dx), [0, 125, 0]);
  assert.ok(d.every((x) => x.dy === 0));
});

Deno.test("distributeDeltas: order follows centres, not input order", () => {
  const boxes = [box(500, 0, 100, 10), box(0, 0, 100, 10), box(400, 0, 10, 10)];
  const d = distributeDeltas(boxes, "h");
  // sorted: [1] 0..100, [2] 400..410, [0] 500..600; gap = (600 - 210) / 2 = 195
  assert.equal(d[1].dx, 0);
  assert.equal(d[2].dx, 295 - 400);
  assert.equal(d[0].dx, 0);
});

Deno.test("distributeDeltas: vertical, and fewer than three do not move", () => {
  const d = distributeDeltas([box(0, 0, 10, 10), box(0, 15, 10, 10), box(0, 90, 10, 10)], "v");
  assert.deepEqual(d.map((x) => x.dy), [0, 30, 0]);
  assert.deepEqual(distributeDeltas([box(0, 0, 1, 1), box(5, 5, 1, 1)], "h"), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
});

Deno.test("coverCrop: wider image crops the sides, taller crops top and bottom", () => {
  const wide = coverCrop(2000, 500, 1280, 720);
  assert.equal(wide.h, 1);
  assert.ok(Math.abs(wide.w - 16 / 9 / 4) < 1e-9);
  assert.ok(Math.abs(wide.x - (1 - wide.w) / 2) < 1e-9);
  const tall = coverCrop(1080, 1920, 1280, 720);
  assert.equal(tall.w, 1);
  assert.ok(Math.abs(tall.h - 1080 / 1920 / (1280 / 720)) < 1e-9);
  assert.deepEqual(coverCrop(1920, 1080, 1280, 720), { x: 0, y: 0, w: 1, h: 1 });
});

Deno.test("untitledName: drops the platform and keeps the kind", () => {
  assert.equal(untitledName({ group: "YouTube", label: "YouTube thumbnail" }), "Untitled thumbnail");
  assert.equal(untitledName({ group: "Spotify", label: "Spotify podcast cover" }), "Untitled podcast cover");
  assert.equal(untitledName({ group: "Social", label: "Square post" }), "Untitled square post");
  assert.equal(untitledName({ group: "Custom", label: "Custom size", custom: true }), "Untitled design");
  assert.equal(untitledName(null), "Untitled design");
});

Deno.test("copyName: counts up", () => {
  assert.equal(copyName("Cats"), "Cats copy");
  assert.equal(copyName("Cats copy"), "Cats copy 2");
  assert.equal(copyName("Cats copy 2"), "Cats copy 3");
});

Deno.test("layerNameFromFile and fileKind", () => {
  assert.equal(layerNameFromFile("my_face.final.png"), "my face.final");
  assert.equal(layerNameFromFile(""), "Image");
  assert.equal(fileKind({ name: "a.longitude", type: "" }), "project");
  assert.equal(fileKind({ name: "doc.json", type: "application/json" }), "project");
  assert.equal(fileKind({ name: "x.PNG", type: "" }), "image");
  assert.equal(fileKind({ name: "x", type: "image/webp" }), "image");
  assert.equal(fileKind({ name: "Font.woff2", type: "" }), "font");
  assert.equal(fileKind({ name: "notes.txt", type: "text/plain" }), null);
});

// ---- starting from an image ---------------------------------------------------------------

Deno.test("startBox: a 16:9 image fills a 16:9 canvas", () => {
  const b = startBox(1920, 1080, 1280, 720);
  assert.deepEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: 640, y: 360, w: 1280, h: 720 });
  assert.deepEqual(b.crop, { x: 0, y: 0, w: 1, h: 1 });
});

Deno.test("startBox: within 3 % fills with a sliver cropped, never stretched", () => {
  const b = startBox(1900, 1080, 1280, 720); // 1.759 against 1.778
  assert.equal(b.w, 1280);
  assert.equal(b.h, 720);
  assert.ok(b.crop.h < 1 && b.crop.h > 0.97, JSON.stringify(b.crop));
});

Deno.test("startBox: a portrait photo fits inside 70 % and nothing is cut", () => {
  const b = startBox(1080, 1350, 1280, 720);
  assert.equal(b.crop, undefined);
  assert.ok(b.h <= 720 * 0.7 + 0.01 && b.w < b.h, `${b.w}x${b.h}`);
  assert.deepEqual([b.x, b.y], [640, 360]);
});

// ---- rescue copies ---------------------------------------------------------------------------

Deno.test("rescueIsNewer: only a readable copy newer than storage wins", () => {
  const rec = { id: "doc_a", at: 2000, doc: { id: "doc_a", layers: [{ type: "text" }] } };
  assert.ok(rescueIsNewer(rec, "doc_a", 1000));
  assert.ok(rescueIsNewer(rec, "doc_a", 0));
  assert.ok(!rescueIsNewer(rec, "doc_a", 2000));
  assert.ok(!rescueIsNewer(rec, "doc_b", 0));
  assert.ok(!rescueIsNewer(null, "doc_a", 0));
  assert.ok(!rescueIsNewer({ id: "doc_a", at: 2000, doc: { layers: "x" } }, "doc_a", 0));
  // An empty design that was never stored is not worth bringing back.
  assert.ok(!rescueIsNewer({ id: "doc_a", at: 2000, doc: { layers: [] } }, "doc_a", 0));
  assert.ok(rescueIsNewer({ id: "doc_a", at: 2000, doc: { layers: [] } }, "doc_a", 1000));
});

async function withFakeStorage(fn) {
  const map = new Map();
  const fake = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  try {
    await fn(map);
  } finally {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete globalThis.localStorage;
  }
}

Deno.test("rescue copies: written, listed and cleared per design", () =>
  withFakeStorage((map) => {
    map.set("longitude.prefs.v1", "{}");
    assert.ok(writeRescue({ id: "doc_one", layers: [] }, 5));
    map.set(RESCUE_PREFIX + "doc_bad", "{not json");
    const list = readRescues();
    assert.deepEqual(list.map((r) => r.id).sort(), ["doc_bad", "doc_one"]);
    assert.equal(list.find((r) => r.id === "doc_one").rec.at, 5);
    assert.equal(list.find((r) => r.id === "doc_bad").rec, null);
    clearRescue("doc_one");
    assert.ok(!map.has(RESCUE_PREFIX + "doc_one"));
    assert.ok(map.has("longitude.prefs.v1"));
  }));

// ---- one window per design ------------------------------------------------------------------

// A small Web Locks stand-in: exclusive and shared modes, ifAvailable, signal.
function fakeLocks() {
  const held = new Map();
  return {
    async request(name, opts, cb) {
      const shared = opts.mode === "shared";
      const h = held.get(name);
      if (h && !(shared && h.mode === "shared")) {
        if (opts.ifAvailable) return cb(null);
        return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
      held.set(name, { mode: shared ? "shared" : "exclusive", count: (h?.count || 0) + 1 });
      try {
        return await cb({ name });
      } finally {
        const x = held.get(name);
        if (x.count > 1) x.count--;
        else held.delete(name);
      }
    },
    async query() {
      return { held: [...held].flatMap(([name, h]) => Array.from({ length: h.count }, () => ({ name, mode: h.mode }))) };
    },
  };
}

async function withLocks(value, fn) {
  const before = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { value, configurable: true });
  try {
    await fn();
  } finally {
    if (before) Object.defineProperty(navigator, "locks", before);
    else delete navigator.locks;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("lockDesign: one window per design", () =>
  withLocks(fakeLocks(), async () => {
    const release = await lockDesign("doc_lock1");
    assert.equal(typeof release, "function");
    assert.equal(await lockDesign("doc_lock1"), null);
    assert.ok(await designOpenElsewhere("doc_lock1"));
    assert.ok(!(await designOpenElsewhere("doc_lock2")));
    // Waiting gives up after the time allowed.
    assert.equal(await lockDesign("doc_lock1", { wait: 20 }), null);
    release();
    await tick();
    const again = await lockDesign("doc_lock1");
    assert.equal(typeof again, "function");
    again();
  }));

Deno.test("otherWindowsOpen: counts the shared window locks", () =>
  withLocks(fakeLocks(), async () => {
    assert.ok(!(await otherWindowsOpen()));
    holdWindowLock();
    await tick();
    assert.ok(!(await otherWindowsOpen()));
    holdWindowLock();
    await tick();
    assert.ok(await otherWindowsOpen());
    assert.equal((await navigator.locks.query()).held.filter((l) => l.name === WINDOW_LOCK).length, 2);
  }));

Deno.test("lockDesign: without Web Locks everything still opens", () =>
  withLocks(undefined, async () => {
    assert.equal(typeof (await lockDesign("doc_x")), "function");
    assert.ok(!(await designOpenElsewhere("doc_x")));
    assert.ok(!(await otherWindowsOpen()));
  }));

// ---- loadDesign stores what it should, remembers only what is stored ----------------------

function lifecycleCtx() {
  return { store: new Store(), projects: new ProjectStore(null), assets: null, fonts: null, prefs: { set() {} }, emit() {}, ui: {} };
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return fn();
}

Deno.test("loadDesign: a design that arrives with content is stored at once", () =>
  withLocks(fakeLocks(), async () => {
    Object.assign(session, { open: false, lock: null, lastOpened: null, autosave: null });
    const stored = [];
    session.onStored = ({ id }) => stored.push(id);
    const ctx = lifecycleCtx();
    const doc = createDoc({ name: "From a photo" });
    doc.layers = [createLayer("shape", { shape: "rect", x: 100, y: 100, w: 80, h: 60 })];
    await loadDesign(ctx, doc);
    assert.ok(await until(() => ctx.projects.has(doc.id)), "stored without an edit");
    assert.deepEqual(stored, [doc.id]);
    // Not remembered here: main.js does that when the save reports in.
    assert.notEqual(await ctx.projects.lastOpened(), doc.id);
    session.lock?.release();
    Object.assign(session, { open: false, lock: null, onStored: null });
  }));

Deno.test("loadDesign: an empty new design is neither stored nor remembered", () =>
  withLocks(fakeLocks(), async () => {
    Object.assign(session, { open: false, lock: null, lastOpened: null, autosave: null });
    const ctx = lifecycleCtx();
    const doc = createDoc({ name: "Blank" });
    await loadDesign(ctx, doc);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!(await ctx.projects.has(doc.id)));
    assert.notEqual(await ctx.projects.lastOpened(), doc.id);
    // A stored design is remembered as soon as it opens, and this window holds it.
    const kept = createDoc({ name: "Kept" });
    await ctx.projects.save(kept, null);
    await loadDesign(ctx, await ctx.projects.load(kept.id), { fromStorage: true });
    assert.ok(await until(async () => (await ctx.projects.lastOpened()) === kept.id));
    assert.equal(session.lock?.id, kept.id);
    assert.equal(await lockDesign(kept.id), null);
    session.lock?.release();
    Object.assign(session, { open: false, lock: null });
  }));
