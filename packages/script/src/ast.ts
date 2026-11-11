export interface Loc {
  line: number
  col: number
}
interface Base extends Loc {
  id: number // unique per node, keys per-call-site state
}

export type Expr =
  | (Base & { type: 'Num'; value: number })
  | (Base & { type: 'Str'; value: string })
  | (Base & { type: 'Color'; value: string })
  | (Base & { type: 'Bool'; value: boolean })
  | (Base & { type: 'Ident'; name: string })
  | (Base & { type: 'Member'; obj: Expr; name: string })
  | (Base & { type: 'Call'; callee: Expr; args: Expr[]; kwargs: { name: string; value: Expr }[] })
  | (Base & { type: 'Index'; expr: Expr; index: Expr })
  | (Base & { type: 'Unary'; op: '-' | 'not'; expr: Expr })
  | (Base & { type: 'Binary'; op: string; left: Expr; right: Expr })
  | (Base & { type: 'Ternary'; cond: Expr; a: Expr; b: Expr })
  | (Base & { type: 'Tuple'; items: Expr[] })

export type Stmt =
  | (Base & { type: 'Assign'; targets: string[]; tuple: boolean; expr: Expr; isVar: boolean; reassign: boolean })
  | (Base & { type: 'If'; cond: Expr; then: Stmt[]; else?: Stmt[] })
  | (Base & { type: 'For'; name: string; from: Expr; to: Expr; by?: Expr; body: Stmt[] })
  | (Base & { type: 'While'; cond: Expr; body: Stmt[] })
  | (Base & { type: 'Break' })
  | (Base & { type: 'Continue' })
  | (Base & { type: 'ExprStmt'; expr: Expr })

export interface Program {
  body: Stmt[]
  nodeCount: number
}
