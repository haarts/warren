/**
 * What is not part of the drawing itself: hover/selection outlines, drag handles, and the tool
 * overlay (draft polyline, rubber band, measure, snap feedback).
 */
import { polylineLength } from '../geom.ts'
import { pointsOf, type Item } from '../model/types.ts'
import { ACCENT, HANDLE_FILL, screenPoints, type DrawCtx } from './draw.ts'
import { pill } from './labels.ts'
import { MARKER_RADIUS } from './markers.ts'
import { noteHeight } from './notes.ts'
import { boxCorners } from './bounds.ts'
import { formatMetres } from '../units.ts'
import type { Overlay } from './scene.ts'
import type { Camera } from './camera.ts'

const HANDLE_SIZE = 9

/** The shape a selection or hover outline traces around one item, by kind. */
function outlinePath(ctx: CanvasRenderingContext2D, cam: Camera, item: Item): void {
  const line = pointsOf(item)
  if (line && line.length >= 2) {
    const pts = screenPoints(cam, line)
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    if (item.kind === 'room') ctx.closePath()
    ctx.stroke()
  } else if (item.kind === 'box') {
    const pad = 3
    ctx.strokeRect(
      cam.toScreenX(item.x) - pad, cam.toScreenY(item.y) - pad,
      item.w * cam.zoom + pad * 2, item.h * cam.zoom + pad * 2,
    )
  } else if (item.kind === 'marker') {
    const p = cam.toScreen(item)
    ctx.beginPath()
    ctx.arc(p.x, p.y, MARKER_RADIUS + 4, 0, Math.PI * 2)
    ctx.stroke()
  } else if (item.kind === 'note') {
    const pad = 3
    ctx.strokeRect(
      cam.toScreenX(item.x) - pad, cam.toScreenY(item.y) - pad,
      item.w * cam.zoom + pad * 2, noteHeight(item) * cam.zoom + pad * 2,
    )
  }
}

export function drawItemOutline(ctx: CanvasRenderingContext2D, cam: Camera, item: Item, color: string, width: number): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  outlinePath(ctx, cam, item)
  ctx.restore()
}

export function drawHandles(dc: DrawCtx): void {
  const { ctx, store, cam, ui } = dc
  const sel = store.selectedItems()
  if (sel.length === 0) return
  ctx.save()
  ctx.setLineDash([])
  ctx.lineWidth = 1.5 * ui
  const s = HANDLE_SIZE * ui
  const square = (p: { x: number; y: number }, active: boolean): void => {
    const sp = cam.toScreen(p)
    ctx.fillStyle = active ? ACCENT : HANDLE_FILL
    ctx.strokeStyle = ACCENT
    ctx.beginPath()
    ctx.rect(sp.x - s / 2, sp.y - s / 2, s, s)
    ctx.fill()
    ctx.stroke()
  }
  for (const item of sel) {
    if (!store.isVisible(item)) continue
    const handlePoints = pointsOf(item)
    if (handlePoints) {
      handlePoints.forEach((wp, i) => {
        const active = store.activeVertex?.itemId === item.id && store.activeVertex.index === i
        square(wp, active)
      })
    } else if (item.kind === 'box') {
      for (const c of boxCorners(item)) square(c, false)
    } else if (item.kind === 'note') {
      // One handle, bottom-right: a note only has a width. Height follows the text.
      square({ x: item.x + item.w, y: item.y + noteHeight(item) }, false)
    }
  }
  ctx.restore()
}

export function drawOverlay(dc: DrawCtx, overlay: Overlay): void {
  const { ctx, store, cam, ui } = dc
  const mmPerPoint = store.sheet.mmPerPoint

  if (overlay.draftPoints && overlay.draftPoints.length > 0) {
    const sys = overlay.draftSystemId ? store.system(overlay.draftSystemId) : null
    const color = sys?.color ?? ACCENT
    const pts = [...overlay.draftPoints]
    if (overlay.draftCursor) pts.push(overlay.draftCursor)
    const sp = screenPoints(cam, pts)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1.2, (sys?.width ?? 1.6) * cam.zoom)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.setLineDash((sys?.dash ?? []).map((d) => Math.max(1, d * cam.zoom)))
    ctx.beginPath()
    ctx.moveTo(sp[0].x, sp[0].y)
    for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = color
    for (const p of screenPoints(cam, overlay.draftPoints)) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3 * ui, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    // Live length readout for the segment being drawn plus the running total.
    if (overlay.draftCursor && overlay.draftPoints.length > 0 && mmPerPoint) {
      const last = overlay.draftPoints[overlay.draftPoints.length - 1]
      const segMm = Math.hypot(overlay.draftCursor.x - last.x, overlay.draftCursor.y - last.y) * mmPerPoint
      const totalMm = polylineLength(pts) * mmPerPoint
      const c = cam.toScreen(overlay.draftCursor)
      pill(dc, `${formatMetres(segMm, 2)}  (Σ ${formatMetres(totalMm, 2)})`, c.x + 14 * ui, c.y - 16 * ui, color, 'left')
    }
  }

  if (overlay.boxDraft) {
    const r = overlay.boxDraft
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.setLineDash([5, 4])
    ctx.lineWidth = 1.4 * ui
    ctx.strokeRect(cam.toScreenX(r.x), cam.toScreenY(r.y), r.w * cam.zoom, r.h * cam.zoom)
    ctx.restore()
  }

  if (overlay.rubberBand) {
    const r = overlay.rubberBand
    ctx.save()
    ctx.fillStyle = 'rgba(11,99,214,0.10)'
    ctx.strokeStyle = ACCENT
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1
    ctx.fillRect(cam.toScreenX(r.x), cam.toScreenY(r.y), r.w * cam.zoom, r.h * cam.zoom)
    ctx.strokeRect(cam.toScreenX(r.x), cam.toScreenY(r.y), r.w * cam.zoom, r.h * cam.zoom)
    ctx.restore()
  }

  if (overlay.measure) {
    const { a, b } = overlay.measure
    const sa = cam.toScreen(a)
    const sb = cam.toScreen(b)
    ctx.save()
    ctx.strokeStyle = '#b91c1c'
    ctx.lineWidth = 1.6 * ui
    ctx.setLineDash([6, 3])
    ctx.beginPath()
    ctx.moveTo(sa.x, sa.y)
    ctx.lineTo(sb.x, sb.y)
    ctx.stroke()
    ctx.setLineDash([])
    for (const p of [sa, sb]) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4 * ui, 0, Math.PI * 2)
      ctx.fillStyle = '#b91c1c'
      ctx.fill()
    }
    const lenPt = Math.hypot(b.x - a.x, b.y - a.y)
    const text = mmPerPoint ? formatMetres(lenPt * mmPerPoint, 3) : `${lenPt.toFixed(1)} pt (uncalibrated)`
    pill(dc, text, (sa.x + sb.x) / 2, (sa.y + sb.y) / 2 - 14 * ui, '#b91c1c')
    ctx.restore()
  }

  if (overlay.snapPoint) {
    const p = cam.toScreen(overlay.snapPoint)
    ctx.save()
    ctx.strokeStyle = '#0f9d58'
    ctx.lineWidth = 1.8 * ui
    ctx.setLineDash([])
    const s = 7 * ui
    ctx.strokeRect(p.x - s, p.y - s, s * 2, s * 2)
    if (overlay.snapLabel) {
      ctx.font = `${10 * ui}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = '#0f9d58'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillText(overlay.snapLabel, p.x + s + 3 * ui, p.y - s)
    }
    ctx.restore()
  }
}
