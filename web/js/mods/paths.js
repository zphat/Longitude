// Paths inside web/mods/. Mods and packs may only point at files in that
// folder: no protocols, no absolute paths, no "..", nothing a typed URL could
// sneak in. Pure helpers, shared by the loader and the pack importer.

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// Returns the cleaned relative path or throws an Error with a plain message.
// what: how the message names the value ("entry", "font file").
export function cleanModPath(path, { exts = [".js", ".mjs"], what = "entry" } = {}) {
  if (typeof path !== "string" || !path.trim()) throw Error(`The ${what} must be a path inside web/mods.`);
  const p = path.trim();
  if (p.length > 200) throw Error(`The ${what} path is too long.`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.includes(":")) throw Error(`The ${what} must be a relative path inside web/mods, not a URL.`);
  if (p.startsWith("/") || p.includes("\\")) throw Error(`The ${what} must be a relative path inside web/mods, like "my-mod/index.js".`);
  if (/[?#]/.test(p)) throw Error(`The ${what} path cannot contain ? or #.`);
  const parts = p.split("/");
  for (const part of parts) {
    if (part === "." || part === ".." || !SEGMENT_RE.test(part)) {
      throw Error(`The ${what} path "${p}" may only use letters, digits, dots, dashes and underscores, without "..".`);
    }
  }
  const lower = p.toLowerCase();
  if (exts.length && !exts.some((e) => lower.endsWith(e))) throw Error(`The ${what} must end in ${exts.join(" or ")}.`);
  return parts.join("/");
}

// Resolves a cleaned path against the mods folder URL and checks the result
// stays inside it. base must end with "/".
export function resolveInside(path, base) {
  const root = new URL(base);
  const url = new URL(path, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash) {
    throw Error(`"${path}" is outside the mods folder.`);
  }
  return url.href;
}

// The mods folder for the current page: <page>/mods/.
export function defaultModsBase() {
  const page = globalThis.document?.baseURI || globalThis.location?.href || "http://localhost/";
  return new URL("mods/", page).href;
}
