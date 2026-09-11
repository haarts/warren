import { dist, normalizeRect, type Pt, type Rect } from '../geom.ts'
import type { Store, VertexRef } from '../model/doc.ts'
import { newId } from '../model/ids.ts'
import type { BoxItem, Item, MarkerItem, MarkerSymbol, NoteItem, RunItem } from '../model/types.ts'
import { Background } from '../render/background.ts'
import { Camera } from '../render/camera.ts'
import { defaultNoteWidth, NOTE_MIN_WIDTH } from '../render/notes.ts'
import { drawScene, itemBounds, type Overlay } from '../render/scene.ts'
import { formatMetres } from '../units.ts'
import { hitBoxCorner, hitNoteHandle, hitSegment, hitTest, hitTestLocked, hitVertex, itemsInRect } from './hittest.ts'
import { resolvePoint } from './snap.ts'

export type ToolId = 'select' | 'run' | 'box' | 'marker' | 'note' | 'measure' | 'calibrate'

type Drag =
  | { mode: 'none' }
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'move'; start: Pt; originals: Map<string, Item>; moved: boolean }
  | { mode: 'vertex'; ref: VertexRef }
  | { mode: 'boxCorner'; boxId: string; anchor: Pt }
  | { mode: 'noteWidth'; noteId: string }
  | { mode: 'rubber'; start: Pt; additive: boolean; current: Pt }
  | { mode: 'newBox'; start: Pt; current: Pt }

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
  onChange: (() => void) | null = null
  onStatus: ((text: string) => void) | null = null

  private bg: Background
  private ctx: CanvasRenderingContext2D
  private drag: Drag = { mode: 'none' }
  private draft: Pt[] = []
  private draftCursor: Pt | null = null
  private measurePts: Pt[] = []
  private snap: { point: Pt; label: string | null } | null = null
  private hoverId: string | null = null
  private hoverLockedId: string | null = null
  private spaceHeld = false
  private shiftHeld = false
  private cursorWorld: Pt | null = null
  private frameQueued = false
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
      hoverId: this.hoverId,
      hoverLockedId: this.hoverLockedId,
    }
  }

  private cursorFor(): string {
    if (this.spaceHeld || this.drag.mode === 'pan') return 'grab'
    if (this.tool === 'select') return this.hoverId ? 'move' : 'default'
    return 'crosshair'
  }

  private publishStatus(): void {
    if (!this.onStatus) return
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
    if (this.snap?.label) parts.push(`snap: ${this.snap.label}`)
    if (this.hoverLockedId) {
      const item = this.store.item(this.hoverLockedId)
      if (item?.locked) parts.push('locked item — use "Unlock all" in the Properties tab')
      else if (item) parts.push(`"${this.store.system(item.systemId).name}" is locked — unlock it in the Layers tab`)
    }
    if (this.tool === 'run' && this.draft.length) parts.push('Enter/double-click finishes · Backspace removes last point · Esc cancels')
    if (this.tool === 'calibrate') parts.push(this.measurePts.length === 0 ? 'Click the first end of a known dimension' : 'Click the second end')
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
    const settings = this.store.project.settings
    const itemSnap = opts.itemSnap ?? true
    const prevItems = settings.snapToItems
    if (!itemSnap) settings.snapToItems = false
    const res = resolvePoint(this.store, raw, this.tol(SNAP_TOL_PX), {
      anchor: opts.anchor ?? null,
      ortho: this.shiftHeld,
      excludeRunId: opts.excludeRunId,
      excludeIndex: opts.excludeIndex,
    })
    settings.snapToItems = prevItems
    this.snap = res.label ? res : null
    return res.point
  }

  // --- pointer ------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId)
    this.shiftHeld = e.shiftKey
    const world = this.eventPoint(e)
    this.cursorWorld = world

    if (e.button === 1 || this.spaceHeld) {
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
      case 'calibrate': this.measurePointerDown(world); break
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

    const corner = hitBoxCorner(store, world, this.tol(HIT_TOL_PX))
    if (corner) {
      const box = store.item(corner.boxId) as BoxItem | undefined
      if (box) {
        const anchor = {
          x: corner.corner === 0 || corner.corner === 3 ? box.x + box.w : box.x,
          y: corner.corner === 0 || corner.corner === 1 ? box.y + box.h : box.y,
        }
        store.begin()
        this.drag = { mode: 'boxCorner', boxId: box.id, anchor }
        return
      }
    }

    const noteHandle = hitNoteHandle(store, world, this.tol(HIT_TOL_PX))
    if (noteHandle) {
      store.begin()
      this.drag = { mode: 'noteWidth', noteId: noteHandle.noteId }
      return
    }

    const hit = hitTest(store, world, this.tol(HIT_TOL_PX))
    if (hit) {
      if (e.altKey && hit.kind === 'run') {
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
    if (this.measurePts.length === 2 && this.tool === 'calibrate') {
      const lengthPt = dist(this.measurePts[0], this.measurePts[1])
      if (lengthPt < 1e-6) {
        this.measurePts = []
        return
      }
      this.onCalibrateRequest?.(lengthPt)
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
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
        // Item snapping is off while moving: it would snap the cursor, not the shape, which
        // feels random. Ortho (Shift) and the grid still apply.
        const target = this.resolve(world, { anchor: this.drag.start, itemSnap: false })
        const dx = target.x - this.drag.start.x
        const dy = target.y - this.drag.start.y
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) this.drag.moved = true
        for (const [id, original] of this.drag.originals) {
          const live = this.store.item(id)
          if (!live) continue
          if (live.kind === 'run' && original.kind === 'run') {
            live.points = original.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
          } else if (live.kind === 'box' && original.kind === 'box') {
            live.x = original.x + dx
            live.y = original.y + dy
          } else if (live.kind === 'marker' && original.kind === 'marker') {
            live.x = original.x + dx
            live.y = original.y + dy
          } else if (live.kind === 'note' && original.kind === 'note') {
            live.x = original.x + dx
            live.y = original.y + dy
          }
        }
        break
      }
      case 'vertex': {
        const run = this.store.item(this.drag.ref.runId)
        if (run && run.kind === 'run') {
          const i = this.drag.ref.index
          const anchor = run.points[i - 1] ?? run.points[i + 1] ?? null
          run.points[i] = this.resolve(world, { anchor, excludeRunId: run.id, excludeIndex: i })
        }
        break
      }
      case 'boxCorner': {
        const box = this.store.item(this.drag.boxId)
        if (box && box.kind === 'box') {
          const p = this.resolve(world, { anchor: this.drag.anchor, itemSnap: true })
          const r = normalizeRect(this.drag.anchor, p)
          box.x = r.x; box.y = r.y; box.w = r.w; box.h = r.h
        }
        break
      }
      case 'noteWidth': {
        const note = this.store.item(this.drag.noteId)
        if (note && note.kind === 'note') note.w = Math.max(NOTE_MIN_WIDTH, world.x - note.x)
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
        } else if ((this.tool === 'measure' || this.tool === 'calibrate') && this.measurePts.length === 1) {
          this.cursorWorld = this.resolve(world, { anchor: this.measurePts[0] })
        } else if (this.tool === 'select') {
          const hit = hitTest(this.store, world, this.tol(HIT_TOL_PX))
          this.hoverId = hit?.id ?? null
          this.hoverLockedId = hit ? null : hitTestLocked(this.store, world, this.tol(HIT_TOL_PX))?.id ?? null
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
      this.hoverId = null
      this.hoverLockedId = null
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
    if (hit && hit.kind === 'run') this.insertVertex(hit, world)
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const factor = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1))
    this.cam.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
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
    this.store.addItem(box)
    this.onChange?.()
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
    this.store.addItem(marker)
    this.onChange?.()
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
    this.store.addItem(note)
    this.onChange?.()
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
    this.store.addItem(run)
    this.onChange?.()
    this.requestRender()
  }

  cancelDraft(): void {
    this.draft = []
    this.draftCursor = null
    this.requestRender()
  }

  private insertVertex(run: Item, world: Pt): void {
    if (run.kind !== 'run') return
    const hit = hitSegment(run, world, this.tol(HIT_TOL_PX * 1.5))
    if (!hit) return
    this.store.mutate(() => {
      const live = this.store.item(run.id)
      if (live && live.kind === 'run') live.points.splice(hit.index + 1, 0, hit.point)
      this.store.selection.clear()
      this.store.selection.add(run.id)
      this.store.activeVertex = { runId: run.id, index: hit.index + 1 }
    })
    this.onChange?.()
  }

  private deleteVertex(ref: VertexRef): void {
    const run = this.store.item(ref.runId)
    if (!run || run.kind !== 'run' || run.points.length <= 2) return
    this.store.mutate(() => {
      const live = this.store.item(ref.runId)
      if (live && live.kind === 'run') live.points.splice(ref.index, 1)
      this.store.activeVertex = null
    })
    this.onChange?.()
  }

  // --- public commands ------------------------------------------------------------------

  setTool(tool: ToolId): void {
    if (this.tool === 'run' && tool !== 'run') this.cancelDraft()
    this.hoverId = null
    this.hoverLockedId = null
    if (tool !== 'measure' && tool !== 'calibrate') this.measurePts = []
    this.tool = tool
    this.requestRender()
    this.onChange?.()
  }

  applyCalibration(realMm: number): void {
    if (this.measurePts.length !== 2 || realMm <= 0) return
    const lengthPt = dist(this.measurePts[0], this.measurePts[1])
    if (lengthPt < 1e-6) return
    this.store.mutate(() => {
      this.store.sheet.mmPerPoint = realMm / lengthPt
    })
    this.measurePts = []
    this.onStatus?.(`Calibrated: 1 pt = ${(realMm / lengthPt).toFixed(3)} mm`)
    this.requestRender()
    this.onChange?.()
  }

  cancelCalibration(): void {
    this.measurePts = []
    this.requestRender()
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
      for (const item of items) {
        if (item.kind === 'run') item.points = item.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
        else { item.x += dx; item.y += dy }
      }
    })
  }

  nudgeByPixels(px: number, py: number): void {
    this.nudge(px / this.cam.zoom, py / this.cam.zoom)
  }

  deleteSelectionOrVertex(): void {
    const av = this.store.activeVertex
    if (av) {
      const run = this.store.item(av.runId)
      if (run && run.kind === 'run' && run.points.length > 2) {
        this.deleteVertex(av)
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
    const sheet = this.store.sheet
    const size = this.bg.size
    if (size) {
      this.cam.fit({ x: 0, y: 0, w: size.w, h: size.h }, this.cssWidth, this.cssHeight)
    } else if (sheet.pdf) {
      this.cam.fit({ x: 0, y: 0, w: sheet.pdf.widthPt, h: sheet.pdf.heightPt }, this.cssWidth, this.cssHeight)
    } else {
      this.cam.fit({ x: 0, y: 0, w: 595, h: 842 }, this.cssWidth, this.cssHeight)
    }
    this.requestRender()
  }

  zoomToSelection(): void {
    const items = this.store.selectedItems()
    if (items.length === 0) return this.zoomToFit()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const it of items) {
      const b = itemBounds(it)
      const pts: Pt[] = it.kind === 'run'
        ? it.points
        : [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]
      for (const p of pts) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
      }
    }
    const pad = Math.max(20, (maxX - minX) * 0.15)
    this.cam.fit({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, this.cssWidth, this.cssHeight)
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
        const len = mmPerPoint
          ? formatMetres(it.points.reduce((acc, p, i) => (i === 0 ? 0 : acc + dist(it.points[i - 1], p)), 0) * mmPerPoint, 2)
          : '—'
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
