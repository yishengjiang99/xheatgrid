/*
 * xheatgrid rendering. Builds the panel with document.createElement only (never an HTML string),
 * so every extension write stays inside #xheatgrid-panel and untrusted strings can never
 * become markup. `doc` is injected so tests can use linkedom.
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

  const PANEL_ID = "xheatgrid-panel";
  const DAY_LABELS = ["Mon", "Wed", "Fri"];

  function el(doc, tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) {
      node.className = className;
    }
    for (const [name, value] of Object.entries(attrs || {})) {
      node.setAttribute(name, value);
    }
    return node;
  }

  function formatDay(key, locale) {
    const n = core.parseDayKey(key);
    if (n === null) {
      return key;
    }
    const { y, m, d } = core.fromDayNumber(n);
    return new Date(Date.UTC(y, m, d)).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  function monthName(year, month, locale) {
    return new Date(Date.UTC(year, month, 1)).toLocaleDateString(locale, { month: "short", timeZone: "UTC" });
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  /** Tooltip / aria text for one cell. `hidden` = series names currently hidden in the chart. */
  function describeCell(cell, locale, hidden) {
    const date = formatDay(cell.date, locale);
    if (!cell.hasData) {
      return `${date}\nNo data`;
    }
    const part = (label, known, value, series) => {
      if (!known) {
        return `${label}: unknown`;
      }
      return `${label}: ${value}${hidden.includes(series) ? " (last known)" : ""}`;
    };
    return `${date}\n${part("Posts", cell.postsKnown, cell.posts, "posts")}\n${part("Replies", cell.repliesKnown, cell.replies, "replies")}`;
  }

  function createPanelController(doc, options) {
    const opts = options || {};
    const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
    const locale = opts.locale || undefined;

    const panel = el(doc, "section", "xheatgrid-ready", {
      id: PANEL_ID,
      role: "region",
      "aria-label": "X Activity Heatmap"
    });
    panel.dataset.state = "loading";

    const card = el(doc, "div", "xheatgrid-card");
    const header = el(doc, "div", "xheatgrid-header");
    const titleBox = el(doc, "div", "xheatgrid-title");
    const h2 = el(doc, "h2");
    h2.append("X Activity Heatmap ");
    const version = el(doc, "span", "xheatgrid-version");
    version.textContent = opts.version ? `v${opts.version}` : "";
    const badge = el(doc, "span", "xheatgrid-badge");
    badge.hidden = true;
    badge.textContent = "approximate";
    badge.setAttribute("title", "Some values were read from bar heights, not from X's data");
    h2.append(version, badge);
    const status = el(doc, "p", "", { "data-role": "status" });
    titleBox.append(h2, status);

    const actions = el(doc, "div", "xheatgrid-actions");
    const minimize = el(doc, "button", "xheatgrid-icon-button", {
      type: "button",
      "data-role": "minimize",
      "aria-label": "Minimize heatmap",
      "aria-expanded": "true"
    });
    minimize.textContent = "–";
    const close = el(doc, "button", "xheatgrid-icon-button", {
      type: "button",
      "data-role": "close",
      "aria-label": "Close heatmap"
    });
    close.textContent = "×";
    actions.append(minimize, close);
    header.append(titleBox, actions);

    const body = el(doc, "div", "xheatgrid-body");
    const message = el(doc, "div", "xheatgrid-message", { "data-role": "message", role: "status" });
    const content = el(doc, "div", "xheatgrid-content");
    content.hidden = true;

    const legend = el(doc, "div", "xheatgrid-legend", { "data-role": "legend" });
    const summary = el(doc, "div", "xheatgrid-summary", { "data-role": "summary" });
    const notes = el(doc, "div", "xheatgrid-notes", { "data-role": "notes" });
    const scroll = el(doc, "div", "xheatgrid-scroll", { "data-role": "scroll" });
    const months = el(doc, "div", "xheatgrid-months");
    const gridWrap = el(doc, "div", "xheatgrid-grid-wrap");
    const days = el(doc, "div", "xheatgrid-days");
    for (const label of DAY_LABELS) {
      const span = el(doc, "span");
      span.textContent = label;
      days.append(span);
    }
    const grid = el(doc, "div", "xheatgrid-grid", { role: "group", "aria-label": "Daily activity" });
    gridWrap.append(days, grid);
    scroll.append(months, gridWrap);
    content.append(legend, summary, notes, scroll);
    body.append(message, content);
    card.append(header, body);

    // One floating tooltip, outside the scroll container and the overflow:hidden card.
    const tooltip = el(doc, "div", "xheatgrid-tooltip", { role: "tooltip", id: "xheatgrid-tooltip" });
    tooltip.hidden = true;
    panel.append(card, tooltip);

    let hiddenSeries = [];
    let rendered = false;

    function showTooltip(cell) {
      tooltip.textContent = cell.dataset.tooltip || "";
      tooltip.hidden = false;
      cell.setAttribute("aria-describedby", tooltip.id);
      const rect = cell.getBoundingClientRect();
      const width = tooltip.offsetWidth || 0;
      const height = tooltip.offsetHeight || 0;
      const viewportWidth = (win && win.innerWidth) || 0;
      let left = rect.left + rect.width / 2 - width / 2;
      if (viewportWidth) {
        left = Math.min(left, viewportWidth - width - 4);
      }
      left = Math.max(4, left);
      let top = rect.top - height - 8;
      if (top < 4) {
        top = rect.bottom + 8;
      }
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    }

    function hideTooltip() {
      tooltip.hidden = true;
      for (const node of grid.querySelectorAll("[aria-describedby]")) {
        node.removeAttribute("aria-describedby");
      }
    }

    function cellOf(event) {
      const target = event.target;
      return target && target.closest ? target.closest(".xheatgrid-cell") : null;
    }

    grid.addEventListener("mouseover", (event) => {
      const cell = cellOf(event);
      if (cell) {
        showTooltip(cell);
      }
    });
    grid.addEventListener("focusin", (event) => {
      const cell = cellOf(event);
      if (cell) {
        showTooltip(cell);
      }
    });
    grid.addEventListener("mouseout", hideTooltip);
    grid.addEventListener("focusout", hideTooltip);
    scroll.addEventListener("scroll", hideTooltip);
    grid.addEventListener("keydown", (event) => {
      const cell = cellOf(event);
      if (!cell) {
        return;
      }
      const column = cell.parentElement;
      const index = Array.prototype.indexOf.call(column.children, cell);
      const columns = Array.from(grid.children);
      const col = columns.indexOf(column);
      let next = null;
      if (event.key === "ArrowDown") {
        next = column.children[index + 1];
      } else if (event.key === "ArrowUp") {
        next = column.children[index - 1];
      } else if (event.key === "ArrowRight") {
        next = columns[col + 1] && columns[col + 1].children[index];
      } else if (event.key === "ArrowLeft") {
        next = columns[col - 1] && columns[col - 1].children[index];
      }
      if (next) {
        event.preventDefault();
        cell.setAttribute("tabindex", "-1");
        next.setAttribute("tabindex", "0");
        next.focus();
      }
    });

    minimize.addEventListener("click", () => {
      const minimized = panel.dataset.minimized !== "true";
      panel.dataset.minimized = String(minimized);
      minimize.setAttribute("aria-expanded", String(!minimized));
      minimize.setAttribute("aria-label", minimized ? "Expand heatmap" : "Minimize heatmap");
      minimize.textContent = minimized ? "+" : "–";
      hideTooltip();
    });
    close.addEventListener("click", () => {
      panel.remove();
      if (opts.onClose) {
        opts.onClose();
      }
    });

    function setText(node, text) {
      if (node.textContent !== text) {
        node.textContent = text; // only write on change: no needless mutations
      }
    }

    /** Non-ready states hide AND clear any previously rendered data. */
    function setState(state, text) {
      if (state === "ready") {
        throw new Error("use renderReady for the ready state");
      }
      panel.dataset.state = state;
      setText(message, text || "");
      message.hidden = false;
      content.hidden = true;
      setText(status, "");
      badge.hidden = true;
      hideTooltip();
      if (grid.firstChild) {
        grid.replaceChildren();
        months.replaceChildren();
        summary.replaceChildren();
        legend.replaceChildren();
        notes.replaceChildren();
      }
      rendered = false;
    }

    /**
     * vm = { rows: [{date,posts,replies}], hidden: ['replies'], approximate, source, notes: [] }
     */
    function renderReady(vm) {
      const rows = vm.rows || [];
      hiddenSeries = vm.hidden || [];
      const weeks = core.buildWeeks(rows);
      if (!weeks.length) {
        setState("empty", "No daily data yet.");
        return;
      }
      const wasAtEnd = !rendered || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 2;
      const previousScroll = scroll.scrollLeft;

      const cells = weeks.flat();
      const thresholds = core.computeThresholds(cells.filter((c) => c.hasData).map((c) => c.total));
      const ranges = core.levelRanges(thresholds);

      panel.dataset.state = "ready";
      message.hidden = true;
      setText(message, "");
      content.hidden = false;
      badge.hidden = !vm.approximate;

      const dataCells = cells.filter((c) => c.hasData);
      const active = dataCells.filter((c) => c.total > 0).length;
      const first = dataCells[0].date;
      const last = dataCells[dataCells.length - 1].date;
      setText(
        status,
        `${formatDay(first, locale)} – ${formatDay(last, locale)} · ${plural(dataCells.length, "day", "days")}, ${active} active` +
          (vm.source ? ` · ${vm.source}` : "")
      );

      // legend (same buckets as the cells)
      legend.replaceChildren();
      const less = el(doc, "span");
      less.textContent = "Less";
      legend.append(less);
      for (let level = 0; level <= 4; level += 1) {
        const swatch = el(doc, "i", "xheatgrid-swatch", { "data-level": String(level) });
        if (ranges[level]) {
          swatch.setAttribute("aria-label", `${ranges[level]} total`);
        }
        legend.append(swatch);
      }
      const more = el(doc, "span");
      more.textContent = "More";
      legend.append(more);

      // summary
      const sum = (key) => dataCells.reduce((t, c) => t + c[key], 0);
      summary.replaceChildren();
      for (const [label, value] of [["Posts", sum("posts")], ["Replies", sum("replies")], ["Total", sum("total")]]) {
        const box = el(doc, "div");
        const strong = el(doc, "strong");
        strong.textContent = String(value);
        const span = el(doc, "span");
        span.textContent = label;
        box.append(strong, span);
        summary.append(box);
      }

      notes.replaceChildren();
      for (const text of vm.notes || []) {
        const p = el(doc, "p");
        p.textContent = text;
        notes.append(p);
      }
      notes.hidden = !(vm.notes && vm.notes.length);

      // months
      months.replaceChildren();
      const labelCols = new Map(core.monthLabelColumns(weeks).map((l) => [l.col, l]));
      weeks.forEach((_, col) => {
        const span = el(doc, "span");
        const label = labelCols.get(col);
        span.textContent = label ? monthName(label.year, label.month, locale) : "";
        months.append(span);
      });

      // grid
      grid.replaceChildren();
      let newest = null;
      weeks.forEach((week) => {
        const column = el(doc, "div", "xheatgrid-week");
        for (const cell of week) {
          const level = cell.hasData ? core.levelFor(cell.total, thresholds) : "none";
          const text = describeCell(cell, locale, hiddenSeries);
          const node = el(doc, "button", "xheatgrid-cell", {
            type: "button",
            tabindex: "-1",
            "data-date": cell.date,
            "data-row": String(cell.row),
            "data-level": String(level),
            "data-tooltip": text,
            "aria-label": text.replace(/\n/g, ", ")
          });
          column.append(node);
          if (cell.hasData) {
            newest = node;
          }
        }
        grid.append(column);
      });
      if (newest) {
        newest.setAttribute("tabindex", "0");
      }

      rendered = true;
      if (wasAtEnd) {
        scroll.scrollLeft = scroll.scrollWidth; // newest on screen
      } else {
        scroll.scrollLeft = previousScroll;
      }
    }

    return { panel, setState, renderReady, showTooltip, hideTooltip, elements: { status, message, content, grid, scroll, tooltip, badge, minimize, close } };
  }

  return { PANEL_ID, createPanelController, describeCell, formatDay };
});
