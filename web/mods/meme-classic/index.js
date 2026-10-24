// Classic meme: top and bottom text in Impact, white with a black outline.
//
// Shows two extension points:
//   - a command ("Classic meme text") that adds two text layers as one undo step
//   - an inspector section ("Meme") for selected text layers
//
// Everything the mod adds goes through api.*.register(), so turning the mod off
// in Settings > Mods removes it again. No deactivate() is needed.

export const manifest = {
  id: "meme-classic",
  name: "Classic meme",
  version: "1.0.0",
  author: "Longitude",
  homepage: "https://github.com/zphat/Longitude/tree/main/web/mods/meme-classic",
  description: "Top and bottom text in Impact, white with a black outline. Adds a command and a Meme section for text.",
  apiVersion: 1,
};

// Impact is a system font. When this computer does not have it, use Anton,
// the bundled font that looks closest.
function memeFont(api) {
  return api.fonts.get("Impact")?.available ? "Impact" : "Anton";
}

// The look, sized for a text layer of the given font size.
function classicLook(font, size) {
  return {
    font,
    weight: 400,
    italic: false,
    color: "#ffffff",
    gradient: { on: false },
    uppercase: true,
    align: "center",
    letterSpacing: 0,
    lineHeight: 1,
    stroke: { on: true, color: "#000000", width: Math.max(2, Math.round(size * 0.065)) },
    stroke2: { on: false },
    bg: { on: false },
  };
}

async function addMemeText(api) {
  const { width: W, height: H } = api.store.doc;
  const font = memeFont(api);
  // Load the font first so the layers are measured with the right shapes.
  await api.fonts.load(font, 400);

  const size = Math.round(Math.min(W * 0.1, H * 0.16));
  const margin = Math.round(Math.min(W, H) * 0.04);
  const base = {
    type: "text",
    size,
    wrap: "fixed",
    w: Math.round(W * 0.92),
    x: W / 2,
    ...classicLook(font, size),
  };

  // One transaction = one undo step, even though it adds and then moves.
  const ids = api.store.transaction("Classic meme text", (store) => {
    const added = store.add([
      { ...base, name: "Top text", text: "Top text", y: H * 0.15 },
      { ...base, name: "Bottom text", text: "Bottom text", y: H * 0.85 },
    ]);
    // Text height comes from layout, so place the boxes once they are measured.
    const [top, bottom] = added.map((id) => store.get(id));
    store.patch(top.id, { y: margin + top.h / 2 });
    store.patch(bottom.id, { y: H - margin - bottom.h / 2 });
    return added;
  });
  api.editor.flash(ids);
}

function makeClassic(api, layers) {
  const font = memeFont(api);
  api.fonts.load(font, 400);
  api.store.patch(
    layers.map((l) => l.id),
    (layer) => classicLook(font, layer.size),
    { label: "Make it classic" }
  );
}

const selectedText = (api) => api.store.selected().filter((l) => l.type === "text");

export function activate(api) {
  api.commands.register({
    id: "meme-classic.add",
    title: "Classic meme text",
    group: "Insert",
    icon: "type",
    keywords: "meme impact caption top bottom text",
    run: (api) => addMemeText(api),
  });

  api.commands.register({
    id: "meme-classic.apply",
    title: "Make text classic meme style",
    group: "Text",
    keywords: "meme impact white black outline uppercase",
    when: (api) => selectedText(api).length > 0,
    run: (api) => makeClassic(api, selectedText(api)),
  });

  api.inspector.register({
    id: "meme-classic",
    title: "Meme",
    order: 16,
    when: (layers) => layers.length > 0 && layers.every((l) => l.type === "text"),
    render(body, layers, api) {
      const { button } = api.controls;
      body.append(
        api.h("p", { class: "mod-hint" }, "Impact, white fill, black outline, all caps."),
        button({ label: "Make it classic", wide: true, onClick: () => makeClassic(api, selectedText(api)) }),
        button({ label: "Add top and bottom text", kind: "ghost", wide: true, onClick: () => api.commands.run("meme-classic.add") })
      );
    },
  });
}
