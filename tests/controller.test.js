"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const { createController } = require("../lib/controller.js");
const { readFixture } = require("./helpers.js");

const ANALYTICS = "/i/account_analytics";

/** Deterministic environment: fake clock/timers, scripted MutationObserver, mutable location. */
function makeEnv(options) {
  const o = Object.assign({ path: ANALYTICS, withChart: true, debug: false }, options);
  const { document, window } = parseHTML(
    `<html lang="en"><body><main id="app">${o.withChart ? readFixture("chart-3m.html") : "<p>other page</p>"}</main></body></html>`
  );
  const clock = { t: new Date(2026, 2, 17, 12, 0, 0).getTime() };
  const timers = [];
  let timerId = 1;
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.root = null;
    }
    observe(root) {
      this.root = root;
      observers.push(this);
    }
    disconnect() {
      const i = observers.indexOf(this);
      if (i >= 0) {
        observers.splice(i, 1);
      }
    }
  }
  const location = { href: `https://x.com${o.path}`, pathname: o.path };
  const listeners = {};
  const navListeners = {};
  const posted = [];
  const logs = { debug: [], warn: [] };
  const env = {
    document,
    window: window,
    location: Object.assign(location, { origin: "https://x.com" }),
    console: { debug: (...a) => logs.debug.push(a), warn: (...a) => logs.warn.push(a) },
    storage: { getItem: (k) => (o.debug && k === "xheatgrid:debug" ? "1" : null) },
    MutationObserver: FakeMutationObserver,
    version: "9.9.9",
    navigation: { addEventListener: (type, fn) => ((navListeners[type] = navListeners[type] || []).push(fn)) },
    postToBridge: (m) => posted.push(m),
    addWindowListener: (type, fn) => ((listeners[type] = listeners[type] || []).push(fn)),
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const id = timerId++;
      timers.push({ id, fn, at: clock.t + ms });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) {
        timers.splice(i, 1);
      }
    }
  };
  function advance(ms) {
    const end = clock.t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) {
        break;
      }
      timers.shift();
      clock.t = Math.max(clock.t, next.at);
      next.fn();
    }
    clock.t = end;
  }
  /** deliver records to observers whose root contains the target (like a browser would) */
  function emit(records) {
    for (const observer of [...observers]) {
      const mine = records.filter((r) => observer.root === r.target || observer.root.contains(r.target));
      if (mine.length) {
        observer.callback(mine);
      }
    }
  }
  const foreign = () => ({ type: "childList", target: document.getElementById("app"), addedNodes: [], removedNodes: [] });
  const messageEvent = (data, extra) => Object.assign({ source: window, origin: "https://x.com", data }, extra);
  return { env, document, window, advance, emit, foreign, location, posted, logs, listeners, navListeners, messageEvent, clock, timers, observers };
}

function startController(options) {
  const h = makeEnv(options);
  const controller = createController(h.env);
  controller.start();
  return Object.assign(h, { controller });
}

const panelState = (h) => h.controller.getPanel() && h.controller.getPanel().dataset.state;
const dataCells = (h) => [...h.document.querySelectorAll("#xheatgrid-panel .xheatgrid-cell")].filter((c) => c.dataset.level !== "none");

test("on the analytics path the panel appears: loading, then ready after two matching reads", () => {
  const h = startController();
  h.advance(160);
  assert.equal(panelState(h), "loading", "first read is not trusted yet (mid-animation protection)");
  h.advance(300);
  assert.equal(panelState(h), "ready");
  assert.equal(dataCells(h).length, 90);
  assert.ok(h.controller.stats().refreshCount <= 3);
  assert.equal(h.document.querySelectorAll("#xheatgrid-panel").length, 1);
  assert.match(h.controller.getPanelController().elements.status.textContent, /90 days/);
});

test("bug 6: an idle tab does not refresh repeatedly", () => {
  const h = startController();
  h.advance(1000);
  const settled = h.controller.stats().refreshCount;
  h.advance(120000);
  assert.equal(h.controller.stats().refreshCount, settled, "no refreshes while idle for 2 minutes");
  assert.equal(h.controller.stats().pending, false);
});

test("bug 6: ready panel + chart disappears does NOT start a refresh loop (own writes are ignored)", () => {
  const h = startController();
  h.advance(1000);
  assert.equal(panelState(h), "ready");
  const app = h.document.getElementById("app");
  const chartHtmlRemoved = app.firstElementChild;
  app.replaceChildren(); // the chart (and range buttons) vanish, e.g. another analytics sub-tab
  const outsideBefore = h.document.getElementById("app").outerHTML;
  h.emit([{ type: "childList", target: app, addedNodes: [], removedNodes: [chartHtmlRemoved] }]);
  h.advance(700);
  assert.equal(panelState(h), "loading");
  const afterRemoval = h.controller.stats().refreshCount;

  // Simulate what a browser reports for every write the extension itself makes inside its panel.
  const panel = h.controller.getPanel();
  const status = panel.querySelector("[data-role='status']");
  const message = panel.querySelector("[data-role='message']");
  for (let i = 0; i < 300; i += 1) {
    h.emit([
      { type: "childList", target: message, addedNodes: [message.firstChild].filter(Boolean), removedNodes: [] },
      { type: "characterData", target: status.firstChild || status, addedNodes: [], removedNodes: [] },
      { type: "childList", target: h.document.body, addedNodes: [panel], removedNodes: [] }
    ]);
    h.advance(100);
  }
  const count = h.controller.stats().refreshCount;
  // allowed: the one-shot loading->empty timeout (8s) only
  assert.ok(count - afterRemoval <= 2, `refreshes after removal: ${count - afterRemoval}`);
  assert.equal(panelState(h), "empty");
  // and everything the controller wrote outside the panel: nothing
  assert.equal(h.document.getElementById("app").outerHTML, outsideBefore);
  // no more activity at all once settled
  h.advance(60000);
  assert.equal(h.controller.stats().refreshCount, count);
});

test("bug 6: repeated waiting refreshes do not rewrite the status text (writes only on change)", () => {
  const h = startController({ withChart: false });
  h.advance(300);
  assert.equal(panelState(h), "loading");
  const message = h.controller.getPanel().querySelector("[data-role='message']");
  const node = message.firstChild;
  for (let i = 0; i < 5; i += 1) {
    h.controller.refresh(["test"]);
  }
  assert.equal(message.firstChild, node, "same text node: no re-write when unchanged");
});

test("bug 7: no chart -> explicit loading state, then empty after the timeout; old data is gone", () => {
  const h = startController({ withChart: false });
  h.advance(200);
  assert.equal(panelState(h), "loading");
  assert.equal(dataCells(h).length, 0);
  h.advance(9000);
  assert.equal(panelState(h), "empty");
  assert.match(h.controller.getPanelController().elements.message.textContent, /No Posts\/Replies chart/);
});

test("bug 12: a constantly mutating page cannot starve refresh and cannot flood it", () => {
  const h = startController({ withChart: false });
  h.advance(300);
  const before = h.controller.stats().refreshCount;
  for (let t = 0; t < 5000; t += 20) {
    h.emit([h.foreign()]);
    h.advance(20);
  }
  const refreshes = h.controller.stats().refreshCount - before;
  assert.ok(refreshes >= 5, `refreshed ${refreshes} times in 5s of constant mutation (max-wait ~500ms)`);
  assert.ok(refreshes <= 14, `bounded: ${refreshes}`);
});

test("bug 12: off the analytics path only URL changes matter (mutation flood is free)", () => {
  const h = startController({ path: "/home", withChart: false });
  h.advance(300);
  assert.equal(h.document.getElementById("xheatgrid-panel"), null, "no panel off-path");
  const before = h.controller.stats().refreshCount;
  for (let i = 0; i < 2000; i += 1) {
    h.emit([h.foreign()]);
  }
  h.advance(5000);
  assert.equal(h.controller.stats().refreshCount, before, "mutations off-path schedule nothing");
});

test("bug 11: navigating away removes the panel; navigating back restores it without a reload", () => {
  const h = startController();
  h.advance(1000);
  assert.equal(panelState(h), "ready");

  // SPA navigation to another page: Navigation API event
  h.location.pathname = "/home";
  h.location.href = "https://x.com/home";
  h.navListeners.navigatesuccess.forEach((fn) => fn());
  h.advance(10);
  assert.equal(h.document.getElementById("xheatgrid-panel"), null);

  // back to analytics, detected through the MAIN-world bridge's history hook message
  h.location.pathname = ANALYTICS;
  h.location.href = `https://x.com${ANALYTICS}`;
  h.listeners.message.forEach((fn) => fn(h.messageEvent({ source: "xheatgrid-bridge", type: "xheatgrid:navigate" })));
  h.advance(1000);
  assert.equal(panelState(h), "ready");
  assert.equal(dataCells(h).length, 90);
});

test("bug 11: URL change is also detected from a page mutation (no Navigation API / MAIN hook)", () => {
  const h = startController();
  h.advance(1000);
  h.location.pathname = "/explore";
  h.location.href = "https://x.com/explore";
  h.emit([h.foreign()]);
  assert.equal(h.document.getElementById("xheatgrid-panel"), null);
  h.location.pathname = ANALYTICS;
  h.location.href = `https://x.com${ANALYTICS}`;
  h.emit([h.foreign()]);
  h.advance(1000);
  assert.equal(panelState(h), "ready");
});

test("bug 6: sub-tab under /i/account_analytics/... without the chart settles into 'empty' (no loop)", () => {
  const h = startController({ path: `${ANALYTICS}/audience`, withChart: false });
  h.advance(12000);
  const settled = h.controller.stats().refreshCount;
  assert.equal(panelState(h), "empty");
  h.advance(60000);
  assert.equal(h.controller.stats().refreshCount, settled);
});

test("closing the panel keeps it closed until the user leaves and returns", () => {
  const h = startController();
  h.advance(1000);
  h.controller.getPanelController().elements.close.dispatchEvent(new (parseHTML("").window.Event)("click", { bubbles: true }));
  assert.equal(h.document.getElementById("xheatgrid-panel"), null);
  h.emit([h.foreign()]);
  h.advance(2000);
  assert.equal(h.document.getElementById("xheatgrid-panel"), null, "stays closed");
  h.location.pathname = "/home";
  h.location.href = "https://x.com/home";
  h.controller.checkUrl("test");
  h.location.pathname = ANALYTICS;
  h.location.href = `https://x.com${ANALYTICS}`;
  h.controller.checkUrl("test");
  h.advance(1000);
  assert.equal(panelState(h), "ready");
});

test("bug 10: hiding Replies keeps the heatmap, shows the note, keeps last known replies", () => {
  const h = startController();
  h.advance(1000);
  const svg = h.document.querySelector("svg.recharts-surface");
  const groups = [...svg.children].filter((el) => el.classList.contains("recharts-bar"));
  groups[1].remove();
  h.emit([{ type: "childList", target: svg, addedNodes: [], removedNodes: [groups[1]] }]);
  h.advance(1000);
  assert.equal(panelState(h), "ready");
  assert.equal(dataCells(h).length, 90);
  const notes = h.document.querySelector("#xheatgrid-panel .xheatgrid-notes").textContent;
  assert.match(notes, /Replies hidden - counts shown are posts only/);
  const newest = h.document.querySelector('#xheatgrid-panel [data-date="2026-03-17"]');
  assert.match(newest.dataset.tooltip, /Replies: 15 \(last known\)/);
});

test("bug 13: a reading is accepted only after two consecutive matching reads (mid-animation heights ignored)", () => {
  const h = startController();
  h.advance(160); // first read
  assert.equal(panelState(h), "loading");
  const svg = h.document.querySelector("svg.recharts-surface");
  const group = [...svg.children].filter((el) => el.classList.contains("recharts-bar"))[1];
  const path = group.querySelector("path");
  const original = path.getAttribute("height");
  path.setAttribute("height", String(Number(original) / 2)); // animation frame
  h.emit([{ type: "attributes", target: path, addedNodes: [], removedNodes: [] }]);
  h.advance(160);
  assert.notEqual(panelState(h), "ready", "differing reads are not accepted");
  path.setAttribute("height", original); // animation settles back
  h.emit([{ type: "attributes", target: path, addedNodes: [], removedNodes: [] }]);
  h.advance(160);
  h.advance(160);
  assert.equal(panelState(h), "ready");
  const newest = h.document.querySelector('#xheatgrid-panel [data-date="2026-03-17"]');
  assert.match(newest.dataset.tooltip, /Replies: 15/);
});

test("bridge rows are validated, merged by date and beat pixel-derived values", () => {
  const h = startController();
  h.advance(1000);
  const send = (data, extra) => h.listeners.message.forEach((fn) => fn(h.messageEvent(data, extra)));
  const good = { source: "xheatgrid-bridge", type: "xheatgrid:rows", via: "react", rows: [{ date: "2026-03-17", posts: 3, replies: 16 }, { date: "bad", posts: 1, replies: 1 }, { date: "2026-03-16", posts: -4, replies: 1 }] };

  // ignored: wrong source window, wrong origin, wrong namespace, wrong via
  send(good, { source: {} });
  send(good, { origin: "https://evil.example" });
  send(Object.assign({}, good, { source: "something-else" }));
  send(Object.assign({}, good, { via: "page-script" }));
  h.advance(1000);
  assert.equal(h.controller.getStore().days.get("2026-03-17").postsSource, "chart");

  send(good);
  h.advance(1000);
  const entry = h.controller.getStore().days.get("2026-03-17");
  assert.deepEqual([entry.posts, entry.replies, entry.postsSource], [3, 16, "data"]);
  assert.equal(h.controller.getStore().days.get("2026-03-16").postsSource, "chart", "invalid rows dropped");
  const cell = h.document.querySelector('#xheatgrid-panel [data-date="2026-03-17"]');
  assert.match(cell.dataset.tooltip, /Posts: 3\n.*Replies: 16/s);
  // a later chart read must not overwrite X's data
  h.controller.refresh(["test"]);
  h.advance(1000);
  assert.equal(h.controller.getStore().days.get("2026-03-17").posts, 3);
});

test("bug 14: unreadable labels -> explicit error state, warned once, no invented dates", () => {
  const h = startController();
  const texts = [...h.document.querySelectorAll(".recharts-xAxis tspan")];
  texts.forEach((t) => (t.textContent = "???"));
  h.advance(2000);
  assert.equal(panelState(h), "error");
  assert.equal(dataCells(h).length, 0);
  assert.match(h.controller.getPanelController().elements.message.textContent, /Unable to read the chart/);
  for (let i = 0; i < 5; i += 1) {
    h.controller.refresh(["again"]);
  }
  assert.equal(h.logs.warn.length, 1, "same error is logged once");
});

test("debug flag: refresh counter + console.debug, absent when the flag is off", () => {
  const on = startController({ debug: true });
  on.advance(1000);
  assert.equal(on.document.documentElement.getAttribute("data-xheatgrid-refreshes"), String(on.controller.stats().refreshCount));
  assert.ok(on.logs.debug.some((args) => String(args[1]).startsWith("refresh #")));
  const off = startController();
  off.advance(1000);
  assert.equal(off.document.documentElement.getAttribute("data-xheatgrid-refreshes"), null);
  assert.equal(off.logs.debug.length, 0);
});

test("the controller asks the MAIN-world bridge for data on start and when a chart is found", () => {
  const h = startController();
  h.advance(1000);
  assert.ok(h.posted.length >= 1);
  assert.ok(h.posted.every((m) => m.source === "xheatgrid-content" && m.type === "xheatgrid:scan-request"));
});
