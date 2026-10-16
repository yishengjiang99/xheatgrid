"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core.js");

const label = (month, day, year = null) => ({ month, day, year });
const keys = (nums) => nums.map(core.dayKey);

// ---------------------------------------------------- bug 3: year inference

test("bug 3: Dec labels viewed on Jan 3 land in the PREVIOUS December", () => {
  const nums = core.assignDayNumbers([label(11, 10), label(11, 20), label(11, 30)], "2027-01-03");
  assert.deepEqual(keys(nums), ["2026-12-10", "2026-12-20", "2026-12-30"]);
});

test("bug 3: Dec 8..Dec 29 labels on Jan 3", () => {
  const labels = [8, 11, 14, 17, 20, 23, 26, 29].map((d) => label(11, d));
  const nums = core.assignDayNumbers(labels, "2027-01-03");
  assert.equal(core.dayKey(nums[0]), "2026-12-08");
  assert.equal(core.dayKey(nums[7]), "2026-12-29");
});

test("bug 3: Jan labels viewed on Jan 3 stay in the current year", () => {
  const nums = core.assignDayNumbers([label(0, 1), label(0, 2), label(0, 3)], "2027-01-03");
  assert.deepEqual(keys(nums), ["2027-01-01", "2027-01-02", "2027-01-03"]);
});

test("bug 3: +1 day tolerance for UTC vs local (label one day ahead of the local date)", () => {
  assert.equal(core.dayKey(core.assignDayNumbers([label(0, 4)], "2027-01-03")[0]), "2027-01-04");
  // two days ahead is NOT tolerated: it must be last year
  assert.equal(core.dayKey(core.assignDayNumbers([label(0, 5)], "2027-01-03")[0]), "2026-01-05");
});

test("bug 3: a 1Y span crossing New Year decrements the year at the wrap", () => {
  const months = [[2, 18], [3, 17], [4, 17], [5, 16], [6, 16], [7, 15], [8, 14], [9, 14], [10, 13], [11, 13], [0, 12], [1, 11], [2, 12]];
  const nums = core.assignDayNumbers(months.map(([m, d]) => label(m, d)), "2026-03-17");
  assert.equal(core.dayKey(nums[0]), "2025-03-18");
  assert.equal(core.dayKey(nums[9]), "2025-12-13");
  assert.equal(core.dayKey(nums[10]), "2026-01-12");
  assert.equal(core.dayKey(nums[12]), "2026-03-12");
  for (let i = 1; i < nums.length; i += 1) {
    assert.ok(nums[i] > nums[i - 1]);
  }
});

test("bug 3: Feb 29 resolves to the leap year (and never to Feb 29 of a common year)", () => {
  // viewed in 2025 (common year): Feb 29 can only be 2024
  assert.equal(core.dayKey(core.assignDayNumbers([label(1, 29)], "2025-03-10")[0]), "2024-02-29");
  // viewed on 2024-03-05: Feb 29 is the current year's
  assert.equal(core.dayKey(core.assignDayNumbers([label(1, 29)], "2024-03-05")[0]), "2024-02-29");
  // sequence across the leap day
  const nums = core.assignDayNumbers([label(1, 28), label(1, 29), label(2, 1)], "2024-03-05");
  assert.deepEqual(keys(nums), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  // unparsed labels with impossible dates are rejected
  assert.equal(core.parseTickLabel("Feb 30", "en"), null);
  assert.deepEqual(core.parseTickLabel("Feb 29", "en"), label(1, 29));
});

test("assignDayNumbers refuses inconsistent explicit years", () => {
  assert.equal(core.assignDayNumbers([label(5, 1, 2030)], "2026-03-17"), null);
});

// ----------------------------------------------------------- label parsing

test("bug 14: tick label parsing", () => {
  assert.deepEqual(core.parseTickLabel("Dec 18", "en-US"), label(11, 18));
  assert.deepEqual(core.parseTickLabel("Sept 1", "en"), label(8, 1));
  assert.deepEqual(core.parseTickLabel("1 Mar", "en-GB"), label(2, 1));
  assert.deepEqual(core.parseTickLabel("18 déc.", "fr"), label(11, 18));
  assert.deepEqual(core.parseTickLabel("17. März", "de"), label(2, 17));
  assert.deepEqual(core.parseTickLabel("3月17日", "ja"), label(2, 17));
  assert.deepEqual(core.parseTickLabel("Mar 1, 2026", "en"), label(2, 1, 2026));
  assert.equal(core.parseTickLabel("Jan", "en"), null, "month-only labels cannot be dated");
  assert.equal(core.parseTickLabel("", "en"), null);
  assert.equal(core.parseTickLabel("Foo 3", "en"), null);
  assert.equal(core.parseTickLabel("12", "en"), null);
});

test("axis number parsing handles K/M suffixes and separators", () => {
  assert.equal(core.parseAxisNumber("1.2K"), 1200);
  assert.equal(core.parseAxisNumber("3M"), 3e6);
  assert.equal(core.parseAxisNumber("1,200"), 1200);
  assert.equal(core.parseAxisNumber("1,2K"), 1200);
  assert.equal(core.parseAxisNumber("45"), 45);
  assert.ok(Number.isNaN(core.parseAxisNumber("Mar 1")));
});

// -------------------------------------------------------- dates / keys

test("bug 18: day keys are calendar based and DST-proof", () => {
  const start = core.parseDayKey("2026-03-01");
  const keysAcrossDst = Array.from({ length: 20 }, (_, i) => core.dayKey(start + i));
  assert.equal(new Set(keysAcrossDst).size, 20);
  assert.equal(keysAcrossDst[7], "2026-03-08");
  assert.equal(keysAcrossDst[8], "2026-03-09");
  assert.equal(core.parseDayKey("2026-02-30"), null);
  assert.equal(core.parseDayKey("2026-2-3"), null);
  assert.equal(core.weekday(core.parseDayKey("2026-03-15")), 0, "2026-03-15 is a Sunday");
  assert.equal(core.weekday(core.parseDayKey("1969-12-28")), 0);
  // Date input is read in LOCAL calendar fields
  assert.equal(core.dayKey(core.toDayNumber(new Date(2026, 2, 17, 23, 59))), "2026-03-17");
});

// ---------------------------------------------------- bug 4: levels

test("bug 4: level 0 for a zero total even when other days exist; 4 discrete non-zero buckets", () => {
  const totals = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 40, 100];
  const th = core.computeThresholds(totals);
  assert.equal(core.levelFor(0, th), 0);
  const levels = totals.map((t) => core.levelFor(t, th));
  assert.deepEqual([...new Set(levels)].sort(), [0, 1, 2, 3, 4]);
  assert.equal(core.levelFor(1, th), 1);
  assert.equal(core.levelFor(100, th), 4);
  // monotonic
  for (let i = 1; i < totals.length; i += 1) {
    assert.ok(levels[i] >= levels[i - 1]);
  }
  // never a faint level for zero (old code: Math.max(0.08, total/max))
  assert.equal(core.levelFor(0, core.computeThresholds([0, 0, 0])), 0);
});

test("bug 4: legend ranges describe exactly the same buckets as the cells", () => {
  const totals = Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? 0 : (i * 37) % 91));
  const th = core.computeThresholds(totals);
  const ranges = core.levelRanges(th);
  for (const total of totals) {
    const level = core.levelFor(total, th);
    if (level === 0) {
      assert.equal(ranges[0], "0");
      continue;
    }
    const [lo, hi] = ranges[level].includes("–") ? ranges[level].split("–").map(Number) : [Number(ranges[level]), Number(ranges[level])];
    assert.ok(total >= lo && total <= hi, `${total} in level ${level} range ${ranges[level]}`);
  }
});

test("levels with a single distinct non-zero total", () => {
  const th = core.computeThresholds([0, 5, 5, 5]);
  assert.equal(core.levelFor(5, th), 4);
  assert.equal(core.levelFor(0, th), 0);
});

// ----------------------------------------------------------- bug 5: weeks

function rowsBetween(from, to, value = 1) {
  const a = core.parseDayKey(from);
  const b = core.parseDayKey(to);
  const rows = [];
  for (let n = a; n <= b; n += 1) {
    rows.push({ date: core.dayKey(n), posts: value, replies: 0 });
  }
  return rows;
}

test("bug 5: weeks start on Sunday: row 0 is Sunday and the last cell is Saturday", () => {
  // 2026-03-04 is a Wednesday, 2026-03-17 a Tuesday
  const weeks = core.buildWeeks(rowsBetween("2026-03-04", "2026-03-17"));
  assert.equal(weeks.length, 3);
  for (const week of weeks) {
    assert.equal(week.length, 7);
    week.forEach((cell, row) => {
      assert.equal(cell.row, row);
      assert.equal(core.weekday(cell.dayNumber), row, `row ${row} weekday`);
    });
    assert.equal(core.weekday(week[0].dayNumber), 0, "row 0 is Sunday");
  }
  const last = weeks[weeks.length - 1];
  assert.equal(core.weekday(last[6].dayNumber), 6, "last cell is Saturday");
  assert.equal(last[6].date, "2026-03-21");
  assert.equal(weeks[0][0].date, "2026-03-01");
  // padding cells are 'no data', in-window cells are data
  assert.equal(weeks[0][0].hasData, false);
  assert.equal(weeks[0][3].hasData, true);
  assert.equal(last[3].hasData, false, "Wed Mar 18 is after the window");
});

test("bug 5: end-of-week padding when the window ends on each weekday", () => {
  for (let offset = 0; offset < 7; offset += 1) {
    const end = core.dayKey(core.parseDayKey("2026-03-15") + offset); // Sun..Sat
    const weeks = core.buildWeeks(rowsBetween("2026-03-08", end));
    const lastCell = weeks[weeks.length - 1][6];
    assert.equal(core.weekday(lastCell.dayNumber), 6);
    assert.ok(lastCell.dayNumber - core.parseDayKey(end) <= 6, "padding is less than a week");
    assert.ok(lastCell.dayNumber >= core.parseDayKey(end));
  }
  // window ending on a Saturday gets no extra week
  const weeks = core.buildWeeks(rowsBetween("2026-03-08", "2026-03-14"));
  assert.equal(weeks.length, 1);
});

test("bug 4: 'no data' (outside window / gaps) is distinct from '0 activity'", () => {
  const rows = [
    { date: "2026-03-09", posts: 0, replies: 0 },
    { date: "2026-03-12", posts: 3, replies: 1 }
  ];
  const cells = core.buildWeeks(rows).flat();
  const byDate = new Map(cells.map((c) => [c.date, c]));
  assert.equal(byDate.get("2026-03-09").hasData, true);
  assert.equal(byDate.get("2026-03-09").total, 0);
  assert.equal(byDate.get("2026-03-10").hasData, false, "gap inside the window");
  assert.equal(byDate.get("2026-03-12").total, 4);
  assert.equal(byDate.get("2026-03-08").hasData, false, "padding before");
});

test("bug 16: month labels follow GitHub (first column labeled, then the 1st; too-close labels skipped)", () => {
  // Dec 18 2025 .. Mar 17 2026
  const weeks = core.buildWeeks(rowsBetween("2025-12-18", "2026-03-17"));
  const labels = core.monthLabelColumns(weeks);
  const names = labels.map((l) => `${l.year}-${l.month + 1}`);
  // Dec 18 starts in the first column, but Jan 1 is only 2 columns later => first label dropped
  assert.deepEqual(names, ["2026-1", "2026-2", "2026-3"]);
  assert.ok(labels.every((l, i) => i === 0 || l.col - labels[i - 1].col >= 3));
  // a first partial month with enough room IS labeled (old code never labeled it)
  const early = core.monthLabelColumns(core.buildWeeks(rowsBetween("2025-12-04", "2026-03-17")));
  assert.deepEqual(early.slice(0, 2).map((l) => l.month + 1), [12, 1]);
  // the column labeled for a month contains that month's 1st
  for (const l of labels) {
    assert.ok(weeks[l.col].some((c) => c.date.endsWith("-01")));
  }
});

// ------------------------------------------------------------ rows / merge

test("validateRows treats input as untrusted", () => {
  const { rows, dropped } = core.validateRows([
    { date: "2026-03-01", posts: 1, replies: 2 },
    { date: "2026-03-02", posts: -1, replies: 2 },
    { date: "2026-03-03", posts: 1.5, replies: 2 },
    { date: "2026-3-4", posts: 1, replies: 2 },
    { date: "2026-03-05", posts: "5", replies: 2 },
    { date: "2026-03-06", posts: null, replies: null },
    { date: "2026-03-07", posts: 4, replies: null, extra: "ignored" },
    { date: "2026-03-07", posts: 9, replies: 9 },
    null,
    "x"
  ]);
  assert.deepEqual(rows, [
    { date: "2026-03-01", posts: 1, replies: 2 },
    { date: "2026-03-07", posts: 4, replies: null }
  ]);
  assert.equal(dropped, 8);
  assert.deepEqual(core.validateRows("nope"), { rows: [], dropped: 0 });
  assert.equal(core.validateRows(new Array(5000).fill({ date: "2026-03-01", posts: 1, replies: 1 })).rows.length, 0);
});

test("mergeRows: null never overwrites, data beats chart, ranges merge by date", () => {
  const store = core.createStore();
  assert.ok(core.mergeRows(store, [{ date: "2026-03-01", posts: 1, replies: 5 }, { date: "2026-03-02", posts: 2, replies: 6 }], "chart"));
  // second range (replies hidden) adds a new day and keeps last known replies
  assert.ok(core.mergeRows(store, [{ date: "2026-03-02", posts: 3, replies: null }, { date: "2026-03-03", posts: 4, replies: null }], "chart"));
  assert.deepEqual(core.storeRows(store).map((r) => [r.date, r.posts, r.replies]), [
    ["2026-03-01", 1, 5],
    ["2026-03-02", 3, 6],
    ["2026-03-03", 4, null]
  ]);
  core.mergeRows(store, [{ date: "2026-03-01", posts: 10, replies: 50 }], "data");
  assert.equal(core.mergeRows(store, [{ date: "2026-03-01", posts: 99, replies: 99 }], "chart"), false);
  assert.equal(core.storeRows(store)[0].posts, 10);
  assert.equal(core.mergeRows(store, [{ date: "2026-03-01", posts: 10, replies: 50 }], "data"), false, "idempotent");
});

// ------------------------------------------------------------- scheduling

test("bug 12: scheduler cannot starve; fires within maxWait of the first pending call", () => {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  const fired = [];
  const scheduler = core.createScheduler((reasons) => fired.push([clock, reasons.length]), {
    delay: 150,
    maxWait: 500,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id)
  });
  function advance(to) {
    while (clock < to) {
      clock += 1;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) {
          timers.delete(id);
          t.fn();
        }
      }
    }
  }
  // a mutation every 20ms for 3 seconds would starve a plain debounce forever
  for (let t = 0; t < 3000; t += 20) {
    advance(t);
    scheduler.schedule("m");
  }
  advance(3300);
  assert.ok(fired.length >= 5, `fired ${fired.length} times`);
  assert.ok(fired.length <= 8, `bounded: ${fired.length}`);
  assert.ok(fired[0][0] <= 500, "first fire within maxWait");
  for (let i = 1; i < fired.length; i += 1) {
    assert.ok(fired[i][0] - fired[i - 1][0] <= 520);
  }
  // quiet: no more fires
  const count = fired.length;
  advance(10000);
  assert.equal(fired.length, count);
});

test("scheduler: single schedule fires once after the delay; cancel works", () => {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  let calls = 0;
  const s = core.createScheduler(() => (calls += 1), {
    delay: 100,
    maxWait: 500,
    now: () => clock,
    setTimer: (fn, ms) => (timers.set(nextId, { fn, ms }), nextId++),
    clearTimer: (id) => timers.delete(id)
  });
  s.schedule();
  assert.ok(s.isPending());
  assert.equal([...timers.values()][0].ms, 100);
  s.cancel();
  assert.equal(timers.size, 0);
  assert.ok(!s.isPending());
});

test("bug 6: isOwnMutation recognises writes inside the panel and panel add/remove", () => {
  const { parseHTML } = require("linkedom");
  const { document } = parseHTML('<html><body><div id="x"></div><section id="xheatgrid-panel"><p id="s">hi</p></section></body></html>');
  const panel = document.getElementById("xheatgrid-panel");
  const status = document.getElementById("s");
  const other = document.getElementById("x");
  assert.ok(core.isOwnMutation({ target: status, addedNodes: [], removedNodes: [] }, "xheatgrid-panel"));
  assert.ok(core.isOwnMutation({ target: status.firstChild, addedNodes: [], removedNodes: [] }, "xheatgrid-panel"), "text node inside panel");
  assert.ok(core.isOwnMutation({ target: document.body, addedNodes: [panel], removedNodes: [] }, "xheatgrid-panel"), "panel appended to body");
  assert.ok(core.isOwnMutation({ target: document.body, addedNodes: [], removedNodes: [panel] }, "xheatgrid-panel"), "panel removed");
  assert.ok(!core.isOwnMutation({ target: other, addedNodes: [], removedNodes: [] }, "xheatgrid-panel"));
  assert.ok(!core.isOwnMutation({ target: document.body, addedNodes: [other], removedNodes: [] }, "xheatgrid-panel"));
  assert.ok(!core.isOwnMutation({ target: document.body, addedNodes: [panel, other], removedNodes: [] }, "xheatgrid-panel"));
});
