const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { extractSeriesFromSvgMarkup } = require("./content.js");

test("extractSeriesFromSvgMarkup parses 7 active days from the 7D posts/replies chart", () => {
  const svgMarkup = fs.readFileSync(path.join(__dirname, "group.svg"), "utf8");
  const series = extractSeriesFromSvgMarkup(svgMarkup, new Date("2026-03-17T12:00:00Z"));

  assert.equal(series.length, 7);

  const simplified = series.map((entry) => ({
    day: entry.date.getDate(),
    posts: entry.posts,
    replies: entry.replies
  }));

  assert.deepEqual(simplified, [
    { day: 11, posts: 5, replies: 35 },
    { day: 12, posts: 3, replies: 12 },
    { day: 13, posts: 0, replies: 18 },
    { day: 14, posts: 0, replies: 21 },
    { day: 15, posts: 5, replies: 40 },
    { day: 16, posts: 4, replies: 27 },
    { day: 17, posts: 2, replies: 15 }
  ]);
});
