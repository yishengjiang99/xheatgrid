/*
 * xheatgrid core: pure, DOM-free logic (dates, axis fitting, series building,
 * levels, week layout, merging, scheduling). Loaded as a classic content script
 * (attaches to globalThis.XHeatgrid) and by node:test via require().
 *
 * All calendar math uses integer "day numbers" (days since 1970-01-01 computed
 * through Date.UTC), so DST and the local timezone never shift a date.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XHeatgrid = Object.assign(root.XHeatgrid || {}, api);
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DAY_MS = 86400000;

  // Calibrated from the 7D, 14D and 3M fixtures: every x-axis label <text x> sits
  // exactly 5px left of the center of the band it labels.
  const DEFAULT_LABEL_OFFSET_PX = 5;

  // ---------------------------------------------------------------- dates

  function dayNumber(y, m, d) {
    return Math.round(Date.UTC(y, m, d) / DAY_MS);
  }

  function fromDayNumber(n) {
    const dt = new Date(n * DAY_MS);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
  }

  function isValidYMD(y, m, d) {
    if (![y, m, d].every(Number.isInteger) || m < 0 || m > 11 || d < 1 || d > 31) {
      return false;
    }
    const r = fromDayNumber(dayNumber(y, m, d));
    return r.y === y && r.m === m && r.d === d;
  }

  function pad(n, width) {
    return String(n).padStart(width, "0");
  }

  /** Day number -> local-calendar-independent "YYYY-MM-DD". */
  function dayKey(n) {
    const { y, m, d } = fromDayNumber(n);
    return `${pad(y, 4)}-${pad(m + 1, 2)}-${pad(d, 2)}`;
  }

  /** Strict "YYYY-MM-DD" -> day number, or null. */
  function parseDayKey(s) {
    const match = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
    if (!match) {
      return null;
    }
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    const d = Number(match[3]);
    return isValidYMD(y, m, d) ? dayNumber(y, m, d) : null;
  }

  /** 0 = Sunday ... 6 = Saturday. */
  function weekday(n) {
    return (((n + 4) % 7) + 7) % 7;
  }

  /**
   * Accepts a day number, a "YYYY-MM-DD" string, or a Date (read in LOCAL time:
   * "today" for the user is their local calendar day).
   */
  function toDayNumber(input) {
    if (typeof input === "number" && Number.isFinite(input)) {
      return input;
    }
    if (typeof input === "string") {
      return parseDayKey(input);
    }
    if (input instanceof Date && !Number.isNaN(input.valueOf())) {
      return dayNumber(input.getFullYear(), input.getMonth(), input.getDate());
    }
    return null;
  }

  // -------------------------------------------------------- label parsing

  function normalizeName(s) {
    return String(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[.\s]/g, "");
  }

  const monthTableCache = new Map();

  /** Map of normalized month name -> month index, built from Intl for `lang` plus English. */
  function getMonthTable(lang) {
    const key = lang || "";
    if (monthTableCache.has(key)) {
      return monthTableCache.get(key);
    }
    const table = new Map();
    const langs = [lang, "en"].filter(Boolean);
    for (const l of langs) {
      let formats;
      try {
        formats = [
          new Intl.DateTimeFormat(l, { month: "short", timeZone: "UTC" }),
          new Intl.DateTimeFormat(l, { month: "long", timeZone: "UTC" }),
          new Intl.DateTimeFormat(l, { month: "short", day: "numeric", timeZone: "UTC" }),
          new Intl.DateTimeFormat(l, { month: "long", day: "numeric", timeZone: "UTC" })
        ];
      } catch (error) {
        continue;
      }
      for (let m = 0; m < 12; m += 1) {
        const date = new Date(Date.UTC(2000, m, 15));
        for (const format of formats) {
          for (const part of format.formatToParts(date)) {
            if (part.type === "month" && !/\d/.test(part.value)) {
              const name = normalizeName(part.value);
              if (name && !table.has(name)) {
                table.set(name, m);
              }
            }
          }
        }
      }
    }
    table.set("sept", 8);
    monthTableCache.set(key, table);
    return table;
  }

  /**
   * Parse an x-axis label like "Dec 18", "18 déc.", "Sept 1", "3月17日", "Mar 1, 2026".
   * Returns { month (0-11), day, year|null } or null. Never guesses.
   */
  function parseTickLabel(text, lang) {
    if (typeof text !== "string") {
      return null;
    }
    const t = text.normalize("NFKC").trim();
    if (!t) {
      return null;
    }

    const cjk = /(\d{1,2})\s*[月월]\s*(\d{1,2})/.exec(t);
    if (cjk) {
      const month = Number(cjk[1]) - 1;
      const day = Number(cjk[2]);
      const yearMatch = /(\d{4})\s*[年년]/.exec(t);
      return finishLabel(month, day, yearMatch ? Number(yearMatch[1]) : null);
    }

    const numbers = t.match(/\d+/g) || [];
    let year = null;
    const rest = [];
    for (const n of numbers) {
      if (n.length === 4 && Number(n) >= 1900 && Number(n) <= 2999 && year === null) {
        year = Number(n);
      } else {
        rest.push(Number(n));
      }
    }
    if (rest.length !== 1) {
      return null;
    }
    const day = rest[0];

    const table = getMonthTable(lang);
    const words = t
      .replace(/\d+/g, " ")
      .split(/[\s,'’\/\-]+/)
      .map(normalizeName)
      .filter(Boolean);
    const months = new Set();
    for (const word of words) {
      if (table.has(word)) {
        months.add(table.get(word));
      }
    }
    if (months.size !== 1) {
      return null;
    }
    return finishLabel([...months][0], day, year);
  }

  function finishLabel(month, day, year) {
    if (!Number.isInteger(month) || month < 0 || month > 11 || !Number.isInteger(day) || day < 1 || day > 31) {
      return null;
    }
    // Feb 29 is only valid in leap years, so validate against a leap year when no year is given.
    if (!isValidYMD(year === null ? 2000 : year, month, day)) {
      return null;
    }
    return { month, day, year };
  }

  /**
   * Assign years to chronologically ordered labels, working BACKWARDS from the last
   * label so it is the latest matching date <= reference (+1 day for UTC vs local).
   * Returns day numbers, or null when no consistent assignment exists.
   */
  function assignDayNumbers(labels, reference) {
    const ref = toDayNumber(reference);
    if (ref === null || !labels.length) {
      return null;
    }
    const out = new Array(labels.length);
    let upper = ref + 1;
    let strict = false;
    for (let i = labels.length - 1; i >= 0; i -= 1) {
      const label = labels[i];
      let found = null;
      if (label.year !== null && label.year !== undefined) {
        if (isValidYMD(label.year, label.month, label.day)) {
          const n = dayNumber(label.year, label.month, label.day);
          found = strict ? (n < upper ? n : null) : (n <= upper ? n : null);
        }
      } else {
        let year = fromDayNumber(upper).y;
        for (let guard = 0; guard < 12 && found === null; guard += 1, year -= 1) {
          if (!isValidYMD(year, label.month, label.day)) {
            continue;
          }
          const n = dayNumber(year, label.month, label.day);
          if (strict ? n < upper : n <= upper) {
            found = n;
          }
        }
      }
      if (found === null) {
        return null;
      }
      out[i] = found;
      upper = found;
      strict = true;
    }
    return out;
  }

  // -------------------------------------------------------------- numbers

  /** "1,200" -> 1200, "1.2K" -> 1200, "3M" -> 3e6, "1,2K" (decimal comma) -> 1200. */
  function parseAxisNumber(text) {
    if (typeof text !== "string") {
      return NaN;
    }
    let t = text.normalize("NFKC").replace(/[\s\u00a0\u202f]/g, "");
    const suffix = /([kKmMbB])$/.exec(t);
    let multiplier = 1;
    if (suffix) {
      multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix[1].toLowerCase()];
      t = t.slice(0, -1);
      if (/^\d+,\d{1,2}$/.test(t)) {
        t = t.replace(",", ".");
      }
    }
    t = t.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(t)) {
      return NaN;
    }
    return Number(t) * multiplier;
  }

  /** Least squares y = a + b*x. Returns { a, b, maxResidual } or null. */
  function fitLine(points) {
    const n = points.length;
    if (n < 2) {
      return null;
    }
    const mx = points.reduce((s, p) => s + p.x, 0) / n;
    const my = points.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const p of points) {
      sxx += (p.x - mx) * (p.x - mx);
      sxy += (p.x - mx) * (p.y - my);
    }
    if (sxx === 0) {
      return null;
    }
    const b = sxy / sxx;
    const a = my - b * mx;
    let maxResidual = 0;
    for (const p of points) {
      maxResidual = Math.max(maxResidual, Math.abs(p.y - (a + b * p.x)));
    }
    return { a, b, maxResidual };
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
    if (!sorted.length) {
      return NaN;
    }
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ------------------------------------------------- geometry -> daily rows

  function fail(code, message, extra) {
    return { ok: false, error: Object.assign({ code, message }, extra || {}) };
  }

  /** "var(--color-Posts)" -> "posts"; unknown names are returned lower-cased; non-var fills -> null. */
  function seriesFromFill(fill) {
    const match = typeof fill === "string" ? /--color-([A-Za-z0-9_-]+)/.exec(fill) : null;
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Identify each bar group STRICTLY by its fill. A group with no bars (every day is
   * zero, or all slots empty) is only identified when it is the complement of an
   * identified sibling in a two-group chart. Returns { posts: group|null, replies: group|null }
   * or { error }.
   */
  function identifySeries(groups) {
    const result = { posts: null, replies: null };
    const unknown = [];
    for (const group of groups) {
      const names = new Set(group.bars.map((bar) => seriesFromFill(bar.fill)));
      if (names.size > 1) {
        return { error: fail("series-unidentified", "A bar group mixes several series fills.") };
      }
      if (names.size === 0) {
        unknown.push(group);
        continue;
      }
      const name = [...names][0];
      if (name !== "posts" && name !== "replies") {
        return { error: fail("series-unidentified", `Unexpected series fill "${name}" (not Posts/Replies).`) };
      }
      if (result[name]) {
        return { error: fail("series-unidentified", `Two bar groups claim to be ${name}.`) };
      }
      result[name] = group;
    }
    for (const group of unknown) {
      const free = ["posts", "replies"].filter((name) => !result[name]);
      if (groups.length === 2 && free.length === 1) {
        result[free[0]] = group;
      } else if (groups.length === 2 && free.length === 2) {
        // Both groups empty: group order is Posts then Replies (verified on fixtures).
        result[group === groups[0] ? "posts" : "replies"] = group;
      } else {
        return {
          error: fail(
            "series-unidentified",
            "Cannot tell which series is visible (single empty bar group with no fill to read)."
          )
        };
      }
    }
    return result;
  }

  /**
   * Convert a plain description of the chart geometry into daily rows.
   *
   * input = {
   *   plot: { left, top, width, height },
   *   groups: [{ slotCount, bars: [{ slotIndex, x, width, height, fill }] }],
   *   yTicks: [{ text, y, gridY|null }],
   *   xTicks: [{ text, x }]
   * }
   * opts = { lang, reference, labelOffsetPx }
   *
   * Never fabricates dates: any inconsistency returns { ok:false, error:{code,message} }.
   */
  function buildSeriesFromGeometry(input, opts) {
    const options = opts || {};
    const warnings = [];
    const labelOffset = Number.isFinite(options.labelOffsetPx) ? options.labelOffsetPx : DEFAULT_LABEL_OFFSET_PX;
    const reference = toDayNumber(options.reference === undefined ? new Date() : options.reference);

    if (!input || !input.plot || !input.groups || !input.groups.length) {
      return fail("no-chart", "No bar groups found in the chart.");
    }
    const { plot } = input;
    const slotCount = Math.max(...input.groups.map((group) => group.slotCount));
    if (![plot.left, plot.width, plot.height].every(Number.isFinite) || plot.width <= 0 || plot.height <= 0 || !(slotCount >= 1)) {
      return fail("no-bars", "Chart plot area or bar slots are missing.");
    }
    const band = plot.width / slotCount;

    // 1. series identity (strictly by fill)
    const identified = identifySeries(input.groups);
    if (identified.error) {
      return identified.error;
    }
    const visible = { posts: Boolean(identified.posts), replies: Boolean(identified.replies) };
    if (!visible.posts && !visible.replies) {
      return fail("series-unidentified", "Neither Posts nor Replies bars are visible.");
    }

    // 2. slot direction (DOM order vs x order) from bar geometry
    const allBars = [];
    for (const name of ["posts", "replies"]) {
      for (const bar of (identified[name] ? identified[name].bars : [])) {
        if ([bar.slotIndex, bar.x, bar.width, bar.height].every(Number.isFinite)) {
          allBars.push({ series: name, ...bar, center: bar.x + bar.width / 2 });
        }
      }
    }
    let reversed = true; // verified on fixtures: first DOM slot is the newest (right-most)
    if (allBars.length) {
      let errAsc = 0;
      let errRev = 0;
      for (const bar of allBars) {
        const col = Math.floor((bar.center - plot.left) / band);
        errAsc += Math.abs(col - bar.slotIndex);
        errRev += Math.abs(col - (slotCount - 1 - bar.slotIndex));
      }
      const best = Math.min(errAsc, errRev) / allBars.length;
      if (best > 1.5) {
        return fail("bars-misaligned", "Bar positions do not line up with the slot order / plot width.");
      }
      if (errAsc === errRev) {
        warnings.push("Slot direction could not be confirmed from bars; assuming newest-first DOM order.");
      } else {
        reversed = errRev < errAsc;
      }
    } else {
      warnings.push("No bars drawn (all zero); slot direction assumed newest-first.");
    }

    // 3. value scale from y ticks (gridline positions where available)
    const yPoints = [];
    for (const tick of input.yTicks || []) {
      const value = parseAxisNumber(tick.text);
      if (!Number.isFinite(value) || !Number.isFinite(tick.y)) {
        continue;
      }
      const y = Number.isFinite(tick.gridY) && Math.abs(tick.gridY - tick.y) <= 4 ? tick.gridY : tick.y;
      yPoints.push({ x: value, y });
    }
    const hasBars = allBars.some((bar) => bar.height > 0);
    let pxPerUnit = NaN;
    let scaleFit = null;
    if (hasBars) {
      scaleFit = fitLine(yPoints);
      if (!scaleFit || !(scaleFit.b < 0)) {
        return fail("bad-axis", "Could not fit a value scale from the y-axis labels.");
      }
      if (scaleFit.maxResidual > 1) {
        return fail("bad-axis", `Y-axis labels are not linear (residual ${scaleFit.maxResidual.toFixed(2)}px).`);
      }
      pxPerUnit = -scaleFit.b;
    }

    // 4. x labels -> dates (no snapping; never invent dates)
    if (reference === null) {
      return fail("no-reference", "No reference date available.");
    }
    const parsedLabels = [];
    for (const tick of input.xTicks || []) {
      const parsed = parseTickLabel(tick.text, options.lang);
      if (!parsed || !Number.isFinite(tick.x)) {
        return fail("labels-unparseable", `Cannot parse x-axis label "${tick.text}" as a date.`, { label: tick.text });
      }
      parsedLabels.push({ ...parsed, x: tick.x, text: tick.text });
    }
    if (!parsedLabels.length) {
      return fail("labels-unparseable", "The chart has no readable x-axis date labels.");
    }
    parsedLabels.sort((p, q) => p.x - q.x);
    const days = assignDayNumbers(parsedLabels, reference);
    if (!days) {
      return fail("labels-unparseable", "x-axis labels do not form a valid chronological sequence.");
    }
    for (let i = 1; i < days.length; i += 1) {
      if (!(days[i] > days[i - 1]) || parsedLabels[i].x - parsedLabels[i - 1].x < 1e-6) {
        return fail("labels-unparseable", "x-axis labels are not strictly increasing in both date and position.");
      }
    }

    const center0 = plot.left + band / 2;
    let startDay;
    let daysPerColumn = 1;
    if (parsedLabels.length >= 2) {
      const fit = fitLine(parsedLabels.map((label, i) => ({ x: days[i] - days[0], y: label.x })));
      if (!fit || !(fit.b > 0)) {
        return fail("labels-misaligned", "x-axis labels do not advance left to right.");
      }
      daysPerColumn = band / fit.b;
      if (Math.abs(daysPerColumn - 1) > 0.03) {
        return fail(
          "columns-not-daily",
          `Each bar covers ${daysPerColumn.toFixed(2)} days (expected 1); refusing to guess dates.`,
          { daysPerColumn }
        );
      }
      if (fit.maxResidual > Math.max(0.5 * band, 0.5)) {
        return fail("labels-misaligned", `x-axis labels deviate ${fit.maxResidual.toFixed(2)}px from a straight line.`);
      }
      // first column's day offset relative to the first label, from the fitted line
      const u0 = (center0 - labelOffset - fit.a) / fit.b;
      if (Math.abs(u0 - Math.round(u0)) > 0.4) {
        return fail("labels-misaligned", "x-axis labels do not sit on bar columns (offset changed?).");
      }
      startDay = days[0] + Math.round(u0);
    } else {
      const col = (parsedLabels[0].x + labelOffset - center0) / band;
      if (Math.abs(col - Math.round(col)) > 0.4) {
        return fail("labels-misaligned", "The x-axis label does not sit on a bar column.");
      }
      startDay = days[0] - Math.round(col);
      warnings.push("Only one x-axis label: bar spacing could not be cross-checked.");
    }

    // pairwise agreement of every label with "1 column = 1 day"
    const colOfLabel = [];
    for (let i = 0; i < parsedLabels.length; i += 1) {
      const col = (parsedLabels[i].x + labelOffset - center0) / band;
      const rounded = Math.round(col);
      if (Math.abs(col - rounded) > 0.4 || rounded < 0 || rounded > slotCount - 1) {
        return fail("labels-misaligned", `Label "${parsedLabels[i].text}" falls outside any bar column.`);
      }
      if (startDay + rounded !== days[i]) {
        return fail(
          "columns-not-daily",
          `Label "${parsedLabels[i].text}" disagrees with the one-column-per-day layout.`
        );
      }
      colOfLabel.push(rounded);
    }

    // When bands are wide the calibrated label offset can be cross-checked directly.
    if (band >= 4 * Math.abs(labelOffset) && labelOffset !== 0) {
      const measured = parsedLabels.map((label, i) => (plot.left + (colOfLabel[i] + 0.5) * band) - label.x);
      const mean = measured.reduce((s, v) => s + v, 0) / measured.length;
      if (Math.abs(mean - labelOffset) > 1) {
        return fail(
          "label-offset-changed",
          `x-axis labels sit ${mean.toFixed(1)}px from band centers (calibrated ${labelOffset}px); layout changed.`
        );
      }
    }

    const endDay = startDay + slotCount - 1;
    if (endDay > reference + 1) {
      return fail("future-dates", `Parsed chart ends ${dayKey(endDay)}, after today (${dayKey(reference)}).`);
    }

    // 5. values
    const rows = [];
    const slotValue = { posts: new Map(), replies: new Map() };
    let maxRounding = 0;
    for (const bar of allBars) {
      const raw = bar.height / pxPerUnit;
      const value = Math.max(0, Math.round(raw));
      maxRounding = Math.max(maxRounding, Math.abs(raw - value));
      slotValue[bar.series].set(bar.slotIndex, value);
    }
    if (maxRounding > 0.3) {
      warnings.push(`Bar heights are not integral (max error ${maxRounding.toFixed(2)}); chart may be mid-animation.`);
    }
    for (let j = 0; j < slotCount; j += 1) {
      const slot = reversed ? slotCount - 1 - j : j;
      rows.push({
        date: dayKey(startDay + j),
        posts: visible.posts ? slotValue.posts.get(slot) || 0 : null,
        replies: visible.replies ? slotValue.replies.get(slot) || 0 : null
      });
    }

    return {
      ok: true,
      rows,
      hidden: ["posts", "replies"].filter((name) => !visible[name]),
      warnings,
      meta: {
        slotCount,
        band,
        daysPerColumn,
        pxPerUnit,
        reversed,
        labelCount: parsedLabels.length,
        firstDate: rows[0].date,
        lastDate: rows[rows.length - 1].date,
        maxRounding,
        approximate: true
      }
    };
  }

  // ------------------------------------------------------- rows & merging

  const MAX_ROWS = 2000;
  const MAX_COUNT = 1e9;

  /** Validate untrusted rows (from postMessage / network). Returns { rows, dropped }. */
  function validateRows(input) {
    const rows = [];
    let dropped = 0;
    if (!Array.isArray(input) || input.length > MAX_ROWS) {
      return { rows, dropped: Array.isArray(input) ? input.length : 0 };
    }
    const seen = new Set();
    for (const item of input) {
      if (!item || typeof item !== "object" || parseDayKey(item.date) === null || seen.has(item.date)) {
        dropped += 1;
        continue;
      }
      const posts = cleanCount(item.posts);
      const replies = cleanCount(item.replies);
      if (posts === undefined || replies === undefined || (posts === null && replies === null)) {
        dropped += 1;
        continue;
      }
      seen.add(item.date);
      rows.push({ date: item.date, posts, replies });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { rows, dropped };
  }

  function cleanCount(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT) {
      return value;
    }
    return undefined;
  }

  function createStore() {
    return { days: new Map() };
  }

  /**
   * Merge rows into the store by date. A null count means "unknown / hidden series":
   * it never overwrites a known value. Network/React data ("data") is never replaced
   * by pixel-derived values ("chart").
   * Returns true when something changed.
   */
  function mergeRows(store, rows, source) {
    let changed = false;
    for (const row of rows) {
      let entry = store.days.get(row.date);
      if (!entry) {
        entry = { date: row.date, posts: null, replies: null, postsSource: null, repliesSource: null };
        store.days.set(row.date, entry);
        changed = true;
      }
      for (const name of ["posts", "replies"]) {
        const incoming = row[name];
        if (incoming === null || incoming === undefined) {
          continue;
        }
        if (entry[`${name}Source`] === "data" && source !== "data") {
          continue;
        }
        if (entry[name] !== incoming || entry[`${name}Source`] !== source) {
          entry[name] = incoming;
          entry[`${name}Source`] = source;
          changed = true;
        }
      }
    }
    return changed;
  }

  function storeRows(store) {
    return [...store.days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // -------------------------------------------------------------- levels

  /**
   * GitHub-style discrete levels: 0 = no activity, 1..4 = quartiles of the NON-ZERO
   * daily totals. Returns thresholds { t1, t2, t3, min, max } (level = 1 + (n>t1) + (n>t2) + (n>t3)).
   */
  function computeThresholds(totals) {
    const nonZero = totals.filter((n) => n > 0).sort((a, b) => a - b);
    if (!nonZero.length) {
      return { t1: 0, t2: 0, t3: 0, min: 0, max: 0 };
    }
    // linear-interpolated quantiles, so even two distinct values spread over all four levels
    const q = (p) => {
      const pos = p * (nonZero.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      return nonZero[lo] + (nonZero[hi] - nonZero[lo]) * (pos - lo);
    };
    return { t1: q(0.25), t2: q(0.5), t3: q(0.75), min: nonZero[0], max: nonZero[nonZero.length - 1] };
  }

  function levelFor(total, th) {
    if (!(total > 0)) {
      return 0;
    }
    if (th.min === th.max) {
      return 4;
    }
    return 1 + (total > th.t1 ? 1 : 0) + (total > th.t2 ? 1 : 0) + (total > th.t3 ? 1 : 0);
  }

  /** Human-readable total range for each level 0..4 (legend tooltips). */
  function levelRanges(th) {
    if (th.max === 0) {
      return ["0", "", "", "", ""];
    }
    if (th.min === th.max) {
      return ["0", "", "", "", String(th.max)];
    }
    // integer n satisfies n > t exactly when n >= floor(t) + 1
    const edges = [0, Math.floor(th.t1), Math.floor(th.t2), Math.floor(th.t3), th.max];
    const out = ["0"];
    for (let level = 1; level <= 4; level += 1) {
      const lo = edges[level - 1] + 1;
      const hi = edges[level];
      out.push(hi < lo ? "" : lo === hi ? String(lo) : `${lo}–${hi}`);
    }
    return out;
  }

  // --------------------------------------------------------------- weeks

  /**
   * Sunday-start week layout (row 0 = Sunday ... row 6 = Saturday). The window runs
   * from the first to the last entry; padding cells before/after it, and days missing
   * inside it, have hasData=false ("no data"), distinct from hasData=true with total 0.
   */
  function buildWeeks(entries) {
    const byDate = new Map();
    let first = Infinity;
    let last = -Infinity;
    for (const entry of entries) {
      const n = parseDayKey(entry.date);
      if (n === null) {
        continue;
      }
      byDate.set(n, entry);
      first = Math.min(first, n);
      last = Math.max(last, n);
    }
    if (!byDate.size) {
      return [];
    }
    const start = first - weekday(first);
    const end = last + (6 - weekday(last));
    const weeks = [];
    for (let n = start; n <= end; n += 7) {
      const week = [];
      for (let row = 0; row < 7; row += 1) {
        const day = n + row;
        const entry = byDate.get(day);
        const posts = entry && entry.posts ? entry.posts : 0;
        const replies = entry && entry.replies ? entry.replies : 0;
        week.push({
          date: dayKey(day),
          dayNumber: day,
          row,
          hasData: Boolean(entry),
          posts,
          replies,
          postsKnown: Boolean(entry) && entry.posts !== null && entry.posts !== undefined,
          repliesKnown: Boolean(entry) && entry.replies !== null && entry.replies !== undefined,
          total: posts + replies
        });
      }
      weeks.push(week);
    }
    return weeks;
  }

  /**
   * GitHub-style month labels: the first column is labeled with its month, then each
   * column whose week contains the 1st of a month. A label closer than `minGap`
   * columns to the previous one is skipped (a too-short first label is dropped instead).
   */
  function monthLabelColumns(weeks, minGap) {
    const gap = minGap === undefined ? 3 : minGap;
    const labels = [];
    weeks.forEach((week, col) => {
      if (col === 0) {
        const firstDay = week.find((cell) => cell.hasData) || week[0];
        const { y, m } = fromDayNumber(firstDay.dayNumber);
        labels.push({ col, year: y, month: m });
        return;
      }
      const firstOfMonth = week.find((cell) => fromDayNumber(cell.dayNumber).d === 1);
      if (!firstOfMonth) {
        return;
      }
      const { y, m } = fromDayNumber(firstOfMonth.dayNumber);
      const previous = labels[labels.length - 1];
      if (previous && col - previous.col < gap) {
        if (previous.col === 0) {
          labels.pop();
        } else {
          return;
        }
      }
      labels.push({ col, year: y, month: m });
    });
    return labels;
  }

  // ----------------------------------------------------------- scheduling

  /**
   * Trailing debounce with a max-wait so a constantly mutating page can never starve
   * the callback: fn runs at most `maxWait` ms after the first pending schedule().
   */
  function createScheduler(fn, options) {
    const o = options || {};
    const delay = o.delay === undefined ? 150 : o.delay;
    const maxWait = o.maxWait === undefined ? 500 : o.maxWait;
    const now = o.now || (() => Date.now());
    const setTimer = o.setTimer || ((f, ms) => setTimeout(f, ms));
    const clearTimer = o.clearTimer || ((id) => clearTimeout(id));
    let timer = null;
    let firstAt = 0;
    let reasons = [];

    function run() {
      timer = null;
      const batch = reasons;
      reasons = [];
      fn(batch);
    }

    return {
      schedule(reason) {
        const t = now();
        if (timer === null) {
          firstAt = t;
        } else {
          clearTimer(timer);
        }
        if (reason !== undefined) {
          reasons.push(reason);
        }
        timer = setTimer(run, Math.max(0, Math.min(delay, firstAt + maxWait - t)));
      },
      cancel() {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
          reasons = [];
        }
      },
      isPending() {
        return timer !== null;
      }
    };
  }

  /**
   * True for mutation records caused by the extension's own panel, which must never
   * re-trigger a refresh (bug: the status-text write used to loop at 10 Hz).
   */
  function isOwnMutation(record, panelId) {
    const inPanel = (node) => {
      const el = node && node.nodeType === 3 ? node.parentElement : node;
      return Boolean(el && el.closest && el.closest(`#${panelId}`));
    };
    if (inPanel(record.target)) {
      return true;
    }
    const changed = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    return changed.length > 0 && changed.every((node) => node.nodeType === 1 && node.id === panelId);
  }

  return {
    DAY_MS,
    DEFAULT_LABEL_OFFSET_PX,
    dayNumber,
    fromDayNumber,
    dayKey,
    parseDayKey,
    weekday,
    toDayNumber,
    isValidYMD,
    getMonthTable,
    parseTickLabel,
    assignDayNumbers,
    parseAxisNumber,
    fitLine,
    median,
    seriesFromFill,
    identifySeries,
    buildSeriesFromGeometry,
    validateRows,
    createStore,
    mergeRows,
    storeRows,
    computeThresholds,
    levelFor,
    levelRanges,
    buildWeeks,
    monthLabelColumns,
    createScheduler,
    isOwnMutation
  };
});
