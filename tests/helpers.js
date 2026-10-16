"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");

const ROOT = path.join(__dirname, "..");

function readFixture(name) {
  return fs.readFileSync(path.join(ROOT, "fixtures", name), "utf8");
}

/** Parse a fixture (svg or html) into a linkedom document. */
function loadFixture(name) {
  const text = readFixture(name);
  const html = name.endsWith(".svg") ? `<html><body>${text}</body></html>` : `<html><body>${text}</body></html>`;
  return parseHTML(html);
}

function chartSvg(document) {
  return document.querySelector("svg.recharts-surface");
}

function docFromSvgString(svg) {
  return parseHTML(`<html><body><div>${svg}</div></body></html>`);
}

/** day number difference helper for consecutive-date assertions */
function assertConsecutive(core, assert, rows) {
  const nums = rows.map((r) => core.parseDayKey(r.date));
  assert.ok(nums.every((n) => n !== null), "all dates valid");
  for (let i = 1; i < nums.length; i += 1) {
    assert.equal(nums[i] - nums[i - 1], 1, `gap/dupe between ${rows[i - 1].date} and ${rows[i].date}`);
  }
}

module.exports = { ROOT, readFixture, loadFixture, chartSvg, docFromSvgString, assertConsecutive };
