// Tests for the "Get the desktop app" card rules in web/js/ui/home.js
//   deno test --allow-read tests/shell-desktopcard.test.js

import assert from "node:assert/strict";
import { showDesktopCard, deskCardSnooze, DESK_SNOOZE_MS, DESKTOP_DOWNLOAD } from "../web/js/ui/home.js";

const base = { desktop: false, platform: "Windows", designs: 1, pref: null, now: 1_000 };

Deno.test("desktop card: shows on Windows for someone with a design", () => {
  assert.equal(showDesktopCard(base), true);
  assert.equal(showDesktopCard({ ...base, platform: "Win32" }), true);
});

Deno.test("desktop card: never in the desktop app, off Windows, or before a first design", () => {
  assert.equal(showDesktopCard({ ...base, desktop: true }), false);
  assert.equal(showDesktopCard({ ...base, platform: "macOS" }), false);
  assert.equal(showDesktopCard({ ...base, platform: "Linux x86_64" }), false);
  assert.equal(showDesktopCard({ ...base, platform: "" }), false);
  assert.equal(showDesktopCard({ ...base, designs: 0 }), false);
});

Deno.test("desktop card: Not now hides it for 30 days, the second time for good", () => {
  const first = deskCardSnooze(null, 1_000);
  assert.deepEqual(first, { until: 1_000 + DESK_SNOOZE_MS, count: 1, never: false });
  assert.equal(showDesktopCard({ ...base, pref: first, now: 2_000 }), false);
  assert.equal(showDesktopCard({ ...base, pref: first, now: 1_000 + DESK_SNOOZE_MS + 1 }), true);
  const second = deskCardSnooze(first, 5_000);
  assert.equal(second.never, true);
  assert.equal(showDesktopCard({ ...base, pref: second, now: 9e15 }), false);
  assert.equal(showDesktopCard({ ...base, pref: { never: true } }), false);
});

Deno.test("desktop card: downloads the newest installer", () => {
  assert.equal(DESKTOP_DOWNLOAD, "https://github.com/zphat/Longitude/releases/latest/download/Longitude-Setup.exe");
});
