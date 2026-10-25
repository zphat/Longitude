// The desktop app's build: the GitHub Actions workflow that makes and releases
// the Windows installer, the installer's files (icons, NSIS art, license), and
// the house rules for every desktop file (American spelling, no local paths).
//   deno test --allow-read tests/desktop-build.test.js

import assert from "node:assert/strict";

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => Deno.readTextFile(url(path));
const bytes = (path) => Deno.readFile(url(path));
const exists = async (path) => {
  try {
    await Deno.stat(url(path));
    return true;
  } catch {
    return false;
  }
};

const workflow = await read(".github/workflows/build.yml");
const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));

// The lines of one job, from "  name:" to the next job.
function job(name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `job ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[a-z][\w-]*:\s*$/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

Deno.test("workflow: publishing rights at the top level, triggers, check before build", () => {
  const top = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.match(top, /^permissions:\n {2}contents: write$/m, "top-level permissions (a job-level grant alone was not enough for Sundial)");
  assert.match(top, /^ {4}branches: \[main\]$/m);
  assert.match(top, /^ {4}tags: \["v\*"\]$/m);
  assert.match(job("windows"), /^ {4}needs: check$/m);
  assert.match(job("windows"), /^ {4}runs-on: windows-latest$/m);
  const check = job("check");
  assert.ok(check.includes("deno run --allow-read tools/check.mjs"), "module check");
  assert.ok(check.includes("deno test --allow-read tests/"), "tests");
  assert.match(check, /GITHUB_REF_NAME" != "v\$VER"/, "a tag must match the app's version, or every install is offered an update to itself");
});

Deno.test("workflow: third-party actions are pinned to a commit", () => {
  const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((m) => ({ ref: m[1], rest: m[2] }));
  assert.ok(uses.length >= 10, "found the steps");
  for (const { ref, rest } of uses) {
    const [repo, at] = ref.split("@");
    assert.ok(at, `${ref} names a version`);
    if (repo.startsWith("actions/")) assert.match(at, /^v\d+$/, `${ref}: GitHub's own actions stay on a major tag`);
    else {
      assert.match(at, /^[0-9a-f]{40}$/, `${ref} is pinned to a commit SHA`);
      assert.match(rest, /^ # \S/, `${ref} says which version the SHA is`);
    }
  }
  for (const repo of ["denoland/setup-deno", "dtolnay/rust-toolchain", "Swatinem/rust-cache", "tauri-apps/tauri-action", "softprops/action-gh-release"]) {
    assert.ok(uses.some((u) => u.ref.startsWith(`${repo}@`)), repo);
  }
});

Deno.test("workflow: the installer bundles the checked background remover", () => {
  const win = job("windows");
  const order = ["python tools/fetch_model.py --models fast", "python tools/fetch_model.py --check", "python src-tauri/stage_vendor.py --move", "npm run tauri build"];
  let at = -1;
  for (const step of order) {
    const i = win.indexOf(step);
    assert.ok(i > at, `${step} runs, after the step before it`);
    at = i;
  }
  assert.match(win, /if \(\$LASTEXITCODE -ne 0\) \{ throw "fetch_model\.py failed/, "a failed download stops the build (pwsh only fails on the last command's exit code)");
  assert.ok(win.includes("isnet-general-int8.onnx"), "the installer is checked for the Fast model");
  assert.ok(win.includes("hashFiles('web/js/features/bgremove/config.js')"), "the download cache follows config.js");
});

Deno.test("workflow: releases on tags, artifacts on every build", () => {
  const win = job("windows");
  assert.ok(win.includes("format('Longitude {0}', github.ref_name)"), "release name");
  assert.match(win, /^ {10}prerelease: false$/m, "/releases/latest (the update check) skips pre-releases");
  assert.match(win, /^ {10}releaseDraft: false$/m);
  assert.match(win, /^ {10}includeUpdaterJson: false$/m);
  assert.ok(win.includes("steps.notes.outputs.body"), "the tag message is the release text");
  assert.ok(win.includes("More info, then Run anyway"), "the unsigned-build note");
  assert.ok(win.includes("no admin password"), "the per-user install note");
  assert.ok(win.includes("Copy-Item $exe.FullName Longitude-Setup.exe"));
  assert.match(win, /files: Longitude-Setup\.exe/);
  assert.match(win, /name: Longitude-windows-installer/);
  for (const step of ["tauri-apps/tauri-action", "Copy the installer to Longitude-Setup.exe", "Attach Longitude-Setup.exe"]) {
    const block = win.slice(win.indexOf(step) - 200, win.indexOf(step) + 200);
    assert.match(block, /if: github\.ref_type == 'tag'/, `${step} only on tags`);
  }
});

Deno.test("workflow: the only commit it makes is Cargo.lock on main, with [skip ci]", () => {
  const adds = [...workflow.matchAll(/git add (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(adds, ["src-tauri/Cargo.lock"]);
  const commits = [...workflow.matchAll(/git commit -m "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(commits.length, 1);
  assert.match(commits[0], /\[skip ci\]/);
  const step = workflow.slice(workflow.indexOf("- name: Commit Cargo.lock"));
  assert.match(step, /if: github\.ref == 'refs\/heads\/main'/);
  const code = workflow.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/git tag (?!-l )/.test(code), "the workflow never makes a tag (it only reads the pushed one)");
  assert.ok(!/git push --force|git push -f\b/.test(code), "never a forced push");
});

Deno.test("tauri.conf.json: every file the installer uses exists", async () => {
  const nsis = conf.bundle.windows.nsis;
  const paths = [...conf.bundle.icon, nsis.installerIcon, nsis.uninstallerIcon, nsis.headerImage, nsis.sidebarImage, nsis.uninstallerHeaderImage, conf.bundle.licenseFile];
  for (const p of paths) assert.ok(await exists(`src-tauri/${p}`), `src-tauri/${p}`);
  assert.ok(conf.bundle.icon.includes("icons/icon.ico"), "the Windows icon");
  assert.deepEqual(conf.bundle.targets, ["nsis"], "Windows only in this pass");
  const cap = JSON.parse(await read("src-tauri/capabilities/default.json"));
  assert.ok(cap.windows.includes(conf.app.windows[0].label), "the capability covers the main window");
  assert.ok(cap.permissions.includes("core:window:allow-set-title"), "desktop.js sets the window title");
});

Deno.test("installer art: NSIS sizes, 24-bit BMP", async () => {
  for (const [file, w, h] of [["src-tauri/installer/header.bmp", 150, 57], ["src-tauri/installer/sidebar.bmp", 164, 314]]) {
    const b = await bytes(file);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    assert.equal(String.fromCharCode(b[0], b[1]), "BM", file);
    assert.equal(v.getInt32(18, true), w, `${file} width`);
    assert.equal(Math.abs(v.getInt32(22, true)), h, `${file} height`);
    assert.equal(v.getUint16(28, true), 24, `${file} bits per pixel`);
  }
});

Deno.test("icon.ico has the sizes Windows asks for", async () => {
  const b = await bytes("src-tauri/icons/icon.ico");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(v.getUint16(0, true), 0);
  assert.equal(v.getUint16(2, true), 1, "an icon, not a cursor");
  const sizes = [];
  for (let i = 0; i < v.getUint16(4, true); i++) sizes.push(b[6 + i * 16] || 256);
  for (const s of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(s), `${s} px frame (${sizes.join(", ")})`);
});

Deno.test("the installer's license page is LICENSE with Windows line endings", async () => {
  const copy = await read(conf.bundle.licenseFile.startsWith("installer/") ? `src-tauri/${conf.bundle.licenseFile}` : conf.bundle.licenseFile);
  const original = await read("LICENSE");
  assert.equal(copy.replace(/\r\n/g, "\n"), original.replace(/\r\n/g, "\n"), "run: python -c \"open('src-tauri/installer/license.txt','w',newline='\\r\\n').write(open('LICENSE').read())\"");
  assert.ok(copy.includes("\r\n") && !/[^\r]\n/.test(copy), "CRLF only (src-tauri/.gitattributes)");
  assert.match(await read("src-tauri/.gitattributes"), /^installer\/license\.txt text eol=crlf$/m);
});

const DESKTOP_FILES = [
  "web/js/app/desktop.js",
  "docs/DESKTOP.md",
  "src-tauri/src/lib.rs",
  "src-tauri/src/main.rs",
  "src-tauri/build.rs",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "src-tauri/capabilities/default.json",
  "src-tauri/stage_vendor.py",
  "src-tauri/make_art.py",
  "src-tauri/.gitignore",
  "package.json",
  ".github/workflows/build.yml",
];

Deno.test("desktop files: American spelling, no local paths", async () => {
  for (const file of DESKTOP_FILES) {
    const text = await read(file);
    const british = [...text.matchAll(/colour|centre|\bgrey|licence|behaviour|favourite|\bcancelled\b/gi)].map((m) => m[0]);
    assert.deepEqual(british, [], `${file}: ${british.join(", ")}`);
    assert.ok(!/[A-Za-z]:[\\/]+Users[\\/]/i.test(text) && !/\/home\/[a-z]/.test(text), `${file} has no local path`);
  }
});

Deno.test("the vendor folder the installer bundles is never committed", async () => {
  assert.match(await read("src-tauri/.gitignore"), /^\/vendor\/$/m);
  assert.match(await read(".gitignore"), /^web\/vendor\/$/m);
  assert.match(await read("src-tauri/build.rs"), /"\.\.\/web\/vendor"/, "build.rs warns when web/vendor/ would be compiled in");
});
