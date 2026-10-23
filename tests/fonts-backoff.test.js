// Tests for the retry backoff of faces that fail to load (web/js/core/fonts.js).
//   deno test --allow-read tests/fonts-backoff.test.js

import { FontRegistry } from "../web/js/core/fonts.js";

const WEB = new URL("../web/", import.meta.url);

function eq(a, b, msg = "") {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb}, got ${sa}`);
}

// A registry whose FontFace fails for urls containing one of failUrls (until
// `fixed`), with a hand-moved clock and its own 'online' target.
async function setup({ failUrls = [] } = {}) {
  const state = { now: 1_000_000, fixed: false, made: [] };
  class FakeFontFace {
    constructor(family, source) {
      this.family = family;
      this.source = source;
      state.made.push(this);
    }
    load() {
      const src = typeof this.source === "string" ? this.source : "";
      if (!state.fixed && failUrls.some((u) => src.includes(u))) return Promise.reject(new Error("offline"));
      return Promise.resolve(this);
    }
  }
  const fontSet = { add() {}, delete() {} };
  const storage = { getAll: async () => [], put: async () => {}, delete: async () => {} };
  const win = new EventTarget();
  const reg = new FontRegistry({
    env: {
      FontFace: FakeFontFace,
      fontSet,
      storage,
      measure: () => 100,
      fetch,
      baseURL: WEB.href,
      now: () => state.now,
      window: win,
    },
  });
  await reg.init("fonts/fonts.json");
  const tries = (family) => state.made.filter((f) => f.family === family).length;
  return { reg, state, win, tries };
}

async function quietly(fn) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return warnings;
}

Deno.test("a failed face is not fetched again on every repaint", async () => {
  const { reg, state, tries } = await setup({ failUrls: ["bungee/"] });
  const warnings = await quietly(async () => {
    eq(await reg.load("Bungee"), false);
    eq(await reg.load("Bungee"), false, "one quick retry");
    eq(tries("Bungee"), 2);
    for (let i = 0; i < 30; i++) eq(await reg.load("Bungee"), false);
    eq(tries("Bungee"), 2, "thirty frames inside the backoff fetch nothing");
    state.now += 1000;
    await reg.load("Bungee");
    eq(tries("Bungee"), 3, "tried again after a second");
    state.now += 1000;
    await reg.load("Bungee");
    eq(tries("Bungee"), 3, "the wait doubles");
    state.now += 1000;
    await reg.load("Bungee");
    eq(tries("Bungee"), 4);
    for (let i = 0; i < 20; i++) {
      state.now += 31000;
      await reg.load("Bungee");
    }
    eq(tries("Bungee"), 24, "never longer than 30 s between tries");
  });
  eq(warnings.length, 1, "warned once for the face");
});

Deno.test("retry: true and the online event skip the backoff", async () => {
  const { reg, state, win, tries } = await setup({ failUrls: ["bungee/"] });
  await quietly(async () => {
    await reg.load("Bungee");
    await reg.load("Bungee");
    eq(tries("Bungee"), 2);
    eq(await reg.load("Bungee"), false);
    eq(tries("Bungee"), 2);
    eq(await reg.load("Bungee", 400, "normal", { retry: true }), false);
    eq(tries("Bungee"), 3, "an explicit retry fetches at once");
    eq((await reg.ensureDoc({ layers: [{ type: "text", font: "Bungee" }] })).length, 1);
    eq(tries("Bungee"), 3, "ensureDoc honors the backoff by default");
    await reg.ensureDoc({ layers: [{ type: "text", font: "Bungee" }] }, { retry: true });
    eq(tries("Bungee"), 4, "opening a design retries");
  });
  state.fixed = true;
  let changed = 0;
  reg.addEventListener("change", () => changed++);
  eq(await reg.load("Bungee"), false, "still waiting");
  win.dispatchEvent(new Event("online"));
  eq(changed, 1, "going online asks text to re-render");
  eq(await reg.load("Bungee"), true, "loads as soon as it asks again");
  eq(reg.loaded("Bungee"), true);
  win.dispatchEvent(new Event("online"));
  eq(changed, 1, "nothing to retry, no change event");
});

Deno.test("a system font's bundled fallback keeps the retry option", async () => {
  const { reg, tries } = await setup({ failUrls: ["anton/"] });
  await quietly(async () => {
    await reg.load("Impact");
    await reg.load("Impact");
    await reg.load("Impact");
    eq(tries("Anton"), 2);
    await reg.load("Impact", 400, "normal", { retry: true });
    eq(tries("Anton"), 3);
  });
});
