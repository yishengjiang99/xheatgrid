(function () {
  const PANEL_ID = "xheatgrid-panel";
  const STYLE_READY_CLASS = "xheatgrid-ready";
  const ANALYTICS_PATH_RE = /\/i\/account_analytics(?:\/|$)/;
  const DAY_MS = 24 * 60 * 60 * 1000;

  let lastSignature = "";
  let lastUrl = location.href;
  let refreshTimer = null;
  let observerStarted = false;

  function scheduleRefresh(delay = 250) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, delay);
  }

  function refresh() {
    if (!ANALYTICS_PATH_RE.test(location.pathname)) {
      removePanel();
      return;
    }

    const chart = findAnalyticsChart();
    if (!chart) {
      removePanel("Waiting for analytics chart...");
      return;
    }

    const series = extractSeries(chart);
    if (!series.length) {
      removePanel("Unable to extract daily posts/replies yet.");
      return;
    }

    const signature = JSON.stringify(series);
    if (signature === lastSignature && document.getElementById(PANEL_ID)) {
      return;
    }

    lastSignature = signature;
    renderPanel(series);
  }

  function removePanel(statusText) {
    const panel = document.getElementById(PANEL_ID);
    if (panel && statusText) {
      const statusNode = panel.querySelector("[data-role='status']");
      if (statusNode) {
        statusNode.textContent = statusText;
        panel.dataset.state = "waiting";
        return;
      }
    }
    panel?.remove();
    lastSignature = "";
  }

  function findAnalyticsChart() {
    const buttons = Array.from(document.querySelectorAll("button[aria-label='Posts']"));
    for (const postsButton of buttons) {
      const container = postsButton.closest("div[class*='rounded-2xl']");
      if (!container) {
        continue;
      }
      const repliesButton = container.querySelector("button[aria-label='Replies']");
      const svg = container.querySelector("svg.recharts-surface");
      if (repliesButton && svg) {
        return container;
      }
    }
    return null;
  }

  function extractSeries(chart) {
    const svg = chart.querySelector("svg.recharts-surface");
    if (!svg) {
      return [];
    }

    const plotArea = getPlotArea(svg);
    const maxValue = getMaxYAxisValue(svg);
    if (!plotArea || !Number.isFinite(maxValue) || maxValue <= 0) {
      return [];
    }

    const columns = extractColumns(svg, plotArea, maxValue);
    if (!columns.length) {
      return [];
    }

    const ticks = extractDateTicks(svg, columns);
    const datedColumns = assignDates(columns, ticks);
    return datedColumns.filter((entry) => entry.date instanceof Date && !Number.isNaN(entry.date.valueOf()));
  }

  function getPlotArea(svg) {
    const clipRect = svg.querySelector("clipPath rect");
    if (!clipRect) {
      return null;
    }

    const x = Number(clipRect.getAttribute("x"));
    const y = Number(clipRect.getAttribute("y"));
    const width = Number(clipRect.getAttribute("width"));
    const height = Number(clipRect.getAttribute("height"));

    if ([x, y, width, height].some((value) => !Number.isFinite(value))) {
      return null;
    }

    return {
      left: x,
      top: y,
      width,
      height,
      bottom: y + height
    };
  }

  function getMaxYAxisValue(svg) {
    const ticks = Array.from(svg.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick-value tspan"))
      .map((node) => Number.parseFloat(node.textContent?.replace(/,/g, "") || ""))
      .filter((value) => Number.isFinite(value));

    return ticks.length ? Math.max(...ticks) : NaN;
  }

  function extractColumns(svg, plotArea, maxValue) {
    const rectangles = Array.from(svg.querySelectorAll(".recharts-bar-rectangle path.recharts-rectangle"));
    const columnsByCenter = new Map();

    for (const node of rectangles) {
      const x = Number(node.getAttribute("x"));
      const y = Number(node.getAttribute("y"));
      const width = Number(node.getAttribute("width"));
      const height = Number(node.getAttribute("height"));
      const fill = node.getAttribute("fill") || "";

      if ([x, y, width, height].some((value) => !Number.isFinite(value))) {
        continue;
      }

      const center = x + width / 2;
      const key = center.toFixed(3);
      const current = columnsByCenter.get(key) || {
        center,
        posts: 0,
        replies: 0
      };

      const value = Math.max(0, Math.round((height / plotArea.height) * maxValue));
      if (/Posts/i.test(fill)) {
        current.posts = value;
      } else if (/Replies/i.test(fill)) {
        current.replies = value;
      } else {
        const inferred = inferSeriesByColor(node, svg);
        current[inferred] = value;
      }

      columnsByCenter.set(key, current);
    }

    return Array.from(columnsByCenter.values()).sort((a, b) => a.center - b.center);
  }

  function inferSeriesByColor(node, svg) {
    const fills = new Map();
    const styleText = svg.parentElement?.querySelector("style")?.textContent || "";
    if (/--color-Posts/.test(styleText) && /--color-Replies/.test(styleText)) {
      fills.set("var(--color-Posts)", "posts");
      fills.set("var(--color-Replies)", "replies");
    }
    const fill = node.getAttribute("fill") || "";
    return fills.get(fill) || "posts";
  }

  function extractDateTicks(svg, columns) {
    const labels = Array.from(svg.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick"));
    const tickData = [];

    for (const label of labels) {
      const text = label.textContent?.trim();
      const textNode = label.querySelector("text");
      const x = Number(textNode?.getAttribute("x"));
      const date = parseTickDate(text);
      if (!text || !Number.isFinite(x) || !date) {
        continue;
      }

      const nearestIndex = findNearestColumnIndex(columns, x);
      tickData.push({
        columnIndex: nearestIndex,
        date
      });
    }

    return tickData.sort((a, b) => a.columnIndex - b.columnIndex);
  }

  function parseTickDate(label) {
    if (!label) {
      return null;
    }

    const currentYear = new Date().getFullYear();
    const parsed = new Date(`${label}, ${currentYear} 12:00:00`);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
    return null;
  }

  function findNearestColumnIndex(columns, x) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    columns.forEach((column, index) => {
      const distance = Math.abs(column.center - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function assignDates(columns, ticks) {
    if (!ticks.length) {
      const end = new Date();
      end.setHours(12, 0, 0, 0);
      return columns.map((column, index) => ({
        ...column,
        total: column.posts + column.replies,
        date: new Date(end.getTime() - (columns.length - 1 - index) * DAY_MS)
      }));
    }

    const dated = columns.map((column) => ({
      ...column,
      total: column.posts + column.replies,
      date: null
    }));

    for (const tick of ticks) {
      dated[tick.columnIndex].date = tick.date;
    }

    for (let i = 1; i < ticks.length; i += 1) {
      const previous = ticks[i - 1];
      const current = ticks[i];
      for (let index = previous.columnIndex + 1; index < current.columnIndex; index += 1) {
        const offset = index - previous.columnIndex;
        dated[index].date = new Date(previous.date.getTime() + offset * DAY_MS);
      }
    }

    const firstTick = ticks[0];
    for (let index = firstTick.columnIndex - 1; index >= 0; index -= 1) {
      const offset = firstTick.columnIndex - index;
      dated[index].date = new Date(firstTick.date.getTime() - offset * DAY_MS);
    }

    const lastTick = ticks[ticks.length - 1];
    for (let index = lastTick.columnIndex + 1; index < dated.length; index += 1) {
      const offset = index - lastTick.columnIndex;
      dated[index].date = new Date(lastTick.date.getTime() + offset * DAY_MS);
    }

    return dated;
  }

  function renderPanel(series) {
    const host = findInsertionPoint();
    if (!host) {
      return;
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.className = STYLE_READY_CLASS;
      host.prepend(panel);
    }

    const maxTotal = Math.max(...series.map((entry) => entry.total), 1);
    const weeks = buildWeeks(series);
    panel.dataset.state = "ready";
    panel.innerHTML = `
      <div class="xheatgrid-card">
        <div class="xheatgrid-header">
          <div>
            <h2>X Activity Heatmap</h2>
            <p data-role="status">${series.length} day${series.length === 1 ? "" : "s"} extracted from account analytics</p>
          </div>
          <div class="xheatgrid-legend">
            <span>Less</span>
            ${[0, 0.25, 0.5, 0.75, 1].map((level) => `<i style="--level:${level}"></i>`).join("")}
            <span>More</span>
          </div>
        </div>
        <div class="xheatgrid-summary">
          <div><strong>${sum(series, "posts")}</strong><span>Posts</span></div>
          <div><strong>${sum(series, "replies")}</strong><span>Replies</span></div>
          <div><strong>${sum(series, "total")}</strong><span>Total</span></div>
        </div>
        <div class="xheatgrid-scroll">
          <div class="xheatgrid-months">${renderMonthLabels(weeks)}</div>
          <div class="xheatgrid-grid-wrap">
            <div class="xheatgrid-days">
              <span>Mon</span>
              <span>Wed</span>
              <span>Fri</span>
            </div>
            <div class="xheatgrid-grid">
              ${weeks.map((week) => `
                <div class="xheatgrid-week">
                  ${week.map((day) => renderCell(day, maxTotal)).join("")}
                </div>
              `).join("")}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function findInsertionPoint() {
    return document.querySelector("main") || document.body;
  }

  function buildWeeks(series) {
    const entries = new Map(
      series.map((item) => [toDayKey(item.date), item])
    );

    const dates = series.map((item) => normalizeDate(item.date)).sort((a, b) => a - b);
    if (!dates.length) {
      return [];
    }

    const start = new Date(dates[0]);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(dates[dates.length - 1]);
    end.setDate(end.getDate() + (7 - end.getDay()) % 7);

    const weeks = [];
    let cursor = new Date(start);
    while (cursor <= end) {
      const week = [];
      for (let row = 0; row < 7; row += 1) {
        const key = toDayKey(cursor);
        const data = entries.get(key) || null;
        week.push({
          date: new Date(cursor),
          posts: data?.posts || 0,
          replies: data?.replies || 0,
          total: data?.total || 0,
          hasData: Boolean(data)
        });
        cursor = new Date(cursor.getTime() + DAY_MS);
      }
      weeks.push(week);
    }

    return weeks;
  }

  function renderMonthLabels(weeks) {
    return weeks.map((week) => {
      const first = week[0].date;
      return `<span>${first.getDate() <= 7 ? first.toLocaleString(undefined, { month: "short" }) : ""}</span>`;
    }).join("");
  }

  function renderCell(day, maxTotal) {
    const level = day.hasData ? Math.max(0.08, day.total / maxTotal) : 0;
    const title = `${formatDate(day.date)}\nPosts: ${day.posts}\nReplies: ${day.replies}\nTotal: ${day.total}`;
    return `
      <button
        class="xheatgrid-cell${day.hasData ? "" : " is-empty"}"
        type="button"
        style="--level:${level}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}"
      ></button>
    `;
  }

  function sum(series, key) {
    return series.reduce((total, item) => total + item[key], 0);
  }

  function toDayKey(date) {
    return normalizeDate(date).toISOString().slice(0, 10);
  }

  function normalizeDate(date) {
    const normalized = new Date(date);
    normalized.setHours(12, 0, 0, 0);
    return normalized;
  }

  function formatDate(date) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("\"", "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function installObservers() {
    if (observerStarted) {
      return;
    }
    observerStarted = true;

    const mutationObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastSignature = "";
      }
      scheduleRefresh(200);
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    const originalPushState = history.pushState;
    history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      scheduleRefresh(50);
      return result;
    };

    window.addEventListener("popstate", () => scheduleRefresh(50));
    window.addEventListener("load", () => scheduleRefresh(50));
  }

  installObservers();
  scheduleRefresh(50);
})();
