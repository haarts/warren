/** Ducts, pipes and cables: one polyline per run, plus the flow arrows walked along it. */
import { walkPolyline, type Pt } from '../geom.ts'
import type { RunItem } from '../model/types.ts'
import { applyStroke, screenPoints, strokeStyleFor, type DrawCtx } from './draw.ts'

/** A duct, pipe or cable run: one polyline, corner dots, and an optional flow direction. */
export function drawRun(dc: DrawCtx, run: RunItem): void {
  const { ctx, cam, ui } = dc
  if (run.points.length < 2) {
    if (run.points.length === 1) {
      const p = cam.toScreen(run.points[0])
      ctx.save()
      ctx.fillStyle = strokeStyleFor(dc, run).color
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3 * ui, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    return
  }
  const style = strokeStyleFor(dc, run)
  const pts = screenPoints(cam, run.points)
  ctx.save()
  applyStroke(dc, style)
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.stroke()
  ctx.setLineDash([])

  // Corner dots make polylines legible where several runs overlap.
  if (cam.zoom > 0.25) {
    ctx.fillStyle = style.color
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.beginPath()
      ctx.arc(pts[i].x, pts[i].y, Math.max(1.2, style.width * cam.zoom * 0.55), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  if (dc.store.project.settings.showFlow && run.flow !== 'none') {
    const lineWidth = Math.max(1.1, style.width * cam.zoom)
    drawFlowArrows(dc, pts, run.flow === 'reverse', style.color, lineWidth, run.flowAssumed === true)
  }
  ctx.restore()
}

/** Wider than this on screen, an arrow fits inside the line and is drawn white on it. */
const INSIDE_FROM_PX = 8

/**
 * Arrowheads walked along the run, sized from the line as drawn rather than fixed: a thin line
 * gets a head wider than itself with a white edge, so it reads against neighbours; a thick one
 * gets a white head inside it, on a disc of the line's colour so a dash gap cannot swallow it.
 * A direction somebody confirmed is filled; one that was only assumed is an outline.
 */
function drawFlowArrows(
  dc: DrawCtx, screenPts: Pt[], reverse: boolean, color: string, lineWidth: number, assumed: boolean,
): void {
  const { ctx, ui } = dc
  const path = reverse ? [...screenPts].reverse() : screenPts
  const inside = lineWidth >= INSIDE_FROM_PX * ui
  // Half the head's length along the run; it spans 1.5x this across.
  const size = inside ? lineWidth * 0.55 : Math.max(5 * ui, lineWidth * 1.8)
  const spacing = Math.max(46 * ui, size * 9)
  const marks = walkPolyline(path, spacing, spacing * 0.5)
  const head = (): void => {
    ctx.beginPath()
    ctx.moveTo(-size * 0.8, -size * 0.75)
    ctx.lineTo(size * 0.9, 0)
    ctx.lineTo(-size * 0.8, size * 0.75)
    ctx.closePath()
  }
  ctx.save()
  ctx.setLineDash([])
  ctx.lineJoin = 'round'
  for (const m of marks) {
    ctx.save()
    ctx.translate(m.p.x, m.p.y)
    ctx.rotate(m.angle)
    if (inside) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(0, 0, lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
      head()
      if (assumed) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = Math.max(1.5 * ui, lineWidth * 0.1)
        ctx.stroke()
      } else {
        ctx.fillStyle = '#ffffff'
        ctx.fill()
      }
    } else {
      head()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 3 * ui
      ctx.stroke()
      ctx.fillStyle = assumed ? '#ffffff' : color
      ctx.fill()
      if (assumed) {
        ctx.strokeStyle = color
        ctx.lineWidth = 1.4 * ui
        ctx.stroke()
      }
    }
    ctx.restore()
  }
  ctx.restore()
}
