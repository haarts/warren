import {
  boundsOf, pointAtFraction, polylineLength, rectsIntersect, walkPolyline,
  type Pt, type Rect,
} from '../geom.ts'
import type { Store } from '../model/doc.ts'
import { LEVEL_SHORT, type BoxItem, type Item, type MarkerItem, type MarkerSymbol, type RunItem } from '../model/types.ts'
import { formatMetres, niceScaleLength } from '../units.ts'
import type { Camera } from './camera.ts'

export interface Overlay {
  draftPoints?: Pt[]
  draftCursor?: Pt | null
  draftSystemId?: string | null
  draftClosed?: boolean
  boxDraft?: Rect | null
  rubberBand?: Rect | null
  snapPoint?: Pt | null
  snapLabel?: string | null
  measure?: { a: Pt; b: Pt } | null
  hoverId?: string | null
}

export interface SceneOptions {
  ctx: CanvasRenderingContext2D
  store: Store
  cam: Camera
  width: number
  height: number
  background: CanvasImageSource | null
  backgroundSize: { w: number; h: number } | null
  /** Multiplies label/handle sizes. 1 on screen; the export scale when rasterising. */
  uiScale?: number
  interactive?: boolean
  overlay?: Overlay
  paper?: boolean
}

const ACCENT = '#0b63d6'
const HANDLE_FILL = '#ffffff'

export function drawScene(opts: SceneOptions): void {
  const { ctx, store, cam, width, height } = opts
  const ui = opts.uiScale ?? 1
  const interactive = opts.interactive ?? true
  const settings = store.project.settings

  ctx.save()
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = opts.paper ? '#ffffff' : '#f1f3f6'
  ctx.fillRect(0, 0, width, height)

  // --- PDF page ---------------------------------------------------------------------
  if (opts.background && opts.backgroundSize) {
    const { w, h } = opts.backgroundSize
    ctx.save()
    ctx.globalAlpha = 1
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(cam.toScreenX(0), cam.toScreenY(0), w * cam.zoom, h * cam.zoom)
    ctx.globalAlpha = settings.backgroundOpacity
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(opts.background, cam.toScreenX(0), cam.toScreenY(0), w * cam.zoom, h * cam.zoom)
    ctx.restore()
    ctx.save()
    ctx.strokeStyle = '#c9ced8'
    ctx.lineWidth = 1
    ctx.strokeRect(cam.toScreenX(0), cam.toScreenY(0), w * cam.zoom, h * cam.zoom)
    ctx.restore()
  }

  if (settings.showGrid) drawGrid(ctx, store, cam, width, height)

  // --- items ------------------------------------------------------------------------
  const items = store.items().filter((i) => store.isVisible(i))
  const boxes = items.filter((i): i is BoxItem => i.kind === 'box')
  const runs = items.filter((i): i is RunItem => i.kind === 'run')
  const markers = items.filter((i): i is MarkerItem => i.kind === 'marker')

  for (const box of boxes) drawBox(ctx, store, cam, box, ui)
  for (const run of runs) drawRun(ctx, store, cam, run, ui, settings.showFlow)
  for (const marker of markers) drawMarker(ctx, store, cam, marker, ui)

  if (settings.showLabels) {
    // One occupancy map for the whole frame: equipment and markers claim their spot first,
    // then runs take what is left. Parallel pipes 150 mm apart would otherwise stack three
    // labels on top of each other and none of them would be readable.
    const placed: Rect[] = []
    for (const box of boxes) drawBoxLabel(ctx, store, cam, box, ui, placed)
    for (const marker of markers) drawMarkerLabel(ctx, store, cam, marker, ui, placed)
    for (const run of runs) drawRunLabel(ctx, store, cam, run, ui, placed)
  }

  // --- selection & tool feedback ------------------------------------------------------
  if (interactive) {
    const overlay = opts.overlay ?? {}
    if (overlay.hoverId && !store.selection.has(overlay.hoverId)) {
      const it = store.item(overlay.hoverId)
      if (it) drawItemOutline(ctx, cam, it, 'rgba(11,99,214,0.35)', 4 * ui)
    }
    for (const it of store.selectedItems()) {
      if (!store.isVisible(it)) continue
      drawItemOutline(ctx, cam, it, 'rgba(11,99,214,0.55)', 6 * ui)
    }
    drawHandles(ctx, store, cam, ui)
    drawOverlay(ctx, store, cam, overlay, ui)
  }

  drawScaleBar(ctx, store, cam, width, height, ui)
  ctx.restore()
}

// ------------------------------------------------------------------------------------
// items
// ------------------------------------------------------------------------------------

function strokeStyleFor(store: Store, item: Item): { color: string; dash: number[]; width: number } {
  const sys = store.system(item.systemId)
  return {
    color: item.colorOverride ?? sys.color,
    dash: sys.dash,
    width: sys.width,
  }
}

function screenPoints(cam: Camera, points: Pt[]): Pt[] {
  return points.map((p) => cam.toScreen(p))
}

function applyStroke(ctx: CanvasRenderingContext2D, cam: Camera, style: { color: string; dash: number[]; width: number }): void {
  ctx.strokeStyle = style.color
  ctx.lineWidth = Math.max(1.1, style.width * cam.zoom)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(style.dash.map((d) => Math.max(1, d * cam.zoom)))
}

function drawRun(
  ctx: CanvasRenderingContext2D, store: Store, cam: Camera, run: RunItem, ui: number, showFlow: boolean,
): void {
  if (run.points.length < 2) {
    if (run.points.length === 1) {
      const p = cam.toScreen(run.points[0])
      ctx.save()
      ctx.fillStyle = strokeStyleFor(store, run).color
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3 * ui, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    return
  }
  const style = strokeStyleFor(store, run)
  const pts = screenPoints(cam, run.points)
  ctx.save()
  applyStroke(ctx, cam, style)
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

  if (showFlow && run.flow !== 'none') {
    drawFlowArrows(ctx, pts, run.flow === 'reverse', style.color, ui)
  }
  ctx.restore()
}

function drawFlowArrows(ctx: CanvasRenderingContext2D, screenPts: Pt[], reverse: boolean, color: string, ui: number): void {
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

function drawBox(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, box: BoxItem, _ui: number): void {
  const style = strokeStyleFor(store, box)
  const x = cam.toScreenX(box.x)
  const y = cam.toScreenY(box.y)
  const w = box.w * cam.zoom
  const h = box.h * cam.zoom
  ctx.save()
  ctx.fillStyle = style.color
  ctx.globalAlpha = 0.14
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = 1
  applyStroke(ctx, cam, style)
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

const MARKER_RADIUS = 8

function drawMarker(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, marker: MarkerItem, ui: number): void {
  const style = strokeStyleFor(store, marker)
  const p = cam.toScreen(marker)
  const r = MARKER_RADIUS * ui
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.setLineDash([])
  ctx.lineWidth = 1.8 * ui
  ctx.strokeStyle = style.color
  ctx.fillStyle = '#ffffff'
  drawMarkerGlyph(ctx, marker.symbol, r, style.color)
  ctx.restore()
}

export function drawMarkerGlyph(ctx: CanvasRenderingContext2D, symbol: MarkerSymbol, r: number, color: string): void {
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = color
  switch (symbol) {
    case 'riser-up':
    case 'riser-down': {
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      const up = symbol === 'riser-up'
      const s = r * 0.55
      ctx.beginPath()
      ctx.moveTo(0, up ? s : -s)
      ctx.lineTo(0, up ? -s : s)
      ctx.moveTo(-s * 0.7, up ? -s * 0.25 : s * 0.25)
      ctx.lineTo(0, up ? -s : s)
      ctx.lineTo(s * 0.7, up ? -s * 0.25 : s * 0.25)
      ctx.stroke()
      break
    }
    case 'penetration': {
      ctx.beginPath()
      ctx.rect(-r, -r, r * 2, r * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(-r, -r); ctx.lineTo(r, r)
      ctx.moveTo(r, -r); ctx.lineTo(-r, r)
      ctx.stroke()
      break
    }
    case 'drain': {
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'cleanout': {
      ctx.beginPath()
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath()
      ctx.fill(); ctx.stroke()
      break
    }
    case 'valve': {
      ctx.beginPath()
      ctx.moveTo(-r, -r * 0.8); ctx.lineTo(0, 0); ctx.lineTo(-r, r * 0.8); ctx.closePath()
      ctx.moveTo(r, -r * 0.8); ctx.lineTo(0, 0); ctx.lineTo(r, r * 0.8); ctx.closePath()
      ctx.fill(); ctx.stroke()
      break
    }
    case 'outlet': {
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(-r * 0.4, 0); ctx.lineTo(r * 0.4, 0)
      ctx.stroke()
      break
    }
    case 'sensor': {
      ctx.beginPath()
      ctx.moveTo(0, -r); ctx.lineTo(r * 0.9, r * 0.7); ctx.lineTo(-r * 0.9, r * 0.7); ctx.closePath()
      ctx.fill(); ctx.stroke()
      break
    }
    case 'note': {
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      break
    }
  }
}

// ------------------------------------------------------------------------------------
// labels
// ------------------------------------------------------------------------------------

export function labelTextFor(store: Store, item: Item): string {
  const sys = store.system(item.systemId)
  const parts: string[] = []
  const main = (item.label ?? '').trim()
  if (main) parts.push(main)
  if (item.kind === 'run') {
    const size = (item.size ?? '').trim()
    if (size && size !== main) parts.push(size)
  }
  if (sys.tag) parts.push(sys.tag)
  if (store.project.settings.showLevels) parts.push(LEVEL_SHORT[item.level])
  return parts.join(' · ')
}

function pillRect(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, ui: number, align: 'center' | 'left'): Rect {
  ctx.font = `${11 * ui}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
  const w = ctx.measureText(text).width + 8 * ui
  const h = 15 * ui
  return { x: align === 'center' ? x - w / 2 : x, y: y - h / 2, w, h }
}

/**
 * Draws a label pill. With `placed` supplied it refuses to overlap an existing label and
 * reports failure, so the caller can try somewhere else or give up.
 */
function pill(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, ui: number,
  align: 'center' | 'left' = 'center', placed?: Rect[],
): boolean {
  const box = pillRect(ctx, text, x, y, ui, align)
  if (placed) {
    const padded = { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 }
    if (placed.some((r) => rectsIntersect(r, padded))) return false
    placed.push(box)
  }
  const padX = 4 * ui
  ctx.save()
  ctx.setLineDash([])
  ctx.globalAlpha = 0.92
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, box.x, box.y, box.w, box.h, 3 * ui)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.strokeStyle = color
  ctx.lineWidth = 1 * ui
  roundRect(ctx, box.x, box.y, box.w, box.h, 3 * ui)
  ctx.stroke()
  ctx.fillStyle = '#111827'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, box.x + padX, y + 0.5 * ui)
  ctx.restore()
  return true
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function drawRunLabel(
  ctx: CanvasRenderingContext2D, store: Store, cam: Camera, run: RunItem, ui: number, placed: Rect[],
): void {
  const text = labelTextFor(store, run)
  if (!text || run.points.length < 2) return
  const screenLen = polylineLength(run.points) * cam.zoom
  ctx.font = `${11 * ui}px ui-sans-serif, system-ui, sans-serif`
  const needed = ctx.measureText(text).width + 10 * ui
  // Declutter: a label that cannot sit along the run is dropped until you zoom in.
  if (needed > screenLen * 0.95) return
  const color = store.system(run.systemId).color
  const off = 11 * ui
  for (const fraction of [0.5, 0.3, 0.7]) {
    const at = pointAtFraction(run.points, fraction)
    const nx = Math.sin(at.angle)
    const ny = -Math.cos(at.angle)
    const p = cam.toScreen(at.p)
    for (const side of [1, -1]) {
      if (pill(ctx, text, p.x + nx * off * side, p.y + ny * off * side, color, ui, 'center', placed)) return
    }
  }
}

function drawBoxLabel(
  ctx: CanvasRenderingContext2D, store: Store, cam: Camera, box: BoxItem, ui: number, placed: Rect[],
): void {
  const text = labelTextFor(store, box)
  if (!text) return
  const cx = cam.toScreenX(box.x + box.w / 2)
  const cy = cam.toScreenY(box.y + box.h / 2)
  // Equipment labels are never dropped: they are the anchors you read the plan from.
  pill(ctx, text, cx, cy, store.system(box.systemId).color, ui)
  placed.push(pillRect(ctx, text, cx, cy, ui, 'center'))
}

function drawMarkerLabel(
  ctx: CanvasRenderingContext2D, store: Store, cam: Camera, marker: MarkerItem, ui: number, placed: Rect[],
): void {
  const text = labelTextFor(store, marker)
  if (!text) return
  const p = cam.toScreen(marker)
  const color = store.system(marker.systemId).color
  const gap = (MARKER_RADIUS + 11) * ui
  for (const dy of [-gap, gap]) {
    if (pill(ctx, text, p.x, p.y + dy, color, ui, 'center', placed)) return
  }
}

// ------------------------------------------------------------------------------------
// selection, handles, overlays
// ------------------------------------------------------------------------------------

function drawItemOutline(ctx: CanvasRenderingContext2D, cam: Camera, item: Item, color: string, width: number): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  if (item.kind === 'run' && item.points.length >= 2) {
    const pts = screenPoints(cam, item.points)
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
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
  }
  ctx.restore()
}

export const HANDLE_SIZE = 9

function drawHandles(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, ui: number): void {
  const sel = store.selectedItems()
  if (sel.length === 0) return
  ctx.save()
  ctx.setLineDash([])
  ctx.lineWidth = 1.5 * ui
  const s = HANDLE_SIZE * ui
  for (const item of sel) {
    if (!store.isVisible(item)) continue
    if (item.kind === 'run') {
      item.points.forEach((wp, i) => {
        const p = cam.toScreen(wp)
        const active = store.activeVertex?.runId === item.id && store.activeVertex.index === i
        ctx.fillStyle = active ? ACCENT : HANDLE_FILL
        ctx.strokeStyle = ACCENT
        ctx.beginPath()
        ctx.rect(p.x - s / 2, p.y - s / 2, s, s)
        ctx.fill()
        ctx.stroke()
      })
    } else if (item.kind === 'box') {
      for (const c of boxCorners(item)) {
        const p = cam.toScreen(c)
        ctx.fillStyle = HANDLE_FILL
        ctx.strokeStyle = ACCENT
        ctx.beginPath()
        ctx.rect(p.x - s / 2, p.y - s / 2, s, s)
        ctx.fill()
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

export function boxCorners(box: BoxItem): Pt[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
}

function drawOverlay(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, overlay: Overlay, ui: number): void {
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
      pill(ctx, `${formatMetres(segMm, 2)}  (Σ ${formatMetres(totalMm, 2)})`, c.x + 14 * ui, c.y - 16 * ui, color, ui, 'left')
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
    pill(ctx, text, (sa.x + sb.x) / 2, (sa.y + sb.y) / 2 - 14 * ui, '#b91c1c', ui)
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

// ------------------------------------------------------------------------------------
// grid + scale bar
// ------------------------------------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, width: number, height: number): void {
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

function drawScaleBar(
  ctx: CanvasRenderingContext2D, store: Store, cam: Camera, _width: number, height: number, ui: number,
): void {
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

export function itemBounds(item: Item): Rect {
  if (item.kind === 'run') return boundsOf(item.points)
  if (item.kind === 'box') return { x: item.x, y: item.y, w: item.w, h: item.h }
  return { x: item.x, y: item.y, w: 0, h: 0 }
}
