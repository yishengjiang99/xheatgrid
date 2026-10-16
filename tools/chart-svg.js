/*
 * Test-fixture generator: builds a Recharts-shaped <svg> from known daily values using
 * the FORWARD model (value -> bar height), independent of the parser's inverse.
 * Used by tests and to produce fixtures/chart-1y.synthetic.html (SYNTHETIC: no live 1Y
 * capture was available, so the 1Y label format is a guess).
 */
"use strict";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function niceStep(raw) {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) {
    if (step >= raw) {
      return step;
    }
  }
  return Math.ceil(raw);
}

function defaultLabel(date) {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * options: { days, end "YYYY-MM-DD", labelEvery, seed, hide:["replies"], label(date)->string,
 *   plot, labelOffset, values: [{posts,replies}] (optional explicit values, oldest first),
 *   yLabel(value)->string, columnDays (days per column; labels step accordingly) }
 * returns { svg, rows:[{date,posts,replies}], plot, yMax }
 */
function generateChartSvg(options) {
  const o = Object.assign(
    {
      days: 365,
      end: "2026-03-17",
      labelEvery: 30,
      seed: 7,
      hide: [],
      label: defaultLabel,
      plot: { left: 50, top: 5, width: 394, height: 99 },
      labelOffset: 5,
      yLabel: String,
      columnDays: 1
    },
    options
  );
  const plot = o.plot;
  const n = o.days;
  const endMs = Date.parse(`${o.end}T00:00:00Z`);
  const rand = lcg(o.seed);
  const rows = [];
  for (let j = 0; j < n; j += 1) {
    const date = new Date(endMs - (n - 1 - j) * o.columnDays * DAY_MS);
    const given = o.values && o.values[j];
    const posts = given ? given.posts : rand() < 0.3 ? 0 : Math.floor(rand() * 12);
    const replies = given ? given.replies : rand() < 0.1 ? 0 : Math.floor(rand() * 60);
    rows.push({ date: date.toISOString().slice(0, 10), posts, replies, _date: date });
  }
  const visible = ["posts", "replies"].filter((name) => !o.hide.includes(name));
  const maxValue = Math.max(1, ...rows.map((r) => Math.max(...visible.map((name) => r[name]))));
  const step = niceStep(maxValue / 3);
  const yMax = step * 3;
  const unit = plot.height / yMax;
  const band = plot.width / n;
  const barWidth = Math.min(16, Math.max(1, band * 0.25));
  const bottom = plot.top + plot.height;
  const center = (j) => plot.left + (j + 0.5) * band;

  const parts = [];
  parts.push(
    `<svg class="recharts-surface" width="${plot.left + plot.width + 11}" height="${plot.top + plot.height + 35}" viewBox="0 0 ${plot.left + plot.width + 11} ${plot.top + plot.height + 35}" style="width: 100%; height: 100%;"><title></title><desc></desc>`
  );
  parts.push(
    `<defs><clipPath id="recharts-synth-clip"><rect x="${plot.left}" y="${plot.top}" height="${plot.height}" width="${plot.width}"></rect></clipPath></defs>`
  );
  parts.push(`<g class="recharts-layer recharts-cartesian-axis recharts-yAxis yAxis"><g class="recharts-cartesian-axis-ticks">`);
  for (let i = 0; i <= 3; i += 1) {
    const y = bottom - (i * plot.height) / 3;
    const textY = i === 3 ? y + 3.24 : y;
    parts.push(
      `<g class="recharts-layer recharts-cartesian-axis-tick"><text orientation="left" x="42" y="${textY}" class="recharts-text recharts-cartesian-axis-tick-value" text-anchor="end"><tspan x="42" dy="0.355em">${o.yLabel(i * step)}</tspan></text></g>`
    );
  }
  parts.push(`</g></g><g class="recharts-cartesian-grid"><g class="recharts-cartesian-grid-horizontal">`);
  for (const i of [0, 1, 3]) {
    const y = bottom - (i * plot.height) / 3;
    parts.push(`<line x="${plot.left}" y="${plot.top}" x1="${plot.left}" y1="${y}" x2="${plot.left + plot.width}" y2="${y}"></line>`);
  }
  parts.push(`</g></g>`);

  for (const name of visible) {
    const fill = name === "posts" ? "var(--color-Posts)" : "var(--color-Replies)";
    const shift = visible.length === 2 ? (name === "posts" ? -0.7 * (band / 4.378) : 0.7 * (band / 4.378)) : 0;
    parts.push(`<g class="recharts-layer recharts-bar"><g class="recharts-layer recharts-bar-rectangles"><g class="recharts-layer">`);
    for (let j = n - 1; j >= 0; j -= 1) {
      // DOM order is newest first
      const value = rows[j][name];
      parts.push(`<g class="recharts-layer recharts-bar-rectangle">`);
      if (value > 0) {
        const height = value * unit;
        const x = center(j) + shift - barWidth / 2;
        parts.push(
          `<path x="${x}" y="${bottom - height}" width="${barWidth}" height="${height}" radius="2" fill="${fill}" stroke-width="3" class="recharts-rectangle" d="M ${x},${bottom} Z"></path>`
        );
      }
      parts.push(`</g>`);
    }
    parts.push(`</g></g><g class="recharts-layer"></g></g>`);
  }

  parts.push(`<g class="recharts-layer recharts-cartesian-axis recharts-xAxis xAxis"><g class="recharts-cartesian-axis-ticks">`);
  const labelCols = [];
  for (let j = 0; j < n; j += o.labelEvery) {
    labelCols.push(j);
  }
  for (const j of labelCols.reverse()) {
    const x = center(j) - o.labelOffset;
    parts.push(
      `<g class="recharts-layer recharts-cartesian-axis-tick"><text orientation="bottom" x="${x}" y="${bottom + 13}" class="recharts-text recharts-cartesian-axis-tick-value" text-anchor="middle"><tspan x="${x}" dy="0.71em">${o.label(rows[j]._date)}</tspan></text></g>`
    );
  }
  parts.push(`</g></g></svg>`);

  return {
    svg: parts.join(""),
    rows: rows.map(({ date, posts, replies }) => ({ date, posts, replies })),
    plot,
    yMax
  };
}

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { svg, rows } = generateChartSvg({ days: 365, end: "2026-03-17", labelEvery: 30, seed: 7 });
  const html =
    "<!-- SYNTHETIC fixture (tools/chart-svg.js, seed 7): NOT captured from x.com. 365 days ending 2026-03-17 in the recharts structure of the real 3M fixture. The real 1Y label format and day bucketing are UNVERIFIED. -->\n" +
    `<div data-chart="chart-rd">${svg}</div>\n`;
  fs.writeFileSync(path.join(__dirname, "..", "fixtures", "chart-1y.synthetic.html"), html);
  fs.writeFileSync(
    path.join(__dirname, "..", "fixtures", "chart-1y.synthetic.expected.json"),
    JSON.stringify(rows) + "\n"
  );
  console.log(`wrote synthetic 1Y fixture (${rows.length} days)`);
}

module.exports = { generateChartSvg, MONTHS };
