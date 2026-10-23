// The document store. Every change to the design goes through here so undo,
// autosave and the UI stay in step. The store never mutates a doc or layer in
// place: a change produces a new doc object, new objects for the layers that
// changed and keeps the identity of the ones that did not. History is a stack
// of snapshots (doc + selection) kept by reference: since nothing is mutated,
// entries share every layer that did not change, so long freehand strokes are
// stored once rather than once per undo step.

import { createDoc, normalizeDoc, normalizeLayer, normalizeBackground, cloneLayer, uid, deepEqual, normAngle, clampNum, isPlainObject } from "./model.js";

const HISTORY_LIMIT = 200;
const COALESCE_MS = 900;

const toIds = (ids) => (ids == null ? [] : Array.isArray(ids) ? ids : ids instanceof Set ? [...ids] : [ids]).filter((id) => typeof id === "string");

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const copyValue = (v) => (v !== null && typeof v === "object" ? structuredClone(v) : v);

const ADD_LABELS = { image: "Add image", text: "Add text", shape: "Add shape", path: "Add drawing", arrow: "Add arrow" };

// Which layers a coalescing change touched, so a run of nudges on one layer
// never swallows a nudge on another.
const idSig = (ids) => (ids == null ? "*" : [...ids].sort().join(","));

// Whether two docs differ. Docs and layers are never mutated, so the same
// reference means the same content and only replaced layers are compared deeply
// (a drag that ends where it started still counts as no change).
function docChanged(a, b) {
  if (a === b) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "layers" || a[k] === b[k]) continue;
    if (!deepEqual(a[k], b[k])) return true;
  }
  const la = a.layers;
  const lb = b.layers;
  if (la === lb) return false;
  if (!Array.isArray(la) || !Array.isArray(lb) || la.length !== lb.length) return true;
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i] && !deepEqual(la[i], lb[i])) return true;
  return false;
}

const cleanDocName = (v, fallback) => {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : "";
  return s || fallback;
};

// Shallow merge of props into a layer; nested plain objects (stroke, shadow,
// crop, adjust, params, ...) merge one level deep. Returns the same layer when
// nothing actually changes. id and type never change, and keys the layer does
// not have are ignored (every normalized layer has all of its fields).
export function mergeLayer(layer, props) {
  let out = null;
  for (const k in props) {
    if (k === "id" || k === "type" || !(k in layer)) continue;
    let v = props[k];
    if (v === undefined) continue;
    const cur = layer[k];
    if (isPlainObject(v) && isPlainObject(cur)) {
      let sub = null;
      for (const sk in v) {
        if (v[sk] === undefined || deepEqual(cur[sk], v[sk])) continue;
        sub ??= { ...cur };
        sub[sk] = copyValue(v[sk]);
      }
      if (!sub) continue;
      v = sub;
    } else {
      if (k === "rotation" && typeof v === "number") v = normAngle(v);
      if (deepEqual(cur, v)) continue;
      v = copyValue(v);
    }
    out ??= { ...layer };
    out[k] = v;
  }
  return out || layer;
}

export class Store extends EventTarget {
  constructor(doc) {
    super();
    this.doc = doc ? normalizeDoc(doc) : createDoc();
    this.selection = [];
    this.now = () => Date.now();
    this._undo = [];
    this._redo = [];
    this._gestures = [];
    this._normalizers = [];
    this._coalesce = null;
    this._indexOf = null;
    this._indexMap = new Map();
  }

  // ---- reading ----------------------------------------------------------

  get(id) {
    const i = this.index(id);
    return i < 0 ? undefined : this.doc.layers[i];
  }

  index(id) {
    const layers = this.doc.layers;
    if (this._indexOf !== layers) {
      this._indexMap.clear();
      for (let i = 0; i < layers.length; i++) this._indexMap.set(layers[i].id, i);
      this._indexOf = layers;
    }
    const i = this._indexMap.get(id);
    return i === undefined ? -1 : i;
  }

  layers() {
    return this.doc.layers;
  }

  selected() {
    if (!this.selection.length) return [];
    const set = new Set(this.selection);
    return this.doc.layers.filter((l) => set.has(l.id));
  }

  get inGesture() {
    return this._gestures.length > 0;
  }

  get canUndo() {
    return this._undo.length > 0 || (this._gestures.length > 0 && this._gestures[0].touched);
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  historyLabels() {
    const u = this._gestures[0]?.touched ? this._gestures[0] : this._undo[this._undo.length - 1];
    const r = this._redo[this._redo.length - 1];
    return { undo: u ? u.label : null, redo: r ? r.label : null };
  }

  // Asset ids referenced by the current doc, the history and open gestures.
  // Pass to assets.gc() so undo never points at a deleted image.
  referencedAssets() {
    const ids = new Set();
    const scan = (doc) => {
      for (const l of doc?.layers || []) {
        if (l.type !== "image") continue;
        if (l.asset) ids.add(l.asset);
        if (l.mask) ids.add(l.mask);
      }
    };
    scan(this.doc);
    for (const e of this._undo) scan(e.doc);
    for (const e of this._redo) scan(e.doc);
    for (const g of this._gestures) scan(g.doc);
    return ids;
  }

  // ---- whole-document changes --------------------------------------------

  setDoc(doc, { history = "reset", label = "Replace design" } = {}) {
    let next = normalizeDoc(doc);
    next = this._normalize(next, next.layers.map((l) => l.id), "self");
    if (history === "push") {
      this._finishGestures();
      this._record(this.doc, this.selection, label, null);
    } else {
      this._undo.length = 0;
      this._redo.length = 0;
      this._gestures.length = 0;
      this._coalesce = null;
    }
    const sel = history === "push" ? this._prune(this.selection, next) : [];
    this._set(next, sel, { reason: "setdoc", ids: null, transient: false }, true);
    return true;
  }

  update(mutator, opts = {}) {
    if (typeof mutator !== "function") return false;
    const before = this.doc;
    const working = structuredClone(before);
    const returned = mutator(working);
    const next = returned && typeof returned === "object" && Array.isArray(returned.layers) ? returned : working;
    if (!Array.isArray(next.layers)) return false;
    const prevById = new Map(before.layers.map((l) => [l.id, l]));
    const seen = new Set();
    const changed = [];
    const layers = [];
    for (const raw of next.layers) {
      const prev = prevById.get(raw?.id);
      if (prev && !seen.has(prev.id) && deepEqual(prev, raw)) {
        layers.push(prev);
        seen.add(prev.id);
        continue;
      }
      const l = normalizeLayer(raw);
      if (!l) continue;
      if (seen.has(l.id)) l.id = uid("lyr");
      seen.add(l.id);
      layers.push(l);
      changed.push(l.id);
    }
    const name = cleanDocName(next.name, before.name);
    const docOut = {
      ...before,
      name: name === before.name ? before.name : name,
      width: Math.round(clampNum(next.width, 16, 8192, before.width)),
      height: Math.round(clampNum(next.height, 16, 8192, before.height)),
      preset: typeof next.preset === "string" || next.preset === null ? next.preset : before.preset,
      background: deepEqual(next.background, before.background) ? before.background : normalizeBackground(next.background, before.background),
      layers,
    };
    const sameProps = ["name", "width", "height", "preset", "background"].every((k) => docOut[k] === before[k]);
    const sameOrder = layers.length === before.layers.length && layers.every((l, i) => l === before.layers[i]);
    if (sameProps && sameOrder && !changed.length) return false;
    const prevMap = new Map();
    for (const id of changed) if (prevById.has(id)) prevMap.set(id, prevById.get(id));
    return this._apply(docOut, { reason: "doc", ids: null, normalize: changed, prevMap, label: "Edit", ...opts });
  }

  setDocProps(props, opts = {}) {
    if (!props || typeof props !== "object") return false;
    const d = this.doc;
    const next = { ...d };
    let changed = false;
    if ("name" in props) {
      const name = cleanDocName(props.name, "Untitled thumbnail");
      if (name !== d.name) (next.name = name), (changed = true);
    }
    for (const k of ["width", "height"]) {
      if (!(k in props)) continue;
      const v = Math.round(clampNum(props[k], 16, 8192, d[k]));
      if (v !== d[k]) (next[k] = v), (changed = true);
    }
    if ("preset" in props) {
      const p = typeof props.preset === "string" && props.preset ? props.preset.slice(0, 64) : null;
      if (p !== d.preset) (next.preset = p), (changed = true);
    }
    if ("background" in props) {
      const raw = props.background && !props.background.kind ? { ...d.background, ...props.background } : props.background;
      const bg = normalizeBackground(raw, d.background);
      if (!deepEqual(bg, d.background)) (next.background = bg), (changed = true);
    }
    if (!changed) return false;
    return this._apply(next, { reason: "docprops", ids: null, label: "Canvas", ...opts });
  }

  // ---- layer changes -----------------------------------------------------

  patch(ids, propsOrFn, opts = {}) {
    const list = toIds(ids);
    if (!list.length || !propsOrFn) return false;
    const base = this.doc.layers;
    let next = null;
    const changed = [];
    const prevMap = new Map();
    for (const id of list) {
      const i = this.index(id);
      if (i < 0) continue;
      const layer = (next || base)[i];
      let props;
      try {
        props = typeof propsOrFn === "function" ? propsOrFn(layer) : propsOrFn;
      } catch (err) {
        console.error(err);
        continue;
      }
      if (!props || typeof props !== "object") continue;
      const merged = mergeLayer(layer, props);
      if (merged === layer) continue;
      next ??= base.slice();
      next[i] = merged;
      if (!prevMap.has(id)) {
        prevMap.set(id, base[i]);
        changed.push(id);
      }
    }
    if (!next) return false;
    return this._apply({ ...this.doc, layers: next }, { reason: "patch", ids: changed, normalize: changed, prevMap, label: "Edit", ...opts });
  }

  add(layers, { index, select = true, label, ...opts } = {}) {
    const list = (Array.isArray(layers) ? layers : [layers]).map((l) => normalizeLayer(l)).filter(Boolean);
    if (!list.length) return [];
    const base = this.doc.layers;
    const taken = new Set(base.map((l) => l.id));
    for (const l of list) {
      if (taken.has(l.id)) l.id = uid("lyr");
      taken.add(l.id);
    }
    const at = index == null || !Number.isFinite(Number(index)) ? base.length : Math.max(0, Math.min(base.length, Math.round(index)));
    const next = [...base.slice(0, at), ...list, ...base.slice(at)];
    const ids = list.map((l) => l.id);
    this._apply(
      { ...this.doc, layers: next },
      {
        reason: "add",
        ids,
        normalize: ids,
        prevMap: new Map(),
        label: label || (ids.length > 1 ? "Add layers" : ADD_LABELS[list[0].type] || "Add layer"),
        selection: select ? ids : null,
        ...opts,
      },
    );
    return ids;
  }

  remove(ids, { label, ...opts } = {}) {
    const set = new Set(toIds(ids).filter((id) => this.index(id) >= 0));
    if (!set.size) return false;
    const next = this.doc.layers.filter((l) => !set.has(l.id));
    return this._apply({ ...this.doc, layers: next }, { reason: "remove", ids: [...set], label: label || "Delete", ...opts });
  }

  move(id, toIndex, opts = {}) {
    const i = this.index(id);
    if (i < 0 || !Number.isFinite(Number(toIndex))) return false;
    const arr = this.doc.layers.slice();
    const to = Math.max(0, Math.min(arr.length - 1, Math.round(toIndex)));
    if (to === i) return false;
    const [l] = arr.splice(i, 1);
    arr.splice(to, 0, l);
    return this._order(arr, [id], opts);
  }

  forward(ids, opts) {
    const set = this._existing(ids);
    if (!set.size) return false;
    const arr = this.doc.layers.slice();
    for (let i = arr.length - 2; i >= 0; i--) {
      if (set.has(arr[i].id) && !set.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    }
    return this._order(arr, [...set], { label: "Bring forward", ...opts });
  }

  backward(ids, opts) {
    const set = this._existing(ids);
    if (!set.size) return false;
    const arr = this.doc.layers.slice();
    for (let i = 1; i < arr.length; i++) {
      if (set.has(arr[i].id) && !set.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
    }
    return this._order(arr, [...set], { label: "Send backward", ...opts });
  }

  toFront(ids, opts) {
    const set = this._existing(ids);
    if (!set.size) return false;
    const arr = this.doc.layers;
    const next = [...arr.filter((l) => !set.has(l.id)), ...arr.filter((l) => set.has(l.id))];
    return this._order(next, [...set], { label: "Bring to front", ...opts });
  }

  toBack(ids, opts) {
    const set = this._existing(ids);
    if (!set.size) return false;
    const arr = this.doc.layers;
    const next = [...arr.filter((l) => set.has(l.id)), ...arr.filter((l) => !set.has(l.id))];
    return this._order(next, [...set], { label: "Send to back", ...opts });
  }

  duplicate(ids, { offset = 24, label = "Duplicate", select = true, ...opts } = {}) {
    const set = this._existing(ids);
    if (!set.size) return [];
    const out = [];
    const newIds = [];
    const d = Number.isFinite(Number(offset)) ? Number(offset) : 24;
    for (const l of this.doc.layers) {
      out.push(l);
      if (!set.has(l.id)) continue;
      const c = cloneLayer(l);
      c.x += d;
      c.y += d;
      out.push(c);
      newIds.push(c.id);
    }
    this._apply({ ...this.doc, layers: out }, { reason: "add", ids: newIds, normalize: newIds, prevMap: new Map(), label, selection: select ? newIds : null, ...opts });
    return newIds;
  }

  // ---- selection (not part of history on its own) -------------------------

  select(ids, { additive = false, toggle = false } = {}) {
    const list = [...new Set(toIds(ids).filter((id) => this.index(id) >= 0))];
    let sel;
    if (toggle) {
      sel = [...this.selection];
      for (const id of list) {
        const i = sel.indexOf(id);
        if (i >= 0) sel.splice(i, 1);
        else sel.push(id);
      }
    } else if (additive) {
      sel = [...this.selection, ...list.filter((id) => !this.selection.includes(id))];
    } else {
      sel = list;
    }
    return this._setSelection(sel);
  }

  clearSelection() {
    return this._setSelection([]);
  }

  selectAll() {
    return this._setSelection(this.doc.layers.filter((l) => !l.hidden && !l.locked).map((l) => l.id));
  }

  // ---- gestures -----------------------------------------------------------

  // Gestures nest: only the outermost commit() records an entry. cancel()
  // restores the snapshot taken by the matching begin().
  begin(label = "Edit") {
    this._gestures.push({
      doc: this.doc,
      selection: [...this.selection],
      label: String(label || "Edit"),
      reason: null,
      ids: new Set(),
      allIds: false,
      touched: false,
    });
    return true;
  }

  commit() {
    const g = this._gestures.pop();
    if (!g) return false;
    const parent = this._gestures[this._gestures.length - 1];
    if (parent) {
      this._mergeGesture(parent, g);
      return false;
    }
    if (!g.touched) return false;
    const changed = docChanged(g.doc, this.doc);
    if (changed) {
      this._push({ doc: g.doc, selection: g.selection, label: g.label });
      this._coalesce = null;
    }
    this._emit("change", { reason: g.reason || "patch", ids: g.allIds ? null : [...g.ids], transient: false });
    if (changed) this._emitHistory();
    return changed;
  }

  cancel() {
    const g = this._gestures.pop();
    if (!g) return false;
    const parent = this._gestures[this._gestures.length - 1];
    if (parent) parent.touched = parent.touched || g.touched;
    if (!g.touched) return false;
    const doc = this._normalize(g.doc, g.doc.layers.map((l) => l.id), "self");
    this._set(doc, this._prune(g.selection, doc), { reason: "doc", ids: null, transient: this._gestures.length > 0 }, false);
    if (!this._gestures.length) this._emitHistory();
    return true;
  }

  // ---- history ------------------------------------------------------------

  undo() {
    this._finishGestures();
    const e = this._undo.pop();
    if (!e) return false;
    this._redo.push({ doc: this.doc, selection: [...this.selection], label: e.label });
    this._coalesce = null;
    this._restore(e, "undo");
    return true;
  }

  redo() {
    this._finishGestures();
    const e = this._redo.pop();
    if (!e) return false;
    this._undo.push({ doc: this.doc, selection: [...this.selection], label: e.label });
    this._coalesce = null;
    this._restore(e, "redo");
    return true;
  }

  clearHistory() {
    this._undo.length = 0;
    this._redo.length = 0;
    this._coalesce = null;
    this._emitHistory();
  }

  // ---- normalizers ----------------------------------------------------------

  // fn(layer, doc, prev) -> props | undefined. prev is the layer before this
  // change (undefined for new layers, the layer itself on remeasure/undo).
  addNormalizer(fn) {
    if (typeof fn !== "function") return () => {};
    this._normalizers.push(fn);
    return () => {
      const i = this._normalizers.indexOf(fn);
      if (i >= 0) this._normalizers.splice(i, 1);
    };
  }

  // Re-run normalizers (for example after a font finishes loading). Not an
  // undo step.
  remeasure(ids) {
    this.dispatchEvent(new CustomEvent("remeasure", { detail: { ids: ids == null ? null : toIds(ids) } }));
    const list = ids == null ? this.doc.layers.map((l) => l.id) : toIds(ids).filter((id) => this.index(id) >= 0);
    if (!list.length) return false;
    const before = this.doc;
    const next = this._normalize(before, list, "self");
    if (next === before) return false;
    const changed = next.layers.filter((l, i) => l !== before.layers[i]).map((l) => l.id);
    this.doc = next;
    this._emit("change", { reason: "patch", ids: changed, transient: this._gestures.length > 0 });
    return true;
  }

  // ---- internals -------------------------------------------------------------

  _existing(ids) {
    return new Set(toIds(ids).filter((id) => this.index(id) >= 0));
  }

  _order(next, ids, opts = {}) {
    const cur = this.doc.layers;
    if (next.length === cur.length && next.every((l, i) => l === cur[i])) return false;
    return this._apply({ ...this.doc, layers: next }, { reason: "order", ids, label: "Reorder", ...opts });
  }

  // prev: a Map of id -> layer before the change, or "self" when each layer is
  // its own reference (remeasure, undo, load).
  _normalize(doc, ids, prev) {
    if (!this._normalizers.length || !ids?.length) return doc;
    let layers = null;
    const idx = new Map();
    doc.layers.forEach((l, i) => idx.set(l.id, i));
    for (const id of ids) {
      const i = idx.get(id);
      if (i === undefined) continue;
      const layer = (layers || doc.layers)[i];
      const before = prev === "self" ? null : prev?.get(id);
      let cur = layer;
      for (const fn of this._normalizers) {
        let props;
        try {
          props = fn(cur, doc, prev === "self" ? cur : before);
        } catch (err) {
          console.error(err);
          continue;
        }
        if (props && typeof props === "object") cur = mergeLayer(cur, props);
      }
      if (cur !== layer) {
        layers ??= doc.layers.slice();
        layers[i] = cur;
      }
    }
    return layers ? { ...doc, layers } : doc;
  }

  _apply(next, { reason, ids = null, normalize = null, prevMap, label = "Edit", coalesce = null, transient = false, selection = null }) {
    next = this._normalize(next, normalize, prevMap || new Map());
    const gesture = this._gestures[this._gestures.length - 1];
    const recording = !transient && !gesture;
    if (recording) this._record(this.doc, this.selection, String(label || "Edit"), coalesce, ids);
    if (gesture) {
      gesture.touched = true;
      gesture.reason = reason;
      if (ids == null) gesture.allIds = true;
      else for (const id of ids) gesture.ids.add(id);
    }
    const sel = this._prune(selection ? toIds(selection) : this.selection, next);
    this._set(next, sel, { reason, ids: ids ? [...ids] : null, transient: !recording }, recording);
    return true;
  }

  _set(doc, selection, detail, history) {
    this.doc = doc;
    const selChanged = !sameList(selection, this.selection);
    if (selChanged) this.selection = selection;
    this._emit("change", detail);
    if (selChanged) this._emit("selection", { ids: this.selection });
    if (history) this._emitHistory();
  }

  _restore(entry, reason) {
    const doc = this._normalize(entry.doc, entry.doc.layers.map((l) => l.id), "self");
    this._set(doc, this._prune(entry.selection, doc), { reason, ids: null, transient: false }, true);
  }

  // doc is kept by reference (see the header). ids: the layers this change
  // touches (null: the whole doc); a coalescing run continues only while they
  // stay the same.
  _record(doc, selection, label, coalesce, ids = null) {
    const now = this.now();
    const c = this._coalesce;
    const top = this._undo[this._undo.length - 1];
    const sig = coalesce ? idSig(ids) : "";
    if (coalesce && c && c.key === coalesce && c.ids === sig && top && top === c.entry && now - c.at <= COALESCE_MS) {
      c.at = now;
      this._redo.length = 0;
      return false;
    }
    const entry = { doc, selection: [...selection], label };
    this._push(entry);
    this._coalesce = coalesce ? { key: coalesce, ids: sig, at: now, entry } : null;
    return true;
  }

  _push(entry) {
    this._undo.push(entry);
    if (this._undo.length > HISTORY_LIMIT) this._undo.splice(0, this._undo.length - HISTORY_LIMIT);
    this._redo.length = 0;
  }

  _mergeGesture(parent, g) {
    if (!g.touched) return;
    parent.touched = true;
    parent.reason = g.reason || parent.reason;
    parent.allIds = parent.allIds || g.allIds;
    for (const id of g.ids) parent.ids.add(id);
  }

  _finishGestures() {
    while (this._gestures.length) this.commit();
  }

  _prune(selection, doc) {
    const ids = new Set(doc.layers.map((l) => l.id));
    const out = [];
    for (const id of selection) if (ids.has(id) && !out.includes(id)) out.push(id);
    return out;
  }

  _setSelection(sel) {
    const next = this._prune(sel, this.doc);
    if (sameList(next, this.selection)) return false;
    this.selection = next;
    this._emit("selection", { ids: next });
    return true;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _emitHistory() {
    this._emit("history", { canUndo: this.canUndo, canRedo: this.canRedo });
  }
}
