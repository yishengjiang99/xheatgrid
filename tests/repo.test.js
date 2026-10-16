"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("bug 19: one version everywhere (manifest, package.json, CHANGELOG); no hard-coded BUILD_VERSION", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(manifest.version, pkg.version);
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, new RegExp(`^## ${manifest.version.replace(/\./g, "\\.")}\\b`, "m"));
  for (const file of ["content.js", "bridge-main.js", ...fs.readdirSync(path.join(ROOT, "lib")).map((f) => `lib/${f}`)]) {
    const source = read(file);
    assert.ok(!/BUILD_VERSION/.test(source), `${file} has no BUILD_VERSION`);
    assert.ok(!/["']v?0\.\d+\.\d+["']/.test(source), `${file} has no hard-coded version literal`);
  }
});

test("bug 19: no unneeded permissions; MAIN-world bridge at document_start; script order", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined, "declarative content scripts need no host_permissions");
  assert.deepEqual(manifest.permissions || [], []);
  assert.ok(Number(manifest.minimum_chrome_version) >= 111, "world: MAIN needs Chrome 111+");
  const [main, isolated] = manifest.content_scripts;
  assert.equal(main.world, "MAIN");
  assert.equal(main.run_at, "document_start");
  assert.deepEqual(main.js, ["bridge-main.js"]);
  assert.equal(isolated.world, undefined);
  assert.deepEqual(isolated.js, ["lib/core.js", "lib/chart-parser.js", "lib/render.js", "lib/controller.js", "content.js"]);
  for (const file of [...main.js, ...isolated.js, ...isolated.css]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  }
});

test("bug 21: the 900 KB logged-in dump is gone; the 3M fixture is trimmed and scrubbed", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "sampledom.html")));
  const fixture = read("fixtures/chart-3m.html");
  assert.ok(fixture.length < 200 * 1024, `fixture is ${fixture.length} bytes`);
  assert.equal((fixture.match(/<svg[^>]*recharts-surface/g) || []).length, 1, "only the Posts/Replies chart");
  for (const forbidden of [/xheatgrid/i, /@[A-Za-z0-9_]{2,}/, /data-testid/, /yisheng/i, /<script/i, /https?:\/\/(?!www\.w3\.org)/]) {
    assert.ok(!forbidden.test(fixture), `fixture must not match ${forbidden}`);
  }
  for (const label of ["7D", "2W", "4W", "3M", "1Y"]) {
    assert.ok(fixture.includes(`>${label}<`), `range button ${label} kept`);
  }
  assert.match(read("fixtures/chart-1y.synthetic.html"), /SYNTHETIC/);
});

test("classic-script load (no module system): files attach to XHeatgrid and the bootstrap starts cleanly", () => {
  const { document } = parseHTML('<html lang="en"><body></body></html>');
  const calls = { observe: 0, listeners: [], posted: [] };
  const context = {
    document,
    location: { href: "https://x.com/home", pathname: "/home", origin: "https://x.com" },
    console,
    chrome: { runtime: { getManifest: () => ({ version: manifest.version }) } },
    MutationObserver: class {
      observe() {
        calls.observe += 1;
      }
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    Intl,
    Date,
    JSON,
    Math
  };
  context.self = context;
  context.window = context;
  context.postMessage = (m) => calls.posted.push(m);
  context.addEventListener = (type) => calls.listeners.push(type);
  vm.createContext(context);
  for (const file of manifest.content_scripts[1].js) {
    vm.runInContext(read(file), context, { filename: file });
  }
  for (const name of ["parseChart", "findCharts", "buildSeriesFromGeometry", "createPanelController", "createController", "buildWeeks"]) {
    assert.equal(typeof context.XHeatgrid[name], "function", `XHeatgrid.${name}`);
  }
  assert.ok(calls.observe >= 1, "page observer installed");
  assert.deepEqual(calls.listeners.sort(), ["hashchange", "message", "popstate"]);
  assert.equal(calls.posted[0].type, "xheatgrid:scan-request");
});
