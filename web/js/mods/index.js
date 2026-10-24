// Everything the shell needs from the mod system, in one import.

export { loadMods, registerModCommands, validateEntry, validateIndex, validateManifest, MOD_ID_RE } from "./loader.js";
export { buildModApi, createScope, scopeOf, API_VERSION } from "./api.js";
export { createPacks, importPack, parsePack, readPack } from "./packs.js";
// Opens Settings, loading its module the first time (resolves to { close }).
export { openSettings, loadSettings } from "./loader.js";
