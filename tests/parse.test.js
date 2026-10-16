"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core.js");
const parser = require("../lib/chart-parser.js");
const { generateChartSvg } = require("../tools/chart-svg.js");
const { loadFixture, chartSvg, docFromSvgString, assertConsecutive, readFixture } = require("./helpers.js");

const REF = "2026-03-17";

function parse(document, extra) {
  const found = parser.findCharts(document);
  assert.ok(found.length >= 1, "Posts/Replies chart found by structure");
  return parser.parseChart(found[0].svg, Object.assign({ lang: "en", reference: REF }, extra));
}

const simplify = (rows) => rows.map((r) => [r.date, r.posts, r.replies]);

// ---------------------------------------------------------------- 7D / 14D

test("7D fixture: 7 consecutive days Mar 11-17 with values read from bar heights", () => {
  const result = parse(loadFixture("chart-7d.svg").document);
  assert.ok(result.ok, JSON.stringify(result.error));
  assertConsecutive(core, assert, result.rows);
  // Derived by hand from fixtures/chart-7d.svg: scale 100px/45 => 2.222px per unit;
  // e.g. Mar 11 posts bar height 11.11 => 5, replies 77.78 => 35. Zero days have no <path>.
  assert.deepEqual(simplify(result.rows), [
    ["2026-03-11", 5, 35],
    ["2026-03-12", 3, 12],
    ["2026-03-13", 0, 18],
    ["2026-03-14", 0, 21],
    ["2026-03-15", 5, 40],
    ["2026-03-16", 4, 27],
    ["2026-03-17", 2, 15]
  ]);
});

test("14D fixture: 14 consecutive days Mar 4-17 (chart ends Mar 17, not the 'Mar 16' last label)", () => {
  const result = parse(loadFixture("chart-14d.svg").document);
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.equal(result.rows.length, 14);
  assertConsecutive(core, assert, result.rows);
  assert.equal(result.rows[0].date, "2026-03-04");
  assert.equal(result.rows[13].date, "2026-03-17");
  // 1.65px per unit: Mar 17 posts h=3.3 => 2, replies h=24.75 => 15
  assert.deepEqual(result.rows[13], { date: "2026-03-17", posts: 2, replies: 15 });
  assert.deepEqual(result.rows[0], { date: "2026-03-04", posts: 0, replies: 31 });
});

// -------------------------------------------------------------------- 3M

test("3M fixture (bug 2): 90 CONSECUTIVE dates ending 2026-03-17, no gaps or duplicates", () => {
  const { document } = loadFixture("chart-3m.html");
  const result = parse(document);
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.equal(result.rows.length, 90);
  assertConsecutive(core, assert, result.rows);
  assert.equal(result.rows[0].date, "2025-12-18");
  assert.equal(result.rows[89].date, "2026-03-17");
  assert.equal(new Set(result.rows.map((r) => r.date)).size, 90);
  // The old nearest-column snapping dropped Dec 31 and mislabeled the last bar Mar 18.
  assert.ok(result.rows.some((r) => r.date === "2025-12-31"), "Dec 31 present");
  assert.ok(result.rows.some((r) => r.date === "2026-01-01"), "Jan 1 present");
  assert.ok(!result.rows.some((r) => r.date === "2026-03-18"), "no Mar 18");
  assert.equal(result.meta.daysPerColumn.toFixed(3), "1.000");
});

test("3M fixture: value spot-checks derived from bar geometry (0.825 px per unit)", () => {
  const { document } = loadFixture("chart-3m.html");
  const result = parse(document);
  const byDate = new Map(result.rows.map((r) => [r.date, r]));
  // y axis 0/40/80/120 over a 99px plot => 0.825px per unit. Heights from fixtures/chart-3m.html:
  //   newest slot (Mar 17): posts 1.65 => 2, replies 12.375 => 15
  assert.deepEqual(byDate.get("2026-03-17"), { date: "2026-03-17", posts: 2, replies: 15 });
  //   slot 2 (Mar 15): posts 4.125 => 5, replies 33 => 40
  assert.deepEqual(byDate.get("2026-03-15"), { date: "2026-03-15", posts: 5, replies: 40 });
  //   slot 3 (Mar 14): no posts <path> => 0, replies 17.325 => 21
  assert.deepEqual(byDate.get("2026-03-14"), { date: "2026-03-14", posts: 0, replies: 21 });
  //   oldest slot (Dec 18): posts 2.475 => 3, replies 75.9 => 92
  assert.deepEqual(byDate.get("2025-12-18"), { date: "2025-12-18", posts: 3, replies: 92 });
  //   slot 87 (Dec 20): posts 10.725 => 13, replies 60.225 => 73
  assert.deepEqual(byDate.get("2025-12-20"), { date: "2025-12-20", posts: 13, replies: 73 });
});

test("3M fixture agrees with the independent 7D and 14D captures for the overlapping days", () => {
  const three = parse(loadFixture("chart-3m.html").document).rows;
  const seven = parse(loadFixture("chart-7d.svg").document).rows;
  const fourteen = parse(loadFixture("chart-14d.svg").document).rows;
  assert.deepEqual(three.slice(-7), seven);
  assert.deepEqual(three.slice(-14), fourteen);
});

test("bug 1: selected range detection uses whole class tokens; parsing does not depend on range", () => {
  const { document } = loadFixture("chart-3m.html");
  const buttons = [...document.querySelectorAll("#range-buttons button")].filter((b) => /^(7D|2W|4W|3M|1Y)$/.test(b.textContent.trim()));
  assert.equal(buttons.length, 5);
  // regression guard: every real range button contains the substring 'active' (Tailwind variant)
  assert.ok(buttons.every((b) => b.className.includes("active:bg-mix-text") || b.className.includes("active:bg-mix-background")));
  assert.deepEqual(parser.detectSelectedRange(document), { label: "3M", days: 90 });

  // re-select each button using the real class strings of the selected / unselected states
  const selectedClass = buttons.find((b) => b.textContent.trim() === "3M").className;
  const unselectedClass = buttons.find((b) => b.textContent.trim() === "7D").className;
  const baseline = parse(document).rows;
  for (const label of ["7D", "2W", "4W", "3M", "1Y"]) {
    for (const b of buttons) {
      b.className = b.textContent.trim() === label ? selectedClass : unselectedClass;
    }
    assert.equal(parser.detectSelectedRange(document).label, label);
    assert.deepEqual(parse(document).rows, baseline, `parse result must not depend on selected range (${label})`);
    assert.equal(parse(document).rows.length, 90);
  }
  // aria-pressed takes precedence when present
  buttons[0].setAttribute("aria-pressed", "true");
  buttons.slice(1).forEach((b) => b.setAttribute("aria-pressed", "false"));
  assert.equal(parser.detectSelectedRange(document).label, "7D");
});

// -------------------------------------------------------------------- 1Y

test("1Y SYNTHETIC fixture: 365 consecutive days across New Year, values round-trip", () => {
  const { document } = loadFixture("chart-1y.synthetic.html");
  const result = parse(document);
  assert.ok(result.ok, JSON.stringify(result.error));
  const expected = JSON.parse(readFixture("chart-1y.synthetic.expected.json"));
  assert.equal(result.rows.length, 365);
  assertConsecutive(core, assert, result.rows);
  assert.equal(result.rows[0].date, "2025-03-18");
  assert.equal(result.rows[364].date, "2026-03-17");
  assert.deepEqual(result.rows, expected);
  assert.ok(result.rows.some((r) => r.date === "2025-12-31") && result.rows.some((r) => r.date === "2026-01-01"));
});

// ----------------------------------------------------- bug 10: hidden series

test("bug 10: Replies hidden (one bar group) still parses; Posts values intact, replies unknown", () => {
  const { document } = loadFixture("chart-3m.html");
  const svg = chartSvg(document);
  const groups = [...svg.children].filter((el) => el.classList.contains("recharts-bar"));
  assert.equal(groups.length, 2);
  groups[1].remove(); // legend toggle hides Replies => Recharts drops that group
  assert.equal(parser.findCharts(document).length, 1, "chart still recognized with one visible series");
  const result = parser.parseChart(svg, { lang: "en", reference: REF });
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.deepEqual(result.hidden, ["replies"]);
  assert.equal(result.rows.length, 90);
  assert.ok(result.rows.every((r) => r.replies === null));
  const byDate = new Map(result.rows.map((r) => [r.date, r]));
  assert.equal(byDate.get("2026-03-17").posts, 2);
  assert.equal(byDate.get("2025-12-18").posts, 3);
  assert.equal(byDate.get("2026-03-14").posts, 0);
});

test("bug 10: Posts hidden -> the remaining group is identified as Replies by fill, not by position", () => {
  const { document } = loadFixture("chart-3m.html");
  const svg = chartSvg(document);
  const groups = [...svg.children].filter((el) => el.classList.contains("recharts-bar"));
  groups[0].remove();
  const result = parser.parseChart(svg, { lang: "en", reference: REF });
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.deepEqual(result.hidden, ["posts"]);
  assert.ok(result.rows.every((r) => r.posts === null));
  assert.equal(result.rows.find((r) => r.date === "2026-03-17").replies, 15);
});

test("bug 10: generated one-series charts parse in both directions", () => {
  for (const hide of [["replies"], ["posts"]]) {
    const gen = generateChartSvg({ days: 90, end: REF, labelEvery: 14, seed: 3, hide });
    const result = parse(docFromSvgString(gen.svg).document);
    assert.ok(result.ok, JSON.stringify(result.error));
    const shown = hide[0] === "replies" ? "posts" : "replies";
    assert.deepEqual(result.hidden, hide);
    assert.deepEqual(result.rows.map((r) => r[shown]), gen.rows.map((r) => r[shown]));
  }
});

test("a lone empty bar group cannot be identified and is reported, never guessed", () => {
  const gen = generateChartSvg({ days: 14, end: REF, labelEvery: 3, seed: 1, hide: ["replies"], values: Array.from({ length: 14 }, () => ({ posts: 0, replies: 0 })) });
  const doc = docFromSvgString(gen.svg).document;
  const result = parser.parseChart(chartSvg(doc), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "series-unidentified");
});

test("structure, not English labels: other 2-series charts (Follows/Unfollows) are not mistaken for Posts/Replies", () => {
  const gen = generateChartSvg({ days: 14, end: REF, labelEvery: 3, seed: 1 });
  const svg = gen.svg.replaceAll("--color-Posts", "--color-Follows").replaceAll("--color-Replies", "--color-Unfollows");
  const { document } = docFromSvgString(svg);
  assert.equal(parser.findCharts(document).length, 0);
  const result = parser.parseChart(chartSvg(document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "series-unidentified");
});

test("chart is found without Tailwind classes or English aria-labels (bug 14/20)", () => {
  const gen = generateChartSvg({ days: 7, end: REF, labelEvery: 2, seed: 2 });
  const { document } = docFromSvgString(gen.svg);
  const found = parser.findCharts(document);
  assert.equal(found.length, 1);
  assert.ok(found[0].card, "card falls back to a parent element");
});

test("card is the nearest ancestor containing the legend buttons (no rounded-2xl dependency)", () => {
  const { document } = loadFixture("chart-3m.html");
  const found = parser.findCharts(document);
  assert.equal(found.length, 1);
  assert.ok(found[0].card.querySelectorAll("button").length >= 2);
  assert.ok(found[0].card.contains(found[0].svg));
});

// ---------------------------------------------------- bug 13: y-axis scale

test("bug 13: abbreviated y labels (1K / 2K) are scaled correctly", () => {
  const values = Array.from({ length: 14 }, (_, i) => ({ posts: i * 150, replies: 3000 - i * 100 }));
  const gen = generateChartSvg({ days: 14, end: REF, labelEvery: 3, values, yLabel: (v) => (v === 0 ? "0" : `${v / 1000}K`) });
  assert.equal(gen.yMax, 3000);
  const result = parse(docFromSvgString(gen.svg).document);
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.deepEqual(simplify(result.rows), simplify(gen.rows));
});

test("bug 13: top y tick need not be the domain max; scale comes from fitted tick positions", () => {
  // 0/40/80/120 labels but bars drawn for a chart whose largest value is 61
  const values = Array.from({ length: 7 }, (_, i) => ({ posts: i, replies: i === 3 ? 61 : 5 }));
  const gen = generateChartSvg({ days: 7, end: REF, labelEvery: 2, values });
  const result = parse(docFromSvgString(gen.svg).document);
  assert.ok(result.ok);
  assert.deepEqual(simplify(result.rows), simplify(gen.rows));
});

test("bug 13: non-linear y labels are rejected instead of guessed", () => {
  const gen = generateChartSvg({ days: 7, end: REF, labelEvery: 2, seed: 4 });
  const svg = gen.svg.replace(/<tspan x="42" dy="0.355em">(\d+)<\/tspan>/g, (m, v) => (v === "0" ? m : m.replace(v, String(Number(v) * Number(v)))));
  const result = parser.parseChart(chartSvg(docFromSvgString(svg).document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bad-axis");
});

// ------------------------------------------------ bugs 14/15: never fabricate

test("bug 14: localized month labels parse via Intl for the document language", () => {
  const fr = (d) => new Intl.DateTimeFormat("fr", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  const gen = generateChartSvg({ days: 90, end: REF, labelEvery: 14, seed: 5, label: fr });
  const result = parser.parseChart(chartSvg(docFromSvgString(gen.svg).document), { lang: "fr", reference: REF });
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.deepEqual(result.rows.map((r) => r.date), gen.rows.map((r) => r.date));
});

test("bug 14: unparseable labels produce an error and NO rows (dates are never fabricated)", () => {
  const gen = generateChartSvg({ days: 90, end: REF, labelEvery: 14, seed: 5, label: (d) => `Zzz ${d.getUTCDate()}` });
  const result = parser.parseChart(chartSvg(docFromSvgString(gen.svg).document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "labels-unparseable");
  assert.equal(result.rows, undefined);
});

test("bug 14: a chart with no x labels at all is an error, not 'ending today'", () => {
  const gen = generateChartSvg({ days: 7, end: REF, labelEvery: 2, seed: 2 });
  const svg = gen.svg.replace(/<g class="recharts-layer recharts-cartesian-axis recharts-xAxis.*<\/svg>/, "</svg>");
  const result = parser.parseChart(chartSvg(docFromSvgString(svg).document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "labels-unparseable");
});

test("bug 14: a chart that does not end today is dated from its labels, not from the clock", () => {
  const gen = generateChartSvg({ days: 30, end: "2026-02-10", labelEvery: 7, seed: 9 });
  const result = parser.parseChart(chartSvg(docFromSvgString(gen.svg).document), { lang: "en", reference: REF });
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.equal(result.rows[29].date, "2026-02-10");
});

test("bug 15: weekly buckets (7 days per bar) are refused, not mislabeled as days", () => {
  const gen = generateChartSvg({ days: 52, end: REF, labelEvery: 4, seed: 6, columnDays: 7 });
  const result = parser.parseChart(chartSvg(docFromSvgString(gen.svg).document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "columns-not-daily");
  assert.ok(Math.abs(result.error.daysPerColumn - 7) < 0.2);
});

test("bug 15: two labels that map to the same column cannot silently overwrite", () => {
  const gen = generateChartSvg({ days: 90, end: REF, labelEvery: 14, seed: 5 });
  // squeeze two labels onto the same x
  const doc = docFromSvgString(gen.svg).document;
  const texts = [...doc.querySelectorAll(".recharts-xAxis text")];
  texts[1].setAttribute("x", texts[0].getAttribute("x"));
  const result = parser.parseChart(chartSvg(doc), { lang: "en", reference: REF });
  assert.equal(result.ok, false, "duplicate label positions must fail loudly");
});

test("label offset changes are detected loudly (sparse and dense charts)", () => {
  const sparse = generateChartSvg({ days: 7, end: REF, labelEvery: 2, seed: 2, labelOffset: 12 });
  let result = parser.parseChart(chartSvg(docFromSvgString(sparse.svg).document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "label-offset-changed");

  const dense = generateChartSvg({ days: 90, end: REF, labelEvery: 14, seed: 2, labelOffset: 7.4 });
  result = parser.parseChart(chartSvg(docFromSvgString(dense.svg).document), { lang: "en", reference: REF });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "labels-misaligned");
});

test("a chart ending after today is rejected", () => {
  const result = parse(loadFixture("chart-3m.html").document, { reference: "2026-03-10" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "future-dates");
});

test("parsing is timezone independent (3M window spans the US DST change on 2026-03-08)", () => {
  const { execFileSync } = require("node:child_process");
  const script = `
    const {parseHTML}=require("linkedom");
    const parser=require("./lib/chart-parser.js");
    const fs=require("fs");
    const {document}=parseHTML("<html><body>"+fs.readFileSync("fixtures/chart-3m.html","utf8")+"</body></html>");
    const svg=parser.findCharts(document)[0].svg;
    const r=parser.parseChart(svg,{lang:"en",reference:new Date(2026,2,17,23,30)});
    process.stdout.write(JSON.stringify(r.rows));`;
  const outputs = ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Pacific/Kiritimati"].map((TZ) =>
    execFileSync(process.execPath, ["-e", script], { cwd: require("./helpers.js").ROOT, env: { ...process.env, TZ } }).toString()
  );
  assert.equal(new Set(outputs).size, 1, "identical rows in every timezone");
  assert.equal(JSON.parse(outputs[0]).length, 90);
});

test("no parallel regex parser remains and range clamping filters are gone", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const sources = ["content.js", "lib/core.js", "lib/chart-parser.js", "lib/render.js", "lib/controller.js"].map((f) =>
    fs.readFileSync(path.join(root, f), "utf8")
  );
  const all = sources.join("\n");
  for (const banned of ["extractSeriesFromSvgMarkup", "parseBarsFromSvgMarkup", "clampSeriesToRange", "getMinimumExpectedDays", "findNearestColumnIndex", "innerHTML"]) {
    assert.ok(!all.includes(banned), `${banned} must not exist`);
  }
});
