// The desktop app's update check: version parsing and comparison, which
// GitHub releases count, and when the daily check is due (web/js/app/desktop.js).
//   deno test --allow-read tests/desktop-version.test.js

import assert from "node:assert/strict";
import { compareVersions, newerRelease, parseVersion, releasePage, updateDue, RELEASES_API, RELEASES_PAGE, UPDATE_EVERY_MS } from "../web/js/app/desktop.js";
import { VERSION } from "../web/js/app/context.js";

Deno.test("parseVersion: tags, short forms, pre-releases, junk", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { nums: [1, 2, 3], pre: [] });
  assert.deepEqual(parseVersion("0.1.0"), { nums: [0, 1, 0], pre: [] });
  assert.deepEqual(parseVersion("2"), { nums: [2, 0, 0], pre: [] });
  assert.deepEqual(parseVersion(" v1.4 "), { nums: [1, 4, 0], pre: [] });
  assert.deepEqual(parseVersion("1.0.0-beta.2"), { nums: [1, 0, 0], pre: ["beta", 2] });
  assert.deepEqual(parseVersion("1.0.0+build.7"), { nums: [1, 0, 0], pre: [] });
  for (const bad of ["", null, undefined, "latest", "v", "1.x", "1.2.3.4", "release-1.0"]) assert.equal(parseVersion(bad), null, String(bad));
});

Deno.test("compareVersions: numbers compare as numbers, pre-releases before releases", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("v0.1.0", "0.1"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "not a string compare");
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.1.1", "0.1.2"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-beta.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "numeric identifiers sort first");
  assert.equal(compareVersions("nope", "1.0.0"), null);
});

const release = (tag, extra = {}) => ({ tag_name: tag, name: `Longitude ${tag}`, html_url: `https://github.com/zphat/Longitude/releases/tag/${tag}`, draft: false, prerelease: false, ...extra });

Deno.test("newerRelease: only a newer, published, regular release counts", () => {
  assert.deepEqual(newerRelease(release("v0.2.0"), "0.1.0"), {
    version: "0.2.0",
    tag: "v0.2.0",
    name: "Longitude v0.2.0",
    url: "https://github.com/zphat/Longitude/releases/tag/v0.2.0",
  });
  assert.equal(newerRelease(release("v0.1.0"), "0.1.0"), null, "same version");
  assert.equal(newerRelease(release("v0.0.9"), "0.1.0"), null, "older");
  assert.equal(newerRelease(release("v0.2.0", { draft: true }), "0.1.0"), null, "draft");
  assert.equal(newerRelease(release("v0.2.0", { prerelease: true }), "0.1.0"), null, "pre-release");
  assert.equal(newerRelease(release("nightly"), "0.1.0"), null, "not a version");
  assert.equal(newerRelease(null, "0.1.0"), null);
  assert.equal(newerRelease({ message: "Not Found" }, "0.1.0"), null, "GitHub's 404 body");
  assert.equal(newerRelease(release("v0.2.0", { name: "" }), "0.1.0").name, "Longitude v0.2.0");
});

Deno.test("releasePage: only this repository's release pages open", () => {
  assert.equal(releasePage("https://github.com/zphat/Longitude/releases/tag/v0.2.0"), "https://github.com/zphat/Longitude/releases/tag/v0.2.0");
  assert.equal(releasePage("https://example.com/releases/tag/v0.2.0"), RELEASES_PAGE);
  assert.equal(releasePage("https://github.com/someone/Longitude/releases/tag/v9"), RELEASES_PAGE);
  assert.equal(releasePage("javascript:alert(1)"), RELEASES_PAGE);
  assert.equal(releasePage(undefined), RELEASES_PAGE);
  assert.equal(newerRelease(release("v0.3.0", { html_url: "https://evil.example/" }), "0.1.0").url, RELEASES_PAGE);
  assert.equal(RELEASES_API, "https://api.github.com/repos/zphat/Longitude/releases/latest");
});

Deno.test("updateDue: once a day, never when turned off", () => {
  const now = Date.UTC(2026, 9, 24, 12);
  assert.equal(updateDue({ lastCheck: 0, now }), true, "never checked");
  assert.equal(updateDue({ lastCheck: now - UPDATE_EVERY_MS, now }), true, "a day ago");
  assert.equal(updateDue({ lastCheck: now - UPDATE_EVERY_MS + 60_000, now }), false, "almost a day ago");
  assert.equal(updateDue({ lastCheck: now - 1000, now }), false, "just now");
  assert.equal(updateDue({ lastCheck: now + 3 * UPDATE_EVERY_MS, now }), true, "a clock set back");
  assert.equal(updateDue({ lastCheck: "garbage", now }), true);
  assert.equal(updateDue({ enabled: false, lastCheck: 0, now }), false, "off");
});

Deno.test("the app's version is a version the check understands", () => {
  assert.ok(parseVersion(VERSION), VERSION);
  assert.equal(compareVersions(`v${VERSION}`, VERSION), 0);
});
