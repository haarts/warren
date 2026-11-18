/** The patch of floor a presence sensor sees, painted faintly under everything it is about. */
import { coverage, obstaclesOf, viewOf } from '../coverage.ts'
import type { MarkerItem } from '../model/types.ts'
import { strokeStyleFor, type DrawCtx } from './draw.ts'

export function drawCoverage(dc: DrawCtx, markers: MarkerItem[]): void {
  const { ctx, cam, store, ui } = dc
  const mmPerPoint = store.sheet.mmPerPoint
  const viewed = markers.map((m) => ({ m, view: viewOf(m, mmPerPoint) })).filter((v) => v.view)
  if (!viewed.length) return
  // Walls stop a view whether or not they are shown: hiding the architecture does not let a
  // sensor see through it.
  const edges = obstaclesOf(store.sheet)
  for (const { m, view } of viewed) {
    const outline = coverage(m, view!, edges)
    if (outline.length < 3) continue
    const color = strokeStyleFor(dc, m).color
    ctx.save()
    ctx.beginPath()
    outline.forEach((p, i) => {
      const s = cam.toScreen(p)
      if (i === 0) ctx.moveTo(s.x, s.y)
      else ctx.lineTo(s.x, s.y)
    })
    ctx.closePath()
    ctx.globalAlpha = m.generated ? 0.06 : 0.1
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = m.generated ? 0.25 : 0.45
    ctx.strokeStyle = color
    ctx.lineWidth = ui
    ctx.setLineDash([4 * ui, 3 * ui])
    ctx.stroke()
    ctx.restore()
  }
}
