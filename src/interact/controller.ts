import { boundsOf, dist, normalizeRect, polylineLength, type Pt, type Rect } from '../geom.ts'
import type { Store, VertexRef } from '../model/doc.ts'
import { newId } from '../model/ids.ts'
import {
  isPositioned, pointsOf,
  type BoxItem, type Item, type MarkerItem, type MarkerSymbol, type NoteItem, type RunItem,
} from '../model/types.ts'
import { Background } from '../render/background.ts'
import { itemBounds } from '../render/bounds.ts'
import { Camera } from '../render/camera.ts'
import { COMPASS_RADIUS_PX, type CompassPart } from '../render/compass.ts'
import { defaultNoteWidth, NOTE_MIN_WIDTH } from '../render/notes.ts'
import { drawScene, type Overlay } from '../render/scene.ts'
import { adopt } from '../generate.ts'
import { formatMetres } from '../units.ts'
import { hitBoxCorner, hitNoteHandle, hitSegment, hitTest, hitTestLocked, hitVertex, itemsInRect } from './hittest.ts'
import { resolvePoint } from './snap.ts'
import { alongBearing, bearingBetween, slugifyDirectionId, splitNames, tipBearing } from '../directions.ts'

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

export type ToolId = 'select' | 'run' | 'box' | 'marker' | 'note' | 'measure' | 'calibrate' | 'direction'

type Drag =
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

const HIT_TOL_PX = 9
const SNAP_TOL_PX = 11

export class Editor {
  cam = new Camera()
  tool: ToolId = 'select'
  activeSystemId = 'water.cold'
  activeLevel: Item['level'] = 'wall'
  activeMarkerSymbol: MarkerSymbol = 'riser-up'

  /** Fired when the user has picked two calibration points; UI asks for the real distance. */
  onCalibrateRequest: ((lengthPt: number) => void) | null = null
  /** Fired when the user has picked two direction points; UI asks what to call this bearing. */
  onDirectionRequest: ((bearingDeg: number) => void) | null = null
  onChange: (() => void) | null = null
  onStatus: ((text: string) => void) | null = null

  private bg: Background
  private ctx: CanvasRenderingContext2D
  private drag: Drag = { mode: 'none' }
  private draft: Pt[] = []
  private draftCursor: Pt | null = null
  private measurePts: Pt[] = []
  private snap: { point: Pt; label: string | null } | null = null
  private hover: { id: string | null; locked: string | null; compass: CompassPart | null } =
    { id: null, locked: null, compass: null }
  private spaceHeld = false
  private shiftHeld = false
  private cursorWorld: Pt | null = null
  private frameQueued = false
  private flashState: { text: string; hold: number; until: number } | null = null
  /** Set the first time a wheel event looks like a trackpad rather than a wheel mouse. */
  private trackpadSeen = false
  private lastMiddleDown = 0
  private cssWidth = 0
  private cssHeight = 0

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')
    this.ctx = ctx
    this.bg = new Background(() => this.requestRender())
    this.attach()
    store.subscribe(() => this.requestRender())
  }

  // --- lifecycle ---------------------------------------------------------------------

  private attach(): void {
    const c = this.canvas
    c.addEventListener('pointerdown', this.onPointerDown)
    c.addEventListener('pointermove', this.onPointerMove)
    c.addEventListener('pointerup', this.onPointerUp)
    c.addEventListener('pointercancel', this.onPointerUp)
    c.addEventListener('pointerleave', this.onPointerLeave)
    c.addEventListener('dblclick', this.onDoubleClick)
    c.addEventListener('wheel', this.onWheel, { passive: false })
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    const ro = new ResizeObserver(() => this.resize())
    ro.observe(c.parentElement ?? c)
    this.resize()
  }

  resize(): void {
    const host = this.canvas.parentElement ?? this.canvas
    const rect = host.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.cssWidth = Math.max(1, Math.floor(rect.width))
    this.cssHeight = Math.max(1, Math.floor(rect.height))
    this.canvas.width = Math.floor(this.cssWidth * dpr)
    this.canvas.height = Math.floor(this.cssHeight * dpr)
    this.canvas.style.width = `${this.cssWidth}px`
    this.canvas.style.height = `${this.cssHeight}px`
    this.requestRender()
  }

  requestRender(): void {
    if (this.frameQueued) return
    this.frameQueued = true
    requestAnimationFrame(() => {
      this.frameQueued = false
      this.render()
    })
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1
    this.bg.sync(this.store.sheet, this.cam.zoom, dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawScene({
      ctx: this.ctx,
      store: this.store,
      cam: this.cam,
      width: this.cssWidth,
      height: this.cssHeight,
      background: this.bg.canvas,
      backgroundSize: this.bg.size,
      interactive: true,
      overlay: this.overlay(),
    })
    this.canvas.style.cursor = this.cursorFor()
    this.publishStatus()
  }

  private overlay(): Overlay {
    return {
      draftPoints: this.draft.length ? this.draft : undefined,
      draftCursor: this.draft.length ? this.draftCursor : null,
      draftSystemId: this.activeSystemId,
      boxDraft: this.drag.mode === 'newBox' ? normalizeRect(this.drag.start, this.drag.current) : null,
      rubberBand: this.drag.mode === 'rubber' ? normalizeRect(this.drag.start, this.drag.current) : null,
      snapPoint: this.snap?.point ?? null,
      snapLabel: this.snap?.label ?? null,
      measure: this.measurePts.length === 2
        ? { a: this.measurePts[0], b: this.measurePts[1] }
        : this.measurePts.length === 1 && this.cursorWorld
          ? { a: this.measurePts[0], b: this.cursorWorld }
          : null,
      hoverId: this.hover.id,
      hoverLockedId: this.hover.locked,
      compass: this.compassPart(),
    }
  }

  /** The rose part currently being dragged, or - failing that - hovered. Shared by the overlay
   * (what to highlight) and the cursor (what shape to show). */
  private compassPart(): CompassPart | null {
    return this.drag.mode === 'compassTurn' ? { part: 'tip', tip: this.drag.tip }
      : this.drag.mode === 'compassMove' ? { part: 'hub' }
      : this.hover.compass
  }

  private cursorFor(): string {
    if (this.spaceHeld || this.drag.mode === 'pan') return 'grab'
    const rose = this.compassPart()
    if (rose) return rose.part === 'tip' ? 'grab' : 'move'
    if (this.tool === 'select') return this.hover.id ? 'move' : 'default'
    return 'crosshair'
  }

  /**
   * Says something and makes it stay said. The status line is rebuilt from the cursor on every
   * frame, so a message posted straight into it is gone before it can be read.
   */
  flash(text: string): void {
    // Held long enough to read, but it steps aside the moment you carry on working - a message
    // that outstays its welcome starts hiding live feedback, which is worse than not saying it.
    this.flashState = { text, hold: Date.now() + 1200, until: Date.now() + 6000 }
    this.onStatus?.(text)
    this.requestRender()
  }

  private clearFlashIfStale(): void {
    if (this.flashState && Date.now() > this.flashState.hold) this.flashState = null
  }

  private publishStatus(): void {
    if (!this.onStatus) return
    if (this.flashState && Date.now() < this.flashState.until) {
      this.onStatus(this.flashState.text)
      return
    }
    this.flashState = null
    const mmPerPoint = this.store.sheet.mmPerPoint
    const parts: string[] = []
    if (this.cursorWorld) {
      if (mmPerPoint) {
        parts.push(`x ${(this.cursorWorld.x * mmPerPoint / 1000).toFixed(2)} m, y ${(this.cursorWorld.y * mmPerPoint / 1000).toFixed(2)} m`)
      } else {
        parts.push(`x ${this.cursorWorld.x.toFixed(0)} pt, y ${this.cursorWorld.y.toFixed(0)} pt`)
      }
    }
    parts.push(`zoom ${(this.cam.zoom * 100).toFixed(0)}%`)
    if (this.trackpadSeen) parts.push('two fingers pan · pinch or ⌥scroll zooms')
    if (this.snap?.label) parts.push(`snap: ${this.snap.label}`)
    if (this.hover.locked) {
      const item = this.store.item(this.hover.locked)
      if (item?.locked) parts.push('locked item — use "Unlock all" in the Properties tab')
      else if (item) parts.push(`"${this.store.system(item.systemId).name}" is locked — unlock it in the Layers tab`)
    }
    if (this.tool === 'run' && this.draft.length) parts.push('Enter/double-click finishes · Backspace removes last point · Esc cancels')
    if (this.tool === 'calibrate') parts.push(this.measurePts.length === 0 ? 'Click the first end of a known dimension' : 'Click the second end')
    const rose = this.store.project.compass
    const part = this.compassPart()
    if (rose && part?.part === 'tip') {
      parts.push(`compass rose tip ${part.tip + 1} at ${Math.round(tipBearing(rose, part.tip))}° — drag to turn the rose, Shift for 45° steps`)
    } else if (rose && part?.part === 'hub') {
      parts.push('compass rose — drag the centre to move it; name the tips in Properties')
    }
    if (this.tool === 'direction') parts.push(this.measurePts.length === 0 ? 'Click a point, then click again toward the direction you mean' : 'Click again, in the direction this points to')
    this.onStatus(parts.join('   ·   '))
  }

  // --- coordinate helpers -------------------------------------------------------------

  private eventPoint(e: PointerEvent | MouseEvent): Pt {
    const rect = this.canvas.getBoundingClientRect()
    return this.cam.toWorld(e.clientX - rect.left, e.clientY - rect.top)
  }

  private tol(px: number): number {
    return px / this.cam.zoom
  }

  private resolve(raw: Pt, opts: { anchor?: Pt | null; excludeRunId?: string; excludeIndex?: number; itemSnap?: boolean } = {}): Pt {
    const res = resolvePoint(this.store, raw, this.tol(SNAP_TOL_PX), {
      anchor: opts.anchor ?? null,
      itemSnap: opts.itemSnap,
      // Latched ortho with Shift as a temporary override, which is how a CAD user expects
      // F8 and Shift to interact.
      ortho: this.store.project.settings.orthoLock !== this.shiftHeld,
      excludeRunId: opts.excludeRunId,
      excludeIndex: opts.excludeIndex,
    })
    this.snap = res.label ? res : null
    return res.point
  }

  /** Mutates the project, notifies whoever is listening, and optionally announces what
   * happened - the shape every compass/calibration/direction/vertex command here follows. */
  private edit(msg: string | null, fn: () => void): void {
    this.store.mutate(fn)
    if (msg) this.flash(msg)
    this.onChange?.()
  }

  /** Adds a freshly drawn item and selects it - shared by every tool that places one. */
  private place(item: Item): void {
    this.store.addItem(item)
    this.onChange?.()
  }

  // --- pointer ------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.clearFlashIfStale()
    this.canvas.setPointerCapture(e.pointerId)
    this.shiftHeld = e.shiftKey
    const world = this.eventPoint(e)
    this.cursorWorld = world

    if (e.button === 1 || this.spaceHeld) {
      // Middle double-click is Zoom Extents in AutoCAD, and costs nothing to honour.
      const now = Date.now()
      if (e.button === 1 && now - this.lastMiddleDown < 400) {
        this.lastMiddleDown = 0
        this.zoomToFit()
        return
      }
      if (e.button === 1) this.lastMiddleDown = now
      this.drag = { mode: 'pan', lastX: e.clientX, lastY: e.clientY }
      this.requestRender()
      return
    }
    if (e.button === 2) {
      if (this.tool === 'run' && this.draft.length >= 2) this.finishDraft()
      else if (this.tool === 'run') this.cancelDraft()
      return
    }
    if (e.button !== 0) return

    switch (this.tool) {
      case 'select': this.selectPointerDown(e, world); break
      case 'run': this.runPointerDown(world); break
      case 'box': this.drag = { mode: 'newBox', start: this.resolve(world), current: this.resolve(world) }; break
      case 'marker': this.placeMarker(this.resolve(world)); break
      case 'note': this.placeNote(this.resolve(world)); break
      case 'measure':
      case 'calibrate':
      case 'direction': this.measurePointerDown(world); break
    }
    this.requestRender()
  }

  private selectPointerDown(e: PointerEvent, world: Pt): void {
    const store = this.store
    const vertex = hitVertex(store, world, this.tol(HIT_TOL_PX))
    if (vertex) {
      if (e.altKey) {
        this.deleteVertex(vertex)
        return
      }
      store.activeVertex = vertex
      store.begin()
      this.drag = { mode: 'vertex', ref: vertex }
      return
    }

    const handle = this.hitHandle(world)
    if (handle) {
      store.begin()
      this.drag = handle
      return
    }

    const hit = hitTest(store, world, this.tol(HIT_TOL_PX))
    if (hit) {
      if (e.altKey && pointsOf(hit) && hit.kind !== 'door') {
        this.insertVertex(hit, world)
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
      this.drag = { mode: 'move', start: world, originals, moved: false }
      this.onChange?.()
      return
    }

    if (!e.shiftKey) {
      store.selection.clear()
      store.activeVertex = null
      this.onChange?.()
    }
    this.drag = { mode: 'rubber', start: world, additive: e.shiftKey, current: world }
  }

  /**
   * The one grab handle under `world` that isn't a shape's own vertex: a compass rose tip or
   * hub, a selected box's corner, or a selected note's resize handle - tried in that order,
   * since the rose floats above everything else on the sheet.
   */
  private hitHandle(world: Pt): Drag | null {
    const store = this.store
    const rose = this.hitCompass(world)
    if (rose && store.project.compass) {
      const c = store.project.compass
      return rose.part === 'tip'
        ? { mode: 'compassTurn', tip: rose.tip, moved: false }
        : { mode: 'compassMove', offset: { x: world.x - c.x, y: world.y - c.y }, moved: false }
    }

    const corner = hitBoxCorner(store, world, this.tol(HIT_TOL_PX))
    const box = corner ? store.item(corner.boxId) : undefined
    if (corner && box && box.kind === 'box') {
      const anchor = {
        x: corner.corner === 0 || corner.corner === 3 ? box.x + box.w : box.x,
        y: corner.corner === 0 || corner.corner === 1 ? box.y + box.h : box.y,
      }
      return { mode: 'boxCorner', boxId: box.id, anchor }
    }

    const noteHandle = hitNoteHandle(store, world, this.tol(HIT_TOL_PX))
    return noteHandle ? { mode: 'noteWidth', noteId: noteHandle.noteId } : null
  }

  private runPointerDown(world: Pt): void {
    const anchor = this.draft.length ? this.draft[this.draft.length - 1] : null
    const p = this.resolve(world, { anchor })
    this.draft.push(p)
    this.draftCursor = p
  }

  private measurePointerDown(world: Pt): void {
    const anchor = this.measurePts.length === 1 ? this.measurePts[0] : null
    const p = this.resolve(world, { anchor })
    if (this.measurePts.length >= 2) this.measurePts = []
    this.measurePts.push(p)
    if (this.measurePts.length !== 2) return
    const [a, b] = this.measurePts
    if (dist(a, b) < 1e-6) { this.measurePts = []; return }
    if (this.tool === 'calibrate') this.onCalibrateRequest?.(dist(a, b))
    else if (this.tool === 'direction') this.onDirectionRequest?.(bearingBetween(a, b))
  }

  private onPointerMove = (e: PointerEvent): void => {
    this.clearFlashIfStale()
    this.shiftHeld = e.shiftKey
    const world = this.eventPoint(e)
    this.cursorWorld = world

    switch (this.drag.mode) {
      case 'pan': {
        this.cam.panByScreen(e.clientX - this.drag.lastX, e.clientY - this.drag.lastY)
        this.drag.lastX = e.clientX
        this.drag.lastY = e.clientY
        break
      }
      case 'move': {
        const only = this.drag.originals.size === 1 ? [...this.drag.originals.values()][0] : null
        let dx: number, dy: number
        if (only && (only.kind === 'marker' || only.kind === 'note')) {
          // A single marker or note is nothing but a point - the cursor and the shape are the
          // same thing, so this is exactly where snapping to a run's end belongs (attaching a
          // lamp to a stub that ends mid-room). Resolve where the *item* would land, not the
          // raw cursor, and exclude the item from its own candidate list.
          const candidate = { x: only.x + (world.x - this.drag.start.x), y: only.y + (world.y - this.drag.start.y) }
          const target = this.resolve(candidate, { excludeRunId: only.id })
          dx = target.x - only.x
          dy = target.y - only.y
        } else {
          // Item snapping is off while moving a shape or a group: it would snap the cursor,
          // not the shape, which feels random. Ortho (Shift) and the grid still apply.
          const target = this.resolve(world, { anchor: this.drag.start, itemSnap: false })
          dx = target.x - this.drag.start.x
          dy = target.y - this.drag.start.y
        }
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) this.drag.moved = true
        for (const [id, original] of this.drag.originals) {
          const live = this.store.item(id)
          if (live) shiftItem(live, dx, dy, original)
        }
        break
      }
      case 'vertex': {
        const item = this.store.item(this.drag.ref.itemId)
        const points = item ? pointsOf(item) : null
        if (item && points) {
          const i = this.drag.ref.index
          const anchor = neighbourOf(item, points, i)
          points[i] = this.resolve(world, { anchor, excludeRunId: item.id, excludeIndex: i })
          adopt(item)
        }
        break
      }
      case 'boxCorner': {
        const box = this.store.item(this.drag.boxId)
        if (box && box.kind === 'box') {
          const p = this.resolve(world, { anchor: this.drag.anchor })
          Object.assign(box, normalizeRect(this.drag.anchor, p))
        }
        break
      }
      case 'noteWidth': {
        const note = this.store.item(this.drag.noteId)
        if (note && note.kind === 'note') note.w = Math.max(NOTE_MIN_WIDTH, world.x - note.x)
        break
      }
      case 'compassTurn': {
        const rose = this.store.project.compass
        if (!rose) break
        const centre = { x: rose.x, y: rose.y }
        // Anchored at the centre, so Shift locks the turn to 45° steps like any other line.
        // Snapping to items would drag the tip onto the nearest pipe, which means nothing here.
        const p = this.resolve(world, { anchor: centre, itemSnap: false })
        if (p.x === centre.x && p.y === centre.y) break
        const next = (((bearingBetween(centre, p) - this.drag.tip * 90) % 360) + 360) % 360
        if (Math.abs(next - rose.rotationDeg) > 1e-9) {
          rose.rotationDeg = next
          this.drag.moved = true
        }
        break
      }
      case 'compassMove': {
        const rose = this.store.project.compass
        if (!rose) break
        rose.x = world.x - this.drag.offset.x
        rose.y = world.y - this.drag.offset.y
        this.drag.moved = true
        break
      }
      case 'rubber': {
        this.drag.current = world
        break
      }
      case 'newBox': {
        this.drag.current = this.resolve(world, { anchor: this.drag.start })
        break
      }
      case 'none': {
        if (this.tool === 'run' && this.draft.length) {
          this.draftCursor = this.resolve(world, { anchor: this.draft[this.draft.length - 1] })
        } else if ((this.tool === 'measure' || this.tool === 'calibrate' || this.tool === 'direction') && this.measurePts.length === 1) {
          this.cursorWorld = this.resolve(world, { anchor: this.measurePts[0] })
        } else if (this.tool === 'select') {
          this.hover.compass = this.hitCompass(world)
          const hit = this.hover.compass ? null : hitTest(this.store, world, this.tol(HIT_TOL_PX))
          this.hover.id = hit?.id ?? null
          this.hover.locked = hit || this.hover.compass ? null : hitTestLocked(this.store, world, this.tol(HIT_TOL_PX))?.id ?? null
          this.snap = null
        } else {
          this.resolve(world)
        }
        break
      }
    }
    this.requestRender()
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    const store = this.store
    switch (this.drag.mode) {
      case 'move':
      case 'compassTurn':
      case 'compassMove':
        // A click that did not move anything leaves no undo step behind.
        if (this.drag.moved) store.commit()
        else store.cancel()
        break
      case 'vertex':
      case 'boxCorner':
      case 'noteWidth':
        store.commit()
        break
      case 'rubber': {
        const rect = normalizeRect(this.drag.start, this.drag.current)
        if (rect.w > 1e-6 || rect.h > 1e-6) {
          const found = itemsInRect(store, rect)
          if (!this.drag.additive) store.selection.clear()
          for (const it of found) store.selection.add(it.id)
          this.onChange?.()
        }
        break
      }
      case 'newBox': {
        const rect = normalizeRect(this.drag.start, this.drag.current)
        if (rect.w * this.cam.zoom > 4 && rect.h * this.cam.zoom > 4) this.createBox(rect)
        break
      }
      default:
        break
    }
    this.drag = { mode: 'none' }
    this.snap = null
    this.requestRender()
  }

  private onPointerLeave = (): void => {
    if (this.drag.mode === 'none') {
      this.cursorWorld = null
      this.snap = null
      this.hover = { id: null, locked: null, compass: null }
      this.requestRender()
    }
  }

  private onDoubleClick = (e: MouseEvent): void => {
    const world = this.eventPoint(e)
    if (this.tool === 'run') {
      if (this.draft.length >= 2) this.finishDraft()
      return
    }
    if (this.tool !== 'select') return
    const hit = hitTest(this.store, world, this.tol(HIT_TOL_PX))
    if (hit && pointsOf(hit) && hit.kind !== 'door') this.insertVertex(hit, world)
  }

  /**
   * A wheel mouse and a trackpad send the same event and mean opposite things by it: one notch
   * of a wheel means zoom, two fingers dragging mean pan. They are told apart by how the
   * browser reports the movement - a wheel arrives in discrete lines or big pixel jumps, a
   * trackpad in small pixel deltas and with sideways movement a wheel cannot produce. Once one
   * has been seen, it is remembered.
   *
   * Ctrl or Cmd always means zoom, which is also how the browser reports a trackpad pinch.
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    if (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && e.deltaY !== 0)) {
      this.trackpadSeen = true
    }
    const pinch = e.ctrlKey || e.metaKey
    const pans = !pinch && this.trackpadSeen && !e.altKey

    if (pans) {
      this.cam.panByScreen(-e.deltaX, -e.deltaY)
    } else {
      const rect = this.canvas.getBoundingClientRect()
      const factor = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1) * (pinch ? 2 : 1))
      this.cam.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
    }
    this.requestRender()
  }

  // --- item creation ------------------------------------------------------------------

  private createBox(rect: Rect): void {
    const sys = this.store.system(this.activeSystemId)
    const box: BoxItem = {
      kind: 'box',
      id: newId('box'),
      systemId: sys.id,
      level: this.activeLevel,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      label: '',
    }
    this.place(box)
  }

  private placeMarker(p: Pt): void {
    const marker: MarkerItem = {
      kind: 'marker',
      id: newId('mk'),
      systemId: this.activeSystemId,
      level: this.activeLevel,
      x: p.x, y: p.y,
      symbol: this.activeMarkerSymbol,
      label: '',
    }
    this.place(marker)
  }

  private placeNote(p: Pt): void {
    const note: NoteItem = {
      kind: 'note',
      id: newId('note'),
      systemId: this.activeSystemId,
      level: this.activeLevel,
      x: p.x,
      y: p.y,
      w: defaultNoteWidth(this.store.sheet.pdf?.widthPt ?? 595),
      text: '',
    }
    this.place(note)
  }

  finishDraft(): void {
    if (this.draft.length < 2) {
      this.cancelDraft()
      return
    }
    const sys = this.store.system(this.activeSystemId)
    const run: RunItem = {
      kind: 'run',
      id: newId('run'),
      systemId: sys.id,
      level: this.activeLevel,
      points: this.draft.map((p) => ({ ...p })),
      size: sys.defaultSize ?? '',
      // The order you drew it in is a decent guess at which way it falls or blows - but only
      // a guess, so it is marked as one until somebody says otherwise.
      flow: sys.assumeFlow ? 'forward' : 'none',
      ...(sys.assumeFlow ? { flowAssumed: true } : {}),
    }
    this.draft = []
    this.draftCursor = null
    this.place(run)
  }

  cancelDraft(): void {
    this.draft = []
    this.draftCursor = null
    this.requestRender()
  }

  private insertVertex(item: Item, world: Pt): void {
    // A door is two jambs and stays two jambs; everything else made of points can grow a corner.
    if (item.kind === 'door' || !pointsOf(item)) return
    const hit = hitSegment(item, world, this.tol(HIT_TOL_PX * 1.5))
    if (!hit) return
    this.edit(null, () => {
      const live = this.store.item(item.id)
      const points = live ? pointsOf(live) : null
      if (live && points) {
        points.splice(hit.index + 1, 0, hit.point)
        adopt(live)
      }
      this.store.selection.clear()
      this.store.selection.add(item.id)
      this.store.activeVertex = { itemId: item.id, index: hit.index + 1 }
    })
  }

  private deleteVertex(ref: VertexRef): void {
    const item = this.store.item(ref.itemId)
    const points = item ? pointsOf(item) : null
    if (!item || !points || points.length <= minPointsFor(item)) return
    this.edit(null, () => {
      const live = this.store.item(ref.itemId)
      const livePoints = live ? pointsOf(live) : null
      if (live && livePoints) {
        livePoints.splice(ref.index, 1)
        adopt(live)
      }
      this.store.activeVertex = null
    })
  }

  // --- public commands ------------------------------------------------------------------

  setTool(tool: ToolId): void {
    this.flashState = null
    if (this.tool === 'run' && tool !== 'run') this.cancelDraft()
    this.hover.id = null
    this.hover.locked = null
    if (tool !== 'measure' && tool !== 'calibrate' && tool !== 'direction') this.measurePts = []
    this.tool = tool
    this.requestRender()
    this.onChange?.()
  }

  applyCalibration(realMm: number): void {
    if (this.measurePts.length !== 2 || realMm <= 0) return
    const lengthPt = dist(this.measurePts[0], this.measurePts[1])
    if (lengthPt < 1e-6) return
    const mmPerPoint = realMm / lengthPt
    this.measurePts = []
    this.edit(`Calibrated: 1 pt = ${mmPerPoint.toFixed(3)} mm`, () => { this.store.sheet.mmPerPoint = mmPerPoint })
  }

  cancelCalibration(): void {
    this.cancelMeasurement()
  }

  /**
   * `names` is whatever the person typed — comma-separated, e.g. "street, north, noord,
   * straatzijde". The first one becomes the stable id; all of them become aliases, so typing
   * the id back later still resolves. Re-using a name updates that direction's bearing instead
   * of adding a duplicate, so clicking again to fix a mistake just works.
   */
  applyDirection(bearingDeg: number, names: string): void {
    const aliases = splitNames(names)
    this.measurePts = []
    if (aliases.length === 0) return
    const id = slugifyDirectionId(aliases[0])
    this.edit(`Direction "${id}" set: ${aliases.join(', ')}`, () => {
      const list = this.store.project.directions ?? (this.store.project.directions = [])
      const existing = list.find((d) => d.id === id)
      if (existing) { existing.bearingDeg = bearingDeg; existing.aliases = aliases }
      else list.push({ id, bearingDeg, aliases })
    })
  }

  cancelDirection(): void {
    this.cancelMeasurement()
  }

  private cancelMeasurement(): void {
    this.measurePts = []
    this.requestRender()
  }

  // --- compass rose ----------------------------------------------------------------------

  /**
   * Drops a compass rose in the middle of whatever is on screen, pointing straight up. There is
   * one for the whole project, shown on every sheet at the same spot: asking again just brings
   * it into view - which is also the way back if a page of another size leaves it off the edge.
   */
  placeCompass(): void {
    const existing = this.store.project.compass
    if (existing) {
      this.cam.x = existing.x - this.cssWidth / 2 / this.cam.zoom
      this.cam.y = existing.y - this.cssHeight / 2 / this.cam.zoom
      this.flash('The project already has a compass rose — it is in the middle of the view now')
      return
    }
    const centre = this.cam.toWorld(this.cssWidth / 2, this.cssHeight / 2)
    this.edit(
      'Compass rose placed — drag a tip to turn it, drag the centre to move it, name the tips in Properties',
      () => { this.store.project.compass = { x: centre.x, y: centre.y, rotationDeg: 0, tips: ['', '', '', ''] } },
    )
  }

  /** What tip `tip` (0-3) is called, comma-separated as typed. */
  nameCompassTip(tip: number, names: string): void {
    const rose = this.store.project.compass
    if (!rose || tip < 0 || tip > 3) return
    const text = splitNames(names).join(', ')
    if (rose.tips[tip] === text) return
    this.edit(null, () => { rose.tips[tip] = text })
  }

  /** Types an exact rotation instead of dragging one. */
  turnCompass(rotationDeg: number): void {
    const rose = this.store.project.compass
    if (!rose || !isFinite(rotationDeg)) return
    const next = ((rotationDeg % 360) + 360) % 360
    if (next === rose.rotationDeg) return
    this.edit(null, () => { rose.rotationDeg = next })
  }

  removeCompass(): void {
    if (!this.store.project.compass) return
    this.edit(null, () => { delete this.store.project.compass })
    this.hover.compass = null
  }

  /**
   * The rose is drawn at a fixed size on screen, like a marker, so what counts as "on a tip"
   * is measured in pixels and converted - otherwise it would be ungrabbable when zoomed out.
   */
  private hitCompass(world: Pt): CompassPart | null {
    const rose = this.store.project.compass
    if (!rose) return null
    const centre = { x: rose.x, y: rose.y }
    const tol = this.tol(HIT_TOL_PX)
    const radius = COMPASS_RADIUS_PX / this.cam.zoom
    for (let tip = 0; tip < 4; tip++) {
      if (dist(alongBearing(centre, tipBearing(rose, tip), radius), world) <= tol * 1.3) return { part: 'tip', tip }
    }
    if (dist(centre, world) <= tol * 1.3) return { part: 'hub' }
    return null
  }

  removeDirection(id: string): void {
    this.edit(null, () => {
      const list = this.store.project.directions
      if (!list) return
      this.store.project.directions = list.filter((d) => d.id !== id)
      if (this.store.project.directions.length === 0) delete this.store.project.directions
    })
  }

  /** Length of the current measurement, in mm, or null. */
  measurementMm(): number | null {
    const mmPerPoint = this.store.sheet.mmPerPoint
    if (this.measurePts.length !== 2 || !mmPerPoint) return null
    return dist(this.measurePts[0], this.measurePts[1]) * mmPerPoint
  }

  nudge(dx: number, dy: number): void {
    const items = this.store.selectedItems().filter((i) => this.store.isEditable(i))
    if (items.length === 0) return
    this.store.mutate(() => {
      for (const item of items) shiftItem(item, dx, dy)
    })
  }

  nudgeByPixels(px: number, py: number): void {
    this.nudge(px / this.cam.zoom, py / this.cam.zoom)
  }

  deleteSelectionOrVertex(): void {
    const av = this.store.activeVertex
    if (av) {
      const item = this.store.item(av.itemId)
      const points = item ? pointsOf(item) : null
      if (item && points) {
        if (points.length > minPointsFor(item)) {
          this.deleteVertex(av)
          return
        }
        // Refuse rather than fall through: you aimed at a corner, and quietly deleting the
        // whole shape instead would be a shock. Esc clears the corner, then Delete removes it.
        const what = item.kind === 'room' ? 'A room needs three corners' : 'A run needs two ends'
        this.flash(`${what} — press Esc, then Delete, to remove the whole thing`)
        return
      }
    }
    this.store.deleteSelection()
    this.onChange?.()
  }

  removeLastDraftPoint(): void {
    if (this.draft.length === 0) return
    this.draft.pop()
    this.requestRender()
  }

  get isDrafting(): boolean {
    return this.draft.length > 0
  }

  /** The latched modes, in the order a CAD status bar shows them. */
  modes(): { id: 'ortho' | 'snap' | 'grid'; label: string; key: string; on: boolean; title: string }[] {
    const s = this.store.project.settings
    return [
      { id: 'ortho', label: 'ORTHO', key: 'F8', on: s.orthoLock, title: 'Constrain to 45° steps (F8). Shift flips it while held.' },
      { id: 'snap', label: 'SNAP', key: 'F3', on: s.snapToItems, title: 'Snap to the ends and corners of what is already drawn (F3)' },
      { id: 'grid', label: 'GRID', key: 'F7', on: s.showGrid, title: 'Show the grid (F7)' },
    ]
  }

  toggleMode(id: 'ortho' | 'snap' | 'grid'): void {
    const s = this.store.project.settings
    if (id === 'ortho') s.orthoLock = !s.orthoLock
    if (id === 'snap') s.snapToItems = !s.snapToItems
    if (id === 'grid') s.showGrid = !s.showGrid
    this.store.touch()
  }

  setSpaceHeld(v: boolean): void {
    this.spaceHeld = v
    this.requestRender()
  }

  setShiftHeld(v: boolean): void {
    this.shiftHeld = v
  }

  zoomBy(factor: number): void {
    this.cam.zoomAt(this.cssWidth / 2, this.cssHeight / 2, factor)
    this.requestRender()
  }

  zoomToFit(): void {
    const pdf = this.store.sheet.pdf
    const { w, h } = this.bg.size ?? (pdf ? { w: pdf.widthPt, h: pdf.heightPt } : { w: 595, h: 842 })
    this.cam.fit({ x: 0, y: 0, w, h }, this.cssWidth, this.cssHeight)
    this.requestRender()
  }

  zoomToSelection(): void {
    const items = this.store.selectedItems()
    if (items.length === 0) return this.zoomToFit()
    const corners = (it: Item): Pt[] => {
      if (it.kind === 'run') return it.points
      const b = itemBounds(it)
      return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]
    }
    const b = boundsOf(items.flatMap(corners))
    const pad = Math.max(20, b.w * 0.15)
    this.cam.fit({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, this.cssWidth, this.cssHeight)
    this.requestRender()
  }

  /** Selection summary for the status bar. */
  selectionSummary(): string {
    const items = this.store.selectedItems()
    if (items.length === 0) return 'Nothing selected'
    if (items.length === 1) {
      const it = items[0]
      const sys = this.store.system(it.systemId)
      if (it.kind === 'run') {
        const mmPerPoint = this.store.sheet.mmPerPoint
        const len = mmPerPoint ? formatMetres(polylineLength(it.points) * mmPerPoint, 2) : '—'
        return `${sys.name} · ${it.points.length} points · ${len}`
      }
      if (it.kind === 'note') return `Note · ${sys.name}`
      return `${sys.name} · ${it.kind}`
    }
    return `${items.length} items selected`
  }

  invalidateBackground(): void {
    this.bg.clear()
    this.requestRender()
  }
}
