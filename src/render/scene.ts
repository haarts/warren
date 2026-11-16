/**
 * The frame painter. One function, `drawScene`, that reads as a table of contents: background,
 * then each item kind in its drawing order, then labels, the compass, selection, and the scale
 * bar. The painters for each concern live in their own file next door; this one just calls them
 * in the right order and builds the `DrawCtx` they all share.
 */
import type { Pt, Rect } from '../geom.ts'
import type { Store } from '../model/doc.ts'
import type { BoxItem, DoorItem, MarkerItem, NoteItem, RoomItem, RunItem, WallItem, WindowItem } from '../model/types.ts'
import { itemsInRoom } from '../rooms.ts'
import type { Camera } from './camera.ts'
import { drawCompass, COMPASS_RADIUS_PX, type CompassPart } from './compass.ts'
import { isDimmed, type DrawCtx } from './draw.ts'
import { drawBoxLabel, drawMarkerLabel, drawRoomLabel, drawRunLabel, labelTextFor } from './labels.ts'
import { drawMarker } from './markers.ts'
import { drawNote, noteHeight } from './notes.ts'
import type { DetailPatch } from './background.ts'
import { drawGhost, type GhostLayer } from './ghost.ts'
import { drawGrid, drawScaleBar } from './gridScale.ts'
import { drawRun } from './runs.ts'
import { drawHandles, drawItemOutline, drawOverlay } from './selection.ts'
import { drawBox, drawDoor, drawRoom, drawWall, drawWindow } from './shapes.ts'

// `COMPASS_RADIUS_PX` lives in compass.ts and `labelTextFor` in labels.ts, next to the code
// that uses them - both are re-exported here only because test/browser/smoke.mjs imports them
// from this path, and that file is frozen.
export { COMPASS_RADIUS_PX, labelTextFor }

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
  /** This sheet's two reference points, shown while aligning or with a floor underneath. */
  alignPoints?: { a: Pt; b: Pt; names: [string, string] } | null
}

export interface SceneOptions {
  ctx: CanvasRenderingContext2D
  store: Store
  cam: Camera
  width: number
  height: number
  background: CanvasImageSource | null
  backgroundSize: { w: number; h: number } | null
  /** A sharper rendering of the part of the page on screen, drawn over the background. */
  backgroundDetail?: DetailPatch | null
  /** Multiplies label/handle sizes. 1 on screen; the export scale when rasterising. */
  uiScale?: number
  interactive?: boolean
  overlay?: Overlay
  paper?: boolean
  /** Another floor drawn faintly underneath, through the alignment. Screen only. */
  ghost?: GhostLayer | null
}

export function drawScene(opts: SceneOptions): void {
  const { ctx, store, cam, width, height } = opts
  const ui = opts.uiScale ?? 1
  const interactive = opts.interactive ?? true
  const settings = store.project.settings

  // Working on one room greys the rest. They stay selectable and snappable, because every
  // circuit has to reach a panel in some other room. A focus naming a room that is no longer
  // there greys the whole drawing, which would be baffling - treated as no focus at all.
  const focused = settings.roomFocus ? itemsInRoom(store.sheet, settings.roomFocus) : null
  const dc: DrawCtx = { ctx, store, cam, ui, interactive, inFocus: focused && focused.size > 0 ? focused : null }

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
    // 'high' filters a cached raster that can be tens of megapixels once zoomed in, and doing
    // that on every frame is what makes panning and dragging feel janky. Screen editing only
    // needs to look good at screen resolution; save the expensive filter for the export render.
    ctx.imageSmoothingQuality = interactive ? 'medium' : 'high'
    ctx.drawImage(opts.background, cam.toScreenX(0), cam.toScreenY(0), w * cam.zoom, h * cam.zoom)
    const d = opts.backgroundDetail
    if (d) ctx.drawImage(d.canvas, cam.toScreenX(d.x), cam.toScreenY(d.y), d.w * cam.zoom, d.h * cam.zoom)
    ctx.restore()
    ctx.save()
    ctx.strokeStyle = '#c9ced8'
    ctx.lineWidth = 1
    ctx.strokeRect(cam.toScreenX(0), cam.toScreenY(0), w * cam.zoom, h * cam.zoom)
    ctx.restore()
  }

  if (opts.ghost) drawGhost(dc, opts.ghost)
  if (settings.showGrid) drawGrid(dc, width, height)

  // --- items ------------------------------------------------------------------------
  const items = store.items().filter((i) => store.isVisible(i))
  // Rooms are the backdrop: painted first, under everything they give context to.
  const rooms = items.filter((i): i is RoomItem => i.kind === 'room')
  const walls = items.filter((i): i is WallItem => i.kind === 'wall')
  const windows = items.filter((i): i is WindowItem => i.kind === 'window')
  const doors = items.filter((i): i is DoorItem => i.kind === 'door')
  const boxes = items.filter((i): i is BoxItem => i.kind === 'box')
  const runs = items.filter((i): i is RunItem => i.kind === 'run')
  const markers = items.filter((i): i is MarkerItem => i.kind === 'marker')
  const notes = items.filter((i): i is NoteItem => i.kind === 'note')

  for (const room of rooms) drawRoom(dc, room)
  for (const wall of walls) drawWall(dc, wall)
  // Over the walls, which run on unbroken behind them.
  for (const win of windows) drawWindow(dc, win)
  for (const door of doors) drawDoor(dc, door)
  for (const box of boxes) drawBox(dc, box)
  for (const run of runs) drawRun(dc, run)
  for (const marker of markers) drawMarker(dc, marker)
  // Notes paint last so they are never buried under a duct, and hit-test first to match.
  for (const note of notes) drawNote(dc, note)

  if (settings.showLabels) {
    // One occupancy map for the whole frame: equipment and markers claim their spot first,
    // then runs take what is left. Parallel pipes 150 mm apart would otherwise stack three
    // labels on top of each other and none of them would be readable.
    const placed: Rect[] = []
    for (const note of notes) {
      if (isDimmed(dc, note)) continue
      placed.push({
        x: cam.toScreenX(note.x), y: cam.toScreenY(note.y),
        w: note.w * cam.zoom, h: noteHeight(note) * cam.zoom,
      })
    }
    // Room names claim their spot first: they are what you orient by.
    // A room keeps its name whatever the focus - it is what you navigate by. Everything else
    // out of focus loses its words: the shape is context, the label would be noise.
    for (const room of rooms) drawRoomLabel(dc, room, placed)
    for (const box of boxes) if (!isDimmed(dc, box)) drawBoxLabel(dc, box, placed)
    for (const marker of markers) if (!isDimmed(dc, marker)) drawMarkerLabel(dc, marker, placed)
    for (const run of runs) if (!isDimmed(dc, run)) drawRunLabel(dc, run, placed)
  }

  // The rose sits above the drawing - it is what you read the drawing's directions off.
  if (store.project.compass) {
    drawCompass(dc, store.project.compass, interactive ? opts.overlay?.compass ?? null : null)
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
    drawHandles(dc)
    drawOverlay(dc, overlay)
    if (overlay.alignPoints) drawAlignPoints(dc, overlay.alignPoints)
  }

  drawScaleBar(dc, height)
  ctx.restore()
}

/**
 * The two spots this floor is lined up by: a ringed cross with its name. While aligning they show
 * what a new pair replaces; with a floor underneath, they sit where that floor's spots land.
 */
function drawAlignPoints(dc: DrawCtx, pts: NonNullable<Overlay['alignPoints']>): void {
  const { ctx, cam, ui } = dc
  ctx.save()
  ctx.setLineDash([])
  ctx.font = `600 ${Math.round(12 * ui)}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  for (const [p, name] of [[pts.a, pts.names[0]], [pts.b, pts.names[1]]] as const) {
    const s = cam.toScreen(p)
    const r = 9 * ui
    for (const [color, width] of [['#ffffff', 4 * ui], ['#c026d3', 1.8 * ui]] as const) {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
      ctx.moveTo(s.x - r * 1.6, s.y); ctx.lineTo(s.x + r * 1.6, s.y)
      ctx.moveTo(s.x, s.y - r * 1.6); ctx.lineTo(s.x, s.y + r * 1.6)
      ctx.stroke()
    }
    const x = s.x + r * 1.8
    const w = ctx.measureText(name).width
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.fillRect(x - 3 * ui, s.y - 9 * ui, w + 6 * ui, 18 * ui)
    ctx.fillStyle = '#a21caf'
    ctx.fillText(name, x, s.y)
  }
  ctx.restore()
}
