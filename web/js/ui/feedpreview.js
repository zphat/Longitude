// Feed preview (SPEC 1.9): the design at real size in mock YouTube and
// Spotify layouts, dark or light, with a "view from a distance" slider.
// Everything around the design is drawn here: no real channels, no logos,
// no outside images.

import { h, on, disposer, debounce } from "./dom.js";
import { icon } from "./icons.js";
import { segmented, slider, iconButton } from "./controls.js";
import { renderToCanvas } from "../core/render.js";
import { mulberry32, hashString } from "../core/effects.js";
import { encode, resizeCanvas } from "../features/compress.js";
import { aspectLabel } from "../features/presets.js";
import { openSheet, ensureIcons } from "./quicktools.js";

// ---- pure helpers ---------------------------------------------------------------

export const FEED_VIEWS = {
  youtube: [
    { id: "home", label: "Home" },
    { id: "search", label: "Search" },
    { id: "watch", label: "Up next" },
    { id: "phone", label: "Phone" },
  ],
  spotify: [
    { id: "shows", label: "Shows" },
    { id: "playlist", label: "Playlist" },
  ],
};

export const FEED_DEFAULTS = {
  title: "Your video title goes here",
  channel: "Your channel",
  duration: "12:34",
  meta: "12K views · 2 days ago",
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function normalizeFeedState(raw = {}) {
  const platform = raw.platform === "spotify" ? "spotify" : "youtube";
  const views = FEED_VIEWS[platform];
  return {
    platform,
    view: views.some((v) => v.id === raw.view) ? raw.view : views[0].id,
    scheme: raw.scheme === "light" ? "light" : "dark",
    distance: clamp(Number.isFinite(raw.distance) ? raw.distance : 1, 1, 3),
  };
}

// Render about 2560 px on the long side: 2x for a 1280 x 720 thumbnail, less
// for big covers, so every real-size slot has pixels to spare.
export function previewRenderScale(width, height) {
  return clamp(2560 / Math.max(1, width, height), 0.25, 2);
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

export function initialOf(name) {
  const ch = [...String(name ?? "").trim()][0];
  return ch ? ch.toLocaleUpperCase() : "Y";
}

// Why the design looks different in a slot, or null when it fits as is.
export function aspectNotice(platform, width, height) {
  if (!(width > 0 && height > 0)) return null;
  const r = width / height;
  const label = aspectLabel(width, height);
  if (platform === "spotify") {
    if (Math.abs(r - 1) <= 0.02) return null;
    return `Spotify shows covers square, so the edges of this ${label} design are cut off.`;
  }
  if (Math.abs(r - 16 / 9) <= 0.02) return null;
  return `YouTube shows thumbnails at 16:9, so this ${label} design gets black bars.`;
}

// ---- procedural mock images -----------------------------------------------------

const hsl = (hue, s, l, a = 1) => `hsl(${(((hue % 360) + 360) % 360).toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}% / ${a})`;

function roundRect(g, x, y, w, hh, r) {
  g.beginPath();
  if (typeof g.roundRect === "function") g.roundRect(x, y, w, hh, r);
  else g.rect(x, y, w, hh);
}

// A busy, colorful thumbnail-like picture: gradient, glow, a figure or an
// object, chunky text bars. kind "video" (16:9) or "cover" (square).
function drawMock(g, W, H, seed, kind) {
  const rnd = mulberry32(seed);
  const r = (a, b) => a + (b - a) * rnd();
  const hue = r(0, 360);
  const hue2 = hue + r(40, 160);
  const ang = r(0, Math.PI * 2);
  const cx = W / 2;
  const cy = H / 2;
  const bg = g.createLinearGradient(cx - Math.cos(ang) * W * 0.6, cy - Math.sin(ang) * H * 0.6, cx + Math.cos(ang) * W * 0.6, cy + Math.sin(ang) * H * 0.6);
  bg.addColorStop(0, hsl(hue, r(55, 85), r(42, 58)));
  bg.addColorStop(1, hsl(hue2, r(45, 75), r(12, 26)));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  const gx = r(0.2, 0.8) * W;
  const gy = r(0.2, 0.7) * H;
  const glow = g.createRadialGradient(gx, gy, 0, gx, gy, Math.max(W, H) * 0.6);
  glow.addColorStop(0, hsl(hue + 30, 95, 72, 0.55));
  glow.addColorStop(1, hsl(hue + 30, 95, 72, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  const u = Math.min(W, H);
  if (kind === "cover") {
    g.fillStyle = hsl(hue2 + 180, 70, 62, 0.9);
    g.beginPath();
    g.arc(r(0.3, 0.7) * W, r(0.25, 0.5) * H, u * r(0.22, 0.34), 0, Math.PI * 2);
    g.fill();
    const lines = 2 + Math.floor(rnd() * 2);
    const bh = u * 0.11;
    let y = H * r(0.56, 0.62);
    for (let i = 0; i < lines; i++) {
      const w = W * r(0.45, 0.8) * (i ? 0.8 : 1);
      g.fillStyle = i ? hsl(0, 0, 100, 0.75) : "#ffffff";
      roundRect(g, (W - w) / 2, y, w, bh * (i ? 0.62 : 1), bh * 0.18);
      g.fill();
      y += bh * (i ? 0.85 : 1.25);
    }
    return;
  }

  const style = Math.floor(rnd() * 3);
  const px = W * r(0.62, 0.8);
  if (style === 0) {
    const skin = hsl(hue + 200, r(18, 40), r(62, 78));
    g.lineWidth = u * 0.03;
    g.strokeStyle = "#ffffff";
    g.fillStyle = skin;
    g.beginPath();
    g.ellipse(px, H * 1.04, H * 0.42, H * 0.4, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(px, H * 0.47, H * 0.2, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  } else if (style === 1) {
    g.save();
    g.translate(px, H * 0.56);
    g.rotate(r(-0.35, 0.35));
    g.fillStyle = hsl(hue + 120, 70, 58);
    g.strokeStyle = "#ffffff";
    g.lineWidth = u * 0.025;
    roundRect(g, -H * 0.26, -H * 0.3, H * 0.52, H * 0.6, H * 0.06);
    g.fill();
    g.stroke();
    g.restore();
  } else {
    g.fillStyle = hsl(hue + 180, 80, 60, 0.85);
    g.beginPath();
    g.moveTo(px - H * 0.3, H * 0.85);
    g.lineTo(px, H * 0.2);
    g.lineTo(px + H * 0.3, H * 0.85);
    g.closePath();
    g.fill();
  }

  const bars = 1 + Math.floor(rnd() * 2);
  const bh = H * 0.15;
  let y = H * r(0.14, 0.32);
  for (let i = 0; i < bars; i++) {
    g.save();
    g.translate(W * 0.06, y);
    g.rotate(r(-0.05, 0.05));
    roundRect(g, 0, 0, W * r(0.3, 0.48), bh, bh * 0.16);
    g.fillStyle = rnd() < 0.55 ? "#ffffff" : "#ffe14d";
    g.lineWidth = H * 0.018;
    g.strokeStyle = "#000000";
    g.stroke();
    g.fill();
    g.restore();
    y += bh * 1.3;
  }
  if (rnd() < 0.35) {
    g.strokeStyle = "#ff2d2d";
    g.lineWidth = H * 0.028;
    g.beginPath();
    g.ellipse(W * r(0.35, 0.6), H * r(0.55, 0.75), H * 0.16, H * 0.12, r(-0.3, 0.3), 0, Math.PI * 2);
    g.stroke();
  }
  const vig = g.createRadialGradient(cx, cy, u * 0.3, cx, cy, Math.max(W, H) * 0.75);
  vig.addColorStop(0, "rgba(0, 0, 0, 0)");
  vig.addColorStop(1, "rgba(0, 0, 0, 0.35)");
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
}

function mockCanvas(seed, w, hgt, kind = "video") {
  const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
  const c = h("canvas", { class: "fp-mock", "aria-hidden": "true" });
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(hgt * dpr));
  const g = c.getContext("2d");
  if (g) {
    g.scale(c.width / w, c.height / hgt);
    drawMock(g, w, hgt, seed, kind);
  }
  return c;
}

// ---- building blocks ------------------------------------------------------------

const bar = (pct, cls) => h("span", { class: ["fp-bar", cls], style: { width: `${pct}%` } });
const bind = (key, tag = "span", cls) => h(tag, { class: cls, dataset: { bind: key } });

function seeded(seed) {
  const rnd = mulberry32(seed);
  return (a, b) => a + (b - a) * rnd();
}

function avatar(seed, cls) {
  const r = seeded(seed * 7 + 3);
  return h("span", { class: ["fp-ava", cls], style: { background: hsl(r(0, 360), r(35, 60), r(38, 55)) } });
}

function mineAvatar(cls) {
  return h("span", { class: ["fp-ava", "mine", cls], dataset: { bind: "avatar" } }, bind("initial"));
}

function mineImage(state, fit) {
  return h("img", { class: ["fp-img", fit], src: state.url, alt: "Your design", draggable: "false", decoding: "async" });
}

// One thumbnail slot. w x hgt is the real CSS size the platform uses.
function thumb(state, { mine, seed, w, hgt, cls, kind = "video", duration = true }) {
  const box = h("div", { class: ["fp-thumb", mine && "mine", cls] });
  if (mine) box.append(mineImage(state, kind === "cover" ? "cover" : "contain"));
  else box.append(mockCanvas(seed, w, hgt, kind));
  if (duration) {
    const r = seeded(seed + 101);
    box.append(h("span", { class: "fp-dur" }, mine ? FEED_DEFAULTS.duration : formatDuration(r(70, 2400))));
  }
  return box;
}

function chips(labels, cls) {
  return h(
    "div",
    { class: ["fp-chips", cls] },
    labels.map((t, i) => h("span", { class: ["fp-chip", i === 0 && "on"] }, t)),
  );
}

// ---- YouTube --------------------------------------------------------------------

function ytMasthead() {
  return h(
    "div",
    { class: "fp-yt-mast" },
    h("div", { class: "fp-yt-mast-l" }, h("span", { class: "fp-ico" }, icon("menu")), h("span", { class: "fp-logo" }, h("span", { class: "fp-logo-mark" }), h("span", { class: "fp-logo-word" }))),
    h(
      "div",
      { class: "fp-yt-searchbar" },
      h("div", { class: "fp-yt-searchgroup" }, h("span", { class: "fp-yt-searchbox" }, "Search"), h("span", { class: "fp-yt-searchbtn" }, icon("search"))),
      h("span", { class: "fp-yt-round" }, icon("mic")),
    ),
    h("div", { class: "fp-yt-mast-r" }, h("span", { class: "fp-yt-create" }, icon("plus"), "Create"), h("span", { class: "fp-ico" }, icon("bell")), avatar(5, "sm")),
  );
}

function ytGuide() {
  return h(
    "nav",
    { class: "fp-yt-guide" },
    ["home", "play", "library", "clock"].map((name, i) => h("span", { class: ["fp-yt-guide-item", i === 0 && "on"] }, icon(name), bar(70 - i * 8, "tiny"))),
  );
}

function ytMeta(mine, seed, { channel = true, small = false } = {}) {
  if (mine) {
    return [
      h("div", { class: "fp-yt-title", dataset: { bind: "title" } }),
      channel ? h("div", { class: "fp-yt-sub" }, bind("channel")) : null,
      h("div", { class: "fp-yt-sub" }, FEED_DEFAULTS.meta),
    ];
  }
  const r = seeded(seed + 7);
  return [
    h("div", { class: "fp-yt-title mock" }, bar(r(78, 96), small ? "t-sm" : "t"), r(0, 1) < 0.6 ? bar(r(35, 70), small ? "t-sm" : "t") : null),
    channel ? h("div", { class: "fp-yt-sub mock" }, bar(r(30, 52), "s")) : null,
    h("div", { class: "fp-yt-sub mock" }, bar(r(38, 60), "s")),
  ];
}

function ytCard(state, mine, seed) {
  return h(
    "div",
    { class: ["fp-yt-card", mine && "mine"] },
    thumb(state, { mine, seed, w: 360, hgt: 202 }),
    h("div", { class: "fp-yt-details" }, mine ? mineAvatar() : avatar(seed), h("div", { class: "fp-yt-meta" }, ytMeta(mine, seed)), h("span", { class: "fp-kebab" }, icon("more-vertical"))),
  );
}

const HOME_CHIPS = ["All", "Music", "Gaming", "News", "Podcasts", "Live", "Cooking", "Recently uploaded", "Watched", "New to you"];

function ytHome(state) {
  const cards = Array.from({ length: 12 }, (_, i) => ytCard(state, i === 1, 40 + i));
  return h("div", { class: "fp-yt-home" }, chips(HOME_CHIPS), h("div", { class: "fp-yt-grid" }, cards));
}

function ytResult(state, mine, seed) {
  const r = seeded(seed + 3);
  const head = mine
    ? [h("div", { class: "fp-yt-rtitle", dataset: { bind: "title" } }), h("div", { class: "fp-yt-sub sm" }, FEED_DEFAULTS.meta)]
    : [h("div", { class: "fp-yt-rtitle mock" }, bar(r(70, 92), "t-lg")), h("div", { class: "fp-yt-sub sm mock" }, bar(r(24, 34), "s"))];
  return h(
    "div",
    { class: ["fp-yt-result", mine && "mine"] },
    thumb(state, { mine, seed, w: 360, hgt: 202 }),
    h(
      "div",
      { class: "fp-yt-rmeta" },
      head,
      h("div", { class: "fp-yt-rchan" }, mine ? mineAvatar("xs") : avatar(seed, "xs"), mine ? bind("channel", "span", "fp-yt-sub sm") : bar(r(18, 30), "s")),
      h("div", { class: "fp-yt-snippet" }, bar(r(75, 95), "s"), bar(r(40, 70), "s")),
    ),
  );
}

function ytSearch(state) {
  return h(
    "div",
    { class: "fp-yt-searchpage" },
    chips(["All", "Videos", "Shorts", "Unwatched", "Recently uploaded", "Live"]),
    h("div", { class: "fp-yt-results" }, [ytResult(state, true, 70), ytResult(state, false, 71), ytResult(state, false, 72), ytResult(state, false, 73)]),
  );
}

function ytCompact(state, mine, seed) {
  return h(
    "div",
    { class: ["fp-yt-compact", mine && "mine"] },
    thumb(state, { mine, seed, w: 168, hgt: 94, cls: "sm" }),
    h("div", { class: "fp-yt-cmeta" }, ytMeta(mine, seed, { small: true })),
  );
}

function ytWatch(state) {
  const player = h(
    "div",
    { class: "fp-yt-player" },
    mockCanvas(90, 854, 480),
    h(
      "div",
      { class: "fp-yt-controls" },
      h("div", { class: "fp-yt-scrub" }, h("span", { class: "fp-yt-scrub-fill" })),
      h("div", { class: "fp-yt-ctl-row" }, icon("play"), icon("skip-forward"), h("span", { class: "fp-yt-time" }, "4:02 / 12:51"), h("span", { class: "fp-grow" }), icon("cast"), icon("monitor")),
    ),
  );
  const primary = h(
    "div",
    { class: "fp-yt-primary" },
    player,
    h("div", { class: "fp-yt-wtitle" }, bar(64, "t-xl")),
    h(
      "div",
      { class: "fp-yt-owner" },
      avatar(91, "md"),
      h("div", { class: "fp-yt-owner-meta" }, bar(60, "t"), bar(40, "s")),
      h("span", { class: "fp-yt-subscribe" }, "Subscribe"),
      h("span", { class: "fp-grow" }),
      h("span", { class: "fp-yt-pill" }, bar(60, "s")),
      h("span", { class: "fp-yt-pill" }, bar(60, "s")),
    ),
    h("div", { class: "fp-yt-desc" }, bar(30, "s"), bar(92, "s"), bar(76, "s")),
  );
  const items = Array.from({ length: 9 }, (_, i) => ytCompact(state, i === 1, 120 + i));
  const secondary = h("div", { class: "fp-yt-secondary" }, chips(["All", "From this channel", "Related", "For you"], "sm"), items);
  return h("div", { class: "fp-yt-watch" }, primary, secondary);
}

function phoneStatus() {
  return h(
    "div",
    { class: "fp-phone-status" },
    h("span", { class: "fp-phone-time" }, "9:41"),
    h("span", { class: "fp-phone-notch" }),
    h("span", { class: "fp-phone-icons" }, h("span", { class: "fp-sig" }), h("span", { class: "fp-batt" })),
  );
}

function ytPhoneItem(state, mine, seed) {
  const r = seeded(seed + 9);
  return h(
    "div",
    { class: ["fp-yt-mitem", mine && "mine"] },
    thumb(state, { mine, seed, w: 375, hgt: 211, cls: "full" }),
    h(
      "div",
      { class: "fp-yt-mdetails" },
      mine ? mineAvatar() : avatar(seed),
      h(
        "div",
        { class: "fp-yt-meta" },
        mine
          ? [h("div", { class: "fp-yt-title m", dataset: { bind: "title" } }), h("div", { class: "fp-yt-sub xs" }, bind("channel"), ` · ${FEED_DEFAULTS.meta}`)]
          : [h("div", { class: "fp-yt-title mock" }, bar(r(80, 96), "t-sm"), bar(r(30, 60), "t-sm")), h("div", { class: "fp-yt-sub mock" }, bar(r(50, 75), "s"))],
      ),
      h("span", { class: "fp-kebab" }, icon("more-vertical")),
    ),
  );
}

function ytPhone(state) {
  const screen = h(
    "div",
    { class: "fp-phone-screen" },
    phoneStatus(),
    h(
      "div",
      { class: "fp-phone-appbar" },
      h("span", { class: "fp-logo" }, h("span", { class: "fp-logo-mark" }), h("span", { class: "fp-logo-word" })),
      h("span", { class: "fp-grow" }),
      icon("cast"),
      icon("bell"),
      icon("search"),
    ),
    chips(["All", "Music", "Gaming", "Live", "News"], "sm"),
    h("div", { class: "fp-phone-feed" }, [ytPhoneItem(state, true, 150), ytPhoneItem(state, false, 151), ytPhoneItem(state, false, 152)]),
    h(
      "div",
      { class: "fp-phone-nav" },
      ["home", "play", "plus-circle", "library", "clock"].map((n, i) => h("span", { class: ["fp-phone-tab", i === 0 && "on"] }, icon(n), i === 2 ? null : bar(60, "tiny"))),
    ),
  );
  return h("div", { class: "fp-phone" }, screen);
}

// ---- Spotify --------------------------------------------------------------------

function spRow(state, mine, seed, round = false) {
  const r = seeded(seed + 5);
  return h(
    "div",
    { class: ["fp-sp-row", mine && "mine"] },
    mine ? h("div", { class: "fp-sp-cover xs" }, mineImage(state, "cover")) : h("div", { class: ["fp-sp-cover", "xs", round && "round"] }, mockCanvas(seed, 48, 48, "cover")),
    h(
      "div",
      { class: "fp-sp-rowtext" },
      mine ? bind("title", "div", "fp-sp-name") : h("div", { class: "fp-sp-name mock" }, bar(r(50, 85), "t-sm")),
      mine ? h("div", { class: "fp-sp-sub" }, "Podcast · ", bind("channel")) : h("div", { class: "fp-sp-sub mock" }, bar(r(40, 70), "s")),
    ),
  );
}

function spLibrary(state) {
  const rows = Array.from({ length: 9 }, (_, i) => spRow(state, i === 2, 200 + i, i === 4 || i === 7));
  return h(
    "aside",
    { class: "fp-sp-lib" },
    h("div", { class: "fp-sp-lib-head" }, icon("library"), h("span", null, "Your Library"), h("span", { class: "fp-grow" }), icon("plus")),
    chips(["Playlists", "Podcasts", "Albums", "Artists"], "sp"),
    h("div", { class: "fp-sp-rows" }, rows),
  );
}

function spCard(state, mine, seed) {
  const r = seeded(seed + 11);
  return h(
    "div",
    { class: ["fp-sp-card", mine && "mine"] },
    mine ? h("div", { class: "fp-sp-cover md" }, mineImage(state, "cover")) : h("div", { class: "fp-sp-cover md" }, mockCanvas(seed, 172, 172, "cover")),
    mine ? bind("title", "div", "fp-sp-ctitle") : h("div", { class: "fp-sp-ctitle mock" }, bar(r(55, 90), "t")),
    mine ? h("div", { class: "fp-sp-csub" }, bind("channel")) : h("div", { class: "fp-sp-csub mock" }, bar(r(40, 75), "s"), bar(r(25, 50), "s")),
  );
}

function spShows(state) {
  const shelf = (title, start, mineAt) =>
    h(
      "section",
      { class: "fp-sp-shelf" },
      h("div", { class: "fp-sp-shelf-head" }, h("h3", null, title), h("span", { class: "fp-sp-more" }, "Show all")),
      h("div", { class: "fp-sp-cards" }, Array.from({ length: 6 }, (_, i) => spCard(state, i === mineAt, start + i))),
    );
  return h(
    "div",
    { class: "fp-sp-page" },
    h("div", { class: "fp-sp-wash" }),
    chips(["All", "Music", "Podcasts"], "sp"),
    shelf("Shows you might like", 300, 1),
    shelf("Recently played", 320, -1),
  );
}

function spPlaylist(state) {
  const tracks = Array.from({ length: 8 }, (_, i) => {
    const r = seeded(400 + i);
    return h(
      "div",
      { class: "fp-sp-track" },
      h("span", { class: "fp-sp-idx" }, String(i + 1)),
      h("div", { class: "fp-sp-cover xxs" }, mockCanvas(400 + i, 40, 40, "cover")),
      h("div", { class: "fp-sp-ttext" }, bar(r(45, 80), "t-sm"), bar(r(25, 50), "s")),
      h("div", { class: "fp-sp-talbum" }, bar(r(40, 75), "s")),
      h("span", { class: "fp-sp-tdur" }, formatDuration(r(130, 290))),
    );
  });
  const header = h(
    "div",
    { class: "fp-sp-head" },
    h("div", { class: "fp-sp-cover xl mine" }, mineImage(state, "cover")),
    h(
      "div",
      { class: "fp-sp-head-text" },
      h("span", { class: "fp-sp-kind" }, "Playlist"),
      bind("title", "h1", "fp-sp-ptitle"),
      h("div", { class: "fp-sp-owner" }, mineAvatar("xxs"), bind("channel", "span", "fp-sp-owner-name"), h("span", null, " · 24 songs, about 1 hr 20 min")),
    ),
  );
  return h(
    "div",
    { class: "fp-sp-page playlist" },
    header,
    h(
      "div",
      { class: "fp-sp-actions" },
      h("span", { class: "fp-sp-play" }, icon("play")),
      h("span", { class: "fp-ico" }, icon("shuffle")),
      h("span", { class: "fp-ico" }, icon("plus-circle")),
      h("span", { class: "fp-ico" }, icon("more-vertical")),
    ),
    h(
      "div",
      { class: "fp-sp-tracks" },
      h("div", { class: "fp-sp-track head" }, h("span", { class: "fp-sp-idx" }, "#"), h("span", { class: "fp-sp-hlabel span2" }, "Title"), h("span", { class: "fp-sp-talbum fp-sp-hlabel" }, "Album"), h("span", { class: "fp-sp-tdur" }, icon("clock"))),
      tracks,
    ),
  );
}

function spWindow(state, page) {
  const win = h(
    "div",
    { class: "fp-window fp-sp" },
    h(
      "div",
      { class: "fp-sp-top" },
      h("span", { class: "fp-logo sp" }, h("span", { class: "fp-logo-mark round" })),
      h("span", { class: "fp-grow" }),
      h("span", { class: "fp-sp-homebtn" }, icon("home")),
      h("span", { class: "fp-sp-search" }, icon("search"), "Search"),
      h("span", { class: "fp-grow" }),
      h("span", { class: "fp-ico" }, icon("bell")),
      avatar(9, "sm"),
    ),
    h("div", { class: "fp-sp-body" }, spLibrary(state), h("main", { class: "fp-sp-main" }, page)),
    h(
      "div",
      { class: "fp-sp-player" },
      h(
        "div",
        { class: "fp-sp-now" },
        h("div", { class: "fp-sp-cover sm mine" }, mineImage(state, "cover")),
        h("div", { class: "fp-sp-rowtext" }, h("div", { class: "fp-sp-name", dataset: { bind: "title" } }), h("div", { class: "fp-sp-sub" }, bind("channel"))),
      ),
      h(
        "div",
        { class: "fp-sp-transport" },
        h("div", { class: "fp-sp-buttons" }, icon("shuffle"), icon("skip-back"), h("span", { class: "fp-sp-pp" }, icon("play")), icon("skip-forward"), h("span", { class: "fp-ico" }, icon("clock"))),
        h("div", { class: "fp-sp-progress" }, h("span", null, "8:14"), h("span", { class: "fp-sp-track-bar" }, h("span", { class: "fp-sp-track-fill" })), h("span", null, "41:09")),
      ),
      h("div", { class: "fp-sp-volume" }, h("span", { class: "fp-sp-track-bar short" }, h("span", { class: "fp-sp-track-fill" }))),
    ),
  );
  win.style.setProperty("--fp-tint", state.tint);
  return win;
}

function ytWindow(state, content, cls) {
  return h("div", { class: ["fp-window", "fp-yt", `fp-v-${cls}`] }, ytMasthead(), h("div", { class: "fp-yt-body" }, ytGuide(), h("div", { class: "fp-yt-content" }, content)));
}

function buildView(state) {
  if (state.platform === "spotify") return spWindow(state, state.view === "playlist" ? spPlaylist(state) : spShows(state));
  if (state.view === "phone") return h("div", { class: "fp-yt fp-yt-phone-wrap" }, ytPhone(state));
  if (state.view === "search") return ytWindow(state, ytSearch(state), "search");
  if (state.view === "watch") return ytWindow(state, ytWatch(state), "watch");
  return ytWindow(state, ytHome(state), "home");
}

// ---- overlay ----------------------------------------------------------------------

function averageColor(canvas) {
  try {
    const c = resizeCanvas(canvas, 1, 1);
    const [r, g, b] = c.getContext("2d").getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  } catch {
    return [70, 70, 80];
  }
}

function tintFrom([r, g, b]) {
  const k = 0.72;
  return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
}

const zoomSupported = () => {
  try {
    return typeof CSS !== "undefined" && CSS.supports("zoom", "0.5");
  } catch {
    return false;
  }
};

let current = null;

export function openFeedPreview(ctx) {
  if (current && !current.sheet.closed) return current.handle;
  const doc = ctx.store?.doc;
  if (!doc) {
    ctx.ui?.toast?.("Open a design first.", { kind: "warn" });
    return { close() {} };
  }
  ensureIcons();
  const d = disposer();
  let st = normalizeFeedState(ctx.prefs?.get?.("feedPreview", {}) || {});
  const view = {
    url: "",
    tint: "rgb(60, 60, 70)",
    title: String(ctx.prefs?.get?.("feedTitle", FEED_DEFAULTS.title) ?? FEED_DEFAULTS.title),
    channel: String(ctx.prefs?.get?.("feedChannel", FEED_DEFAULTS.channel) ?? FEED_DEFAULTS.channel),
  };
  let ready = false;
  let failed = "";

  const sheet = openSheet({
    label: "Preview in a feed",
    className: "fp-sheet",
    ui: ctx.ui,
    full: true,
    onClose() {
      saveText.flush();
      d.dispose();
      if (view.url) URL.revokeObjectURL(view.url);
      if (current?.sheet === sheet) current = null;
    },
    onKeyDown(e) {
      const typing = e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA";
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        sheet.close();
        return true;
      }
      return false;
    },
  });

  // ---- stage
  const page = h("div", { class: "fp-page" });
  const stage = h("div", { class: "fp-stage" }, page);
  const notice = h("div", { class: "fp-notice", role: "note", hidden: true });

  // ---- top islands
  const closeBtn = iconButton({ icon: "x", tip: "Close", kbd: "Esc", onClick: () => sheet.close() });
  const topLeft = h("div", { class: "island fp-island fp-top-left" }, closeBtn, h("div", { class: "fp-heading" }, h("span", { class: "fp-heading-title" }, "Feed preview"), h("span", { class: "micro" }, "Mock layout, real sizes")));
  const platformSeg = segmented({
    value: st.platform,
    options: [
      { value: "youtube", label: "YouTube" },
      { value: "spotify", label: "Spotify" },
    ],
    onChange: (v) => setState({ platform: v, view: FEED_VIEWS[v][0].id }),
  });
  const viewHost = h("div", { class: "fp-views" });
  const topCenter = h("div", { class: "island fp-island fp-top-center" }, platformSeg, h("span", { class: "fp-sep" }), viewHost);
  const schemeSeg = segmented({
    value: st.scheme,
    options: [
      { value: "dark", label: "Dark", icon: "moon", showLabel: true, tip: "Dark theme" },
      { value: "light", label: "Light", icon: "sun", showLabel: true, tip: "Light theme" },
    ],
    onChange: (v) => setState({ scheme: v }),
  });
  const topRight = h("div", { class: "island fp-island fp-top-right" }, schemeSeg);

  // ---- bottom island
  const titleInput = h("input", { type: "text", class: "fp-input wide", value: view.title, placeholder: FEED_DEFAULTS.title, "aria-label": "Video title", spellcheck: "true" });
  const channelInput = h("input", { type: "text", class: "fp-input", value: view.channel, placeholder: FEED_DEFAULTS.channel, "aria-label": "Channel name", spellcheck: "false" });
  const distance = slider({
    label: "View from a distance",
    min: 1,
    max: 3,
    step: 0.1,
    value: st.distance,
    unit: "×",
    decimals: 1,
    defaultValue: 1,
    tip: "Shrinks everything, like stepping back from the screen",
    onInput: (v) => setDistance(v),
    onChange: (v) => setState({ distance: v }, { rebuild: false }),
  });
  const bottom = h(
    "div",
    { class: "island fp-island fp-bottom" },
    h("label", { class: "fp-field" }, h("span", { class: "micro" }, "Title"), titleInput),
    h("label", { class: "fp-field" }, h("span", { class: "micro" }, "Channel"), channelInput),
    h("div", { class: "fp-distance" }, distance),
  );

  sheet.panel.append(stage, topLeft, topCenter, topRight, bottom, notice);

  // ---- behavior

  function paintViews() {
    const seg = segmented({ value: st.view, options: FEED_VIEWS[st.platform].map((v) => ({ value: v.id, label: v.label })), onChange: (v) => setState({ view: v }) });
    viewHost.replaceChildren(seg);
    platformSeg.value = st.platform;
    schemeSeg.value = st.scheme;
    topRight.hidden = st.platform === "spotify";
  }

  function setState(patch, { rebuild = true } = {}) {
    st = normalizeFeedState({ ...st, ...patch });
    ctx.prefs?.set?.("feedPreview", { ...st });
    paintViews();
    if (rebuild) build();
  }

  function setDistance(v) {
    const z = 1 / clamp(v, 1, 3);
    if (zoomSupported()) {
      page.style.zoom = String(z);
      page.style.transform = "";
    } else {
      page.style.transform = `scale(${z})`;
    }
  }

  function sizeWindow() {
    const w = clamp((stage.clientWidth || 1280) - 64, 960, 1480);
    page.style.setProperty("--fp-win-w", `${Math.round(w)}px`);
  }

  function applyText() {
    const title = view.title.trim() || FEED_DEFAULTS.title;
    const channel = view.channel.trim() || FEED_DEFAULTS.channel;
    for (const el of page.querySelectorAll("[data-bind=title]")) el.textContent = title;
    for (const el of page.querySelectorAll(".fp-sp-ptitle")) el.dataset.len = title.length > 48 ? "long" : title.length > 22 ? "mid" : "short";
    for (const el of page.querySelectorAll("[data-bind=channel]")) el.textContent = channel;
    for (const el of page.querySelectorAll("[data-bind=initial]")) el.textContent = initialOf(channel);
    const hue = hashString(channel) % 360;
    for (const el of page.querySelectorAll("[data-bind=avatar]")) el.style.background = hsl(hue, 55, 46);
  }

  function build() {
    page.className = `fp-page ${st.platform} ${st.scheme}`;
    if (failed) {
      page.replaceChildren(h("div", { class: "fp-status error" }, icon("alert-triangle", { size: "lg" }), h("span", null, failed)));
      return;
    }
    if (!ready) {
      page.replaceChildren(h("div", { class: "fp-status" }, h("span", { class: "xp-spin lg" }), h("span", null, "Getting the preview ready")));
      return;
    }
    const tree = buildView({ ...view, platform: st.platform, view: st.view });
    tree.classList.add(st.scheme);
    page.replaceChildren(tree);
    applyText();
    const msg = aspectNotice(st.platform, doc.width, doc.height);
    notice.hidden = !msg;
    notice.replaceChildren(...(msg ? [icon("info", { size: "sm" }), h("span", null, msg)] : []));
    stage.scrollTop = 0;
  }

  const saveText = debounce(() => {
    ctx.prefs?.set?.("feedTitle", view.title);
    ctx.prefs?.set?.("feedChannel", view.channel);
  }, 400);
  titleInput.addEventListener("input", () => {
    view.title = titleInput.value;
    saveText();
    applyText();
  });
  channelInput.addEventListener("input", () => {
    view.channel = channelInput.value;
    saveText();
    applyText();
  });
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => sizeWindow());
    ro.observe(stage);
    d(() => ro.disconnect());
  } else {
    d(on(window, "resize", sizeWindow));
  }

  paintViews();
  setDistance(st.distance);
  sizeWindow();
  build();
  sheet.focus(closeBtn);

  (async () => {
    try {
      const scale = previewRenderScale(doc.width, doc.height);
      const canvas = await renderToCanvas(doc, { scale, assets: ctx.assets, fonts: ctx.fonts, background: true });
      const opaque = doc.background?.kind !== "transparent";
      const blob = await encode(canvas, opaque ? { type: "image/jpeg", quality: 0.95 } : { type: "image/png" });
      if (sheet.closed) return;
      view.url = URL.createObjectURL(blob);
      view.tint = tintFrom(averageColor(canvas));
      ready = true;
    } catch (err) {
      console.error(err);
      failed = err?.message || "The preview could not be drawn.";
    }
    if (!sheet.closed) build();
  })();

  const handle = { close: () => sheet.close() };
  current = { sheet, handle };
  return handle;
}
