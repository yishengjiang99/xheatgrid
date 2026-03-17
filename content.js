(function () {
  const PANEL_ID = "xheatgrid-panel";
  const STYLE_READY_CLASS = "xheatgrid-ready";
  const ANALYTICS_PATH_RE = /\/i\/account_analytics(?:\/|$)/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BUILD_VERSION = "v0.1.12";

  let lastSignature = "";
  let lastUrl = typeof location !== "undefined" ? location.href : "";
  let refreshTimer = null;
  let observerStarted = false;
  let chartSurfaceObserver = null;
  let observedChartSurface = null;

  function scheduleRefresh(delay = 250) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, delay);
  }

  function refresh() {
    if (!ANALYTICS_PATH_RE.test(location.pathname)) {
      disconnectChartSurfaceObserver();
      removePanel();
      return;
    }

    const chart = findAnalyticsChart();
    if (!chart) {
      disconnectChartSurfaceObserver();
      removePanel("Waiting for analytics chart...");
      return;
    }

    observeChartSurface(chart);
    const rangeDays = getSelectedRangeDays();
    const series = clampSeriesToRange(extractSeries(chart), rangeDays);
    if (!series.length) {
      console.log("[xheatgrid] parsed days: 0");
      removePanel("Unable to extract daily posts/replies yet.");
      return;
    }

    const signature = JSON.stringify(series);
    const panel = document.getElementById(PANEL_ID);
    const panelIsReady = panel?.dataset.state === "ready";
    if (signature === lastSignature && panelIsReady) {
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

  function observeChartSurface(chart) {
    const svg = chart.querySelector("svg.recharts-surface");
    if (!svg) {
      disconnectChartSurfaceObserver();
      return;
    }

    if (observedChartSurface === svg && chartSurfaceObserver) {
      return;
    }

    disconnectChartSurfaceObserver();
    observedChartSurface = svg;
    chartSurfaceObserver = new MutationObserver(() => scheduleRefresh(50));
    chartSurfaceObserver.observe(svg, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  function disconnectChartSurfaceObserver() {
    chartSurfaceObserver?.disconnect();
    chartSurfaceObserver = null;
    observedChartSurface = null;
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

  function extractSeriesFromSvgMarkup(svgMarkup, referenceDate = new Date()) {
    if (typeof svgMarkup !== "string" || !svgMarkup.trim()) {
      return [];
    }

    const plotArea = parsePlotAreaFromSvgMarkup(svgMarkup);
    const maxValue = parseMaxYAxisValueFromSvgMarkup(svgMarkup);
    if (!plotArea || !Number.isFinite(maxValue) || maxValue <= 0) {
      return [];
    }

    const slotGroups = parseBarSlotGroupsFromSvgMarkup(svgMarkup, plotArea, maxValue);
    const columns = extractColumnsFromSlotGroups(slotGroups, plotArea)
      || extractColumnsFromBarData(parseBarsFromSvgMarkup(svgMarkup), plotArea, maxValue);
    if (!columns.length) {
      return [];
    }

    const tickLabels = parseDateTicksFromSvgMarkup(svgMarkup);
    const ticks = extractDateTicksFromData(tickLabels, columns, referenceDate);
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
    const columnsFromSlots = buildColumnsFromSeriesSlots(
      postsSlots,
      repliesSlots,
      estimateSlotCount(svg, postsSlots, repliesSlots),
      plotArea
    );
    if (columnsFromSlots.length) {
      return columnsFromSlots;
    }

    if (!postsSlots.length && !repliesSlots.length) {
      return extractColumnsFromBars(svg, plotArea, maxValue);
    }

    return extractColumnsFromBars(svg, plotArea, maxValue);
  }

  function extractColumnsFromBars(svg, plotArea, maxValue) {
    const rectangles = Array.from(svg.querySelectorAll(".recharts-bar-rectangle path.recharts-rectangle"));
    const bars = rectangles
      .map((node) => {
        const x = Number(node.getAttribute("x"));
        const width = Number(node.getAttribute("width"));
        const height = Number(node.getAttribute("height"));
        const fill = node.getAttribute("fill") || "";

        if ([x, width, height].some((value) => !Number.isFinite(value))) {
          return null;
        }

        let series = "";
        if (/Posts/i.test(fill)) {
          series = "posts";
        } else if (/Replies/i.test(fill)) {
          series = "replies";
        } else {
          series = inferSeriesByColor(node, svg);
        }

        return {
          x,
          width,
          height,
          fill,
          series
        };
      })
      .filter(Boolean);

    return extractColumnsFromBarData(bars, plotArea, maxValue);
  }

  function extractColumnsFromBarData(bars, plotArea, maxValue) {
    const normalizedBars = bars
      .map((bar) => {
        const x = Number(bar.x);
        const width = Number(bar.width);
        const height = Number(bar.height);
        if ([x, width, height].some((value) => !Number.isFinite(value))) {
          return null;
        }

        return {
          x,
          width,
          center: x + width / 2,
          series: bar.series || "posts",
          value: Math.max(0, Math.round((height / plotArea.height) * maxValue))
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);

    if (!normalizedBars.length) {
      return [];
    }

    const typicalWidth = median(normalizedBars.map((bar) => bar.width));
    const sameDayGap = typicalWidth * 1.25;
    const columns = [];
    let current = null;

    for (const bar of normalizedBars) {
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

  function buildColumnsFromSeriesSlots(postsSlots, repliesSlots, slotCount, plotArea) {
    if (!slotCount) {
      return [];
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

    return columns.sort((a, b) => a.center - b.center);
  }

  function extractColumnsFromSlotGroups(slotGroups, plotArea) {
    if (!slotGroups.length) {
      return null;
    }

    const slotsBySeries = new Map();
    slotGroups.forEach((slots) => {
      const sample = slots.find(Boolean);
      if (!sample?.series || slotsBySeries.has(sample.series)) {
        return;
      }
      slotsBySeries.set(sample.series, slots);
    });

    const postsSlots = slotsBySeries.get("posts") || [];
    const repliesSlots = slotsBySeries.get("replies") || [];
    const slotCount = Math.max(postsSlots.length, repliesSlots.length);
    return buildColumnsFromSeriesSlots(postsSlots, repliesSlots, slotCount, plotArea);
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

  function estimateSlotCount(svg, postsSlots, repliesSlots) {
    const explicitCount = Math.max(postsSlots.length, repliesSlots.length);
    if (explicitCount) {
      return explicitCount;
    }

    const ticks = Array.from(svg.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick text"))
      .map((node) => Number(node.getAttribute("x")))
      .filter((value) => Number.isFinite(value));

    if (ticks.length >= 2) {
      const distances = [];
      for (let index = 1; index < ticks.length; index += 1) {
        const distance = ticks[index] - ticks[index - 1];
        if (distance > 0) {
          distances.push(distance);
        }
      }

      const step = median(distances);
      if (Number.isFinite(step) && step > 0) {
        const span = ticks[ticks.length - 1] - ticks[0];
        return Math.round(span / step) + 1;
      }
    }

    return 0;
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

    return extractDateTicksFromData(parsedLabels, columns);
  }

  function extractDateTicksFromData(labels, columns, referenceDate = new Date()) {
    const datedLabels = assignYearsToTicks([...labels].sort((a, b) => a.x - b.x), referenceDate);
    const tickData = [];
    let minColumnIndex = 0;

    for (const label of datedLabels) {
      const nearestIndex = findNearestColumnIndex(columns, label.x, minColumnIndex);
      tickData.push({
        columnIndex: nearestIndex,
        date: label.date
      });
      minColumnIndex = Math.min(columns.length - 1, nearestIndex + 1);
    }

    return tickData.sort((a, b) => a.columnIndex - b.columnIndex);
  }

  function parsePlotAreaFromSvgMarkup(svgMarkup) {
    const rectMatch = svgMarkup.match(/<clipPath\b[^>]*>[\s\S]*?<rect\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\b(?:height="([^"]+)"[^>]*\bwidth="([^"]+)"|\bwidth="([^"]+)"[^>]*\bheight="([^"]+)")[^>]*>/i);
    if (!rectMatch) {
      return null;
    }

    const x = Number(rectMatch[1]);
    const y = Number(rectMatch[2]);
    const width = Number(rectMatch[4] || rectMatch[5]);
    const height = Number(rectMatch[3] || rectMatch[6]);
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

  function parseMaxYAxisValueFromSvgMarkup(svgMarkup) {
    const values = Array.from(svgMarkup.matchAll(/<tspan\b[^>]*>([^<]+)<\/tspan>/gi))
      .map((match) => Number.parseFloat(match[1].replace(/,/g, "")))
      .filter((value) => Number.isFinite(value));

    return values.length ? Math.max(...values) : NaN;
  }

  function parseBarsFromSvgMarkup(svgMarkup) {
    return Array.from(svgMarkup.matchAll(/<path\b[^>]*\bx="([^"]+)"[^>]*\bwidth="([^"]+)"[^>]*\bheight="([^"]+)"[^>]*\bfill="([^"]+)"[^>]*class="recharts-rectangle"[^>]*>/gi))
      .map((match) => {
        const fill = match[4] || "";
        let series = "";
        if (/Posts/i.test(fill)) {
          series = "posts";
        } else if (/Replies/i.test(fill)) {
          series = "replies";
        } else {
          return null;
        }

        return {
          x: Number(match[1]),
          width: Number(match[2]),
          height: Number(match[3]),
          fill,
          series
        };
      })
      .filter(Boolean);
  }

  function parseBarSlotGroupsFromSvgMarkup(svgMarkup, plotArea, maxValue) {
    return svgMarkup
      .split('<g class="recharts-layer recharts-bar">')
      .slice(1)
      .map((groupMarkup) => Array.from(groupMarkup.matchAll(/<g class="recharts-layer recharts-bar-rectangle">([\s\S]*?)<\/g>/gi))
        .map((match) => {
          const pathMatch = match[1].match(/<path\b[^>]*\bx="([^"]+)"[^>]*\bwidth="([^"]+)"[^>]*\bheight="([^"]+)"[^>]*\bfill="([^"]+)"[^>]*class="recharts-rectangle"[^>]*>/i);
          if (!pathMatch) {
            return null;
          }

          const fill = pathMatch[4] || "";
          let series = "";
          if (/Posts/i.test(fill)) {
            series = "posts";
          } else if (/Replies/i.test(fill)) {
            series = "replies";
          } else {
            return null;
          }

          const x = Number(pathMatch[1]);
          const width = Number(pathMatch[2]);
          const height = Number(pathMatch[3]);
          if ([x, width, height].some((value) => !Number.isFinite(value))) {
            return null;
          }

          return {
            center: x + width / 2,
            value: Math.max(0, Math.round((height / plotArea.height) * maxValue)),
            series
          };
        }))
      .filter((slots) => slots.length);
  }

  function parseDateTicksFromSvgMarkup(svgMarkup) {
    return Array.from(svgMarkup.matchAll(/<text\b[^>]*\bx="([^"]+)"[^>]*>\s*<tspan\b[^>]*>([^<]+)<\/tspan>\s*<\/text>/gi))
      .map((match) => {
        const x = Number(match[1]);
        const text = (match[2] || "").trim();
        const parts = parseTickParts(text);
        if (!Number.isFinite(x) || !parts) {
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

  function assignYearsToTicks(labels, referenceDate = new Date()) {
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

    let year = referenceDate.getFullYear() - wraps;
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

  function findNearestColumnIndex(columns, x, minIndex = 0) {
    let bestIndex = Math.max(0, Math.min(columns.length - 1, minIndex));
    let bestDistance = Infinity;
    columns.forEach((column, index) => {
      if (index < minIndex) {
        return;
      }
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
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "X Activity Heatmap");
      host.append(panel);
    }

    const maxTotal = Math.max(...series.map((entry) => entry.total), 1);
    const weeks = buildWeeks(series);
    const activeDays = series.length;
    const coveredDays = countCoveredDays(weeks);
    console.log("[xheatgrid] parsed days:", activeDays);
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
    return document.body || document.documentElement;
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
    const title = `${formatDate(day.date)}\nPosts: ${day.posts}\nReplies: ${day.replies}`;
    return `
      <button
        class="xheatgrid-cell${day.hasData ? "" : " is-empty"}"
        type="button"
        style="--level:${level}"
        data-tooltip="${escapeHtml(title)}"
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

    const pageObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastSignature = "";
        disconnectChartSurfaceObserver();
        scheduleRefresh(50);
        return;
      }

      if (!observedChartSurface || !document.documentElement.contains(observedChartSurface)) {
        disconnectChartSurfaceObserver();
        scheduleRefresh(100);
      }
    });

    pageObserver.observe(document.documentElement, {
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      extractSeriesFromSvgMarkup
    };
  }

  if (typeof window !== "undefined" && typeof document !== "undefined" && typeof location !== "undefined") {
    installObservers();
    scheduleRefresh(50);
  }
})();
