// The little the mod system needs from the interface: the icons its commands
// and Settings use, and Settings' stylesheet. Kept apart from ui/settings.js
// so starting Longitude never loads the Settings dialog; that module and
// css/mods.css are fetched the first time Settings opens (loader.js
// openSettings). The classes mods use in their own sections (.mod-stack,
// .mod-hint) are in inspector.css, which is always loaded.

import { loadStyle } from "../ui/dom.js";
import { hasIcon, registerIcons } from "../ui/icons.js";

// Lucide paths (ISC), registered only when the shell's set lacks them.
export const FALLBACK_ICONS = {
  "sliders-horizontal": '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  puzzle: '<path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.24-.7 1.71l-1.61 1.61a.98.98 0 0 1-.84.28c-.47-.07-.8-.48-.97-.93a2.5 2.5 0 1 0-3.21 3.21c.45.17.86.5.93.97a.98.98 0 0 1-.28.84l-1.61 1.61a2.4 2.4 0 0 1-1.7.7 2.4 2.4 0 0 1-1.71-.7l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57A2.4 2.4 0 0 1 2 12c0-.62.24-1.23.7-1.7l1.53-1.53c.24-.24.58-.35.92-.3.51.08.87.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92L10.3 2.7A2.4 2.4 0 0 1 12 2c.62 0 1.23.24 1.7.7l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.9.53-.97 1.02Z"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "trash-2": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  "external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  "book-open": '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
};

// Loads web/css/mods.css once; resolves when it is in (at once without a browser).
export function ensureModStyles() {
  return loadStyle(new URL("../../css/mods.css", import.meta.url).href);
}

// Adds the icons Settings and the mod commands use when the shell's set lacks them.
export function ensureModIcons() {
  const missing = {};
  for (const [k, v] of Object.entries(FALLBACK_ICONS)) if (!hasIcon(k)) missing[k] = v;
  registerIcons(missing);
}
