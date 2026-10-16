/*
 * xheatgrid DOM adapter: the ONE production parsing path. It reads a Recharts <svg>
 * Element (live DOM in the browser, linkedom in tests) into the plain geometry object
 * consumed by core.buildSeriesFromGeometry, and finds the Posts/Replies chart by
 * structure (bar fills), not by English labels or Tailwind classes.
 */
(function (root, factory) {
  const core = typeof require === "function" && typeof module !== "undefined" ? require("./core.js") : root.XHeatgrid;
  const api = factory(core);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XHeatgrid = Object.assign(root.XHeatgrid || {}, api);
  }
})(typeof self !== "undefined" ? self : globalThis, function (core) {
  "use strict";

  const RANGE_OPTIONS = [
    { label: "7D", days: 7 },
    { label: "2W", days: 14 },
    { label: "4W", days: 28 },
    { label: "3M", days: 90 },
    { label: "1Y", days: 365 }
  ];

  function num(el, name) {
    const raw = el.getAttribute(name);
    return raw === null || raw === "" ? NaN : Number(raw);
  }

  function hasClass(el, name) {
    return Boolean(el && el.classList && el.classList.contains(name));
  }

  function barGroups(svg) {
    return Array.from(svg.children).filter((el) => hasClass(el, "recharts-bar"));
  }

  function readPlotArea(svg) {
    for (const rect of svg.querySelectorAll("rect")) {
      const parent = rect.parentNode;
      if (parent && String(parent.nodeName).toLowerCase() === "clippath") {
        const plot = { left: num(rect, "x"), top: num(rect, "y"), width: num(rect, "width"), height: num(rect, "height") };
        if (Object.values(plot).every(Number.isFinite)) {
          return plot;
        }
      }
    }
    return null;
  }

  function tickText(textEl) {
    const spans = Array.from(textEl.querySelectorAll("tspan"));
    const raw = spans.length ? spans.map((s) => s.textContent).join(" ") : textEl.textContent;
    return String(raw || "").replace(/\s+/g, " ").trim();
  }

  function readTicks(svg, axisClass) {
    const ticks = [];
    for (const tick of svg.querySelectorAll(`.${axisClass} .recharts-cartesian-axis-tick`)) {
      const text = tick.querySelector("text");
      if (text) {
        ticks.push({ text: tickText(text), x: num(text, "x"), y: num(text, "y") });
      }
    }
    return ticks;
  }

  /** Read the chart <svg> into the plain geometry object (no interpretation). */
  function readChartGeometry(svg) {
    const gridYs = [];
    for (const line of svg.querySelectorAll(".recharts-cartesian-grid-horizontal line")) {
      const y = num(line, "y1");
      if (Number.isFinite(y)) {
        gridYs.push(y);
      }
    }

    const groups = barGroups(svg).map((group) => {
      const slots = Array.from(group.querySelectorAll("g.recharts-bar-rectangle"));
      const bars = [];
      slots.forEach((slot, slotIndex) => {
        const path = slot.querySelector("path.recharts-rectangle") || slot.querySelector("path");
        if (!path) {
          return; // zero days keep the slot but draw no <path>
        }
        bars.push({
          slotIndex,
          x: num(path, "x"),
          width: num(path, "width"),
          height: num(path, "height"),
          fill: path.getAttribute("fill") || ""
        });
      });
      return { slotCount: slots.length, bars };
    });

    const yTicks = readTicks(svg, "recharts-yAxis").map((tick) => {
      let gridY = null;
      let best = Infinity;
      for (const y of gridYs) {
        const distance = Math.abs(y - tick.y);
        if (distance < best) {
          best = distance;
          gridY = y;
        }
      }
      return { text: tick.text, y: tick.y, gridY };
    });
    const xTicks = readTicks(svg, "recharts-xAxis").map(({ text, x }) => ({ text, x }));

    return { plot: readPlotArea(svg), groups, yTicks, xTicks };
  }

  /** Parse a chart <svg> into daily rows. opts: { lang, reference, labelOffsetPx }. */
  function parseChart(svg, opts) {
    const options = Object.assign({}, opts);
    if (options.lang === undefined && typeof document !== "undefined") {
      options.lang = document.documentElement && document.documentElement.lang;
    }
    return core.buildSeriesFromGeometry(readChartGeometry(svg), options);
  }

  function hasEnglishLegend(card) {
    return Boolean(
      card && card.querySelector("button[aria-label='Posts']") && card.querySelector("button[aria-label='Replies']")
    );
  }

  /** Nearest ancestor of the svg that also contains the legend toggle buttons. */
  function findCard(svg) {
    let node = svg.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (node.querySelectorAll("button").length >= 2) {
        return node;
      }
    }
    return svg.parentElement;
  }

  function isPostsRepliesChart(svg) {
    const groups = barGroups(svg);
    if (!groups.length) {
      return false;
    }
    let paths = 0;
    for (const group of groups) {
      for (const path of group.querySelectorAll("path.recharts-rectangle, path")) {
        paths += 1;
        const name = core.seriesFromFill(path.getAttribute("fill"));
        if (name === "posts" || name === "replies") {
          return true;
        }
      }
    }
    // Every day is zero (no <path> at all): fall back to the English legend as a last resort.
    return paths === 0 && groups.length === 2 && hasEnglishLegend(findCard(svg));
  }

  /** All Posts/Replies charts under root, best first (visible and most bars). */
  function findCharts(root) {
    const found = [];
    for (const svg of root.querySelectorAll("svg.recharts-surface")) {
      if (!isPostsRepliesChart(svg)) {
        continue;
      }
      let visible = 1;
      if (typeof svg.getBoundingClientRect === "function") {
        const rect = svg.getBoundingClientRect();
        visible = rect.width > 0 && rect.height > 0 ? 1 : 0;
      }
      const bars = svg.querySelectorAll(".recharts-bar-rectangle path").length;
      found.push({ svg, card: findCard(svg), score: visible * 1e6 + bars });
    }
    return found.sort((a, b) => b.score - a.score);
  }

  /**
   * Selected range button (diagnostics only; parsing does not depend on it). Uses
   * aria-pressed / aria-selected / data-state when present, else the whole-token class
   * pair "bg-text" + "text-background". NEVER substring matching: every range button
   * carries "active:bg-mix-text".
   */
  function detectSelectedRange(root) {
    const labels = new Map(RANGE_OPTIONS.map((option) => [option.label, option]));
    const buttons = Array.from(root.querySelectorAll("button")).filter((button) =>
      labels.has((button.textContent || "").trim())
    );
    let selected = null;
    for (const button of buttons) {
      const pressed = button.getAttribute("aria-pressed");
      const ariaSelected = button.getAttribute("aria-selected");
      const state = button.getAttribute("data-state");
      let isSelected;
      if (pressed !== null || ariaSelected !== null || state !== null) {
        isSelected = pressed === "true" || ariaSelected === "true" || state === "active" || state === "on" || state === "selected";
      } else {
        isSelected = button.classList.contains("bg-text") && button.classList.contains("text-background");
      }
      if (isSelected) {
        if (selected) {
          return null; // ambiguous
        }
        selected = labels.get(button.textContent.trim());
      }
    }
    return selected;
  }

  return { RANGE_OPTIONS, readChartGeometry, parseChart, findCard, findCharts, detectSelectedRange };
});
