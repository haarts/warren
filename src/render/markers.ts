/** Point symbols - sockets, switches, detectors and the rest - as a table of glyph painters. */
import type { MarkerItem, MarkerSymbol } from '../model/types.ts'
import { strokeStyleFor, type DrawCtx } from './draw.ts'

export const MARKER_RADIUS = 8

/** A point symbol: socket, switch, detector and the rest, from the table below. */
export function drawMarker(dc: DrawCtx, marker: MarkerItem): void {
  const { ctx, cam, ui } = dc
  const style = strokeStyleFor(dc, marker)
  const p = cam.toScreen(marker)
  const r = MARKER_RADIUS * ui
  ctx.save()
  // Faint means a rule put it there and nobody has looked yet - the same language as an
  // assumed flow direction.
  if (marker.generated) ctx.globalAlpha = 0.5
  ctx.translate(p.x, p.y)
  ctx.setLineDash([])
  ctx.lineWidth = 1.8 * ui
  ctx.strokeStyle = style.color
  ctx.fillStyle = '#ffffff'
  GLYPHS[marker.symbol](ctx, r, style.color)
  ctx.restore()
}

type Glyph = (ctx: CanvasRenderingContext2D, r: number, color: string) => void

// Every symbol below is a circle or square body, a line and a filled dot, at the proportions
// IEC 60617 / NEN 5152 draw them - these three primitives are all a glyph needs.
const ring = (ctx: CanvasRenderingContext2D, r: number): void => { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2) }
const square = (ctx: CanvasRenderingContext2D, half: number): void => { ctx.beginPath(); ctx.rect(-half, -half, half * 2, half * 2) }
const polygon = (ctx: CanvasRenderingContext2D, pts: [number, number][]): void => {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
}
const line = (ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number): void => {
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
}
const fillStroke = (ctx: CanvasRenderingContext2D): void => { ctx.fill(); ctx.stroke() }

/** One socket painter serves all four gang counts; only the span it repeats along differs. */
function socketGlyph(ctx: CanvasRenderingContext2D, r: number, gangs: number): void {
  // Wandcontactdoos: a half-round on its diameter line, joined to the circuit by a stem at
  // right angles - the stem is what makes it read as mounted on something rather than
  // floating. Extra gangs repeat the half-round along the same line rather than shrinking it,
  // so a quadruple stays legible when zoomed out.
  const a = r * 0.62
  const span = gangs * 2 * a
  ctx.beginPath()
  for (let i = 0; i < gangs; i++) {
    const cx = -span / 2 + a + i * 2 * a
    ctx.moveTo(cx - a, 0)
    ctx.arc(cx, 0, a, Math.PI, 0)
  }
  fillStroke(ctx)
  line(ctx, -span / 2 - r * 0.32, 0, span / 2 + r * 0.32, 0)
  line(ctx, 0, 0, 0, r * 1.05)
}

function riserGlyph(ctx: CanvasRenderingContext2D, r: number, up: boolean): void {
  ring(ctx, r)
  fillStroke(ctx)
  const s = r * 0.55
  ctx.beginPath()
  ctx.moveTo(0, up ? s : -s)
  ctx.lineTo(0, up ? -s : s)
  ctx.moveTo(-s * 0.7, up ? -s * 0.25 : s * 0.25)
  ctx.lineTo(0, up ? -s : s)
  ctx.lineTo(s * 0.7, up ? -s * 0.25 : s * 0.25)
  ctx.stroke()
}

const GLYPHS: Record<MarkerSymbol, Glyph> = {
  socket: (ctx, r) => socketGlyph(ctx, r, 1),
  'socket-2': (ctx, r) => socketGlyph(ctx, r, 2),
  'socket-3': (ctx, r) => socketGlyph(ctx, r, 3),
  'socket-4': (ctx, r) => socketGlyph(ctx, r, 4),

  switch: (ctx, r, color) => {
    ctx.beginPath()
    ctx.arc(0, r * 0.45, r * 0.38, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    line(ctx, 0, r * 0.45, r * 0.85, -r * 0.75)
  },

  light: (ctx, r) => {
    ring(ctx, r * 0.9)
    fillStroke(ctx)
    const d = r * 0.64
    line(ctx, -d, -d, d, d)
    line(ctx, d, -d, -d, d)
  },

  detector: (ctx, r, color) => {
    ring(ctx, r * 0.8)
    fillStroke(ctx)
    ring(ctx, r * 0.3)
    ctx.fillStyle = color
    ctx.fill()
    ctx.beginPath()
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      ctx.moveTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95)
      ctx.lineTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4)
    }
    ctx.stroke()
  },

  'data-outlet': (ctx, r, color) => {
    square(ctx, r * 0.85)
    fillStroke(ctx)
    polygon(ctx, [[-r * 0.3, -r * 0.45], [r * 0.5, 0], [-r * 0.3, r * 0.45]])
    ctx.fillStyle = color
    ctx.fill()
  },

  'air-valve': (ctx, r) => {
    square(ctx, r * 0.9)
    fillStroke(ctx)
    ring(ctx, r * 0.58)
    ctx.stroke()
  },

  'riser-up': (ctx, r) => riserGlyph(ctx, r, true),
  'riser-down': (ctx, r) => riserGlyph(ctx, r, false),

  penetration: (ctx, r) => {
    square(ctx, r)
    fillStroke(ctx)
    line(ctx, -r, -r, r, r)
    line(ctx, r, -r, -r, r)
  },

  drain: (ctx, r) => {
    ring(ctx, r)
    fillStroke(ctx)
    ring(ctx, r * 0.45)
    ctx.stroke()
  },

  cleanout: (ctx, r) => {
    polygon(ctx, [[0, -r], [r, 0], [0, r], [-r, 0]])
    fillStroke(ctx)
  },

  valve: (ctx, r) => {
    ctx.beginPath()
    ctx.moveTo(-r, -r * 0.8); ctx.lineTo(0, 0); ctx.lineTo(-r, r * 0.8); ctx.closePath()
    ctx.moveTo(r, -r * 0.8); ctx.lineTo(0, 0); ctx.lineTo(r, r * 0.8); ctx.closePath()
    fillStroke(ctx)
  },

  outlet: (ctx, r) => {
    ring(ctx, r * 0.85)
    fillStroke(ctx)
    line(ctx, -r * 0.4, 0, r * 0.4, 0)
  },

  sensor: (ctx, r) => {
    polygon(ctx, [[0, -r], [r * 0.9, r * 0.7], [-r * 0.9, r * 0.7]])
    fillStroke(ctx)
  },

  note: (ctx, r, color) => {
    ring(ctx, r)
    ctx.fillStyle = color
    ctx.fill()
  },
}
