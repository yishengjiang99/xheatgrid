# Changelog

## 0.2.0

Rewrite of the parsing/rendering pipeline. See README for architecture and the live-page checklist.

### Fixed
- Selected range detection no longer matches the `active:` Tailwind variant substring (7D always won and 3M/1Y were truncated to 7 days). Parsing no longer depends on the range at all; the window comes from the parsed dates.
- Dense charts (3M/1Y): x-axis labels are no longer snapped to the nearest column (off-by-one dates, a dropped Dec 31, last bar mislabeled Mar 18). Dates come from a least-squares fit of all labels, validated to be one column per day; inconsistencies show an error instead of wrong dates.
- Year inference works backwards from today (Dec labels viewed in January no longer land in the next year; Feb 29 handled).
- Zero-activity days are level 0; four discrete GitHub-style levels from the quartiles of non-zero totals; legend matches the cells; "no data" is an outline, "0 activity" a dark fill.
- Weeks start on Sunday (grid, labels and padding agree).
- No more 10 Hz refresh loop: own panel writes never trigger refreshes, status text is written only on change, refreshes use a throttle + trailing debounce with a 500 ms max-wait, and off the analytics path only the URL is checked.
- Waiting / error / empty states hide and clear stale data; there is a loading state on first load.
- Tooltips: a single fixed-position tooltip outside the scroller (no clipping, no duplicate native `title`), shown on hover and focus.
- One parser (DOM adapter + pure core). The regex parser is deleted.
- Hiding the Posts or Replies series (legend toggle) works; series are identified strictly by `--color-Posts` / `--color-Replies` fills.
- SPA navigation is detected via the Navigation API, a MAIN-world history hook and a URL check (the dead isolated-world `history.pushState` patch and `load` listener are gone).
- Bar heights are converted with a scale fitted from the y-axis labels/gridlines (handles `1.2K`/`3M`); a reading is accepted only after two matching reads.
- Locale: month names come from `Intl` for the document language; chart is found by structure, not English labels; dates are never fabricated.
- Weekly (or otherwise non-daily) bars are refused.
- Panel UX: close and minimize buttons, `role="region"`, scrolls to the newest week and keeps the scroll position on updates, GitHub-style month labels, status counts active days, DOM built with `createElement` (no `innerHTML`), keyboard navigation, smaller on mobile.
- Dates are calendar based (no `toISOString()` on local noon, no DST drift).
- Version comes from `manifest.json` only; removed unneeded `host_permissions`.
- Dead code removed.
- `sampledom.html` (900 KB logged-in page dump) replaced by trimmed fixtures in `fixtures/`.

### Added
- MAIN-world bridge (`bridge-main.js`) that forwards per-day rows from analytics network responses and Recharts React props (best effort, unverified response shape) with the SVG parser as the guaranteed fallback.
- Rows are merged by date across range changes (in memory only).
- "approximate" badge when values came from bar geometry.
- Debug flag: `localStorage["xheatgrid:debug"] = "1"` logs each refresh and sets `data-xheatgrid-refreshes` on `<html>`.
- Tests (`node --test`), devDependency `linkedom` (tests only).
