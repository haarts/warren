/**
 * The text pills that name a run, box or marker, and the room name they defer to. One
 * `placeLabel` helper tries candidate positions and drops the label rather than overlap another
 * - the four `drawXLabel` functions below just supply the text and the candidates.
 */
import { polygonArea, polygonCentroid, rectsIntersect, type Pt, type Rect } from '../geom.ts'
import { LEVEL_SHORT, type BoxItem, type MarkerItem, type RoomItem, type RunItem } from '../model/types.ts'
import type { Store } from '../model/doc.ts'
import { DIMMED, isDimmed, type DrawCtx } from './draw.ts'
import { MARKER_RADIUS } from './markers.ts'

/**
 * The text on a run, box or marker label: the item's own label, its size for a run, the
 * system's tag, and - only when levels are shown - the level badge. Exported from `scene.ts`
 * too, for `test/browser/smoke.mjs`, which imports it from that path.
 */
export function labelTextFor(store: Store, item: RunItem | BoxItem | MarkerItem): string {
  const sys = store.system(item.systemId)
  const parts: string[] = []
  const main = (item.label ?? '').trim()
  if (main) parts.push(main)
  if (item.kind === 'run') {
    const size = (item.size ?? '').trim()
    if (size && size !== main) parts.push(size)
  }
  if (sys.tag) parts.push(sys.tag)
  // The level badge annotates a label; it is not a label on its own. Without this, anything
  // unlabelled still gets a pill saying "ON WAL", and fifty of those bury the drawing.
  if (parts.length && store.project.settings.showLevels) parts.push(LEVEL_SHORT[item.level])
  return parts.join(' · ')
}

const LABEL_FONT = (ui: number): string => `${11 * ui}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`

function pillRect(dc: DrawCtx, text: string, x: number, y: number, align: 'center' | 'left'): Rect {
  dc.ctx.font = LABEL_FONT(dc.ui)
  const w = dc.ctx.measureText(text).width + 8 * dc.ui
  const h = 15 * dc.ui
  return { x: align === 'center' ? x - w / 2 : x, y: y - h / 2, w, h }
}

/**
 * Draws a label pill. With `placed` supplied it refuses to overlap an existing label and
 * reports failure, so the caller can try somewhere else or give up. Exported for the overlay -
 * a draft length readout and a measured distance are pills too, just not tied to an item.
 */
export function pill(
  dc: DrawCtx, text: string, x: number, y: number, color: string,
  align: 'center' | 'left' = 'center', placed?: Rect[],
): boolean {
  const box = pillRect(dc, text, x, y, align)
  if (placed) {
    const padded = { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 }
    if (placed.some((r) => rectsIntersect(r, padded))) return false
    placed.push(box)
  }
  paintPill(dc, text, box, y, color)
  return true
}

/** The pill itself, at `box`, its text centred on `textY`. */
function paintPill(dc: DrawCtx, text: string, box: Rect, textY: number, color: string): void {
  const { ctx, ui } = dc
  ctx.save()
  ctx.font = LABEL_FONT(ui)
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
  ctx.fillText(text, box.x + 4 * ui, textY + 0.5 * ui)
  ctx.restore()
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

/**
 * Tries each candidate position in turn and keeps the first pill that does not collide with an
 * already-placed label. `always` draws at the first candidate regardless of collision - used
 * for equipment labels, which are the anchors the plan is read from and must never be dropped.
 */
function placeLabel(
  dc: DrawCtx, text: string, candidates: Pt[], color: string, placed: Rect[], always = false,
): void {
  if (!text || candidates.length === 0) return
  for (const p of candidates) {
    if (pill(dc, text, p.x, p.y, color, 'center', placed)) return
  }
  if (always) {
    const p = candidates[0]
    pill(dc, text, p.x, p.y, color)
    placed.push(pillRect(dc, text, p.x, p.y, 'center'))
  }
}

export function drawRoomLabel(dc: DrawCtx, room: RoomItem, placed: Rect[]): void {
  if (room.points.length < 3) return
  const { ctx, cam, store, ui } = dc
  const mmPerPoint = store.sheet.mmPerPoint
  const area = mmPerPoint ? Math.abs(polygonArea(room.points)) * (mmPerPoint / 1000) ** 2 : null
  const parts = [room.ref, room.name].filter(Boolean).join(' ')
  const text = area !== null ? `${parts} · ${area.toFixed(1)} m²` : parts
  if (!text.trim()) return
  const c = cam.toScreen(polygonCentroid(room.points))

  ctx.save()
  ctx.font = `600 ${11.5 * ui}px ui-sans-serif, system-ui, sans-serif`
  const w = ctx.measureText(text).width
  const box = { x: c.x - w / 2 - 3 * ui, y: c.y - 9 * ui, w: w + 6 * ui, h: 16 * ui }
  if (placed.some((r) => rectsIntersect(r, box))) { ctx.restore(); return }
  placed.push(box)
  // A room name is quiet context, so no pill - just a halo so it survives a busy plan.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 3 * ui
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.setLineDash([])
  ctx.strokeText(text, c.x, c.y)
  ctx.fillStyle = isDimmed(dc, room) ? DIMMED : store.system(room.systemId).color
  ctx.fillText(text, c.x, c.y)
  ctx.restore()
}

export function drawBoxLabel(dc: DrawCtx, box: BoxItem, placed: Rect[]): void {
  const text = labelTextFor(dc.store, box)
  const cx = dc.cam.toScreenX(box.x + box.w / 2)
  const cy = dc.cam.toScreenY(box.y + box.h / 2)
  // Equipment labels are never dropped: they are the anchors you read the plan from.
  placeLabel(dc, text, [{ x: cx, y: cy }], dc.store.system(box.systemId).color, placed, true)
}

export function drawMarkerLabel(dc: DrawCtx, marker: MarkerItem, placed: Rect[]): void {
  const text = labelTextFor(dc.store, marker)
  const p = dc.cam.toScreen(marker)
  const color = dc.store.system(marker.systemId).color
  const gap = (MARKER_RADIUS + 11) * dc.ui
  placeLabel(dc, text, [{ x: p.x, y: p.y - gap }, { x: p.x, y: p.y + gap }], color, placed)
}

/**
 * A run's label sits *on* the run, turned to follow it, with the line going in one end of the
 * pill and out the other - the way an installation drawing or a road map does it. A label set
 * beside its line can be read as belonging to the next one over as soon as two runs go side by
 * side; one sitting on its line cannot be read any other way.
 *
 * It wants a straight stretch longer than itself, so it is tried on the longest segments first,
 * at the middle and then staggered either side - two parallel runs of the same length would
 * otherwise both claim the same middle, and the second would lose its label.
 */
export function drawRunLabel(dc: DrawCtx, run: RunItem, placed: Rect[]): void {
  const text = labelTextFor(dc.store, run)
  if (!text || run.points.length < 2) return
  const { ctx, cam, ui } = dc
  ctx.font = LABEL_FONT(ui)
  const w = ctx.measureText(text).width + 8 * ui
  const h = 15 * ui
  // Room for the pill plus enough bare line either side to see that it runs through.
  const needed = w + 16 * ui
  const pts = run.points.map((p) => cam.toScreen(p))
  const segments = pts.slice(1)
    .map((b, i) => ({ a: pts[i], b, len: Math.hypot(b.x - pts[i].x, b.y - pts[i].y) }))
    .filter((s) => s.len >= needed)
    .sort((s, t) => t.len - s.len)
  // Declutter: a label that cannot sit along the run is dropped until you zoom in.
  if (!segments.length) return
  const color = dc.store.system(run.systemId).color
  for (const seg of segments.slice(0, 4)) {
    // How far the centre can move from the middle and still leave bare line at both ends.
    const slack = (seg.len - needed) / 2 / seg.len
    for (const t of [0.5, 0.5 - slack * 0.6, 0.5 + slack * 0.6, 0.5 - slack, 0.5 + slack]) {
      const centre = { x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t }
      if (inlinePill(dc, text, centre, readableAngle(seg.a, seg.b), w, h, color, placed)) return
    }
  }
}

/** The segment's angle, turned so text along it never reads upside down. Vertical reads upward. */
function readableAngle(a: Pt, b: Pt): number {
  let angle = Math.atan2(b.y - a.y, b.x - a.x)
  if (angle > Math.PI / 2 + 1e-6) angle -= Math.PI
  else if (angle <= -Math.PI / 2 + 1e-6) angle += Math.PI
  return angle
}

/** A pill turned to `angle` about `centre`, refused if its upright bounds hit a placed label. */
function inlinePill(
  dc: DrawCtx, text: string, centre: Pt, angle: number, w: number, h: number, color: string, placed: Rect[],
): boolean {
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const bw = w * cos + h * sin
  const bh = w * sin + h * cos
  const bounds = { x: centre.x - bw / 2, y: centre.y - bh / 2, w: bw, h: bh }
  const padded = { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 }
  if (placed.some((r) => rectsIntersect(r, padded))) return false
  placed.push(bounds)
  const { ctx } = dc
  ctx.save()
  ctx.translate(centre.x, centre.y)
  ctx.rotate(angle)
  paintPill(dc, text, { x: -w / 2, y: -h / 2, w, h }, 0, color)
  ctx.restore()
  return true
}
