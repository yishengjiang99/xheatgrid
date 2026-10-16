# X Analytics Heatmap

Chrome (MV3) extension, plain JS, **no build step, no runtime dependencies**. On
`https://x.com/i/account_analytics` it reads the daily **Posts** and **Replies** counts
and draws a GitHub-style heatmap panel (Sunday-first weeks, four discrete activity levels,
one floating tooltip, close/minimize, scrolls to the newest week).

## Install

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder.
2. Requires Chrome 111+ (the bridge is a `"world": "MAIN"` content script).
3. Open `https://x.com/i/account_analytics`.

## How it works

```
page (x.com)                          extension
┌─────────────────────┐   postMessage   ┌──────────────────────────────────────────┐
│ bridge-main.js      │ ──────────────▶ │ isolated world (lib/*.js + content.js)    │
│ (MAIN world,        │   rows + nav    │  controller.js  state, observers, refresh │
│  document_start)    │ ◀────────────── │  chart-parser.js DOM adapter (the ONE     │
│  - wraps fetch/XHR  │   scan-request  │                 parsing path)             │
│  - reads React props│                 │  core.js        pure logic (tested)       │
│  - hooks history.*  │                 │  render.js      createElement UI          │
└─────────────────────┘                 └──────────────────────────────────────────┘
```

Data sources, best first:

1. **Network** (MAIN world): JSON responses from x.com/twitter.com URLs containing
   `analytic` are scanned for an array of per-day objects with a date and posts/replies
   counts. **The response shape is a guess (UNVERIFIED on the live site)**; anything
   unexpected is ignored.
2. **React props** (MAIN world): `props.data` of the Recharts chart found via the
   `__reactFiber$…` expando on `.recharts-wrapper`. **UNVERIFIED**, same validation.
3. **SVG geometry** (guaranteed fallback, verified against fixtures): bar heights are
   converted to counts and x-axis labels to dates. Values from this path show an
   **approximate** badge.

Everything coming from the bridge is untrusted: the isolated script checks
`event.source === window`, origin and a namespaced `source`/`type`, then validates every row
(`core.validateRows`). Page scripts can also post such messages, so the heatmap can be
fed fake numbers by the page itself; it only affects what this panel displays.

Rows are merged **by date** across range changes (memory only, cleared when you leave the
analytics path; no `storage` permission). X data is never overwritten by pixel-derived data.

### SVG geometry parsing (what is assumed)

* Chart = the `svg.recharts-surface` whose bar fills are `var(--color-Posts)` /
  `var(--color-Replies)` (not English labels, not Tailwind classes). Series are identified
  strictly by fill, so hiding one series (legend toggle) still works
  ("Replies hidden - counts shown are posts only", last known replies are kept).
* Each `g.recharts-bar-rectangle` is one day; zero days have no `<path>`. Slot order vs x
  order is detected from the bars. Band centers come from the plot clip rect
  (`left + (i + 0.5) * width / n`), so zero days need no interpolation.
* Dates: x-axis labels are parsed with `Intl` month names for `<html lang>` (plus English),
  years are assigned backwards from today, a least-squares line over **all** labels must
  show exactly one column per day (7D/14D/3M verified; weekly bars are refused), and every
  label must sit on a column. Labels are **never snapped** to the nearest column.
* **Calibrated constant:** every label `<text x>` sits 5 px left of its band center in all
  three fixtures (`DEFAULT_LABEL_OFFSET_PX`). On dense charts (3M, 1Y) this offset is a
  multiple of the column width and cannot be derived from the page, so it is trusted and
  only checked for sub-column consistency (and cross-checked directly on sparse charts).
  This is the main residual risk of the fallback on 1Y, which is why that path is badged
  approximate and why the network/React sources exist.
* Values: scale fitted from y-axis labels vs gridline positions (`1.2K`, `3M` handled); a
  reading is accepted only after two consecutive identical reads (animation).
* If anything does not add up the panel shows an **error state**; dates are never invented.

## Tests

```
npm install      # only devDependency: linkedom (DOM for tests)
node --test
```

`fixtures/`: `chart-7d.svg`, `chart-14d.svg`, `chart-3m.html` (trimmed from a real page
dump: range buttons + chart card only) and `chart-1y.synthetic.html` (**SYNTHETIC**, from
`tools/chart-svg.js`; the real 1Y label format and bucketing are unverified; regenerate with
`node tools/chart-svg.js`). To add a real 1Y fixture: on the 1Y range, DevTools → select
the chart card `div` → *Copy outerHTML* → save as `fixtures/chart-1y.html` and replace the
synthetic one in `tests/parse.test.js`.

## Debugging

`localStorage.setItem("xheatgrid:debug", "1")` then reload: every refresh logs
`[xheatgrid] refresh #N <reasons>` (console level *Verbose*), and
`document.documentElement.dataset.xheatgridRefreshes` holds the counter. Remove the key to
turn it off.

## Manual live-page checklist (not automated; needs a logged-in x.com tab)

Set the debug flag first (see above), reload `https://x.com/i/account_analytics`.

- [ ] Panel appears (briefly "Waiting…"/"Reading chart…", then the grid). Console: no errors.
- [ ] Switch **7D → 2W → 4W → 3M → 1Y → back to 7D**. After each: the date range in the
      panel header matches X's chart, newest day is today (or X's last day).
- [ ] For each range spot-check **at least 3 days** (first, a middle one, the newest) against
      X's own hover tooltip on the chart: Posts and Replies must match. Note whether the
      panel shows the *approximate* badge (means no network/React data was received).
- [ ] 1Y: check days around New Year (Dec 31 / Jan 1) and the first/last visible day.
      If the panel shows an error ("columns-not-daily", "labels-unparseable", …) that is
      useful: copy the console warning, and save the chart card outerHTML as a fixture.
- [ ] Toggle the **Replies** legend button: panel stays, shows "Replies hidden - counts shown
      are posts only"; toggle **Posts** hidden likewise; both back on.
- [ ] **Idle:** leave the tab untouched 60 s; `data-xheatgrid-refreshes` must not change
      (it only moves when X re-renders the chart).
- [ ] Hover cells in the top row: single tooltip, not clipped, no second native tooltip.
      Tab into the grid, use arrow keys. Close (×) and minimize (–) work.
- [ ] Navigate to another x.com page: panel disappears; use browser Back: panel returns
      without a reload. Open another `/i/account_analytics/...` sub-tab without the chart:
      panel says "No Posts/Replies chart…" and the counter stops moving.
- [ ] Debug-only: in the console, `data-xheatgrid-refreshes` plus a `data/geometry mismatch`
      debug line tells you if network/React rows ever disagree with the bars.

## Verified vs unverified

Verified (automated, `node --test`): everything against the 7D/14D/3M fixtures and
generated charts; controller behaviour with fake timers/observers; bridge parsing with fake
windows. Smoke-tested by hand in headless Chrome 154 loading the unpacked extension on a
local mock page containing the fixtures (extension loads, MAIN-world script runs, panel
renders, SPA navigation away/back works, idle counter flat).

**Not verified on the live site:** the network response shape, the React props shape,
real 1Y label format/bucketing, that X buckets days in UTC vs local time, and rendering
inside X's real page CSS.
