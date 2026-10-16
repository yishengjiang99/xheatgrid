/*
 * xheatgrid controller: owns state, observers and refresh scheduling. Everything it
 * touches in the environment is injected (document, location, MutationObserver, timers,
 * clock) so tests can drive it deterministically with fake timers.
 */
(function (root, factory) {
  const lib =
    typeof require === "function" && typeof module !== "undefined"
      ? { core: require("./core.js"), parser: require("./chart-parser.js"), render: require("./render.js") }
      : { core: root.XHeatgrid, parser: root.XHeatgrid, render: root.XHeatgrid };
  const api = factory(lib);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XHeatgrid = Object.assign(root.XHeatgrid || {}, api);
  }
})(typeof self !== "undefined" ? self : globalThis, function (lib) {
  "use strict";

  const { core, parser, render } = lib;
  const ANALYTICS_PATH_RE = /\/i\/account_analytics(?:\/|$)/;
  const LOADING_TIMEOUT_MS = 8000;
  const STABLE_AFTER_MS = 100;
  const MAX_UNSTABLE_READS = 12;
  const SCAN_INTERVAL_MS = 1000;
  const SERIES_NAMES = { posts: "Posts", replies: "Replies" };

  function createController(env) {
    const doc = env.document;
    const now = env.now || (() => Date.now());
    const setTimer = env.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = env.clearTimer || ((id) => clearTimeout(id));

    let store = core.createStore();
    let ctl = null;
    let dismissed = false;
    let wasOnPath = false;
    let enteredAt = 0;
    let lastUrl = env.location.href;
    let refreshCount = 0;
    let lastVm = "";
    let lastHidden = [];
    let pageObserver = null;
    let svgObserver = null;
    let observedSvg = null;
    let loadingTimer = null;
    let acceptedSig = "";
    let gate = { sig: "", at: 0, tries: 0 };
    let lastScanAt = -Infinity;
    let lastErrorKey = "";

    const scheduler = core.createScheduler((reasons) => refresh(reasons), {
      delay: 150,
      maxWait: 500,
      now,
      setTimer,
      clearTimer
    });

    const onPath = () => ANALYTICS_PATH_RE.test(env.location.pathname);
    const debugOn = () => {
      try {
        return Boolean(env.storage && env.storage.getItem("xheatgrid:debug") === "1");
      } catch (error) {
        return false;
      }
    };
    const log = (...args) => env.console && env.console.debug && env.console.debug("[xheatgrid]", ...args);
    const lang = () => (doc.documentElement && doc.documentElement.lang) || undefined;

    // ------------------------------------------------------------ panel

    function ensurePanel() {
      const existing = doc.getElementById(render.PANEL_ID);
      if (ctl && existing === ctl.panel) {
        return ctl;
      }
      if (existing) {
        existing.remove(); // leftover from a previous extension instance
      }
      ctl = render.createPanelController(doc, {
        version: env.version,
        locale: lang(),
        onClose: () => {
          dismissed = true;
          ctl = null;
          lastVm = "";
        }
      });
      (doc.body || doc.documentElement).append(ctl.panel);
      lastVm = "";
      return ctl;
    }

    function removePanel() {
      const existing = doc.getElementById(render.PANEL_ID);
      if (existing) {
        existing.remove();
      }
      ctl = null;
      lastVm = "";
    }

    function teardown() {
      scheduler.cancel();
      if (loadingTimer !== null) {
        clearTimer(loadingTimer);
        loadingTimer = null;
      }
      observeSvg(null);
      removePanel();
      store = core.createStore();
      dismissed = false;
      wasOnPath = false;
      acceptedSig = "";
      gate = { sig: "", at: 0, tries: 0 };
      lastHidden = [];
    }

    function showState(state, text) {
      ensurePanel().setState(state, text);
      lastVm = "";
    }

    // -------------------------------------------------------- observers

    function observeSvg(svg) {
      if (svg === observedSvg && (svg === null || svgObserver)) {
        return;
      }
      if (svgObserver) {
        svgObserver.disconnect();
        svgObserver = null;
      }
      observedSvg = svg;
      if (svg) {
        svgObserver = new env.MutationObserver(() => scheduler.schedule("chart-mutation"));
        svgObserver.observe(svg, { childList: true, subtree: true, attributes: true, characterData: true });
      }
    }

    function onPageMutations(records) {
      if (env.location.href !== lastUrl) {
        checkUrl("mutation");
        return;
      }
      if (!onPath()) {
        return; // off the analytics path: URL changes are the only thing we care about
      }
      if (observedSvg && doc.documentElement.contains(observedSvg)) {
        return; // the chart is being watched directly
      }
      if (records.every((record) => core.isOwnMutation(record, render.PANEL_ID))) {
        return; // our own panel writes must never re-trigger a refresh
      }
      scheduler.schedule("dom");
    }

    function checkUrl(reason) {
      if (env.location.href === lastUrl) {
        return;
      }
      lastUrl = env.location.href;
      acceptedSig = "";
      gate = { sig: "", at: 0, tries: 0 };
      if (!onPath()) {
        teardown();
        return;
      }
      scheduler.schedule(`nav:${reason}`);
    }

    // ---------------------------------------------------------- refresh

    function requestScan() {
      const t = now();
      if (t - lastScanAt >= SCAN_INTERVAL_MS && env.postToBridge) {
        lastScanAt = t;
        env.postToBridge({ source: "xheatgrid-content", type: "xheatgrid:scan-request" });
      }
    }

    function noChart() {
      observeSvg(null);
      const waited = now() - enteredAt;
      if (waited < LOADING_TIMEOUT_MS) {
        showState("loading", "Waiting for the analytics chart…");
        if (loadingTimer === null) {
          loadingTimer = setTimer(() => {
            loadingTimer = null;
            scheduler.schedule("loading-timeout");
          }, LOADING_TIMEOUT_MS - waited + 10);
        }
      } else {
        showState("empty", "No Posts/Replies chart found on this page.");
      }
    }

    function logErrorOnce(error) {
      const key = `${error.code}:${error.message}`;
      if (key !== lastErrorKey) {
        lastErrorKey = key;
        if (env.console && env.console.warn) {
          env.console.warn("[xheatgrid] cannot read chart:", error.code, error.message);
        }
      }
    }

    function describeSource(rows) {
      let data = 0;
      let chart = 0;
      for (const row of rows) {
        for (const name of ["posts", "replies"]) {
          const source = row[`${name}Source`];
          if (source === "data") {
            data += 1;
          } else if (source === "chart") {
            chart += 1;
          }
        }
      }
      if (data && !chart) {
        return "from X data";
      }
      if (chart && !data) {
        return "read from chart";
      }
      return "X data + chart";
    }

    function renderFromStore(extraNotes) {
      const entries = core.storeRows(store);
      if (!entries.length) {
        return false;
      }
      const approximate = entries.some((row) => row.postsSource === "chart" || row.repliesSource === "chart");
      const notes = [...(extraNotes || [])];
      for (const name of lastHidden) {
        const other = name === "posts" ? "replies" : "posts";
        notes.push(
          `${SERIES_NAMES[name]} hidden - counts shown are ${other} only (last known ${name} kept for days seen earlier)`
        );
      }
      const vm = {
        rows: entries.map(({ date, posts, replies }) => ({ date, posts, replies })),
        hidden: lastHidden,
        approximate,
        source: describeSource(entries),
        notes
      };
      const signature = JSON.stringify(vm);
      const panel = ensurePanel();
      if (signature === lastVm && panel.panel.dataset.state === "ready") {
        return true;
      }
      lastVm = signature;
      panel.renderReady(vm);
      return true;
    }

    function crossCheck(rows) {
      if (!debugOn()) {
        return;
      }
      const mismatches = [];
      for (const row of rows) {
        const known = store.days.get(row.date);
        if (!known) {
          continue;
        }
        for (const name of ["posts", "replies"]) {
          if (row[name] !== null && known[`${name}Source`] === "data" && known[name] !== row[name]) {
            mismatches.push(`${row.date} ${name}: data=${known[name]} chart=${row[name]}`);
          }
        }
      }
      if (mismatches.length) {
        log(`data/geometry mismatch (${mismatches.length})`, mismatches.slice(0, 5));
      }
    }

    function refresh(reasons) {
      refreshCount += 1;
      if (debugOn()) {
        log(`refresh #${refreshCount}`, (reasons || []).join(",") || "-", env.location.pathname);
        doc.documentElement.setAttribute("data-xheatgrid-refreshes", String(refreshCount));
      }

      if (!onPath()) {
        teardown();
        return;
      }
      if (dismissed) {
        return;
      }
      if (!wasOnPath) {
        wasOnPath = true;
        enteredAt = now();
      }
      ensurePanel();

      const charts = parser.findCharts(doc);
      if (!charts.length) {
        noChart();
        return;
      }
      const { svg } = charts[0];
      observeSvg(svg);
      requestScan();

      const result = parser.parseChart(svg, { lang: lang(), reference: new Date(now()) });
      if (!result.ok) {
        logErrorOnce(result.error);
        const hasData = core.storeRows(store).some((row) => row.postsSource === "data" || row.repliesSource === "data");
        if (!(hasData && renderFromStore([`Chart could not be read (${result.error.code}); showing X data only.`]))) {
          showState("error", `Unable to read the chart: ${result.error.message}`);
        }
        return;
      }
      lastErrorKey = "";

      // Accept a geometry reading only when two consecutive reads match (mid-animation
      // bar heights are not trustworthy).
      const signature = JSON.stringify([result.rows, result.hidden]);
      const t = now();
      if (signature !== acceptedSig) {
        if (gate.sig !== signature) {
          gate = { sig: signature, at: t, tries: gate.tries + 1 };
          if (gate.tries <= MAX_UNSTABLE_READS) {
            if (!renderFromStore()) {
              showState("loading", "Reading chart…");
            }
            scheduler.schedule("stability-check");
            return;
          }
        } else if (t - gate.at < STABLE_AFTER_MS) {
          scheduler.schedule("stability-check");
          return;
        }
        acceptedSig = signature;
        gate = { sig: "", at: 0, tries: 0 };
        if (result.warnings.length) {
          log("warnings", result.warnings);
        }
      }

      lastHidden = result.hidden;
      crossCheck(result.rows);
      core.mergeRows(store, result.rows, "chart");
      renderFromStore();
    }

    // --------------------------------------------------------- messages

    function handleMessage(event) {
      if (!event || event.source !== env.window || (event.origin && event.origin !== env.location.origin)) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object" || data.source !== "xheatgrid-bridge") {
        return;
      }
      if (data.type === "xheatgrid:navigate") {
        checkUrl("history");
        return;
      }
      if (data.type === "xheatgrid:rows" && (data.via === "network" || data.via === "react") && onPath()) {
        const { rows, dropped } = core.validateRows(data.rows);
        if (dropped && debugOn()) {
          log(`dropped ${dropped} invalid rows from ${data.via}`);
        }
        if (rows.length && core.mergeRows(store, rows, "data")) {
          scheduler.schedule(`rows:${data.via}`);
        }
      }
    }

    // ------------------------------------------------------------ start

    function start() {
      if (!pageObserver) {
        pageObserver = new env.MutationObserver(onPageMutations);
        pageObserver.observe(doc.documentElement, { childList: true, subtree: true });
      }
      if (env.addWindowListener) {
        env.addWindowListener("message", handleMessage);
        env.addWindowListener("popstate", () => checkUrl("popstate"));
        env.addWindowListener("hashchange", () => checkUrl("hashchange"));
      }
      if (env.navigation && env.navigation.addEventListener) {
        env.navigation.addEventListener("navigatesuccess", () => checkUrl("navigatesuccess"));
      }
      scheduler.schedule("init");
      if (env.postToBridge) {
        env.postToBridge({ source: "xheatgrid-content", type: "xheatgrid:scan-request" }); // replay anything seen before we loaded
      }
    }

    return {
      start,
      refresh,
      handleMessage,
      checkUrl,
      stats: () => ({ refreshCount, pending: scheduler.isPending() }),
      getStore: () => store,
      getPanel: () => (ctl ? ctl.panel : null),
      getPanelController: () => ctl
    };
  }

  return { createController, ANALYTICS_PATH_RE };
});
