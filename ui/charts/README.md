# BumbleBeam · UI · charts

Charts are their own part of the library: every site draws some, and they differ in kind more
than in look. One look (colours from `../tokens.css`, styles in `../components.css`), several kinds.

## Kinds

| Kind | Where today | In the library |
|---|---|---|
| Sparkline: a trend in a table cell, no axes | pool (miners), desktop miner, 3BMiner | `BBCharts.spark(values, {color})` |
| Time series, one line with area: right axis, current value pill, peak, crosshair | pool (hashrate), 3BMiner (hashrate) | `BBCharts.line(points, {label, peak})` |
| Time series, many lines: legend, an optional min–max band | thermo (temperatures, fans) | `BBCharts.line([{name, points, band}], {now: false, zero: false})` |
| Shares: donut with legend rows | pool and explorer (blocks per pool) | `BBCharts.donut(items, {total, sub})` |
| Bars over time (block times) | pool | not yet: next |
| Price steps (order book prices, hashrate carried) | NiceHash dashboard | not yet |
| Candles + volume + MA/EMA/RSI, pan and zoom on canvas | DEX terminal: BeeChart, TypeScript, private repo `beam/dex/web/src/chart` | stays BeeChart; it takes its colours from `BBCharts.theme()`. It moves here when the DEX goes public |

`charts.js` is a classic script setting `window.BBCharts`; each function returns an SVG/HTML
string for `innerHTML`, which is how the sites build their views already. One document listener
drives the crosshair of every chart on the page, so redrawing a view needs no re-binding.

## Colours

| Token | Use |
|---|---|
| `--chart-main` (= the chain's accent) | the single series of a one-line chart |
| `--chart-1` … `--chart-6` | series in order (thermo's hues, checked on the dark surfaces) |
| `--chart-up`, `--chart-down` | candles and deltas; turquoise and red on every chain |
| `--chart-grid`, `--chart-text`, `--chart-cross`, `--chart-label-bg`, `--chart-label-text` | grid, labels, crosshair, its pills |

Colours are written as `style="stroke:var(...)"`, so switching `data-chain` recolours a drawn
chart. Known: on the Bitcoin accent `--chart-3` (`#cc7a24`) is close to the orange accent; a
Bitcoin page that draws the accent next to series should start its series at `--chart-1` and skip
`--chart-3`, or pass its own colours.

## API

```js
BBCharts.spark([[t, v], ...] or [v, ...], { color })
BBCharts.line(points or series, {
  label: (v) => '1.23k',   // axis and pill text (default BBCharts.compact)
  title: 'Hashrate',       // for screen readers
  now: true,               // the first series' last value: dotted guide + pill
  peak: false,             // mark the highest point
  zero: undefined,         // y from 0 (default: when all values >= 0)
  narrow: undefined,       // phone layout (default: viewport <= 700px)
  height: undefined, empty: 'No data yet',
})
BBCharts.donut([{ name, value, color }], { total, sub, label, title })
BBCharts.theme()           // resolved colours for canvas charts (BeeChart's ChartTheme)
```
