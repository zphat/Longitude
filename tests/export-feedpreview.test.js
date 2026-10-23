// Tests for the pure parts of web/js/ui/feedpreview.js
//   deno test --allow-read tests/export-feedpreview.test.js

import assert from "node:assert/strict";
import { normalizeFeedState, previewRenderScale, formatDuration, initialOf, aspectNotice, FEED_VIEWS, FEED_DEFAULTS } from "../web/js/ui/feedpreview.js";

Deno.test("normalizeFeedState fills defaults and keeps views per platform", () => {
  assert.deepEqual(normalizeFeedState({}), { platform: "youtube", view: "home", scheme: "dark", distance: 1 });
  assert.deepEqual(normalizeFeedState({ platform: "spotify", view: "home" }), { platform: "spotify", view: "shows", scheme: "dark", distance: 1 });
  assert.deepEqual(normalizeFeedState({ platform: "youtube", view: "phone", scheme: "light", distance: 9 }), { platform: "youtube", view: "phone", scheme: "light", distance: 3 });
  assert.equal(normalizeFeedState({ distance: 0.2 }).distance, 1);
  assert.equal(normalizeFeedState({ platform: "tiktok" }).platform, "youtube");
  assert.deepEqual(FEED_VIEWS.youtube.map((v) => v.id), ["home", "search", "watch", "phone"]);
  assert.deepEqual(FEED_VIEWS.spotify.map((v) => v.id), ["shows", "playlist"]);
});

Deno.test("previewRenderScale aims for about 2560 px, at most 2x", () => {
  assert.equal(previewRenderScale(1280, 720), 2);
  assert.equal(previewRenderScale(100, 100), 2);
  assert.ok(Math.abs(previewRenderScale(3000, 3000) * 3000 - 2560) < 1e-9);
  assert.equal(previewRenderScale(16000, 16000), 0.25);
  assert.equal(previewRenderScale(0, 0), 2);
});

Deno.test("formatDuration", () => {
  assert.equal(formatDuration(754), "12:34");
  assert.equal(formatDuration(59), "0:59");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(-4), "0:00");
});

Deno.test("initialOf", () => {
  assert.equal(initialOf("your channel"), "Y");
  assert.equal(initialOf("  élan"), "É");
  assert.equal(initialOf(""), "Y");
  assert.equal(initialOf(null), "Y");
});

Deno.test("aspectNotice explains bars and crops", () => {
  assert.equal(aspectNotice("youtube", 1280, 720), null);
  assert.equal(aspectNotice("youtube", 1920, 1080), null);
  assert.match(aspectNotice("youtube", 1080, 1080), /1:1 design gets black bars/);
  assert.match(aspectNotice("youtube", 1080, 1920), /9:16/);
  assert.equal(aspectNotice("spotify", 3000, 3000), null);
  assert.match(aspectNotice("spotify", 1280, 720), /16:9 design are cut off/);
  assert.equal(aspectNotice("youtube", 0, 0), null);
});

Deno.test("defaults match the prefs contract", () => {
  assert.equal(FEED_DEFAULTS.title, "Your video title goes here");
  assert.equal(FEED_DEFAULTS.channel, "Your channel");
  assert.equal(FEED_DEFAULTS.duration, "12:34");
});
