# @rebull/script

Zero-dependency TypeScript runtime for the Webull script dialect (`ind.*`, `plt`, `define`, `iff`, `hline`,
`plt.fill_between`, `none`, `x[n]` history, `crossover`/`crossunder`, `nz`, `fixnan`, `for`/`while`/`var`, `requestbar`).
Not PineTS (AGPL). Tests: `pnpm test`. Typecheck: `pnpm typecheck`.

```ts
import { compile, run, createSession } from '@rebull/script'
const program = compile(src)                    // ScriptError(line, col) on typos / undefined names
const out = run(program, bars, { inputs: { fast_ema: 5 }, host })   // plots, hlines, fills, inputs
const live = createSession(program, bars)       // live.updateLast(tick) re-runs only the last bar; live.append(bar)
```
Output arrays are per bar: `PlotOut.values` is a `Float64Array` (NaN = none), colors are per-bar hex or null (so `iff(...)` colors work).

## Semantics that are GUESSES (Webull does not document them; verify against a live Webull chart)
- Indicator math follows Pine v5 reference semantics: EMA/RMA seed with the SMA of the first `len` values; warmup bars are `none`.
- Argument order: explicit series args first (`src`, `src2`), then params. `high/low/close/volume` are implicit from the bar
  (matches `ind.atr(len)` in real scripts). So `ind.kc(close, len, mult)`, `ind.dmi(diLen, adxLen)`, `math.stoch(close, len)`.
- Multi-output order: `ind.macd` -> [macd, signal, hist]; `ind.bb`/`ind.kc` -> [mid, upper, lower]; `ind.dmi` -> [+DI, -DI, adx].
- `ind.up_trend`/`ind.down_trend`: true when src rose/fell on each of the last `len` bars. Meaning unconfirmed.
- `bar_check.highest_offset`/`lowest_offset`: 0 for the current bar, -k for k bars ago (Pine `highestbars`).
- `std`/`variance`/`bb` use population (biased) statistics; `math.dev` is mean absolute deviation; `cci` divides by 0.015 x mean deviation.
- `requestbar(interval, source)`: signature invented. Returns the last COMPLETED higher-timeframe bar (no lookahead).
- `time.*`: ISO weekdays Mon=1..Sun=7, timezone defaults to America/New_York. `fill_none` is a null color.
- Colors are CSS named colors; `color.sys_up/sys_down` = TraderMatrix bull/bear (#10b981/#ef4444).
- Legacy Pine-ish names accepted: `study` (no-op), `input`, bare `ema/sma/...`, `plot`, `fill` (covered by the LEGACY fixture in test/fixtures/scripts.ts).
- Division or modulo by zero and any non-finite result become `none`; `Infinity` never reaches an output.
- Runaway loops stop at `maxLoopIterations` (default 10,000 per loop per bar) with a ScriptError carrying line and bar.
