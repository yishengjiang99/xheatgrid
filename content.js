(function () {
  const PANEL_ID = "xheatgrid-panel";
  const STYLE_READY_CLASS = "xheatgrid-ready";
  const ANALYTICS_PATH_RE = /\/i\/account_analytics(?:\/|$)/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BUILD_VERSION = "v0.1.3";

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

    const rangeDays = getSelectedRangeDays();
    const series = clampSeriesToRange(extractSeries(chart), rangeDays);
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
    const candidates = [];
    for (const postsButton of buttons) {
      const container = postsButton.closest("div[class*='rounded-2xl']");
      if (!container) {
        continue;
      }
      const repliesButton = container.querySelector("button[aria-label='Replies']");
      const svg = container.querySelector("svg.recharts-surface");
      if (!repliesButton || !svg) {
        continue;
      }

      const area = getSvgArea(svg);
      const rectangleCount = svg.querySelectorAll(".recharts-bar-rectangle path.recharts-rectangle").length;
      candidates.push({
        container,
        score: area + rectangleCount * 10
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length) {
      return candidates[0].container;
    }
    return null;
  }

  function getSvgArea(svg) {
    const viewBox = svg.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/\s+/).map(Number);
      if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
        return parts[2] * parts[3];
      }
    }

    const width = Number(svg.getAttribute("width"));
    const height = Number(svg.getAttribute("height"));
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return width * height;
    }

    return 0;
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
    const barGroups = Array.from(svg.querySelectorAll(":scope > g.recharts-layer.recharts-bar"));
    const slotsBySeries = new Map();

    barGroups.forEach((group, groupIndex) => {
      const rectangles = getBarRectangles(group);
      if (!rectangles.length) {
        return;
      }

      const series = detectBarSeries(group, svg, slotsBySeries, groupIndex, barGroups.length);
      const slots = rectangles.map((rectangle) => readBarSlot(rectangle, plotArea, maxValue));
      slotsBySeries.set(series, slots);
    });

    const postsSlots = slotsBySeries.get("posts") || [];
    const repliesSlots = slotsBySeries.get("replies") || [];
    const slotCount = Math.max(postsSlots.length, repliesSlots.length);
    if (!slotCount) {
      return extractColumnsFromBars(svg, plotArea, maxValue);
    }

    const columns = [];
    const centersByIndex = inferSlotCenters(postsSlots, repliesSlots, plotArea);
    for (let index = 0; index < slotCount; index += 1) {
      const posts = postsSlots[index] || null;
      const replies = repliesSlots[index] || null;
      const center = centersByIndex[index];
      if (!Number.isFinite(center)) {
        continue;
      }

      columns.push({
        center,
        posts: posts?.value || 0,
        replies: replies?.value || 0
      });
    }

    return columns;
  }

  function extractColumnsFromBars(svg, plotArea, maxValue) {
    const rectangles = Array.from(svg.querySelectorAll(".recharts-bar-rectangle path.recharts-rectangle"));
    const bars = [];

    for (const node of rectangles) {
      const x = Number(node.getAttribute("x"));
      const width = Number(node.getAttribute("width"));
      const height = Number(node.getAttribute("height"));
      const fill = node.getAttribute("fill") || "";

      if ([x, width, height].some((value) => !Number.isFinite(value))) {
        continue;
      }

      let series = "";
      if (/Posts/i.test(fill)) {
        series = "posts";
      } else if (/Replies/i.test(fill)) {
        series = "replies";
      } else {
        series = inferSeriesByColor(node, svg);
      }

      bars.push({
        x,
        width,
        center: x + width / 2,
        series,
        value: Math.max(0, Math.round((height / plotArea.height) * maxValue))
      });
    }

    bars.sort((a, b) => a.x - b.x);
    if (!bars.length) {
      return [];
    }

    const typicalWidth = median(bars.map((bar) => bar.width));
    const sameDayGap = typicalWidth * 1.25;
    const columns = [];
    let current = null;

    for (const bar of bars) {
      if (!current || bar.x - current.lastRight > sameDayGap) {
        current = {
          center: bar.center,
          lastRight: bar.x + bar.width,
          posts: 0,
          replies: 0,
          points: [bar.center]
        };
        columns.push(current);
      } else {
        current.lastRight = Math.max(current.lastRight, bar.x + bar.width);
        current.points.push(bar.center);
        current.center = current.points.reduce((sum, point) => sum + point, 0) / current.points.length;
      }

      current[bar.series] = Math.max(current[bar.series], bar.value);
    }

    return columns.map(({ lastRight, points, ...column }) => column);
  }

  function detectBarSeries(group, svg, slotsBySeries, groupIndex, groupCount) {
    if (groupCount === 2) {
      return groupIndex === 0 ? "posts" : "replies";
    }

    const sample = group.querySelector("path.recharts-rectangle");
    if (sample) {
      const fill = sample.getAttribute("fill") || "";
      if (/Posts/i.test(fill) || fill === "var(--color-Posts)") {
        return "posts";
      }
      if (/Replies/i.test(fill) || fill === "var(--color-Replies)") {
        return "replies";
      }

      const inferred = inferSeriesByColor(sample, svg);
      if (inferred) {
        return inferred;
      }
    }

    return slotsBySeries.has("posts") ? "replies" : "posts";
  }

  function getBarRectangles(group) {
    const rectangleLayer = group.querySelector(":scope > g.recharts-layer.recharts-bar-rectangles > g.recharts-layer");
    if (!rectangleLayer) {
      return [];
    }
    return Array.from(rectangleLayer.children).filter((node) => node.classList?.contains("recharts-bar-rectangle"));
  }

  function readBarSlot(rectangle, plotArea, maxValue) {
    const path = rectangle.querySelector("path.recharts-rectangle");
    if (!path) {
      return null;
    }

    const x = Number(path.getAttribute("x"));
    const width = Number(path.getAttribute("width"));
    const height = Number(path.getAttribute("height"));
    if ([x, width, height].some((value) => !Number.isFinite(value))) {
      return null;
    }

    return {
      center: x + width / 2,
      value: Math.max(0, Math.round((height / plotArea.height) * maxValue))
    };
  }

  function inferSlotCenters(postsSlots, repliesSlots, plotArea) {
    const slotCount = Math.max(postsSlots.length, repliesSlots.length);
    const centers = new Array(slotCount).fill(NaN);

    for (let index = 0; index < slotCount; index += 1) {
      const values = [postsSlots[index]?.center, repliesSlots[index]?.center]
        .filter((value) => Number.isFinite(value));
      if (values.length) {
        centers[index] = values.reduce((sum, value) => sum + value, 0) / values.length;
      }
    }

    const known = centers
      .map((center, index) => ({ center, index }))
      .filter((entry) => Number.isFinite(entry.center));

    if (!known.length) {
      return centers;
    }

    const steps = [];
    for (let index = 1; index < known.length; index += 1) {
      const distance = known[index].center - known[index - 1].center;
      const slots = known[index].index - known[index - 1].index;
      if (distance > 0 && slots > 0) {
        steps.push(distance / slots);
      }
    }
    let step = median(steps) || 0;
    if ((!Number.isFinite(step) || step <= 0) && slotCount > 1 && Number.isFinite(plotArea?.width)) {
      step = plotArea.width / (slotCount - 1);
    }

    for (let index = 1; index < known.length; index += 1) {
      const previous = known[index - 1];
      const next = known[index];
      if (next.index - previous.index <= 1) {
        continue;
      }
      for (let missing = previous.index + 1; missing < next.index; missing += 1) {
        const ratio = (missing - previous.index) / (next.index - previous.index);
        centers[missing] = previous.center + (next.center - previous.center) * ratio;
      }
    }

    const firstKnown = known[0];
    for (let index = firstKnown.index - 1; index >= 0; index -= 1) {
      centers[index] = firstKnown.center - (firstKnown.index - index) * step;
    }

    const lastKnown = known[known.length - 1];
    for (let index = lastKnown.index + 1; index < slotCount; index += 1) {
      centers[index] = lastKnown.center + (index - lastKnown.index) * step;
    }

    return centers;
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
    const parsedLabels = labels
      .map((label) => {
        const text = label.textContent?.trim();
        const textNode = label.querySelector("text");
        const x = Number(textNode?.getAttribute("x"));
        const parts = parseTickParts(text);
        if (!text || !Number.isFinite(x) || !parts) {
          return null;
        }

        return {
          label: text,
          x,
          monthIndex: parts.monthIndex,
          day: parts.day
        };
      })
      .filter(Boolean);

    const datedLabels = assignYearsToTicks(parsedLabels);
    const tickData = [];

    for (const label of datedLabels) {
      const nearestIndex = findNearestColumnIndex(columns, label.x);
      tickData.push({
        columnIndex: nearestIndex,
        date: label.date
      });
    }

    return tickData.sort((a, b) => a.columnIndex - b.columnIndex);
  }

  function parseTickParts(label) {
    if (!label) {
      return null;
    }

    const match = label.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
    if (!match) {
      return null;
    }

    const monthIndex = new Date(`${match[1]} 1, 2000`).getMonth();
    const day = Number.parseInt(match[2], 10);
    if (!Number.isFinite(monthIndex) || !Number.isFinite(day)) {
      return null;
    }

    return { monthIndex, day };
  }

  function assignYearsToTicks(labels) {
    if (!labels.length) {
      return [];
    }

    let wraps = 0;
    for (let index = 1; index < labels.length; index += 1) {
      const previous = labels[index - 1];
      const current = labels[index];
      if (
        current.monthIndex < previous.monthIndex ||
        (current.monthIndex === previous.monthIndex && current.day < previous.day)
      ) {
        wraps += 1;
      }
    }

    let year = new Date().getFullYear() - wraps;
    return labels.map((label, index) => {
      if (index > 0) {
        const previous = labels[index - 1];
        if (
          label.monthIndex < previous.monthIndex ||
          (label.monthIndex === previous.monthIndex && label.day < previous.day)
        ) {
          year += 1;
        }
      }

      return {
        ...label,
        date: new Date(year, label.monthIndex, label.day, 12, 0, 0, 0)
      };
    });
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

  function median(values) {
    if (!values.length) {
      return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
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
    const activeDays = series.length;
    const coveredDays = countCoveredDays(weeks);
    panel.dataset.state = "ready";
    panel.innerHTML = `
      <div class="xheatgrid-card">
        <div class="xheatgrid-header">
          <div>
            <h2>X Activity Heatmap <span class="xheatgrid-version">${BUILD_VERSION}</span></h2>
            <p data-role="status">${coveredDays} day window reconstructed from ${activeDays} active day${activeDays === 1 ? "" : "s"}</p>
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

  function countCoveredDays(weeks) {
    return weeks.reduce((total, week) => total + week.length, 0);
  }

  function getSelectedRangeDays() {
    const options = [
      { label: "7D", days: 7 },
      { label: "2W", days: 14 },
      { label: "4W", days: 28 },
      { label: "3M", days: 92 },
      { label: "1Y", days: 366 }
    ];

    for (const option of options) {
      const buttons = Array.from(document.querySelectorAll("button"));
      const activeButton = buttons.find((button) => {
        const text = button.textContent?.trim();
        if (text !== option.label) {
          return false;
        }

        const state = `${button.getAttribute("aria-pressed") || ""} ${button.getAttribute("data-state") || ""} ${button.className || ""}`.toLowerCase();
        return (
          state.includes("active") ||
          state.includes("selected") ||
          state.includes("current") ||
          state.includes("true") ||
          button.getAttribute("aria-current") === "page"
        );
      });

      if (activeButton) {
        return option.days;
      }
    }

    return 366;
  }

  function clampSeriesToRange(series, rangeDays) {
    if (!series.length || !Number.isFinite(rangeDays) || rangeDays <= 0) {
      return series;
    }

    const sorted = [...series].sort((a, b) => a.date - b.date);
    const latest = sorted[sorted.length - 1].date;
    const earliest = new Date(latest.getTime() - (rangeDays - 1) * DAY_MS);
    return sorted.filter((entry) => entry.date >= earliest && entry.date <= latest);
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
