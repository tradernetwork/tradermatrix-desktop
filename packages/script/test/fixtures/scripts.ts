/** Original inline Webull-dialect scripts used as fixtures by the runtime tests (written for this repo, MIT). */

/** Overlay: EMA ribbon with per-bar fill colors and sparse crossover circles. */
export const RIBBON = `
fast_len = define(9, name="Fast EMA", min=1)
mid_len = define(21, name="Mid EMA", min=1)
slow_len = define(50, name="Slow EMA", min=1)
fast = ind.ema(close, fast_len)
mid = ind.ema(close, mid_len)
slow = ind.ema(close, slow_len)
a = plt(fast, name="Fast EMA", color=color.white)
b = plt(mid, name="Mid EMA", color=color.yellow)
c = plt(slow, name="Slow EMA", color=color.gray)
plt.fill_between(a, b, color=iff(fast >= mid, color.green, color.red), opacity=25, name="Fast-Mid Fill")
plt.fill_between(b, c, color=iff(mid >= slow, color.green, color.red), opacity=25, name="Mid-Slow Fill")
plt(iff(crossover(fast, mid), low, none), name="Cross Up", color=color.lime, type=plt.type_circles)
plt(iff(crossunder(fast, mid), high, none), name="Cross Down", color=color.red, type=plt.type_circles)
`

/** Sub-chart: stochastic with threshold coloring, hlines, a band fill, and a hidden RSI plot. */
export const SUBCHART = `
k_len = define(8, name="Stochastic Length", min=1)
smooth = define(3, name="Smoothing", min=1)
rsi_len = define(2, name="RSI Length", min=1)
lo = math.lowest(low, k_len)
hi = math.highest(high, k_len)
raw = ((close - lo) / (hi - lo)) * 100
k = ind.sma(raw, smooth)
d = ind.sma(k, smooth)
col = iff(k >= 60, color.green, iff(k <= 40, color.yellow, color.gray))
plt(k, name="Slow Stoch %K", color=col)
plt(d, name="Slow Stoch %D", color=color.white)
hi_line = hline(60)
lo_line = hline(40)
hline(80)
hline(20)
plt.fill_between(lo_line, hi_line, color=color.gray, opacity=10, name="Middle Fill")
plt(ind.rsi(close, rsi_len), name="RSI", color=color.orange, display=display.none)
`

/** Legacy Pine-style names: study, input, bare ema, plot, fill, hidden plots. */
export const LEGACY = `
study(title="Legacy Ribbon", shorttitle="Legacy", overlay=true)
fast_ema = input(title="Fast EMA", defval=8, minval=1)
pivot_ema = input(title="Pivot EMA", defval=21, minval=1)
slow_ema = input(title="Slow EMA", defval=34, minval=1)
fv = ema(close, fast_ema)
pv = ema(close, pivot_ema)
sv = ema(close, slow_ema)
fp = plot(series=fv, title="Fast EMA", color=color.gray, display=display.none)
pp = plot(series=pv, title="Pivot EMA", color=color.gray, display=display.none)
sp = plot(series=sv, title="Slow EMA", color=color.gray, display=display.none)
fill(fp, pp, color=iff(fv>=pv, color.green, color.red), opacity=40)
fill(pp, sp, color=iff(pv>=sv, color.blue, color.orange), opacity=40)
`
