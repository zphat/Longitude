// Start-up weight and offline use: what main.js loads at boot, that web/sw.js
// precaches every file the app can load (at boot and later: dynamic import(),
// a worker, a stylesheet, the interface fonts) so a fresh cache after a
// VERSION bump starts offline, and that ondemand.js pins every module loaded
// later to the page's own version.
// Run: deno test --allow-read tests/shell-boot.test.js
import assert from "node:assert/strict";
import { ON_DEMAND as PINNED, pinOnDemand } from "../web/js/ui/ondemand.js";

const WEB = new URL("../web/", import.meta.url);
const rel = (url) => url.href.slice(WEB.href.length);

// Comment lines and block comments never count as references.
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const STATIC = /^[ \t]*(?:import|export)\b(?:[^;"'`()]*?\bfrom)?\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const ASSET = /new URL\(\s*["']([^"']+\.(?:js|css))["']\s*,\s*import\.meta\.url\s*\)/g;

// Files reachable from main.js: static imports only, or also the ones loaded later.
async function graph({ lazy }) {
  const seen = new Set();
  const walk = async (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    if (!url.pathname.endsWith(".js")) return;
    const text = code(await Deno.readTextFile(url));
    const specs = [...text.matchAll(STATIC)].map((m) => m[1]);
    if (lazy) for (const re of [DYNAMIC, ASSET]) specs.push(...[...text.matchAll(re)].map((m) => m[1]));
    for (const spec of specs) if (spec.startsWith(".")) await walk(new URL(spec, url));
  };
  await walk(new URL("js/main.js", WEB));
  return new Set([...seen].map((href) => rel(new URL(href))));
}

const ON_DEMAND = [
  "js/ui/exportdialog.js",
  "js/ui/quicktools.js",
  "js/ui/feedpreview.js",
  "js/ui/settings.js",
  "js/features/compress.js",
  "js/features/png8.js",
  "js/features/zip.js",
  "js/features/bgremove/mask.js",
  "js/features/bgremove/engine.js",
  "js/features/bgremove/runner.js",
  "js/features/bgremove/worker.js",
  "css/export.css",
  "css/mods.css",
];

Deno.test("boot loads none of the on-demand modules", async () => {
  const boot = await graph({ lazy: false });
  for (const f of ON_DEMAND) assert.ok(!boot.has(f), `${f} is imported statically from main.js`);
  assert.ok(boot.has("js/ui/ondemand.js"), "the on-demand commands are registered at start");
});

Deno.test("index.html links only the stylesheets the first screen needs", async () => {
  const html = await Deno.readTextFile(new URL("index.html", WEB));
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 5, "the base stylesheets are linked");
  for (const href of links) await Deno.stat(new URL(href, WEB));
  for (const f of ["css/export.css", "css/mods.css"]) assert.ok(!links.includes(f), `${f} loads with its dialog`);
});

async function precacheList() {
  const sw = await Deno.readTextFile(new URL("sw.js", WEB));
  const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(block, "sw.js has a PRECACHE list");
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

Deno.test("sw.js precaches every file loaded after boot", async () => {
  const precache = await precacheList();
  for (const f of precache) if (f !== "./") await Deno.stat(new URL(f, WEB)); // no stale names
  const boot = await graph({ lazy: false });
  const all = await graph({ lazy: true });
  const later = [...all].filter((f) => !boot.has(f));
  assert.ok(later.length >= ON_DEMAND.length, `found the on-demand files (${later.join(", ")})`);
  for (const f of later) assert.ok(precache.has(f), `${f} loads on demand but is not in sw.js PRECACHE`);
  for (const f of ON_DEMAND) assert.ok(later.includes(f), `${f} is reachable from main.js`);
});

// A VERSION bump starts an empty cache: without the boot files in it, an
// offline start after the update would stop at "Longitude could not start".
Deno.test("sw.js precaches the whole boot: modules, stylesheets and interface fonts", async () => {
  const precache = await precacheList();
  for (const f of await graph({ lazy: true })) assert.ok(precache.has(f), `${f} is not in sw.js PRECACHE`);
  const html = await Deno.readTextFile(new URL("index.html", WEB));
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of links) assert.ok(precache.has(href), `${href} (linked by index.html) is not in sw.js PRECACHE`);
  const tokens = await Deno.readTextFile(new URL("css/tokens.css", WEB));
  const fonts = [...tokens.matchAll(/url\(\s*["']?\.\.\/(fonts\/ui\/[^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 4, `tokens.css names the interface fonts (${fonts.join(", ")})`);
  for (const f of fonts) assert.ok(precache.has(f), `${f} (tokens.css) is not in sw.js PRECACHE`);
  for (const f of ["./", "index.html", "manifest.webmanifest"]) assert.ok(precache.has(f), `${f} is precached`);
});

// The worker gets its own module map, so it is the one later file not pinned.
Deno.test("ondemand.js pins every module loaded after boot", async () => {
  const boot = await graph({ lazy: false });
  const later = [...(await graph({ lazy: true }))].filter((f) => !boot.has(f) && f.endsWith(".js") && f !== "js/features/bgremove/worker.js");
  const pinned = PINNED.map((href) => rel(new URL(href)));
  assert.deepEqual([...pinned].sort(), [...later].sort());
  const head = [];
  const doc = { head: { append: (el) => head.push(el) }, createElement: (tag) => ({ tag }) };
  assert.equal(pinOnDemand(doc), true);
  assert.equal(head.length, PINNED.length);
  assert.ok(head.every((l) => l.tag === "link" && l.rel === "modulepreload" && PINNED.includes(l.href)), "one modulepreload link per module");
  assert.equal(pinOnDemand(doc), false, "runs once");
  assert.equal(head.length, PINNED.length);
});
