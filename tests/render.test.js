"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const core = require("../lib/core.js");
const render = require("../lib/render.js");
const parser = require("../lib/chart-parser.js");
const { loadFixture } = require("./helpers.js");

function newPanel(options) {
  const { document } = parseHTML("<html><body></body></html>");
  const ctl = render.createPanelController(document, Object.assign({ version: "9.9.9", locale: "en-US" }, options));
  document.body.append(ctl.panel);
  return { document, ctl };
}

function rows3m() {
  const result = parser.parseChart(parser.findCharts(loadFixture("chart-3m.html").document)[0].svg, { lang: "en", reference: "2026-03-17" });
  assert.ok(result.ok);
  return result.rows;
}

const cellsOf = (panel) => [...panel.querySelectorAll(".xheatgrid-cell")];

test("renders the 3M window: Sunday-first columns, 90 data cells, region role (bug 5, 16)", () => {
  const { ctl } = newPanel();
  ctl.renderReady({ rows: rows3m(), hidden: [], approximate: true, source: "read from chart", notes: [] });
  const panel = ctl.panel;
  assert.equal(panel.getAttribute("role"), "region");
  assert.ok(panel.getAttribute("aria-label"));
  assert.equal(panel.dataset.state, "ready");
  const columns = [...panel.querySelectorAll(".xheatgrid-week")];
  assert.equal(columns.length, 14);
  for (const column of columns) {
    const first = column.children[0];
    assert.equal(first.dataset.row, "0");
    assert.equal(core.weekday(core.parseDayKey(first.dataset.date)), 0, "row 0 is Sunday");
    assert.equal(core.weekday(core.parseDayKey(column.children[6].dataset.date)), 6);
  }
  assert.equal(cellsOf(panel).filter((c) => c.dataset.level !== "none").length, 90);
  assert.equal(ctl.elements.badge.hidden, false, "approximate badge");
  assert.match(panel.querySelector(".xheatgrid-version").textContent, /v9\.9\.9/);
});

test("bug 4: zero-activity days are level 0 (dark fill); outside-window cells are 'none' (outline)", () => {
  const { ctl } = newPanel();
  ctl.renderReady({
    rows: [
      { date: "2026-03-10", posts: 0, replies: 0 },
      { date: "2026-03-11", posts: 5, replies: 5 },
      { date: "2026-03-12", posts: 1, replies: 0 }
    ],
    hidden: [],
    notes: []
  });
  const byDate = new Map(cellsOf(ctl.panel).map((c) => [c.dataset.date, c]));
  assert.equal(byDate.get("2026-03-10").dataset.level, "0");
  assert.equal(byDate.get("2026-03-11").dataset.level, "4");
  assert.equal(byDate.get("2026-03-12").dataset.level, "1");
  assert.equal(byDate.get("2026-03-09").dataset.level, "none");
  assert.match(byDate.get("2026-03-09").dataset.tooltip, /No data/);
  const levels = [...ctl.panel.querySelectorAll(".xheatgrid-swatch")].map((s) => s.dataset.level);
  assert.deepEqual(levels, ["0", "1", "2", "3", "4"], "legend uses the same five buckets");
});

test("bug 8: no title attribute (no native tooltip), aria-label kept, ONE tooltip outside scroller and card", () => {
  const { ctl } = newPanel();
  ctl.renderReady({ rows: rows3m(), hidden: [], notes: [] });
  const cells = cellsOf(ctl.panel);
  assert.ok(cells.length > 90);
  assert.ok(cells.every((c) => !c.hasAttribute("title")), "no title attributes");
  assert.ok(cells.every((c) => c.getAttribute("aria-label")), "aria-label on every cell");
  assert.ok(cells.every((c) => c.tagName === "BUTTON"));
  const tooltips = ctl.panel.querySelectorAll(".xheatgrid-tooltip");
  assert.equal(tooltips.length, 1);
  const tooltip = tooltips[0];
  assert.equal(tooltip.getAttribute("role"), "tooltip");
  assert.equal(tooltip.closest(".xheatgrid-scroll"), null);
  assert.equal(tooltip.closest(".xheatgrid-card"), null);
  assert.equal(tooltip.hidden, true);

  Object.defineProperty(tooltip, "offsetHeight", { value: 30, configurable: true });
  Object.defineProperty(tooltip, "offsetWidth", { value: 80, configurable: true });
  const cell = ctl.panel.querySelector('[data-date="2026-03-17"]');
  cell.getBoundingClientRect = () => ({ left: 100, top: 20, right: 112, bottom: 32, width: 12, height: 12 });
  cell.dispatchEvent(new (parseHTML("").window.Event)("mouseover", { bubbles: true }));
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.textContent, /Mar 17, 2026/);
  assert.match(tooltip.textContent, /Posts: 2/);
  assert.match(tooltip.textContent, /Replies: 15/);
  // near the top of the viewport it flips below the cell instead of being clipped
  assert.equal(tooltip.style.top, "40px");
  cell.dispatchEvent(new (parseHTML("").window.Event)("mouseout", { bubbles: true }));
  assert.equal(tooltip.hidden, true);
  cell.dispatchEvent(new (parseHTML("").window.Event)("focusin", { bubbles: true }));
  assert.equal(tooltip.hidden, false, "shown on focus too");
});

test("bug 8: stylesheet has no pseudo-element tooltips and no clipping overflow on the scroller", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "heatmap.css"), "utf8");
  assert.ok(!/::after/.test(css) && !/::before/.test(css), "no ::after/::before tooltips");
  assert.ok(!/overflow-y:\s*visible/.test(css));
  assert.match(css, /\.xheatgrid-tooltip\s*\{[^}]*position:\s*fixed/);
});

test("bug 7: loading/empty/error states hide AND clear the previous data", () => {
  const { ctl } = newPanel();
  ctl.renderReady({ rows: rows3m(), hidden: [], notes: [] });
  assert.ok(cellsOf(ctl.panel).length > 0);
  ctl.setState("loading", "Waiting for the analytics chart…");
  assert.equal(ctl.panel.dataset.state, "loading");
  assert.equal(ctl.elements.content.hidden, true);
  assert.equal(cellsOf(ctl.panel).length, 0, "old grid removed");
  assert.equal(ctl.panel.querySelector(".xheatgrid-summary").children.length, 0, "old totals removed");
  assert.equal(ctl.elements.message.hidden, false);
  assert.match(ctl.elements.message.textContent, /Waiting/);
  assert.equal(ctl.elements.status.textContent, "");
  for (const state of ["empty", "error"]) {
    ctl.setState(state, `x ${state}`);
    assert.equal(ctl.panel.dataset.state, state);
  }
  assert.throws(() => ctl.setState("ready"));
});

test("bug 16: status counts ACTIVE days, not every parsed day", () => {
  const { ctl } = newPanel();
  ctl.renderReady({
    rows: [
      { date: "2026-03-10", posts: 0, replies: 0 },
      { date: "2026-03-11", posts: 0, replies: 0 },
      { date: "2026-03-12", posts: 1, replies: 0 },
      { date: "2026-03-13", posts: 0, replies: 4 }
    ],
    hidden: [],
    notes: []
  });
  assert.match(ctl.elements.status.textContent, /4 days, 2 active/);
});

test("bug 16: re-render keeps the scroll position; first render scrolls to the newest week", () => {
  const { ctl } = newPanel();
  const scroll = ctl.elements.scroll;
  Object.defineProperty(scroll, "scrollWidth", { value: 1000, configurable: true });
  Object.defineProperty(scroll, "clientWidth", { value: 300, configurable: true });
  ctl.renderReady({ rows: rows3m(), hidden: [], notes: [] });
  assert.equal(scroll.scrollLeft, 1000, "newest on screen after first render");
  scroll.scrollLeft = 120; // user scrolled back
  ctl.renderReady({ rows: rows3m().slice(0, 80), hidden: [], notes: [] });
  assert.equal(scroll.scrollLeft, 120, "scroll not reset by data change");
  scroll.scrollLeft = 700; // at the end again
  ctl.renderReady({ rows: rows3m(), hidden: [], notes: [] });
  assert.equal(scroll.scrollLeft, 1000, "stays pinned to the newest when already there");
});

test("bug 16: close removes the panel and notifies; minimize toggles", () => {
  let closed = 0;
  const { document, ctl } = newPanel({ onClose: () => (closed += 1) });
  ctl.renderReady({ rows: rows3m(), hidden: [], notes: [] });
  const click = () => new (parseHTML("").window.Event)("click", { bubbles: true });
  ctl.elements.minimize.dispatchEvent(click());
  assert.equal(ctl.panel.dataset.minimized, "true");
  assert.equal(ctl.elements.minimize.getAttribute("aria-expanded"), "false");
  ctl.elements.minimize.dispatchEvent(click());
  assert.equal(ctl.panel.dataset.minimized, "false");
  ctl.elements.close.dispatchEvent(click());
  assert.equal(closed, 1);
  assert.equal(document.getElementById("xheatgrid-panel"), null);
});

test("bug 10: hidden series note; tooltip marks last-known and unknown values", () => {
  const { ctl } = newPanel();
  ctl.renderReady({
    rows: [
      { date: "2026-03-10", posts: 2, replies: 7 },
      { date: "2026-03-11", posts: 3, replies: null }
    ],
    hidden: ["replies"],
    notes: ["Replies hidden - counts shown are posts only"]
  });
  assert.match(ctl.panel.querySelector(".xheatgrid-notes").textContent, /Replies hidden - counts shown are posts only/);
  const d10 = ctl.panel.querySelector('[data-date="2026-03-10"]');
  const d11 = ctl.panel.querySelector('[data-date="2026-03-11"]');
  assert.match(d10.dataset.tooltip, /Replies: 7 \(last known\)/);
  assert.match(d11.dataset.tooltip, /Replies: unknown/);
});

test("untrusted strings are never interpreted as markup", () => {
  const { ctl } = newPanel({ version: '1"><img src=x onerror=alert(1)>' });
  ctl.renderReady({ rows: [{ date: "2026-03-10", posts: 1, replies: 0 }], hidden: [], notes: ["<img src=x onerror=alert(1)>"] });
  assert.equal(ctl.panel.querySelectorAll("img").length, 0);
});

test("keyboard: arrow keys move focus between cells (roving tabindex)", () => {
  const { ctl } = newPanel();
  ctl.renderReady({ rows: rows3m(), hidden: [], notes: [] });
  const tabbable = cellsOf(ctl.panel).filter((c) => c.getAttribute("tabindex") === "0");
  assert.equal(tabbable.length, 1);
  assert.equal(tabbable[0].dataset.date, "2026-03-17", "newest day is the tab stop");
  const left = tabbable[0];
  let focused = null;
  const target = ctl.panel.querySelector('[data-date="2026-03-10"]');
  target.focus = () => (focused = target);
  const Event = parseHTML("").window.Event;
  const event = new Event("keydown", { bubbles: true });
  event.key = "ArrowLeft";
  left.dispatchEvent(event);
  assert.equal(focused, target, "ArrowLeft goes to the same weekday last week");
  assert.equal(target.getAttribute("tabindex"), "0");
  assert.equal(left.getAttribute("tabindex"), "-1");
});
