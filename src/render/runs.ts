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
    drawFlowArrows(dc, pts, run.flow === 'reverse', style.color, run.flowAssumed === true)
  }
  ctx.restore()
}

function drawFlowArrows(
  dc: DrawCtx, screenPts: Pt[], reverse: boolean, color: string, assumed: boolean,
): void {
  const { ctx, ui } = dc
  const path = reverse ? [...screenPts].reverse() : screenPts
  const spacing = 34 * ui
  const size = 4.5 * ui
  const marks = walkPolyline(path, spacing, spacing * 0.5)
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6 * ui
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  // Faint means guessed. Solid means somebody looked at it and agreed.
  if (assumed) ctx.globalAlpha = 0.45
  for (const m of marks) {
    ctx.save()
    ctx.translate(m.p.x, m.p.y)
    ctx.rotate(m.angle)
    ctx.beginPath()
    ctx.moveTo(-size, -size * 0.8)
    ctx.lineTo(size * 0.6, 0)
    ctx.lineTo(-size, size * 0.8)
    ctx.stroke()
    ctx.restore()
  }
  ctx.restore()
}
