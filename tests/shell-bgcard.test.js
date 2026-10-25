// Home's "Get background removal ready" card: "Not now" hides it for 7 days,
// the second "Not now" for good (prefs bgReadyCard).
//   deno test --allow-read tests/shell-bgcard.test.js

import assert from "node:assert/strict";
import { BG_SNOOZE_MS, bgCardSnooze, bgCardSnoozed } from "../web/js/ui/home.js";

const DAY = 24 * 60 * 60 * 1000;

Deno.test("bgCardSnoozed: shown until the first Not now", () => {
  assert.equal(BG_SNOOZE_MS, 7 * DAY);
  for (const pref of [null, undefined, "", 0, true, "yes", {}]) assert.equal(bgCardSnoozed(pref, 1000), false, `pref ${JSON.stringify(pref)}`);
});

Deno.test("bgCardSnooze: 7 days, then back once, then never again", () => {
  const t0 = 1_700_000_000_000;
  const first = bgCardSnooze(null, t0);
  assert.deepEqual(first, { until: t0 + 7 * DAY, count: 1, never: false });
  assert.equal(bgCardSnoozed(first, t0), true);
  assert.equal(bgCardSnoozed(first, t0 + 7 * DAY - 1), true, "hidden for the whole week");
  assert.equal(bgCardSnoozed(first, t0 + 7 * DAY + 1), false, "back after it");
  const second = bgCardSnooze(first, t0 + 8 * DAY);
  assert.equal(second.count, 2);
  assert.equal(second.never, true);
  assert.equal(bgCardSnoozed(second, t0 + 400 * DAY), true, "no more nagging");
});

Deno.test("bgCardSnooze: odd stored values start over", () => {
  assert.deepEqual(bgCardSnooze({ count: "x" }, 0), { until: 7 * DAY, count: 1, never: false });
  assert.equal(bgCardSnoozed({ until: "soon" }, 0), false);
});
