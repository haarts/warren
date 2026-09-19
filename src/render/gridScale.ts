/** The two things drawn in screen space, not world space: the reference grid and the scale bar. */
import { formatMetres, niceScaleLength } from '../units.ts'
import type { DrawCtx } from './draw.ts'

/** The faint reference grid, spaced at the sheet's grid setting, drawn only once it's legible. */
export function drawGrid(dc: DrawCtx, width: number, height: number): void {
  const { ctx, store, cam } = dc
  const mmPerPoint = store.sheet.mmPerPoint
  if (!mmPerPoint) return
  const stepWorld = store.project.settings.gridMm / mmPerPoint
  const stepPx = stepWorld * cam.zoom
  if (stepPx < 6) return
  const view = cam.viewRect(width, height)
  ctx.save()
  ctx.strokeStyle = 'rgba(15,23,42,0.10)'
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  const startX = Math.floor(view.x / stepWorld) * stepWorld
  for (let x = startX; x < view.x + view.w; x += stepWorld) {
    const sx = Math.round(cam.toScreenX(x)) + 0.5
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, height)
  }
  const startY = Math.floor(view.y / stepWorld) * stepWorld
  for (let y = startY; y < view.y + view.h; y += stepWorld) {
    const sy = Math.round(cam.toScreenY(y)) + 0.5
    ctx.moveTo(0, sy)
    ctx.lineTo(width, sy)
  }
  ctx.stroke()
  ctx.restore()
}

/** A metric scale bar bottom-left, or a warning in its place when the sheet has no scale yet. */
export function drawScaleBar(dc: DrawCtx, height: number): void {
  const { ctx, store, cam, ui } = dc
  const mmPerPoint = store.sheet.mmPerPoint
  ctx.save()
  ctx.setLineDash([])
  const x = 16 * ui
  const y = height - 20 * ui
  if (!mmPerPoint) {
    ctx.font = `${11 * ui}px ui-sans-serif, system-ui, sans-serif`
    ctx.fillStyle = '#b45309'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('Not calibrated — lengths unavailable', x, y)
    ctx.restore()
    return
  }
  const mmPerPx = mmPerPoint / cam.zoom
  const lengthMm = niceScaleLength(mmPerPx, 120 * ui)
  const px = lengthMm / mmPerPx
  ctx.strokeStyle = '#111827'
  ctx.fillStyle = '#111827'
  ctx.lineWidth = 1.4 * ui
  ctx.beginPath()
  ctx.moveTo(x, y - 5 * ui)
  ctx.lineTo(x, y)
  ctx.lineTo(x + px, y)
  ctx.lineTo(x + px, y - 5 * ui)
  ctx.stroke()
  ctx.font = `${11 * ui}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(formatMetres(lengthMm, lengthMm >= 1000 ? 0 : 2), x, y - 8 * ui)
  ctx.restore()
}
