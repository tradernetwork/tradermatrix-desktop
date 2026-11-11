export interface Bar {
  time: number // ms epoch UTC
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export class ScriptError extends Error {
  constructor(
    msg: string,
    public line: number,
    public col: number,
    public bar?: number,
  ) {
    super(`${msg} (line ${line}, col ${col}${bar === undefined ? '' : `, bar ${bar}`})`)
    this.name = 'ScriptError'
  }
}

export type TokKind = 'num' | 'str' | 'color' | 'ident' | 'op' | 'kw' | 'newline' | 'indent' | 'dedent' | 'eof'
export interface Token {
  kind: TokKind
  text: string
  line: number
  col: number
}

// ---- runtime values and public output shapes ----
export interface PlotRef {
  kind: 'plot' | 'hline'
  id: number
}
/** Numbers use NaN for `none`. Colors are hex strings, null for no color. */
export type Value = number | boolean | string | null | PlotRef | Value[]

export interface InputDef {
  key: string
  name: string
  type: 'integer' | 'float' | 'bool' | 'string' | 'source'
  default: number | boolean | string
  min?: number
  max?: number
}
export type PlotType = 'line' | 'linebr' | 'stepline' | 'area' | 'circles' | 'columns' | 'cross' | 'histogram'
export interface PlotOut {
  id: number
  name: string
  values: Float64Array
  color: (string | null)[]
  lineWidth: number
  type: PlotType
  opacity: number
  display: 'all' | 'none'
}
export interface HLineOut {
  id: number
  value: number
  color: string
  style: 'solid' | 'dashed' | 'dotted'
  lineWidth: number
}
export interface FillOut {
  a: PlotRef
  b: PlotRef
  color: (string | null)[]
  opacity: number
  name: string
}
export interface ScriptOutput {
  inputs: InputDef[]
  plots: PlotOut[]
  hlines: HLineOut[]
  fills: FillOut[]
}
export interface Host {
  /** Bars for a higher timeframe, oldest first. */
  requestBars(interval: string): Bar[]
}
export interface RunOptions {
  inputs?: Record<string, number | boolean | string>
  host?: Host
  timezone?: string // default America/New_York
  maxLoopIterations?: number // default 10_000 per loop per bar
}
