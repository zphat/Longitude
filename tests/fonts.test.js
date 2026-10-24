// Tests for web/js/core/fonts.js and web/fonts/fonts.json.
//   deno test --allow-read tests/fonts.test.js

import {
  CATEGORIES,
  FontRegistry,
  guessFromFileName,
  matchWeight,
  parseFontFile,
  quoteFamily,
} from "../web/js/core/fonts.js";

const WEB = new URL("../web/", import.meta.url);
const FONTS = new URL("fonts/", WEB);

function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg = "") {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb}, got ${sa}`);
}
async function rejects(fn, re) {
  try {
    await fn();
  } catch (err) {
    if (re && !re.test(err.message)) throw new Error(`wrong error: ${err.message}`);
    return;
  }
  throw new Error("expected a rejection");
}

const readBuffer = async (rel) => (await Deno.readFile(new URL(rel, FONTS))).buffer;

// ---- fakes ---------------------------------------------------------------

function fakeEnv({ installed = [], failUrls = [], slowUrls = [], timeout } = {}) {
  const made = [];
  class FakeFontFace {
    constructor(family, source, desc) {
      this.family = family;
      this.source = source;
      this.weight = desc.weight;
      this.style = desc.style;
      this.display = desc.display;
      made.push(this);
    }
    load() {
      const src = typeof this.source === "string" ? this.source : "";
      if (failUrls.some((u) => src.includes(u))) return Promise.reject(new Error("bad font"));
      if (slowUrls.some((u) => src.includes(u))) return new Promise(() => {});
      return new Promise((resolve) => setTimeout(() => resolve(this), 2));
    }
  }
  const fontSet = {
    faces: new Set(),
    add(f) {
      this.faces.add(f);
    },
    delete(f) {
      this.faces.delete(f);
    },
  };
  const have = new Set(installed.map((n) => n.toLowerCase()));
  const measure = (font) => {
    const m = /"([^"]+)"/.exec(font);
    return m && have.has(m[1].toLowerCase()) ? 120 : 100;
  };
  const records = new Map();
  const storage = {
    records,
    getAll: async () => [...records.values()].map((r) => structuredClone(r)),
    put: async (r) => void records.set(r.family, r),
    delete: async (k) => void records.delete(k),
  };
  return {
    made,
    fontSet,
    storage,
    env: { FontFace: FakeFontFace, fontSet, measure, storage, fetch, baseURL: WEB.href, timeout },
  };
}

async function registry(opts) {
  const fake = fakeEnv(opts);
  const reg = new FontRegistry({ env: fake.env });
  await reg.init("fonts/fonts.json");
  return { reg, ...fake };
}

// ---- pure helpers -------------------------------------------------------------

Deno.test("quoteFamily quotes names and leaves generics bare", () => {
  eq(quoteFamily("Anton"), '"Anton"');
  eq(quoteFamily("Arial Black"), '"Arial Black"');
  eq(quoteFamily("Sans-Serif"), "sans-serif");
  eq(quoteFamily('My "Odd" \\ Font'), '"My \\"Odd\\" \\\\ Font"');
});

Deno.test("matchWeight follows CSS font matching", () => {
  eq(matchWeight([800, 900], 400), 0, "400 with only heavy faces");
  eq(matchWeight([300, 700], 400), 0, "400 prefers lighter before heavier than 500");
  eq(matchWeight([300, 500, 700], 400), 1, "400 takes 500 first");
  eq(matchWeight([100, 300, 700], 600), 2, "600 goes heavier");
  eq(matchWeight([100, 300], 600), 1, "600 falls back to the heaviest lighter");
  eq(matchWeight([200, 600], 350), 0, "350 goes lighter");
  eq(matchWeight([[100, 900]], 950), 0);
  eq(matchWeight([[300, 900], 200], 250), 1);
  eq(matchWeight([], 400), -1);
});

Deno.test("guessFromFileName reads family, weight, style and variable hints", () => {
  eq(guessFromFileName("OpenSans-BoldItalic.woff2"), { family: "Open Sans", weight: 700, style: "italic", variable: null });
  eq(guessFromFileName("C:\\fonts\\Delight-Regular.woff2").family, "Delight");
  eq(guessFromFileName("MyFont.woff2"), { family: "My Font", weight: 400, style: "normal", variable: null });
  const v = guessFromFileName("Inter[opsz,wght].woff2");
  eq(v.family, "Inter");
  eq(v.variable, { min: 100, max: 900 });
  eq(guessFromFileName("cool_font_extra-light.ttf").weight, 200);
  eq(guessFromFileName("Thing Black.otf").weight, 900);
});

// ---- parsing font files ----------------------------------------------------------

async function toWoff(ttf) {
  const v = new DataView(ttf);
  const n = v.getUint16(4);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const raw = new Uint8Array(ttf, v.getUint32(at + 8), v.getUint32(at + 12));
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
    const comp = new Uint8Array(await new Response(stream).arrayBuffer());
    tables.push({ tag: v.getUint32(at), sum: v.getUint32(at + 4), len: raw.length, data: comp.length < raw.length ? comp : raw });
  }
  let size = 44 + n * 20;
  const offsets = tables.map((t) => {
    const o = size;
    size += (t.data.length + 3) & ~3;
    return o;
  });
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x774f4646);
  o.setUint32(4, v.getUint32(0));
  o.setUint32(8, size);
  o.setUint16(12, n);
  tables.forEach((t, i) => {
    const at = 44 + i * 20;
    o.setUint32(at, t.tag);
    o.setUint32(at + 4, offsets[i]);
    o.setUint32(at + 8, t.data.length);
    o.setUint32(at + 12, t.len);
    o.setUint32(at + 16, t.sum);
    out.set(t.data, offsets[i]);
  });
  return out.buffer;
}

Deno.test("parseFontFile reads the name, OS/2 and head tables of a TTF", async () => {
  const meta = await parseFontFile(await readBuffer("creepster/Creepster-Regular.ttf"), "whatever.ttf");
  eq([meta.family, meta.weight, meta.style, meta.format, meta.mime, meta.variable], ["Creepster", 400, "normal", "ttf", "font/ttf", null]);
  const russo = await parseFontFile(await readBuffer("russoone/RussoOne-Regular.ttf"), "x.ttf");
  eq(russo.family, "Russo One");
});

Deno.test("parseFontFile inflates WOFF tables", async () => {
  const woff = await toWoff(await readBuffer("righteous/Righteous-Regular.ttf"));
  const meta = await parseFontFile(woff, "renamed.woff");
  eq([meta.family, meta.weight, meta.style, meta.format], ["Righteous", 400, "normal", "woff"]);
});

Deno.test("parseFontFile falls back to the file name for WOFF2", async () => {
  const meta = await parseFontFile(await readBuffer("montserrat/Montserrat-Italic-Variable.woff2"), "Montserrat-Italic-Variable.woff2");
  eq([meta.family, meta.style, meta.format, meta.mime], ["Montserrat", "italic", "woff2", "font/woff2"]);
  eq(meta.variable, { min: 100, max: 900 });
});

Deno.test("parseFontFile rejects things that are not fonts", async () => {
  await rejects(() => parseFontFile(new TextEncoder().encode("hello, this is text").buffer, "a.ttf"), /not a font/);
  const ttc = new Uint8Array(32);
  ttc.set([0x74, 0x74, 0x63, 0x66]);
  await rejects(() => parseFontFile(ttc.buffer, "a.ttc"), /collections/);
  await rejects(() => parseFontFile(new ArrayBuffer(4), "a.ttf"), /not a font/);
});

// ---- fonts.json -------------------------------------------------------------------

Deno.test("fonts.json is complete and points at real files", async () => {
  const data = JSON.parse(await Deno.readTextFile(new URL("fonts.json", FONTS)));
  eq(data.v, 1);
  const seen = new Set();
  let lastCat = 0;
  let bytes = 0;
  for (const f of data.families) {
    const where = `fonts.json ${f.family}:`;
    for (const k of ["family", "label", "category", "faces", "fallback", "license", "credit", "tags", "sample"]) assert(k in f, `${where} missing ${k}`);
    assert("variable" in f, `${where} missing variable`);
    assert(!seen.has(f.family.toLowerCase()), `${where} listed twice`);
    seen.add(f.family.toLowerCase());
    const cat = CATEGORIES.indexOf(f.category);
    assert(cat >= 0, `${where} unknown category`);
    assert(cat >= lastCat, `${where} out of picker order`);
    lastCat = cat;
    assert(f.sample === f.sample.toUpperCase() && f.sample.length <= 16, `${where} sample should be short caps`);
    assert(f.tags.length >= 3, `${where} needs tags`);
    assert(f.faces.length > 0, `${where} needs faces`);
    if (f.variable) assert(f.variable.min < f.variable.max, `${where} bad variable range`);
    const system = f.source === "system";
    for (const face of f.faces) {
      assert([100, 200, 300, 400, 500, 600, 700, 800, 900].includes(face.weight), `${where} odd weight`);
      assert(face.style === "normal" || face.style === "italic", `${where} odd style`);
      if (system) {
        assert(!face.file, `${where} system fonts have no files`);
        continue;
      }
      const st = await Deno.stat(new URL(face.file, FONTS));
      bytes += st.size;
    }
    if (!system) {
      assert(/^(OFL-1\.1|Apache-2\.0)$/.test(f.license), `${where} license must be OFL-1.1 or Apache-2.0`);
      const slug = f.category === "original" ? f.family.toLowerCase().replace(/ /g, "-") : f.family.toLowerCase().replace(/[^a-z0-9]/g, "");
      await Deno.stat(new URL(`LICENSES/${slug}.txt`, FONTS));
    }
  }
  for (const c of ["original", "classic", "meme", "display", "clean"]) {
    assert(data.families.some((f) => f.category === c), `no ${c} fonts`);
  }
  assert(bytes < 4 * 1024 * 1024, `design fonts are ${bytes} bytes, over the 4 MB budget`);
});

// ---- the registry ---------------------------------------------------------------

Deno.test("init lists families in picker order and hides missing system fonts", async () => {
  const { reg } = await registry({ installed: ["Impact"] });
  const list = reg.list();
  const cats = list.map((f) => CATEGORIES.indexOf(f.category));
  eq(cats, [...cats].sort((a, b) => a - b), "category order");
  eq(list[0].family, "Longitude Meridian");
  assert(list.some((f) => f.family === "Impact" && f.source === "system"), "Impact shown when installed");
  assert(!list.some((f) => f.family === "Arial Black"), "Arial Black hidden when missing");
  eq(reg.get("arial black").available, false);
  const mont = reg.get("Montserrat");
  eq([mont.source, mont.italic, mont.variable, mont.defaultWeight], ["bundled", true, { min: 100, max: 900 }, 900]);
  eq(mont.weights, [100, 200, 300, 400, 500, 600, 700, 800, 900]);
  eq(reg.get("Oswald").weights, [200, 300, 400, 500, 600, 700]);
  eq(reg.get("Poppins").weights, [800, 900]);
  eq(reg.get("Anton").weights, [400]);
  eq(reg.get("nope"), null);
});

Deno.test("stack quotes the family and its fallbacks", async () => {
  const { reg } = await registry();
  eq(reg.stack("Anton"), '"Anton", "Impact", "Haettenschweiler", sans-serif');
  eq(reg.stack("Impact"), '"Impact", "Anton", "Haettenschweiler", sans-serif');
  eq(reg.stack("Comic Neue"), '"Comic Neue", "Comic Sans MS", cursive');
  eq(reg.stack("Unknown Font"), '"Unknown Font", sans-serif');
});

Deno.test("nearestWeight clamps variable fonts and snaps static ones", async () => {
  const { reg } = await registry();
  eq(reg.nearestWeight("Oswald", 900), 700);
  eq(reg.nearestWeight("Oswald", 450), 450);
  eq(reg.nearestWeight("Poppins", 400), 800);
  eq(reg.nearestWeight("Poppins", 950), 900);
  eq(reg.nearestWeight("Anton", 900), 400);
  eq(reg.nearestWeight("Comic Neue", 400), 700);
  eq(reg.nearestWeight("Unknown", 640), 640);
});

Deno.test("load creates one FontFace per face, deduped, with the right descriptors", async () => {
  const { reg, made, fontSet } = await registry();
  const events = [];
  reg.addEventListener("load", (e) => events.push(e.detail));
  const [a, b] = await Promise.all([reg.load("Anton"), reg.load("anton", 700)]);
  assert(a && b, "Anton loads");
  eq(made.length, 1, "one FontFace for Anton");
  eq(made[0].weight, "1 1000", "a lone static face claims every weight");
  assert(made[0].source.includes("anton/Anton-Regular.woff2"), "source url");
  eq(events, [{ family: "Anton", weight: 400, style: "normal" }]);
  assert(reg.loaded("Anton", 900), "loaded() for any weight");
  assert(fontSet.faces.has(made[0]), "added to the font set");

  await reg.load("Montserrat", 900, "italic");
  const mi = made.at(-1);
  eq([mi.weight, mi.style], ["100 900", "italic"]);
  assert(!reg.loaded("Montserrat", 400, "normal"), "the upright face is separate");

  await reg.load("Poppins", 900);
  eq(made.at(-1).weight, "900", "families with several static faces use exact weights");
  await reg.load("Poppins", 400, "italic");
  eq(made.at(-1).weight, "1 1000", "the only italic face claims every weight");
});

Deno.test("system fonts: installed ones load at once, missing Impact loads Anton", async () => {
  const { reg, made } = await registry({ installed: ["Arial Black"] });
  eq(await reg.load("Arial Black", 900), true);
  eq(made.length, 0);
  eq(await reg.load("Impact"), true, "drawable through the fallback");
  eq(made.length, 1);
  eq(made[0].family, "Anton");
  eq(reg.loaded("Impact"), false);
});

Deno.test("load returns false for a broken face and retries later", async () => {
  const { reg, made } = await registry({ failUrls: ["bangers/"] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    eq(await reg.load("Bangers"), false);
    eq(await reg.load("Bangers"), false);
  } finally {
    console.warn = warn;
  }
  eq(made.filter((f) => f.family === "Bangers").length, 2, "a failed face can be retried");
});

Deno.test("usedIn and ensureDoc cover every text layer, with a timeout per face", async () => {
  const { reg, made } = await registry({ slowUrls: ["bungee/"], timeout: 60 });
  const doc = {
    layers: [
      { type: "text", font: "Anton", weight: 400 },
      { type: "image" },
      { type: "text", font: "Montserrat", weight: 900, italic: true },
      { type: "text", font: "anton", weight: 700 },
      { type: "text", font: "Bungee" },
      { type: "text", font: "Not A Real Font" },
    ],
  };
  eq(reg.usedIn(doc), ["Anton", "Montserrat", "Bungee", "Not A Real Font"]);
  const t0 = Date.now();
  const missing = await reg.ensureDoc(doc);
  assert(Date.now() - t0 < 1000, "the slow face did not block");
  eq(missing.sort(), ["Bungee", "Not A Real Font"]);
  eq(made.filter((f) => f.family === "Anton").length, 1);
  assert(made.some((f) => f.family === "Montserrat" && f.style === "italic"));
  eq(await reg.ensureDoc({ layers: [] }), []);
});

Deno.test("search matches labels, categories and tags", async () => {
  const { reg } = await registry();
  assert(reg.search("pixel").some((f) => f.family === "Press Start 2P"));
  assert(reg.search("pixel").some((f) => f.family === "Longitude Gridline"));
  assert(reg.search("horror").some((f) => f.family === "Creepster"));
  eq(reg.search("classics condensed").map((f) => f.family).sort(), ["Anton", "Bebas Neue", "Oswald"]);
  eq(reg.search("").length, reg.list().length);
});

Deno.test("addCustom stores the font, survives a restart and can be removed", async () => {
  const { reg, storage, made } = await registry();
  const changes = [];
  reg.addEventListener("change", (e) => changes.push(e.detail.reason));
  const bytes = await Deno.readFile(new URL("righteous/Righteous-Regular.ttf", FONTS));
  const fam = await reg.addCustom(new File([bytes], "MyUpload.ttf"));
  eq(fam, "Righteous (yours)", "a bundled name gets a suffix");
  eq(reg.get(fam).category, "custom");
  eq(reg.get(fam).source, "custom");
  eq(changes, ["custom"]);
  eq(await reg.addCustom(new File([bytes], "again.ttf")), fam, "adding the same font again replaces it");
  eq(reg.list().filter((f) => f.source === "custom").length, 1);
  eq(reg.get(fam).weights, [400]);
  assert(made.some((f) => f.family === fam && f.source instanceof ArrayBuffer), "loaded from the bytes");
  const rec = storage.records.get(fam);
  eq([rec.family, rec.weight, rec.style, rec.name], [fam, 400, "normal", "again.ttf"]);
  assert(rec.blob instanceof Blob && rec.blob.type === "font/ttf");

  // second face of the same family goes into faces[]
  const fam2 = await reg.addCustom(new File([bytes], "x.ttf"), { family: fam, weight: 700 });
  eq(fam2, fam);
  eq(storage.records.get(fam).faces.length, 1);
  eq(reg.get(fam).weights, [400, 700]);

  const fresh = new FontRegistry({ env: { ...fakeEnv().env, storage } });
  await fresh.init("fonts/fonts.json");
  eq(fresh.get(fam).weights, [400, 700], "restored from storage");
  assert(fresh.list().at(-1).family === fam, "custom fonts list last");

  eq(await reg.removeCustom(fam), true);
  eq(reg.get(fam), null);
  assert(!storage.records.has(fam));
  eq(await reg.removeCustom("Anton"), false, "bundled fonts cannot be removed");
});

Deno.test("addCustom rejects files that are not fonts", async () => {
  const { reg } = await registry();
  await rejects(() => reg.addCustom(new File(["just text, really"], "notes.ttf")), /not a font/);
  await rejects(() => reg.addCustom(null), /font file/);
});

Deno.test("exportFonts and importFonts carry custom fonts in a project", async () => {
  const a = await registry();
  const bytes = await Deno.readFile(new URL("creepster/Creepster-Regular.ttf", FONTS));
  const fam = await a.reg.addCustom(new File([bytes], "Spooky.ttf"), { family: "Spooky Sans" });
  const doc = { layers: [{ type: "text", font: "Spooky Sans" }, { type: "text", font: "Anton" }] };
  const list = await a.reg.exportFonts(doc);
  eq(list.length, 1);
  eq([list[0].family, list[0].weight, list[0].style], [fam, 400, "normal"]);
  assert(list[0].dataURL.startsWith("data:font/ttf;base64,"));
  eq(await a.reg.exportFonts({ layers: [{ type: "text", font: "Anton" }] }), []);

  const b = await registry();
  eq(await b.reg.importFonts(list), ["Spooky Sans"]);
  eq(b.reg.get("Spooky Sans").source, "custom");
  const blob = b.reg.getCustom("Spooky Sans").faces[0].blob;
  eq(blob.size, bytes.length, "bytes survive the round trip");
  eq(await b.reg.importFonts([{ family: "Anton", dataURL: list[0].dataURL }]), ["Anton"], "an installed family is kept");
  eq(b.reg.get("Anton").source, "bundled");
});

Deno.test("register adds a mod font and dispose removes it", async () => {
  const { reg, made, fontSet } = await registry({ installed: ["Georgia"] });
  const dispose = reg.register({
    family: "Mod Face", label: "Mod face", category: "display", tags: ["test"],
    faces: [{ url: "mods/demo/ModFace.woff2", weight: 700 }],
  });
  const info = reg.get("Mod Face");
  eq([info.source, info.category, info.weights], ["mod", "display", [700]]);
  await reg.load("Mod Face");
  assert(made.at(-1).source.includes("/web/mods/demo/ModFace.woff2"), "relative urls resolve against the page");
  await rejects(async () => reg.register({ family: "Mod Face", faces: [{ url: "x.woff2" }] }), /already registered/);
  await rejects(async () => reg.register({ family: "No faces", faces: [] }), /at least one face/);
  dispose();
  eq(reg.get("Mod Face"), null);
  eq(fontSet.faces.size, 0, "its FontFace is removed");
  dispose();

  const sys = reg.register({ family: "Georgia", category: "system", faces: [{ weight: 400 }] });
  eq(reg.get("Georgia").source, "system");
  assert(reg.list().some((f) => f.family === "Georgia"), "installed system font is listed");
  sys();
});

Deno.test("stack follows families that are added and removed", async () => {
  const { reg } = await registry();
  eq(reg.stack("Shiny Mod Font"), '"Shiny Mod Font", sans-serif');
  const off = reg.register({ family: "Shiny Mod Font", fallback: "Georgia, serif", faces: [{ url: "data:font/woff2;base64,AAAA", weight: 400 }] });
  eq(reg.stack("Shiny Mod Font"), '"Shiny Mod Font", "Georgia", serif');
  eq(reg.stack("Shiny Mod Font"), '"Shiny Mod Font", "Georgia", serif', "cached answer is the same");
  off();
  eq(reg.stack("Shiny Mod Font"), '"Shiny Mod Font", sans-serif');
});
