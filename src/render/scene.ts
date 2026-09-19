import {
  boundsOf, dist, pointAtFraction, polygonArea, polygonCentroid, polylineLength, rectsIntersect,
  walkPolyline, type Pt, type Rect,
} from '../geom.ts'
import type { Store } from '../model/doc.ts'
import { LEVEL_SHORT, type BoxItem, type CompassRose, type DoorItem, type Item, type MarkerItem, type MarkerSymbol, type NoteItem, type RoomItem, type RunItem } from '../model/types.ts'
import { pointsOf } from '../model/types.ts'
import { itemsInRoom } from '../rooms.ts'
import { alongBearing, tipBearing } from '../directions.ts'
import { measureNote, noteFont, noteHeight, NOTE_LINE_HEIGHT, NOTE_PAD, NOTE_STRIPE } from './notes.ts'
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
  hoverLockedId?: string | null
  /** The part of the compass rose under the pointer, or being dragged. */
  compass?: CompassPart | null
}

/** Which part of the compass rose is meant: a tip (0-3) turns it, the hub moves it. */
export type CompassPart = { part: 'tip'; tip: number } | { part: 'hub' }

/** Screen radius of the compass rose. Fixed like a marker, so it reads at any zoom. */
export const COMPASS_RADIUS_PX = 46

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
/** What an out-of-focus item is drawn in: present, plainly context, not competing. */
const DIMMED = '#c3c9d2'

/**
 * Items in the focused room, for this frame only. Held here rather than threaded through every
 * draw function; the render pass is one frame at a time, so there is nothing to race with.
 */
let inFocus: Set<string> | null = null

const dimmed = (item: Item): boolean => inFocus !== null && !inFocus.has(item.id)

export function drawScene(opts: SceneOptions): void {
  const { ctx, store, cam, width, height } = opts
  const ui = opts.uiScale ?? 1
  const interactive = opts.interactive ?? true
  const settings = store.project.settings

  // Working on one room greys the rest. They stay selectable and snappable, because every
  // circuit has to reach a panel in some other room.
  const focused = settings.roomFocus ? itemsInRoom(store.sheet, settings.roomFocus) : null
  // A focus naming a room that is no longer there greys the whole drawing, which would be
  // baffling. Treat it as no focus at all.
  inFocus = focused && focused.size > 0 ? focused : null

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
  // Rooms are the backdrop: painted first, under everything they give context to.
  const rooms = items.filter((i): i is RoomItem => i.kind === 'room')
  const doors = items.filter((i): i is DoorItem => i.kind === 'door')
  const boxes = items.filter((i): i is BoxItem => i.kind === 'box')
  const runs = items.filter((i): i is RunItem => i.kind === 'run')
  const markers = items.filter((i): i is MarkerItem => i.kind === 'marker')
  const notes = items.filter((i): i is NoteItem => i.kind === 'note')

  for (const room of rooms) drawRoom(ctx, store, cam, room)
  for (const door of doors) drawDoor(ctx, store, cam, door, ui)
  for (const box of boxes) drawBox(ctx, store, cam, box, ui)
  for (const run of runs) drawRun(ctx, store, cam, run, ui, settings.showFlow)
  for (const marker of markers) drawMarker(ctx, store, cam, marker, ui)
  // Notes paint last so they are never buried under a duct, and hit-test first to match.
  for (const note of notes) drawNote(ctx, store, cam, note, ui)

  if (settings.showLabels) {
    // One occupancy map for the whole frame: equipment and markers claim their spot first,
    // then runs take what is left. Parallel pipes 150 mm apart would otherwise stack three
    // labels on top of each other and none of them would be readable.
    const placed: Rect[] = []
    for (const note of notes) {
      if (dimmed(note)) continue
      placed.push({
        x: cam.toScreenX(note.x), y: cam.toScreenY(note.y),
        w: note.w * cam.zoom, h: noteHeight(note) * cam.zoom,
      })
    }
    // Room names claim their spot first: they are what you orient by.
    // A room keeps its name whatever the focus — it is what you navigate by. Everything else
    // out of focus loses its words: the shape is context, the label would be noise.
    for (const room of rooms) drawRoomLabel(ctx, store, cam, room, ui, placed)
    for (const box of boxes) if (!dimmed(box)) drawBoxLabel(ctx, store, cam, box, ui, placed)
    for (const marker of markers) if (!dimmed(marker)) drawMarkerLabel(ctx, store, cam, marker, ui, placed)
    for (const run of runs) if (!dimmed(run)) drawRunLabel(ctx, store, cam, run, ui, placed)
  }

  // The rose sits above the drawing - it is what you read the drawing's directions off.
  if (store.sheet.compass) {
    drawCompass(ctx, cam, store.sheet.compass, ui, interactive, interactive ? opts.overlay?.compass ?? null : null)
  }

  // --- selection & tool feedback ------------------------------------------------------
  if (interactive) {
    const overlay = opts.overlay ?? {}
    if (overlay.hoverId && !store.selection.has(overlay.hoverId)) {
      const it = store.item(overlay.hoverId)
      if (it) drawItemOutline(ctx, cam, it, 'rgba(11,99,214,0.35)', 4 * ui)
    }
    if (overlay.hoverLockedId) {
      // Grey rather than blue: "I can see it, it just will not move."
      const it = store.item(overlay.hoverLockedId)
      if (it) drawItemOutline(ctx, cam, it, 'rgba(100,116,139,0.45)', 4 * ui)
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
    color: dimmed(item) ? DIMMED : item.colorOverride ?? sys.color,
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
    drawFlowArrows(ctx, pts, run.flow === 'reverse', style.color, ui, run.flowAssumed === true)
  }
  ctx.restore()
}

function drawFlowArrows(
  ctx: CanvasRenderingContext2D, screenPts: Pt[], reverse: boolean, color: string, ui: number, assumed = false,
): void {
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

function drawRoom(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, room: RoomItem): void {
  if (room.points.length < 3) return
  const color = dimmed(room) ? DIMMED : room.colorOverride ?? store.system(room.systemId).color
  const pts = screenPoints(cam, room.points)
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.globalAlpha = 0.05
  ctx.fill()
  ctx.globalAlpha = 0.65
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, 1.1 * cam.zoom)
  ctx.setLineDash([Math.max(2, 5 * cam.zoom), Math.max(2, 4 * cam.zoom)])
  ctx.stroke()
  ctx.restore()
}

function drawRoomLabel(
  ctx: CanvasRenderingContext2D, store: Store, cam: Camera, room: RoomItem, ui: number, placed: Rect[],
): void {
  if (room.points.length < 3) return
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
  ctx.fillStyle = dimmed(room) ? DIMMED : store.system(room.systemId).color
  ctx.fillText(text, c.x, c.y)
  ctx.restore()
}

/** The architect's door symbol: the opening, the leaf from the hinge, and its swing. */
function drawDoor(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, door: DoorItem, ui: number): void {
  if (door.points.length < 2) return
  const color = dimmed(door) ? DIMMED : door.colorOverride ?? store.system(door.systemId).color
  const hinge = door.points[0]
  const strike = door.points[1]
  const width = dist(hinge, strike) * cam.zoom
  if (width < 2) return
  const h = cam.toScreen(hinge)
  const st = cam.toScreen(strike)
  const angle = Math.atan2(st.y - h.y, st.x - h.x)

  ctx.save()
  ctx.setLineDash([])
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.2, store.system(door.systemId).width * cam.zoom)
  // The opening itself.
  ctx.beginPath()
  ctx.moveTo(h.x, h.y)
  ctx.lineTo(st.x, st.y)
  ctx.stroke()

  // The leaf, swung a quarter turn, and the arc it sweeps.
  const swept = angle + (door.swing * Math.PI) / 2
  ctx.beginPath()
  ctx.moveTo(h.x, h.y)
  ctx.lineTo(h.x + Math.cos(swept) * width, h.y + Math.sin(swept) * width)
  ctx.stroke()
  ctx.globalAlpha = 0.45
  ctx.lineWidth = Math.max(0.8, 0.8 * cam.zoom)
  ctx.beginPath()
  ctx.arc(h.x, h.y, width, Math.min(angle, swept), Math.max(angle, swept))
  ctx.stroke()
  ctx.globalAlpha = 1

  // A dot on the hinge, so which end is which is readable at a glance.
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(h.x, h.y, Math.max(1.5, 2 * ui), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

const ROSE_INK = '#334155'
const ROSE_TIP_ONE = '#b91c1c'

/**
 * Four long arms a quarter-turn apart, four short ones between them for the look of the thing,
 * and each long arm's names written just past its tip. Tip 1 is picked out in red, because it
 * is the one the rotation is measured by. The numbered discs are the drag handles, so they
 * only appear on screen, never in an export.
 */
function drawCompass(
  ctx: CanvasRenderingContext2D, cam: Camera, rose: CompassRose, ui: number,
  interactive: boolean, active: CompassPart | null,
): void {
  const c = cam.toScreen(rose)
  const R = COMPASS_RADIUS_PX * ui
  const half = 6 * ui
  const arm = (bearing: number, length: number, color: string): void => {
    const tip = alongBearing(c, bearing, length)
    const left = alongBearing(c, bearing - 90, half * (length / R))
    const right = alongBearing(c, bearing + 90, half * (length / R))
    // Two halves, one filled and one pale: the classic rose, readable as a direction at a glance.
    ctx.fillStyle = color
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(left.x, left.y); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(right.x, right.y); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 1 * ui
    ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(right.x, right.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.stroke()
  }

  ctx.save()
  ctx.setLineDash([])
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = ROSE_INK
  ctx.lineWidth = 1 * ui
  ctx.beginPath()
  ctx.arc(c.x, c.y, R * 0.62, 0, Math.PI * 2)
  ctx.stroke()
  for (let i = 0; i < 4; i++) arm(tipBearing(rose, i) + 45, R * 0.48, ROSE_INK)
  for (let i = 3; i >= 0; i--) arm(tipBearing(rose, i), R, i === 0 ? ROSE_TIP_ONE : ROSE_INK)
  ctx.globalAlpha = 1

  // The hub: the move handle.
  const hubHot = active?.part === 'hub'
  ctx.fillStyle = hubHot ? ACCENT : '#ffffff'
  ctx.strokeStyle = hubHot ? ACCENT : ROSE_INK
  ctx.lineWidth = 1.5 * ui
  ctx.beginPath()
  ctx.arc(c.x, c.y, 3.5 * ui, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  ctx.font = `600 ${11 * ui}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
  for (let i = 0; i < 4; i++) {
    const bearing = tipBearing(rose, i)
    const tip = alongBearing(c, bearing, R)
    if (interactive) {
      const hot = active?.part === 'tip' && active.tip === i
      ctx.fillStyle = hot ? ACCENT : '#ffffff'
      ctx.strokeStyle = hot ? ACCENT : i === 0 ? ROSE_TIP_ONE : ROSE_INK
      ctx.lineWidth = 1.5 * ui
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, 7 * ui, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = hot ? '#ffffff' : ROSE_INK
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), tip.x, tip.y + 0.5 * ui)
    }

    const names = rose.tips[i]
    if (!names) continue
    const at = alongBearing(c, bearing, R + 11 * ui)
    const rad = (bearing * Math.PI) / 180
    const ux = Math.sin(rad)
    const uy = -Math.cos(rad)
    // Hang the text off the side of the point it belongs to, whichever way the rose is turned.
    ctx.textAlign = ux > 0.38 ? 'left' : ux < -0.38 ? 'right' : 'center'
    ctx.textBaseline = uy > 0.38 ? 'top' : uy < -0.38 ? 'bottom' : 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3.5 * ui
    ctx.strokeStyle = '#ffffff'
    ctx.strokeText(names, at.x, at.y)
    ctx.fillStyle = i === 0 ? ROSE_TIP_ONE : ROSE_INK
    ctx.fillText(names, at.x, at.y)
  }
  ctx.restore()
}

const NOTE_BODY = '#fef3c7'
const NOTE_EDGE = '#d4a72c'
const NOTE_FOLD = '#e8d08a'
const NOTE_INK = '#422006'
/** Below this on-screen width the text is unreadable, so collapse to a marker instead. */
const NOTE_COLLAPSE_PX = 46

function drawNote(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, note: NoteItem, ui: number): void {
  const accent = dimmed(note) ? DIMMED : note.colorOverride ?? store.system(note.systemId).color
  const x = cam.toScreenX(note.x)
  const y = cam.toScreenY(note.y)
  const w = note.w * cam.zoom

  ctx.save()
  ctx.setLineDash([])

  if (w < NOTE_COLLAPSE_PX) {
    // Zoomed out: show where the note is, not what it says.
    const s = 11 * ui
    ctx.fillStyle = NOTE_BODY
    ctx.strokeStyle = NOTE_EDGE
    ctx.lineWidth = 1 * ui
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + s, y)
    ctx.lineTo(x + s, y + s * 0.65)
    ctx.lineTo(x + s * 0.65, y + s)
    ctx.lineTo(x, y + s)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = accent
    ctx.fillRect(x, y, Math.max(1.5, s * 0.18), s)
    ctx.restore()
    return
  }

  const layout = measureNote(note)
  const h = layout.h * cam.zoom
  const fold = Math.min(10 * ui, w * 0.22, h * 0.4)

  ctx.fillStyle = NOTE_BODY
  ctx.strokeStyle = NOTE_EDGE
  ctx.lineWidth = 1 * ui
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + h - fold)
  ctx.lineTo(x + w - fold, y + h)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // The folded corner, and the stripe that says which layer this note belongs to.
  ctx.fillStyle = NOTE_FOLD
  ctx.beginPath()
  ctx.moveTo(x + w - fold, y + h)
  ctx.lineTo(x + w - fold, y + h - fold)
  ctx.lineTo(x + w, y + h - fold)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = NOTE_EDGE
  ctx.stroke()

  ctx.fillStyle = accent
  ctx.fillRect(x, y, NOTE_STRIPE * cam.zoom, h)

  ctx.fillStyle = NOTE_INK
  ctx.font = noteFont(cam.zoom)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  const left = x + (NOTE_STRIPE + NOTE_PAD) * cam.zoom
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, left, y + (NOTE_PAD + i * NOTE_LINE_HEIGHT) * cam.zoom)
  })
  ctx.restore()
  ctx.restore()
}

const MARKER_RADIUS = 8

function drawMarker(ctx: CanvasRenderingContext2D, store: Store, cam: Camera, marker: MarkerItem, ui: number): void {
  const style = strokeStyleFor(store, marker)
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
  drawMarkerGlyph(ctx, marker.symbol, r, style.color)
  ctx.restore()
}

export function drawMarkerGlyph(ctx: CanvasRenderingContext2D, symbol: MarkerSymbol, r: number, color: string): void {
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = color
  switch (symbol) {
    case 'socket':
    case 'socket-2':
    case 'socket-3':
    case 'socket-4': {
      // Wandcontactdoos, IEC 60617 / NEN 5152: a half-round on its diameter line, joined to
      // the circuit by a stem at right angles. The stem is what makes it read as mounted on
      // something rather than floating. Extra gangs repeat the half-round along the same line
      // rather than shrinking it, so a quadruple stays legible when zoomed out.
      const gangs = symbol === 'socket' ? 1 : Number(symbol.slice(-1))
      const a = r * 0.62
      const span = gangs * 2 * a
      ctx.beginPath()
      for (let i = 0; i < gangs; i++) {
        const cx = -span / 2 + a + i * 2 * a
        ctx.moveTo(cx - a, 0)
        ctx.arc(cx, 0, a, Math.PI, 0)
      }
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(-span / 2 - r * 0.32, 0)
      ctx.lineTo(span / 2 + r * 0.32, 0)
      ctx.moveTo(0, 0)
      ctx.lineTo(0, r * 1.05)
      ctx.stroke()
      break
    }
    case 'switch': {
      ctx.beginPath()
      ctx.arc(0, r * 0.45, r * 0.38, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(0, r * 0.45)
      ctx.lineTo(r * 0.85, -r * 0.75)
      ctx.stroke()
      break
    }
    case 'light': {
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      const d = r * 0.64
      ctx.beginPath()
      ctx.moveTo(-d, -d); ctx.lineTo(d, d)
      ctx.moveTo(d, -d); ctx.lineTo(-d, d)
      ctx.stroke()
      break
    }
    case 'detector': {
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.beginPath()
      for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
        ctx.moveTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95)
        ctx.lineTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4)
      }
      ctx.stroke()
      break
    }
    case 'data-outlet': {
      ctx.beginPath()
      ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(-r * 0.3, -r * 0.45)
      ctx.lineTo(r * 0.5, 0)
      ctx.lineTo(-r * 0.3, r * 0.45)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
      break
    }
    case 'air-valve': {
      ctx.beginPath()
      ctx.rect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.58, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
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
    const handlePoints = pointsOf(item)
    if (handlePoints) {
      handlePoints.forEach((wp, i) => {
        const p = cam.toScreen(wp)
        const active = store.activeVertex?.itemId === item.id && store.activeVertex.index === i
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
    } else if (item.kind === 'note') {
      // One handle, bottom-right: a note only has a width. Height follows the text.
      const p = cam.toScreen({ x: item.x + item.w, y: item.y + noteHeight(item) })
      ctx.fillStyle = HANDLE_FILL
      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.rect(p.x - s / 2, p.y - s / 2, s, s)
      ctx.fill()
      ctx.stroke()
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
  const points = pointsOf(item)
  if (points) return boundsOf(points)
  if (item.kind === 'box') return { x: item.x, y: item.y, w: item.w, h: item.h }
  if (item.kind === 'note') return { x: item.x, y: item.y, w: item.w, h: noteHeight(item) }
  if (item.kind === 'marker') return { x: item.x, y: item.y, w: 0, h: 0 }
  return { x: 0, y: 0, w: 0, h: 0 }
}
