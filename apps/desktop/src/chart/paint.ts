import type { DrawOp } from './drawPlan'

const CHIP_FONT = "600 10px 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
const CHIP_PAD_X = 5
const CHIP_HEIGHT = 14

/** Paint draw ops on a 2D context. Alpha goes through globalAlpha and is restored afterwards. */
export function paintOps(ctx: CanvasRenderingContext2D, ops: DrawOp[]): void {
  if (ops.length === 0) return
  const prevAlpha = ctx.globalAlpha
  try {
    for (const op of ops) {
      switch (op.kind) {
        case 'polygon': {
          if (op.points.length < 3) break
          ctx.globalAlpha = op.alpha
          ctx.fillStyle = op.color
          ctx.beginPath()
          op.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
          ctx.closePath()
          ctx.fill()
          break
        }
        case 'rect': {
          ctx.globalAlpha = op.alpha ?? 1
          ctx.fillStyle = op.color
          ctx.fillRect(op.x, op.y, op.w, op.h)
          break
        }
        case 'polyline': {
          if (op.points.length < 2) break
          ctx.globalAlpha = op.alpha ?? 1
          ctx.strokeStyle = op.color
          ctx.lineWidth = op.width
          ctx.lineJoin = 'round'
          ctx.setLineDash([])
          ctx.beginPath()
          op.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
          ctx.stroke()
          break
        }
        case 'hline': {
          ctx.globalAlpha = op.alpha ?? 1
          ctx.strokeStyle = op.color
          ctx.lineWidth = op.width
          ctx.setLineDash(op.dash)
          ctx.beginPath()
          ctx.moveTo(op.x0 ?? 0, op.y)
          ctx.lineTo(op.x1 ?? ctx.canvas.width, op.y)
          ctx.stroke()
          ctx.setLineDash([])
          break
        }
        case 'label': {
          ctx.globalAlpha = op.alpha ?? 1
          ctx.font = op.font ?? '11px system-ui, sans-serif'
          ctx.textAlign = op.align
          ctx.textBaseline = 'alphabetic'
          if (op.halo) {
            ctx.strokeStyle = op.halo
            ctx.lineWidth = 3
            ctx.lineJoin = 'round'
            ctx.strokeText(op.text, op.x, op.y)
          }
          ctx.fillStyle = op.color
          ctx.fillText(op.text, op.x, op.y)
          break
        }
        case 'chip': {
          // filled level chip: x is the left edge (the right edge when align is 'right'), y the vertical centre; the text is measured, never clipped
          ctx.globalAlpha = op.alpha ?? 1
          ctx.font = CHIP_FONT
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          const w = Math.ceil(ctx.measureText(op.text).width) + 2 * CHIP_PAD_X
          const left = op.align === 'right' ? op.x - w : op.x
          ctx.fillStyle = op.color
          ctx.fillRect(left, op.y - CHIP_HEIGHT / 2, w, CHIP_HEIGHT)
          ctx.fillStyle = op.ink
          ctx.fillText(op.text, left + CHIP_PAD_X, op.y + 0.5)
          break
        }
        case 'circle': {
          ctx.globalAlpha = op.alpha ?? 1
          ctx.fillStyle = op.color
          ctx.beginPath()
          ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2)
          ctx.fill()
          break
        }
        case 'cross': {
          ctx.globalAlpha = op.alpha ?? 1
          ctx.strokeStyle = op.color
          ctx.lineWidth = 1
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(op.x - op.size, op.y)
          ctx.lineTo(op.x + op.size, op.y)
          ctx.moveTo(op.x, op.y - op.size)
          ctx.lineTo(op.x, op.y + op.size)
          ctx.stroke()
          break
        }
      }
    }
  } finally {
    ctx.globalAlpha = prevAlpha
  }
}
