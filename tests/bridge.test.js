"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("../bridge-main.js");

const DAY = 86400000;

function sampleRows(n = 10) {
  const start = Date.UTC(2026, 2, 1);
  return Array.from({ length: n }, (_, i) => ({ date: new Date(start + i * DAY).toISOString().slice(0, 10), Posts: i, Replies: i * 2 }));
}

test("toDateKey accepts ISO dates, ISO datetimes, epoch ms and s; rejects the rest", () => {
  assert.equal(bridge.toDateKey("2026-03-17"), "2026-03-17");
  assert.equal(bridge.toDateKey("2026-03-17T23:59:59Z"), "2026-03-17");
  assert.equal(bridge.toDateKey(Date.UTC(2026, 2, 17, 5)), "2026-03-17");
  assert.equal(bridge.toDateKey(Date.UTC(2026, 2, 17, 5) / 1000), "2026-03-17");
  assert.equal(bridge.toDateKey("Mar 17"), null);
  assert.equal(bridge.toDateKey(12), null);
  assert.equal(bridge.toDateKey(null), null);
  assert.equal(bridge.toDateKey("1999-01-01"), null);
});

test("rowsFromArray maps per-day objects and validates counts", () => {
  const rows = bridge.rowsFromArray(sampleRows(5));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[4], { date: "2026-03-05", posts: 4, replies: 8 });
  assert.equal(bridge.rowsFromArray([{ date: "2026-03-01", foo: 1 }]), null, "no posts/replies keys");
  assert.equal(bridge.rowsFromArray([]), null);
  assert.equal(bridge.rowsFromArray("x"), null);
  const dirty = sampleRows(10);
  dirty[0].Posts = -1;
  dirty[1].Posts = "7";
  dirty[2].Replies = 1e12;
  const cleaned = bridge.rowsFromArray(dirty);
  const byDate = new Map(cleaned.map((r) => [r.date, r]));
  assert.deepEqual(byDate.get("2026-03-01"), { date: "2026-03-01", posts: null, replies: 0 }, "negative count -> unknown");
  assert.equal(byDate.get("2026-03-02").posts, null, "string count -> unknown");
  assert.equal(byDate.get("2026-03-03").replies, null, "absurd count -> unknown");
});

test("extractRowsFromJson finds the per-day array anywhere in an untrusted response", () => {
  const response = { data: { viewer: { analytics: { series: { nodes: sampleRows(30).map((r) => ({ timestamp: Date.parse(r.date), posts: r.Posts, replies: r.Replies, __typename: "X" })) } } } }, other: [1, 2, { a: "b" }] };
  const rows = bridge.extractRowsFromJson(response);
  assert.equal(rows.length, 30);
  assert.equal(rows[0].date, "2026-03-01");
  assert.deepEqual(rows[29], { date: "2026-03-30", posts: 29, replies: 58 });
  assert.equal(bridge.extractRowsFromJson({ nothing: [1, 2, 3] }), null);
  assert.equal(bridge.extractRowsFromJson(null), null);
  assert.equal(bridge.extractRowsFromJson("str"), null);
});

test("rowsFromFiber walks up from the recharts wrapper to the chart props.data and uses dataKey hints", () => {
  const data = sampleRows(8).map((r) => ({ day: r.date, tweetsx: r.Posts, repliesx: r.Replies }));
  // dataKeys that do not match the name patterns are not used, but standard keys are
  assert.equal(bridge.rowsFromFiber({ memoizedProps: {}, return: { memoizedProps: { data }, return: null } }), null);
  const standard = sampleRows(8).map((r) => ({ date: r.date, Posts: r.Posts, Replies: r.Replies }));
  const rows = bridge.rowsFromFiber({ memoizedProps: {}, return: { memoizedProps: { data: standard, children: [{ props: { dataKey: "Posts" } }, { props: { dataKey: "Replies" } }] }, return: null } });
  assert.equal(rows.length, 8);
  assert.equal(rows[7].replies, 14);
});

test("scanReact reads the __reactFiber$ expando of .recharts-wrapper", () => {
  const standard = sampleRows(8).map((r) => ({ date: r.date, Posts: r.Posts, Replies: r.Replies }));
  const wrapper = { ["__reactFiber$abc123"]: { memoizedProps: {}, return: { memoizedProps: { data: standard }, return: null } } };
  const doc = { querySelectorAll: () => [{}, wrapper] };
  assert.equal(bridge.scanReact(doc).length, 8);
  assert.equal(bridge.scanReact({ querySelectorAll: () => [{}] }), null);
});

test("isCandidateUrl only matches x.com/twitter.com analytics URLs", () => {
  const base = "https://x.com/i/account_analytics";
  assert.ok(bridge.isCandidateUrl("/i/api/graphql/abc/AccountAnalyticsTimeseries?variables=1", base));
  assert.ok(bridge.isCandidateUrl("https://twitter.com/i/api/analytics/daily", base));
  assert.ok(!bridge.isCandidateUrl("https://x.com/i/api/graphql/abc/HomeTimeline", base));
  assert.ok(!bridge.isCandidateUrl("https://evil.example/analytics", base));
  assert.ok(!bridge.isCandidateUrl("https://notx.com/analytics", base));
});

function fakeWindow(fetchImpl) {
  const posted = [];
  const listeners = {};
  const win = {
    location: { origin: "https://x.com", href: "https://x.com/i/account_analytics" },
    fetch: fetchImpl,
    postMessage: (message, origin) => posted.push({ message, origin }),
    addEventListener: (type, fn) => ((listeners[type] = listeners[type] || []).push(fn)),
    document: { querySelectorAll: () => [] },
    history: { pushState() { return "pushed"; }, replaceState() { return "replaced"; } },
    XMLHttpRequest: undefined
  };
  return { win, posted, listeners };
}

const jsonResponse = (body) => ({
  ok: true,
  headers: { get: () => "application/json" },
  clone() {
    return { text: async () => JSON.stringify(body) };
  }
});

test("fetch wrapper: returns the original promise, posts rows only for analytics JSON", async () => {
  const body = { rows: sampleRows(12).map((r) => ({ date: r.date, posts: r.Posts, replies: r.Replies })) };
  const original = async () => jsonResponse(body);
  const { win, posted } = fakeWindow(original);
  bridge.install(win);
  assert.notEqual(win.fetch, original);

  const response = await win.fetch("/i/api/graphql/x/AccountAnalytics");
  assert.equal(response.ok, true, "page still gets its response");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, "https://x.com");
  const message = posted[0].message;
  assert.equal(message.source, "xheatgrid-bridge");
  assert.equal(message.type, "xheatgrid:rows");
  assert.equal(message.via, "network");
  assert.equal(message.endpoint, "/i/api/graphql/x/AccountAnalytics", "path only, no query string");
  assert.equal(message.rows.length, 12);

  await win.fetch("/i/api/graphql/x/HomeTimeline");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 1, "non-analytics URLs ignored");
});

test("fetch wrapper never breaks the page: rejections and bad JSON pass through", async () => {
  const failing = () => Promise.reject(new Error("net"));
  const a = fakeWindow(failing);
  bridge.install(a.win);
  await assert.rejects(a.win.fetch("/i/api/analytics/x"), /net/);

  const bad = fakeWindow(async () => ({ ok: true, headers: { get: () => "application/json" }, clone: () => ({ text: async () => "{not json" }) }));
  bridge.install(bad.win);
  const response = await bad.win.fetch("/i/api/analytics/x");
  assert.equal(response.ok, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bad.posted.length, 0);
});

test("history hooks report SPA navigation; scan-request replays or scans (only same-window, namespaced)", async () => {
  const { win, posted, listeners } = fakeWindow(async () => jsonResponse({}));
  bridge.install(win);
  assert.equal(win.history.pushState(), "pushed");
  assert.equal(win.history.replaceState(), "replaced");
  assert.deepEqual(posted.map((p) => p.message.type), ["xheatgrid:navigate", "xheatgrid:navigate"]);

  const before = posted.length;
  listeners.message[0]({ source: {}, data: { source: "xheatgrid-content", type: "xheatgrid:scan-request" } });
  listeners.message[0]({ source: win, data: { source: "page", type: "xheatgrid:scan-request" } });
  assert.equal(posted.length, before, "ignored");

  // with a React chart present the scan posts rows
  const standard = sampleRows(8).map((r) => ({ date: r.date, Posts: r.Posts, Replies: r.Replies }));
  win.document.querySelectorAll = () => [{ ["__reactFiber$z"]: { memoizedProps: { data: standard }, return: null } }];
  listeners.message[0]({ source: win, data: { source: "xheatgrid-content", type: "xheatgrid:scan-request" } });
  const last = posted[posted.length - 1].message;
  assert.equal(last.via, "react");
  assert.equal(last.rows.length, 8);
});
