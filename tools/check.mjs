// Static check for Longitude's browser modules, run with Deno:
//   deno run --allow-read tools/check.mjs [paths...]
// Imports every module under web/js and web/mods. Syntax errors, missing files
// and missing named exports fail at link time and are reported. Runtime errors
// from browser-only globals (document, window, canvas) are expected under Deno
// and ignored.

const root = new URL("../web/", import.meta.url);
const args = Deno.args.length ? Deno.args : ["js", "mods"];

async function* walk(dir) {
  for await (const e of Deno.readDir(dir)) {
    const p = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(p);
    else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) yield p;
  }
}

const BROWSER_ONLY = /\b(document|window|navigator|localStorage|indexedDB|OffscreenCanvas|HTMLCanvasElement|Image|FontFace|createImageBitmap|requestAnimationFrame|matchMedia|caches|self|DOMMatrix|Path2D|ImageData|CSS|getComputedStyle|devicePixelRatio|location|history)\b/;

let bad = 0;
let ok = 0;
for (const a of args) {
  const start = new URL(a.endsWith(".js") || a.endsWith(".mjs") ? a : a.replace(/\/?$/, "/"), root);
  let files = [];
  try {
    const st = await Deno.stat(start);
    if (st.isFile) files = [start];
    else for await (const f of walk(start)) files.push(f);
  } catch {
    console.log(`skip ${a} (not found)`);
    continue;
  }
  for (const f of files.sort((x, y) => x.href.localeCompare(y.href))) {
    const rel = f.href.slice(root.href.length);
    if (rel === "sw.js") continue;
    try {
      await import(f.href);
      ok++;
    } catch (err) {
      const msg = String(err?.message || err);
      // Deno can report a syntax error in a nested import as "TypeError: SyntaxError: ...".
      const linkError = err instanceof SyntaxError || /SyntaxError|Expression expected|does not provide an export|Module not found|Cannot resolve|Unable to load|not a valid|Unexpected/.test(msg);
      if (!linkError && (err instanceof ReferenceError || err instanceof TypeError) && BROWSER_ONLY.test(msg)) {
        ok++;
        continue;
      }
      if (!linkError && !(err instanceof SyntaxError)) {
        console.log(`warn ${rel}: ${err?.name}: ${msg.split("\n")[0]}`);
        ok++;
        continue;
      }
      bad++;
      console.log(`FAIL ${rel}: ${err?.name}: ${msg.split("\n")[0]}`);
    }
  }
}
console.log(`\n${ok} ok, ${bad} failed`);
if (bad) Deno.exit(1);
