# X Analytics Heatmap

Chrome extension that reads the `x.com/i/account_analytics` activity chart, extracts daily `Posts` and `Replies`, and renders a GitHub-style heatmap directly on the page.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `/Users/yishengj/xheatgrid`.

## How it works

- Targets the analytics chart that contains `Posts` and `Replies`.
- Reads the Recharts SVG bars and axis labels from the page DOM.
- Reconstructs daily values by mapping bar positions to the labeled dates.
- Draws an in-page heatmap where each cell represents one day and intensity is based on `posts + replies`.

## Notes

- The current parser is designed around the chart structure shown in the provided HTML.
- If X changes the analytics DOM or Recharts markup, selectors may need adjustment.
- Empty days are included in the calendar grid so the layout matches a contribution chart.
