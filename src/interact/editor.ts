/**
 * The Editor: canvas state and the coordinate/snapping/mutation primitives that pointer.ts,
 * compass.ts and view.ts are built from. Each takes an Editor instance as its first argument
 * and owns one cluster of behaviour; this file is the state and the glue between them.
 */
import type { Pt } from '../geom.ts'
import type { Store } from '../model/doc.ts'
import type { Item, MarkerSymbol } from '../model/types.ts'
import { Background } from '../render/background.ts'
import { Camera } from '../render/camera.ts'
import type { CompassPart } from '../render/compass.ts'
import { resolvePoint } from './snap.ts'
import {
  attachPointer, cancelDraft, deleteSelectionOrVertex as pointerDeleteSelectionOrVertex,
  nudge as pointerNudge, type Drag,
} from './pointer.ts'
import { attachView, requestRender as viewRequestRender, zoomToSelection as viewZoomToSelection } from './view.ts'

export type ToolId = 'select' | 'run' | 'box' | 'marker' | 'note' | 'measure' | 'calibrate' | 'direction'

/** Real distance the raw cursor snaps a point in, at 1:1 zoom; see `Editor.resolve`. */
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

  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  bg: Background
  store: Store

  drag: Drag = { mode: 'none' }
  draft: Pt[] = []
  draftCursor: Pt | null = null
  measurePts: Pt[] = []
  snap: { point: Pt; label: string | null } | null = null
  hover: { id: string | null; locked: string | null; compass: CompassPart | null } =
    { id: null, locked: null, compass: null }
  spaceHeld = false
  shiftHeld = false
  cursorWorld: Pt | null = null
  frameQueued = false
  flashState: { text: string; hold: number; until: number } | null = null
  /** Set the first time a wheel event looks like a trackpad rather than a wheel mouse. */
  trackpadSeen = false
  lastMiddleDown = 0
  cssWidth = 0
  cssHeight = 0

  constructor(canvas: HTMLCanvasElement, store: Store) {
    this.canvas = canvas
    this.store = store
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')
    this.ctx = ctx
    this.bg = new Background(() => this.requestRender())
    attachPointer(this)
    attachView(this)
    store.subscribe(() => this.requestRender())
  }

  // --- coordinate + mutation primitives, shared by every cluster below ---------------------

  eventPoint(e: PointerEvent | MouseEvent): Pt {
    const rect = this.canvas.getBoundingClientRect()
    return this.cam.toWorld(e.clientX - rect.left, e.clientY - rect.top)
  }

  tol(px: number): number {
    return px / this.cam.zoom
  }

  resolve(raw: Pt, opts: { anchor?: Pt | null; excludeRunId?: string; excludeIndex?: number; itemSnap?: boolean } = {}): Pt {
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
   * happened - the shape every compass/calibration/direction/vertex command follows. */
  edit(msg: string | null, fn: () => void): void {
    this.store.mutate(fn)
    if (msg) this.flash(msg)
    this.onChange?.()
  }

  /** Adds a freshly drawn item and selects it - shared by every tool that places one. */
  place(item: Item): void {
    this.store.addItem(item)
    this.onChange?.()
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

  // --- frozen surface: the browser smoke test reaches these by exact name ------------------

  requestRender(): void { viewRequestRender(this) }

  setTool(tool: ToolId): void {
    this.flashState = null
    if (this.tool === 'run' && tool !== 'run') cancelDraft(this)
    this.hover.id = null
    this.hover.locked = null
    if (tool !== 'measure' && tool !== 'calibrate' && tool !== 'direction') this.measurePts = []
    this.tool = tool
    this.requestRender()
    this.onChange?.()
  }

  nudge(dx: number, dy: number): void { pointerNudge(this, dx, dy) }
  deleteSelectionOrVertex(): void { pointerDeleteSelectionOrVertex(this) }
  zoomToSelection(): void { viewZoomToSelection(this) }

  // --- small state that does not belong to any one cluster ---------------------------------

  nudgeByPixels(px: number, py: number): void { this.nudge(px / this.cam.zoom, py / this.cam.zoom) }

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

  setSpaceHeld(v: boolean): void { this.spaceHeld = v; this.requestRender() }
  setShiftHeld(v: boolean): void { this.shiftHeld = v }
  invalidateBackground(): void { this.bg.clear(); this.requestRender() }

  get isDrafting(): boolean { return this.draft.length > 0 }
}
