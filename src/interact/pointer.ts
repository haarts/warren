/**
 * The pointer/drag state machine, per tool - including the two ways to build something by
 * clicking points, a run drawn corner by corner and the two-click measure/calibrate/direction
 * tools. Compass dragging is a drag mode like any other; compass.ts owns its hit-test and what
 * a finished calibration or direction answer means.
 */
import { dist, normalizeRect, type Pt, type Rect } from '../geom.ts'
import type { VertexRef } from '../model/doc.ts'
import { newId } from '../model/ids.ts'
import { isPositioned, pointsOf, type BoxItem, type Item, type MarkerItem, type NoteItem, type RunItem } from '../model/types.ts'
import { defaultNoteWidth, NOTE_MIN_WIDTH } from '../render/notes.ts'
import { adopt } from '../generate.ts'
import { bearingBetween } from '../directions.ts'
import { HIT_TOL_PX, hitBoxCorner, hitNoteHandle, hitSegment, hitTest, hitTestLocked, hitVertex, itemsInRect } from './hittest.ts'
import { hitCompass } from './compass.ts'
import { clearFlashIfStale, zoomToFit } from './view.ts'
import type { Editor } from './editor.ts'

/** The fewest points a shape can have and still be that shape. */
function minPointsFor(item: Item): number {
  return item.kind === 'room' ? 3 : 2
}

/** The corner next door, for ortho lock. A room wraps around; a run stops at its ends. */
function neighbourOf(item: Item, points: Pt[], index: number): Pt | null {
  if (item.kind === 'room') {
    const n = points.length
    return points[(index - 1 + n) % n] ?? null
  }
  return points[index - 1] ?? points[index + 1] ?? null
}

/**
 * Move an item by a delta, whatever shape it is made of, measured from `from`'s coordinates -
 * which defaults to the item's own (a live nudge) but can be an earlier snapshot (a drag, so
 * the delta is measured from where the gesture started, not accumulated frame to frame).
 */
function shiftItem(item: Item, dx: number, dy: number, from: Item = item): void {
  adopt(item)
  const points = pointsOf(from)
  if (points) (item as { points: Pt[] }).points = points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
  else if (isPositioned(from) && isPositioned(item)) { item.x = from.x + dx; item.y = from.y + dy }
}

export type Drag =
  | { mode: 'none' }
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'move'; start: Pt; originals: Map<string, Item>; moved: boolean }
  | { mode: 'vertex'; ref: VertexRef }
  | { mode: 'boxCorner'; boxId: string; anchor: Pt }
  | { mode: 'noteWidth'; noteId: string }
  | { mode: 'rubber'; start: Pt; additive: boolean; current: Pt }
  | { mode: 'newBox'; start: Pt; current: Pt }
  | { mode: 'compassTurn'; tip: number; moved: boolean }
  | { mode: 'compassMove'; offset: Pt; moved: boolean }

export function attachPointer(ed: Editor): void {
  const c = ed.canvas
  const up = (e: PointerEvent): void => onPointerUp(ed, e)
  c.addEventListener('pointerdown', (e) => onPointerDown(ed, e))
  c.addEventListener('pointermove', (e) => onPointerMove(ed, e))
  c.addEventListener('pointerup', up)
  c.addEventListener('pointercancel', up)
  c.addEventListener('pointerleave', () => onPointerLeave(ed))
  c.addEventListener('dblclick', (e) => onDoubleClick(ed, e))
  c.addEventListener('wheel', (e) => onWheel(ed, e), { passive: false })
  c.addEventListener('contextmenu', (e) => e.preventDefault())
}

function onPointerDown(ed: Editor, e: PointerEvent): void {
  clearFlashIfStale(ed)
  ed.canvas.setPointerCapture(e.pointerId)
  ed.shiftHeld = e.shiftKey
  const world = ed.eventPoint(e)
  ed.cursorWorld = world

  if (e.button === 1 || ed.spaceHeld) {
    // Middle double-click is Zoom Extents in AutoCAD, and costs nothing to honour.
    const now = Date.now()
    if (e.button === 1 && now - ed.lastMiddleDown < 400) {
      ed.lastMiddleDown = 0
      zoomToFit(ed)
      return
    }
    if (e.button === 1) ed.lastMiddleDown = now
    ed.drag = { mode: 'pan', lastX: e.clientX, lastY: e.clientY }
    ed.requestRender()
    return
  }
  if (e.button === 2) {
    if (ed.tool === 'run' && ed.draft.length >= 2) finishDraft(ed)
    else if (ed.tool === 'run') cancelDraft(ed)
    return
  }
  if (e.button !== 0) return

  switch (ed.tool) {
    case 'select': selectPointerDown(ed, e, world); break
    case 'run': runPointerDown(ed, world); break
    case 'box': ed.drag = { mode: 'newBox', start: ed.resolve(world), current: ed.resolve(world) }; break
    case 'marker': placeMarker(ed, ed.resolve(world)); break
    case 'note': placeNote(ed, ed.resolve(world)); break
    case 'measure':
    case 'calibrate':
    case 'direction': measurePointerDown(ed, world); break
  }
  ed.requestRender()
}

function selectPointerDown(ed: Editor, e: PointerEvent, world: Pt): void {
  const store = ed.store
  const vertex = hitVertex(store, world, ed.tol(HIT_TOL_PX))
  if (vertex) {
    if (e.altKey) {
      deleteVertex(ed, vertex)
      return
    }
    store.activeVertex = vertex
    store.begin()
    ed.drag = { mode: 'vertex', ref: vertex }
    return
  }

  const handle = hitHandle(ed, world)
  if (handle) {
    store.begin()
    ed.drag = handle
    return
  }

  const hit = hitTest(store, world, ed.tol(HIT_TOL_PX))
  if (hit) {
    if (e.altKey && pointsOf(hit) && hit.kind !== 'door') {
      insertVertex(ed, hit, world)
      return
    }
    if (e.shiftKey) {
      if (store.selection.has(hit.id)) store.selection.delete(hit.id)
      else store.selection.add(hit.id)
    } else if (!store.selection.has(hit.id)) {
      store.selection.clear()
      store.selection.add(hit.id)
    }
    store.activeVertex = null
    const originals = new Map<string, Item>()
    for (const it of store.selectedItems()) {
      if (store.isEditable(it)) originals.set(it.id, structuredClone(it))
    }
    store.begin()
    ed.drag = { mode: 'move', start: world, originals, moved: false }
    ed.onChange?.()
    return
  }

  if (!e.shiftKey) {
    store.selection.clear()
    store.activeVertex = null
    ed.onChange?.()
  }
  ed.drag = { mode: 'rubber', start: world, additive: e.shiftKey, current: world }
}

/**
 * The one grab handle under `world` that isn't a shape's own vertex: a compass rose tip or
 * hub, a selected box's corner, or a selected note's resize handle - tried in that order,
 * since the rose floats above everything else on the sheet.
 */
function hitHandle(ed: Editor, world: Pt): Drag | null {
  const store = ed.store
  const rose = hitCompass(ed, world)
  if (rose && store.project.compass) {
    const c = store.project.compass
    return rose.part === 'tip'
      ? { mode: 'compassTurn', tip: rose.tip, moved: false }
      : { mode: 'compassMove', offset: { x: world.x - c.x, y: world.y - c.y }, moved: false }
  }

  const corner = hitBoxCorner(store, world, ed.tol(HIT_TOL_PX))
  const box = corner ? store.item(corner.boxId) : undefined
  if (corner && box && box.kind === 'box') {
    const anchor = {
      x: corner.corner === 0 || corner.corner === 3 ? box.x + box.w : box.x,
      y: corner.corner === 0 || corner.corner === 1 ? box.y + box.h : box.y,
    }
    return { mode: 'boxCorner', boxId: box.id, anchor }
  }

  const noteHandle = hitNoteHandle(store, world, ed.tol(HIT_TOL_PX))
  return noteHandle ? { mode: 'noteWidth', noteId: noteHandle.noteId } : null
}

function onPointerMove(ed: Editor, e: PointerEvent): void {
  clearFlashIfStale(ed)
  ed.shiftHeld = e.shiftKey
  const world = ed.eventPoint(e)
  ed.cursorWorld = world

  switch (ed.drag.mode) {
    case 'pan': {
      ed.cam.panByScreen(e.clientX - ed.drag.lastX, e.clientY - ed.drag.lastY)
      ed.drag.lastX = e.clientX
      ed.drag.lastY = e.clientY
      break
    }
    case 'move': {
      const only = ed.drag.originals.size === 1 ? [...ed.drag.originals.values()][0] : null
      let dx: number, dy: number
      if (only && (only.kind === 'marker' || only.kind === 'note')) {
        // A single marker or note is nothing but a point - the cursor and the shape are the
        // same thing, so this is exactly where snapping to a run's end belongs (attaching a
        // lamp to a stub that ends mid-room). Resolve where the *item* would land, not the
        // raw cursor, and exclude the item from its own candidate list.
        const candidate = { x: only.x + (world.x - ed.drag.start.x), y: only.y + (world.y - ed.drag.start.y) }
        const target = ed.resolve(candidate, { excludeRunId: only.id })
        dx = target.x - only.x
        dy = target.y - only.y
      } else {
        // Item snapping is off while moving a shape or a group: it would snap the cursor,
        // not the shape, which feels random. Ortho (Shift) and the grid still apply.
        const target = ed.resolve(world, { anchor: ed.drag.start, itemSnap: false })
        dx = target.x - ed.drag.start.x
        dy = target.y - ed.drag.start.y
      }
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) ed.drag.moved = true
      for (const [id, original] of ed.drag.originals) {
        const live = ed.store.item(id)
        if (live) shiftItem(live, dx, dy, original)
      }
      break
    }
    case 'vertex': {
      const item = ed.store.item(ed.drag.ref.itemId)
      const points = item ? pointsOf(item) : null
      if (item && points) {
        const i = ed.drag.ref.index
        const anchor = neighbourOf(item, points, i)
        points[i] = ed.resolve(world, { anchor, excludeRunId: item.id, excludeIndex: i })
        adopt(item)
      }
      break
    }
    case 'boxCorner': {
      const box = ed.store.item(ed.drag.boxId)
      if (box && box.kind === 'box') {
        const p = ed.resolve(world, { anchor: ed.drag.anchor })
        Object.assign(box, normalizeRect(ed.drag.anchor, p))
      }
      break
    }
    case 'noteWidth': {
      const note = ed.store.item(ed.drag.noteId)
      if (note && note.kind === 'note') note.w = Math.max(NOTE_MIN_WIDTH, world.x - note.x)
      break
    }
    case 'compassTurn': {
      const rose = ed.store.project.compass
      if (!rose) break
      const centre = { x: rose.x, y: rose.y }
      // Anchored at the centre, so Shift locks the turn to 45° steps like any other line.
      // Snapping to items would drag the tip onto the nearest pipe, which means nothing here.
      const p = ed.resolve(world, { anchor: centre, itemSnap: false })
      if (p.x === centre.x && p.y === centre.y) break
      const next = (((bearingBetween(centre, p) - ed.drag.tip * 90) % 360) + 360) % 360
      if (Math.abs(next - rose.rotationDeg) > 1e-9) {
        rose.rotationDeg = next
        ed.drag.moved = true
      }
      break
    }
    case 'compassMove': {
      const rose = ed.store.project.compass
      if (!rose) break
      rose.x = world.x - ed.drag.offset.x
      rose.y = world.y - ed.drag.offset.y
      ed.drag.moved = true
      break
    }
    case 'rubber': {
      ed.drag.current = world
      break
    }
    case 'newBox': {
      ed.drag.current = ed.resolve(world, { anchor: ed.drag.start })
      break
    }
    case 'none': {
      if (ed.tool === 'run' && ed.draft.length) {
        updateDraftCursor(ed, world)
      } else if ((ed.tool === 'measure' || ed.tool === 'calibrate' || ed.tool === 'direction') && ed.measurePts.length === 1) {
        updateMeasureCursor(ed, world)
      } else if (ed.tool === 'select') {
        updateHover(ed, world)
      } else {
        ed.resolve(world)
      }
      break
    }
  }
  ed.requestRender()
}

/** Nothing is being dragged and the Select tool is active - track what the cursor is over, so
 * the overlay can highlight it and a click has something to act on. */
function updateHover(ed: Editor, world: Pt): void {
  ed.hover.compass = hitCompass(ed, world)
  const hit = ed.hover.compass ? null : hitTest(ed.store, world, ed.tol(HIT_TOL_PX))
  ed.hover.id = hit?.id ?? null
  ed.hover.locked = hit || ed.hover.compass ? null : hitTestLocked(ed.store, world, ed.tol(HIT_TOL_PX))?.id ?? null
  ed.snap = null
}

function onPointerUp(ed: Editor, e: PointerEvent): void {
  if (ed.canvas.hasPointerCapture(e.pointerId)) ed.canvas.releasePointerCapture(e.pointerId)
  const store = ed.store
  switch (ed.drag.mode) {
    case 'move':
    case 'compassTurn':
    case 'compassMove':
      // A click that did not move anything leaves no undo step behind.
      if (ed.drag.moved) store.commit()
      else store.cancel()
      break
    case 'vertex':
    case 'boxCorner':
    case 'noteWidth':
      store.commit()
      break
    case 'rubber': {
      const rect = normalizeRect(ed.drag.start, ed.drag.current)
      if (rect.w > 1e-6 || rect.h > 1e-6) {
        const found = itemsInRect(store, rect)
        if (!ed.drag.additive) store.selection.clear()
        for (const it of found) store.selection.add(it.id)
        ed.onChange?.()
      }
      break
    }
    case 'newBox': {
      const rect = normalizeRect(ed.drag.start, ed.drag.current)
      if (rect.w * ed.cam.zoom > 4 && rect.h * ed.cam.zoom > 4) createBox(ed, rect)
      break
    }
    default:
      break
  }
  ed.drag = { mode: 'none' }
  ed.snap = null
  ed.requestRender()
}

function onPointerLeave(ed: Editor): void {
  if (ed.drag.mode === 'none') {
    ed.cursorWorld = null
    ed.snap = null
    ed.hover = { id: null, locked: null, compass: null }
    ed.requestRender()
  }
}

function onDoubleClick(ed: Editor, e: MouseEvent): void {
  const world = ed.eventPoint(e)
  if (ed.tool === 'run') {
    if (ed.draft.length >= 2) finishDraft(ed)
    return
  }
  if (ed.tool !== 'select') return
  const hit = hitTest(ed.store, world, ed.tol(HIT_TOL_PX))
  if (hit && pointsOf(hit) && hit.kind !== 'door') insertVertex(ed, hit, world)
}

/**
 * A wheel mouse and a trackpad send the same event and mean opposite things by it: one notch
 * of a wheel means zoom, two fingers dragging mean pan. They are told apart by how the browser
 * reports the movement - a wheel arrives in discrete lines or big pixel jumps, a trackpad in
 * small pixel deltas and with sideways movement a wheel cannot produce. Once one has been
 * seen, it is remembered.
 *
 * Ctrl or Cmd always means zoom, which is also how the browser reports a trackpad pinch.
 */
function onWheel(ed: Editor, e: WheelEvent): void {
  e.preventDefault()
  if (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && e.deltaY !== 0)) {
    ed.trackpadSeen = true
  }
  const pinch = e.ctrlKey || e.metaKey
  const pans = !pinch && ed.trackpadSeen && !e.altKey

  if (pans) {
    ed.cam.panByScreen(-e.deltaX, -e.deltaY)
  } else {
    const rect = ed.canvas.getBoundingClientRect()
    const factor = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1) * (pinch ? 2 : 1))
    ed.cam.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
  }
  ed.requestRender()
}

// --- drafts and two-point tools ---------------------------------------------------------------

function runPointerDown(ed: Editor, world: Pt): void {
  const anchor = ed.draft.length ? ed.draft[ed.draft.length - 1] : null
  const p = ed.resolve(world, { anchor })
  ed.draft.push(p)
  ed.draftCursor = p
}

function updateDraftCursor(ed: Editor, world: Pt): void {
  ed.draftCursor = ed.resolve(world, { anchor: ed.draft[ed.draft.length - 1] })
}

export function finishDraft(ed: Editor): void {
  if (ed.draft.length < 2) {
    cancelDraft(ed)
    return
  }
  const sys = ed.store.system(ed.activeSystemId)
  const run: RunItem = {
    kind: 'run',
    id: newId('run'),
    systemId: sys.id,
    level: ed.activeLevel,
    points: ed.draft.map((p) => ({ ...p })),
    size: sys.defaultSize ?? '',
    // The order you drew it in is a decent guess at which way it falls or blows - but only
    // a guess, so it is marked as one until somebody says otherwise.
    flow: sys.assumeFlow ? 'forward' : 'none',
    ...(sys.assumeFlow ? { flowAssumed: true } : {}),
  }
  ed.draft = []
  ed.draftCursor = null
  ed.place(run)
}

export function cancelDraft(ed: Editor): void {
  ed.draft = []
  ed.draftCursor = null
  ed.requestRender()
}

export function removeLastDraftPoint(ed: Editor): void {
  if (ed.draft.length === 0) return
  ed.draft.pop()
  ed.requestRender()
}

function measurePointerDown(ed: Editor, world: Pt): void {
  const anchor = ed.measurePts.length === 1 ? ed.measurePts[0] : null
  const p = ed.resolve(world, { anchor })
  if (ed.measurePts.length >= 2) ed.measurePts = []
  ed.measurePts.push(p)
  if (ed.measurePts.length !== 2) return
  const [a, b] = ed.measurePts
  if (dist(a, b) < 1e-6) { ed.measurePts = []; return }
  if (ed.tool === 'calibrate') ed.onCalibrateRequest?.(dist(a, b))
  else if (ed.tool === 'direction') ed.onDirectionRequest?.(bearingBetween(a, b))
}

function updateMeasureCursor(ed: Editor, world: Pt): void {
  ed.cursorWorld = ed.resolve(world, { anchor: ed.measurePts[0] })
}

/** Abandons whatever two-click capture is in progress - shared by Esc and by backing out of a
 * calibration or direction prompt. */
export function cancelMeasurement(ed: Editor): void {
  ed.measurePts = []
  ed.requestRender()
}

// --- item creation ---------------------------------------------------------------------------

function createBox(ed: Editor, rect: Rect): void {
  const sys = ed.store.system(ed.activeSystemId)
  const box: BoxItem = {
    kind: 'box',
    id: newId('box'),
    systemId: sys.id,
    level: ed.activeLevel,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    label: '',
  }
  ed.place(box)
}

function placeMarker(ed: Editor, p: Pt): void {
  const marker: MarkerItem = {
    kind: 'marker',
    id: newId('mk'),
    systemId: ed.activeSystemId,
    level: ed.activeLevel,
    x: p.x, y: p.y,
    symbol: ed.activeMarkerSymbol,
    label: '',
  }
  ed.place(marker)
}

function placeNote(ed: Editor, p: Pt): void {
  const note: NoteItem = {
    kind: 'note',
    id: newId('note'),
    systemId: ed.activeSystemId,
    level: ed.activeLevel,
    x: p.x,
    y: p.y,
    w: defaultNoteWidth(ed.store.sheet.pdf?.widthPt ?? 595),
    text: '',
  }
  ed.place(note)
}

function insertVertex(ed: Editor, item: Item, world: Pt): void {
  // A door is two jambs and stays two jambs; everything else made of points can grow a corner.
  if (item.kind === 'door' || !pointsOf(item)) return
  const hit = hitSegment(item, world, ed.tol(HIT_TOL_PX * 1.5))
  if (!hit) return
  ed.edit(null, () => {
    const live = ed.store.item(item.id)
    const points = live ? pointsOf(live) : null
    if (live && points) {
      points.splice(hit.index + 1, 0, hit.point)
      adopt(live)
    }
    ed.store.selection.clear()
    ed.store.selection.add(item.id)
    ed.store.activeVertex = { itemId: item.id, index: hit.index + 1 }
  })
}

function deleteVertex(ed: Editor, ref: VertexRef): void {
  const item = ed.store.item(ref.itemId)
  const points = item ? pointsOf(item) : null
  if (!item || !points || points.length <= minPointsFor(item)) return
  ed.edit(null, () => {
    const live = ed.store.item(ref.itemId)
    const livePoints = live ? pointsOf(live) : null
    if (live && livePoints) {
      livePoints.splice(ref.index, 1)
      adopt(live)
    }
    ed.store.activeVertex = null
  })
}

// --- frozen commands, delegated to from editor.ts ---------------------------------------------

export function nudge(ed: Editor, dx: number, dy: number): void {
  const items = ed.store.selectedItems().filter((i) => ed.store.isEditable(i))
  if (items.length === 0) return
  ed.store.mutate(() => {
    for (const item of items) shiftItem(item, dx, dy)
  })
}

export function deleteSelectionOrVertex(ed: Editor): void {
  const av = ed.store.activeVertex
  if (av) {
    const item = ed.store.item(av.itemId)
    const points = item ? pointsOf(item) : null
    if (item && points) {
      if (points.length > minPointsFor(item)) {
        deleteVertex(ed, av)
        return
      }
      // Refuse rather than fall through: you aimed at a corner, and quietly deleting the
      // whole shape instead would be a shock. Esc clears the corner, then Delete removes it.
      const what = item.kind === 'room' ? 'A room needs three corners' : 'A run needs two ends'
      ed.flash(`${what} — press Esc, then Delete, to remove the whole thing`)
      return
    }
  }
  ed.store.deleteSelection()
  ed.onChange?.()
}
