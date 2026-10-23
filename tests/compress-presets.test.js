// Run: deno test --allow-read tests/compress-presets.test.js
import { assert, assertEquals } from "./compress-assert.js";
import { aspectLabel, createPresets, GUIDE_KINDS, loadPresets, normalizePreset } from "../web/js/features/presets.js";

const jsonUrl = new URL("../web/presets/presets.json", import.meta.url).href;

function throwsMessage(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  return null;
}

Deno.test("presets.json loads with no invalid entries", async () => {
  const events = [];
  const ctx = { emit: (type, detail) => events.push([type, detail]) };
  const presets = await loadPresets(ctx, jsonUrl);
  assertEquals(presets.errors, []);
  const raw = JSON.parse(await Deno.readTextFile(new URL("../web/presets/presets.json", import.meta.url)));
  assertEquals(presets.list().length, raw.presets.length);
  // The required set from the brief.
  for (const id of ["yt-thumb", "yt-shorts", "yt-banner", "yt-avatar", "yt-post", "sp-podcast", "sp-video-thumb", "sp-playlist", "sp-header", "sp-avatar", "square", "story", "wide", "custom"]) {
    assert(presets.get(id), `has ${id}`);
  }
  const off = presets.register({ id: "mod.test", group: "YouTube", label: "Test", width: 100, height: 100 });
  assertEquals(events.at(-1)?.[0], "presets", "emits presets on change");
  off();
});

Deno.test("YouTube thumbnail comes first with the 2 MB export and its guides", async () => {
  const presets = await loadPresets(null, jsonUrl);
  const first = presets.list()[0];
  assertEquals(first.id, "yt-thumb");
  assertEquals([first.width, first.height], [1280, 720]);
  assertEquals(first.export.type, "image/jpeg");
  assertEquals(first.export.maxBytes, 2000000);
  assertEquals(first.guides.map((g) => g.kind), ["badge", "bar"]);
  const badge = first.guides[0];
  assert(badge.x > 0.8 && badge.x + badge.w <= 1 && badge.y + badge.h <= 1, "badge sits bottom right");
});

Deno.test("guides match the platform layouts", async () => {
  const presets = await loadPresets(null, jsonUrl);
  const shorts = presets.get("yt-shorts");
  const zones = shorts.guides.filter((g) => g.kind === "zone");
  assert(zones.length >= 2);
  for (const z of zones) assertEquals(z.label, "Covered by YouTube UI");
  assert(zones.some((z) => z.y + z.h >= 0.999 && z.w === 1), "bottom title area");
  assert(zones.some((z) => z.x + z.w >= 0.999 && z.x > 0.7), "right action buttons");

  const banner = presets.get("yt-banner");
  const safes = banner.guides.filter((g) => g.kind === "safe");
  assertEquals(safes.length, 3);
  for (let i = 1; i < safes.length; i++) {
    const outer = safes[i - 1];
    const inner = safes[i];
    assert(inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w + 1e-9 && inner.y + inner.h <= outer.y + outer.h + 1e-9, "safe areas nest");
  }
  const all = safes[2];
  assert(Math.abs(all.w * 2560 - 1546) < 5 && Math.abs(all.h * 1440 - 423) < 3, "all-devices area is about 1546 x 423");
  assert(Math.abs(all.x + all.w / 2 - 0.5) < 1e-3 && Math.abs(all.y + all.h / 2 - 0.5) < 1e-3, "centred");

  for (const id of ["yt-avatar", "sp-avatar"]) {
    const c = presets.get(id).guides.find((g) => g.kind === "circle");
    assert(c && c.r === 0.5 && c.cx === 0.5 && c.cy === 0.5, `${id} has a full circle`);
  }
});

Deno.test("every bundled preset is documented", async () => {
  const presets = await loadPresets(null, jsonUrl);
  for (const p of presets.list()) {
    assert(p.note.length > 0, `${p.id} has a note`);
    assert(!/!/.test(p.note), `${p.id} note has no exclamation mark`);
    for (const g of p.guides) assert(GUIDE_KINDS.includes(g.kind));
    if (p.group === "YouTube" || p.group === "Spotify") {
      assert(p.sources.length > 0, `${p.id} cites a source`);
      for (const s of p.sources) {
        assert(/^https:\/\//.test(s.url), `${p.id} source url`);
        assertEquals(s.checked, "2026-10-23", `${p.id} source date`);
      }
    }
  }
});

Deno.test("groups come in the fixed order with unknown groups before Custom", () => {
  const presets = createPresets([
    { id: "c", group: "Custom", label: "C", width: 100, height: 100, custom: true },
    { id: "x", group: "Twitch", label: "X", width: 100, height: 100 },
    { id: "s", group: "Social", label: "S", width: 100, height: 100 },
    { id: "sp", group: "Spotify", label: "Sp", width: 100, height: 100 },
    { id: "y", group: "YouTube", label: "Y", width: 100, height: 100 },
    { id: "n", label: "No group", width: 100, height: 100 },
  ]);
  assertEquals(presets.groups().map((g) => g.id), ["YouTube", "Spotify", "Social", "Twitch", "Other", "Custom"]);
  assertEquals(presets.list().map((p) => p.id), ["y", "sp", "s", "x", "n", "c"]);
  assertEquals(presets.find(100, 100).id, "y", "find skips custom and follows list order");
  assertEquals(presets.find(5, 5), null);
});

Deno.test("register validates and returns a dispose function", () => {
  const presets = createPresets([]);
  let changes = 0;
  presets.onChange(() => changes++);
  const dispose = presets.register({ id: "twitch.panel", group: "Twitch", label: "Twitch panel", width: 320, height: 160 });
  assertEquals(presets.get("twitch.panel").source, "mod");
  assertEquals(presets.list().length, 1);
  assert(Object.isFrozen(presets.get("twitch.panel")), "frozen");
  assert(throwsMessage(() => presets.register({ id: "twitch.panel", label: "Again", width: 320, height: 160 })), "duplicate ids are refused");
  dispose();
  assertEquals(presets.get("twitch.panel"), null);
  assertEquals(changes, 2);
});

Deno.test("invalid presets are refused with plain messages", () => {
  const base = { id: "ok", label: "OK", width: 1280, height: 720 };
  const cases = [
    [{ ...base, id: "Bad Id" }, /id/],
    [{ ...base, label: "  " }, /label/],
    [{ ...base, width: 15 }, /width/],
    [{ ...base, height: 8001 }, /height/],
    [{ ...base, width: "1280" }, /width/],
    [{ ...base, guides: {} }, /list/],
    [{ ...base, guides: [{ kind: "sparkle", x: 0, y: 0, w: 1, h: 1 }] }, /kind/],
    [{ ...base, guides: [{ kind: "safe", x: 0.5, y: 0, w: 0.6, h: 1 }] }, /inside/],
    [{ ...base, guides: [{ kind: "zone", x: 0, y: 0, w: 0, h: 1 }] }, /above 0/],
    [{ ...base, guides: [{ kind: "circle", cx: 0.5, cy: 0.5, r: 0 }] }, /cx, cy and r/],
    [{ ...base, guides: [{ kind: "badge", x: -0.2, y: 0, w: 0.1, h: 0.1 }] }, /between 0 and 1/],
  ];
  for (const [def, pattern] of cases) {
    const msg = throwsMessage(() => normalizePreset(def));
    assert(msg && pattern.test(msg), `${JSON.stringify(def)} -> ${msg}`);
  }
});

Deno.test("bad entries in a list are skipped, not fatal", () => {
  const presets = createPresets([
    { id: "good", label: "Good", width: 100, height: 100 },
    { id: "bad", label: "Bad", width: 1, height: 100 },
    null,
  ]);
  assertEquals(presets.list().map((p) => p.id), ["good"]);
  assertEquals(presets.errors.length, 2);
  assertEquals(presets.errors[0].id, "bad");
});

Deno.test("defaults are filled in", () => {
  const p = normalizePreset({ id: "p", label: "P", width: 640.4, height: 480, export: { type: "image/gif", quality: 7, maxBytes: -1, formats: ["image/png", "image/png", "x"] } });
  assertEquals([p.width, p.height], [640, 480]);
  assertEquals(p.group, "Other");
  assertEquals(p.export, { type: "image/png", quality: 1, maxBytes: null, formats: ["image/png"] });
  assertEquals(p.guides, []);
  assertEquals(p.sources, []);
  assertEquals(p.background, null);
  assertEquals(p.custom, false);
});

Deno.test("loadPresets falls back when the file is missing", async () => {
  const presets = await loadPresets(null, new URL("../web/presets/missing.json", import.meta.url).href);
  assertEquals(presets.list()[0].id, "yt-thumb");
  assert(presets.get("custom").custom);
});

Deno.test("aspect labels", () => {
  assertEquals(aspectLabel(1280, 720), "16:9");
  assertEquals(aspectLabel(1080, 1920), "9:16");
  assertEquals(aspectLabel(3000, 3000), "1:1");
  assertEquals(aspectLabel(2660, 1140), "7:3");
  assertEquals(aspectLabel(1546, 423), "3.65:1");
  assertEquals(aspectLabel(1201, 1600), "3:4");
  assertEquals(aspectLabel(0, 10), "");
});
